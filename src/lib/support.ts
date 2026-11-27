// Support access (1.21.4): time-limited, approved and audited access for
// CompassDocs staff to a cloud workspace. Nobody at CompassDocs has standing
// access to a workspace; this is the only way in.
//
//   1. The console asks. Its signing service signs a request token
//      (lib/support-token, typ compassdocs.support_request: the staff
//      member, the reason, read-only or administrator, how long) and the
//      console POSTs it to /api/support/requests. It appears on Settings →
//      Support access for the workspace's administrators (and in their
//      bell), pending, for PENDING_TTL_MS. The workspace can turn requests
//      off (supportSettings).
//   2. An administrator approves or denies it there. Approval opens the
//      window: from now, for the requested duration (at most 8 hours).
//   3. The staff member signs in. The console's signing service signs a
//      grant token naming the request; the browser opens
//      /support/sign-in#<token>, whose page posts it to
//      /api/support/session. The token is used once, must match the
//      request's staff member and level, and the session ends at the
//      earlier of the token's `exp` and the window's end.
//   Emergency: a grant token with an `emergency` reason and no request
//   opens a session without waiting for approval, only where the workspace
//   allows emergency access (off by default; read-only, or read-only and
//   administrator). Administrators are told at once (the bell) and every
//   page of Settings shows it until one of them marks it reviewed.
//
// The session is its own service account (users.status 'service',
// auth_provider 'compassdocs_support', named "<staff> (CompassDocs
// support)"), never one of the customer's, and lib/support-policy limits it
// (the proxy, its permissions). Every request, decision, sign-in, refused
// sign-in, page viewed, change made and end is in the workspace's audit log
// (category "support"); Settings → Support access lists past and active
// access, and an administrator can revoke any of it at any moment.
//
// Only in cloud mode with COMPASSDOCS_SUPPORT_PUBLIC_KEY (lib/cloud
// supportAccessConfig); otherwise every entry point answers as if it did
// not exist.

import "server-only";
import { randomBytes } from "node:crypto";
import { supportAccessConfig } from "./cloud";
import { CLOCK_SKEW_S, levelLabel, verifySupportToken, type GrantClaims, type SupportLevel } from "./support-token";
import { SUPPORT_TOKEN_PREFIX } from "./support-policy";
import { createSupportBrowserSession, getSetting, insertNotifications, pool, setSetting, withAdvisoryLock, type Queryable } from "./db";
import { audit, type AuditActor } from "./audit";
import { logEvent } from "./log";

export const SUPPORT_SETTINGS_KEY = "support_access";
/** A request nobody decided lapses after this long. */
export const PENDING_TTL_MS = 24 * 60 * 60_000;
/** At most this many requests pending at once. */
export const MAX_PENDING = 10;
/** At most this many requests a day (rolling). */
export const MAX_REQUESTS_PER_DAY = 30;
/** A session that would last less than this is not opened. */
export const MIN_SESSION_MS = 60_000;
/** The service account's provider (users.auth_provider). */
export const SUPPORT_PROVIDER = "compassdocs_support";

export type EmergencyAccess = "off" | "read_only" | "admin";

export interface SupportSettings {
  /** May the console ask for access (each request still needs an administrator's approval)? */
  requests: boolean;
  /** Emergency access without approval: off (the default), read-only only, or read-only and administrator. */
  emergency: EmergencyAccess;
}

export const DEFAULT_SUPPORT_SETTINGS: SupportSettings = { requests: true, emergency: "off" };

export class SupportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "SupportError";
  }
}

const NOT_AVAILABLE = () => new SupportError("Not found.", 404, "not_found");

function config() {
  const cfg = supportAccessConfig();
  if (!cfg) throw NOT_AVAILABLE();
  return cfg;
}

/** The audit actor for a staff member acting through the console (not signed in). */
function staffActor(name: string): AuditActor {
  return { id: null, name: `${name} (CompassDocs support)`, role: null };
}

// --- Settings -----------------------------------------------------------------------------

export function parseSupportSettings(raw: string | undefined | null): SupportSettings {
  try {
    const o = raw ? (JSON.parse(raw) as Partial<SupportSettings>) : {};
    return {
      requests: typeof o.requests === "boolean" ? o.requests : DEFAULT_SUPPORT_SETTINGS.requests,
      emergency: o.emergency === "read_only" || o.emergency === "admin" ? o.emergency : "off",
    };
  } catch {
    return { ...DEFAULT_SUPPORT_SETTINGS };
  }
}

export async function supportSettings(): Promise<SupportSettings> {
  return parseSupportSettings(await getSetting(SUPPORT_SETTINGS_KEY));
}

export async function saveSupportSettings(next: SupportSettings, actor: AuditActor, ip: string | null): Promise<SupportSettings> {
  config();
  const before = await supportSettings();
  const clean = parseSupportSettings(JSON.stringify(next));
  await setSetting(SUPPORT_SETTINGS_KEY, JSON.stringify(clean));
  if (before.requests !== clean.requests || before.emergency !== clean.emergency) {
    await audit({ actor, action: "support.settings_changed", targetType: "support", targetLabel: "Support access", details: { before, after: clean }, ip });
  }
  return clean;
}

// --- Rows ------------------------------------------------------------------------------------

export type RequestStatus = "pending" | "approved" | "denied" | "revoked" | "expired" | "ended";

export interface SupportRequestRow {
  id: string;
  kind: "request" | "emergency";
  status: RequestStatus;
  staff_name: string;
  staff_email: string;
  reason: string;
  level: SupportLevel;
  duration_minutes: number;
  emergency_reason: string | null;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by_name: string | null;
  window_starts: string | null;
  window_ends: string | null;
  ended_at: string | null;
  end_reason: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
}

export interface SupportSessionRow {
  id: number;
  request_id: string;
  level: SupportLevel;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  end_reason: string | null;
  ended_by_name: string | null;
  ip: string | null;
  pages: number;
  actions: number;
  last_seen_at: string | null;
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function requestRow(r: Record<string, unknown>): SupportRequestRow {
  return {
    ...(r as unknown as SupportRequestRow),
    requested_at: iso(r.requested_at)!,
    expires_at: iso(r.expires_at)!,
    decided_at: iso(r.decided_at),
    window_starts: iso(r.window_starts),
    window_ends: iso(r.window_ends),
    ended_at: iso(r.ended_at),
    reviewed_at: iso(r.reviewed_at),
  };
}

function sessionRow(r: Record<string, unknown>): SupportSessionRow {
  return {
    ...(r as unknown as SupportSessionRow),
    started_at: iso(r.started_at)!,
    expires_at: iso(r.expires_at)!,
    ended_at: iso(r.ended_at),
    last_seen_at: iso(r.last_seen_at),
  };
}

/** What the console is told about a request (no administrator names, no audit detail). */
export interface RequestView {
  id: string;
  status: RequestStatus;
  level: SupportLevel;
  duration_minutes: number;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  window_starts: string | null;
  window_ends: string | null;
}

export function requestView(r: SupportRequestRow): RequestView {
  return {
    id: r.id,
    status: r.status,
    level: r.level,
    duration_minutes: r.duration_minutes,
    requested_at: r.requested_at,
    expires_at: r.expires_at,
    decided_at: r.decided_at,
    window_starts: r.window_starts,
    window_ends: r.window_ends,
  };
}

async function adminIds(): Promise<number[]> {
  try {
    const { recoveryHolders } = await import("./authz");
    return (await recoveryHolders()).map((h) => h.id);
  } catch {
    return [];
  }
}

async function bell(title: string, body: string): Promise<void> {
  try {
    await insertNotifications(await adminIds(), { kind: "service_status", title, body, link: "/admin/support-access" });
  } catch (e) {
    logEvent("warn", "support.notify_failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// --- 1. The console asks -----------------------------------------------------------------------

/**
 * POST /api/support/requests: a signed request token. Idempotent: the same
 * token again answers the request it made (created false).
 */
export async function createSupportRequest(raw: string, opts: { ip?: string | null; now?: number } = {}): Promise<{ created: boolean; request: RequestView }> {
  const cfg = config();
  const now = opts.now ?? Date.now();
  const v = verifySupportToken("request", raw, cfg, now);
  if (!v.ok) throw new SupportError(v.message, 401, v.code);
  const c = v.claims;
  const settings = await supportSettings();
  if (!settings.requests) throw new SupportError("Support access requests are turned off in this workspace (Settings → Support access).", 403, "support_requests_off");

  const out = await withAdvisoryLock("support", async (client) => {
    const existing = await client.query("SELECT * FROM support_requests WHERE id = $1", [c.jti]);
    if (existing.rows[0]) return { created: false, row: requestRow(existing.rows[0]) };
    const counts = await client.query<{ pending: number; day: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending' AND expires_at > now())::int AS pending,
              count(*) FILTER (WHERE kind = 'request' AND requested_at > now() - interval '1 day')::int AS day
         FROM support_requests`
    );
    if ((counts.rows[0]?.pending ?? 0) >= MAX_PENDING) throw new SupportError(`This workspace already has ${MAX_PENDING} support requests waiting.`, 429, "too_many_pending");
    if ((counts.rows[0]?.day ?? 0) >= MAX_REQUESTS_PER_DAY) throw new SupportError(`At most ${MAX_REQUESTS_PER_DAY} support requests a day.`, 429, "too_many_requests");
    const r = await client.query(
      `INSERT INTO support_requests (id, kind, status, staff_name, staff_email, reason, level, duration_minutes, requested_at, expires_at)
       VALUES ($1, 'request', 'pending', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [c.jti, c.staff.name, c.staff.email, c.reason, c.level, c.duration_minutes, new Date(now), new Date(now + PENDING_TTL_MS)]
    );
    return { created: true, row: requestRow(r.rows[0]) };
  });
  if (out.created) {
    await audit({
      actor: staffActor(c.staff.name),
      action: "support.requested",
      targetType: "support_request",
      targetId: c.jti,
      targetLabel: c.staff.name,
      details: { staff_email: c.staff.email, level: c.level, duration_minutes: c.duration_minutes, reason: c.reason },
      ip: opts.ip ?? null,
    });
    await bell(`${c.staff.name} from CompassDocs support asks for access`, `${levelLabel(c.level)} for ${durationText(c.duration_minutes)}: ${c.reason}`);
  }
  return { created: out.created, request: requestView(out.row) };
}

/** GET /api/support/requests/<id>, with the request's own token as the credential. */
export async function supportRequestStatus(id: string, raw: string, now = Date.now()): Promise<RequestView> {
  const cfg = config();
  const v = verifySupportToken("request", raw, cfg, now);
  if (!v.ok) throw new SupportError(v.message, 401, v.code);
  if (v.claims.jti !== id) throw new SupportError("The token is not this request's.", 401, "wrong_request");
  const r = await pool().query("SELECT * FROM support_requests WHERE id = $1", [id]);
  if (!r.rows[0]) throw NOT_AVAILABLE();
  return requestView(requestRow(r.rows[0]));
}

export function durationText(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  if (minutes < 60) return `${minutes} minutes`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// --- 2. An administrator decides ---------------------------------------------------------------

export type Decision = "approve" | "deny" | "revoke" | "review";

/** Approve or deny a pending request, revoke approved access (ending its sessions), or mark an emergency reviewed. */
export async function decideSupportRequest(id: string, decision: Decision, actor: AuditActor & { id: number }, ip: string | null, now = Date.now()): Promise<SupportRequestRow> {
  config();
  const result = await withAdvisoryLock("support", async (client) => {
    const cur = await client.query("SELECT * FROM support_requests WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rows[0]) throw new SupportError("That support request doesn't exist.", 404, "not_found");
    const r = requestRow(cur.rows[0]);
    const at = new Date(now);
    const name = actor.name ?? "An administrator";
    if (decision === "approve" || decision === "deny") {
      if (r.status !== "pending" || new Date(r.expires_at).getTime() <= now) {
        throw new SupportError(r.status === "pending" ? "That request has lapsed: ask CompassDocs support to send a new one." : `That request is already ${r.status}.`, 409, "not_pending");
      }
      const row =
        decision === "approve"
          ? await client.query(
              `UPDATE support_requests SET status = 'approved', decided_at = $2, decided_by = $3, decided_by_name = $4, window_starts = $2, window_ends = $5
                WHERE id = $1 RETURNING *`,
              [id, at, actor.id, name, new Date(now + r.duration_minutes * 60_000)]
            )
          : await client.query(`UPDATE support_requests SET status = 'denied', decided_at = $2, decided_by = $3, decided_by_name = $4 WHERE id = $1 RETURNING *`, [id, at, actor.id, name]);
      return { row: requestRow(row.rows[0]), ended: [] as SupportSessionRow[] };
    }
    if (decision === "revoke") {
      if (r.status !== "approved") throw new SupportError(`That access is ${r.status}, not active.`, 409, "not_active");
      const row = await client.query(`UPDATE support_requests SET status = 'revoked', ended_at = $2, end_reason = 'revoked' WHERE id = $1 RETURNING *`, [id, at]);
      const ended = await endSessionsWhere(client, "request_id = $1", [id], "revoked", name, at);
      return { row: requestRow(row.rows[0]), ended };
    }
    // review: an emergency grant an administrator has looked at.
    if (r.kind !== "emergency") throw new SupportError("Only emergency access is marked reviewed.", 409, "not_emergency");
    if (r.reviewed_at) return { row: r, ended: [] };
    const row = await client.query(`UPDATE support_requests SET reviewed_at = $2, reviewed_by_name = $3 WHERE id = $1 RETURNING *`, [id, at, name]);
    return { row: requestRow(row.rows[0]), ended: [] };
  });
  const r = result.row;
  const action = { approve: "support.approved", deny: "support.denied", revoke: "support.revoked", review: "support.emergency_reviewed" }[decision];
  await audit({
    actor,
    action,
    targetType: "support_request",
    targetId: r.id,
    targetLabel: r.staff_name,
    details: { staff_email: r.staff_email, level: r.level, ...(decision === "approve" ? { window_ends: r.window_ends } : {}), reason: r.reason },
    ip,
  });
  for (const s of result.ended) await auditSessionEnd(s, r, "revoked");
  return r;
}

// --- 3. Staff sign in --------------------------------------------------------------------------

export interface SupportSignIn {
  token: string;
  expiresAt: Date;
  level: SupportLevel;
  sessionId: number;
}

const LEVEL_RANK: Record<SupportLevel, number> = { read_only: 0, admin: 1 };

/** Audit a refused sign-in (the reason, never the token) and throw. */
async function refuse(message: string, code: string, claims: Partial<GrantClaims> | null, ip: string | null, status = 403): Promise<never> {
  await audit({
    actor: claims?.staff ? staffActor(claims.staff.name) : { name: "CompassDocs support" },
    action: "support.sign_in_refused",
    targetType: "support_request",
    targetId: claims?.request ?? claims?.jti ?? null,
    targetLabel: claims?.staff?.name ?? null,
    details: { code, message, ...(claims?.staff ? { staff_email: claims.staff.email } : {}) },
    ip,
  });
  throw new SupportError(message, status, code);
}

/** POST /api/support/session: use a grant token once and open the support session. */
export async function startSupportSession(raw: string, opts: { ip?: string | null; userAgent?: string | null; now?: number } = {}): Promise<SupportSignIn> {
  const cfg = config();
  const now = opts.now ?? Date.now();
  const ip = opts.ip ?? null;
  const { legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) return refuse("Support access is unavailable while COMPASSDOCS_AUTHZ_LEGACY is set.", "unavailable", null, ip, 503);
  const v = verifySupportToken("grant", raw, cfg, now);
  if (!v.ok) return refuse(v.message, v.code, null, ip, 401);
  const c = v.claims;
  const settings = await supportSettings();

  // A refusal inside the transaction rolls it back: the token is not spent, so the same link works once the request is approved.
  class Refused extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  let refusal: { message: string; code: string } | null = null;
  const no = (message: string, code: string): never => {
    refusal = { message, code };
    throw new Refused(code);
  };
  const made = await withAdvisoryLock("support", async (client) => {
    // One-time use: the id is remembered until a day after the token expires.
    const used = await client.query("INSERT INTO support_token_uses (jti, kind, expires_at) VALUES ($1, 'grant', $2) ON CONFLICT (jti) DO NOTHING RETURNING jti", [
      c.jti,
      new Date((c.exp + 86_400) * 1000),
    ]);
    if (!used.rows[0]) no("This support sign-in link has already been used. Ask the console for a new one.", "replayed");
    let requestId: string;
    let ends = c.exp * 1000;
    let emergency = false;
    if (c.request) {
      const cur = await client.query("SELECT * FROM support_requests WHERE id = $1 FOR UPDATE", [c.request]);
      const r = cur.rows[0] ? requestRow(cur.rows[0]) : null;
      if (!r || r.kind !== "request") return no("There is no such support request in this workspace.", "unknown_request");
      if (r.status === "pending") no("This support request hasn't been approved yet.", "not_approved");
      if (r.status !== "approved") no(`This support request was ${r.status}.`, `request_${r.status}`);
      if (r.staff_email !== c.staff.email) no("This support request was approved for someone else.", "wrong_staff");
      if (LEVEL_RANK[c.level] > LEVEL_RANK[r.level]) no(`This support request was approved for ${levelLabel(r.level).toLowerCase()} access only.`, "level_too_high");
      if (!r.window_starts || !r.window_ends || now < new Date(r.window_starts).getTime() - CLOCK_SKEW_S * 1000 || now >= new Date(r.window_ends).getTime()) {
        no("The approved access window has ended.", "window_closed");
      }
      requestId = r.id;
      ends = Math.min(ends, new Date(r.window_ends!).getTime());
    } else {
      emergency = true;
      if (settings.emergency === "off") no("This workspace doesn't allow emergency support access.", "emergency_off");
      if (settings.emergency !== "off" && LEVEL_RANK[c.level] > LEVEL_RANK[settings.emergency]) no("This workspace allows read-only emergency access only.", "level_too_high");
      requestId = c.jti;
      const clash = await client.query("SELECT 1 FROM support_requests WHERE id = $1", [c.jti]);
      if (clash.rows[0]) no("This support sign-in link has already been used. Ask the console for a new one.", "replayed");
      await client.query(
        `INSERT INTO support_requests (id, kind, status, staff_name, staff_email, reason, level, duration_minutes, emergency_reason,
                                       requested_at, expires_at, decided_at, decided_by_name, window_starts, window_ends)
         VALUES ($1, 'emergency', 'approved', $2, $3, $4, $5, $6, $7, $8, $9, $8, 'Emergency access (workspace setting)', $8, $9)`,
        [c.jti, c.staff.name, c.staff.email, c.reason, c.level, Math.max(1, Math.round((c.exp - c.nbf) / 60)), c.emergency, new Date(now), new Date(c.exp * 1000)]
      );
    }
    if (ends - now < MIN_SESSION_MS) no("The support access ends in less than a minute.", "window_closed");
    const user = await client.query<{ id: number }>(
      `INSERT INTO users (username, email, name, role, status, auth_provider, external_id, password_hash, password_salt)
       VALUES ($1, '', $2, 'admin', 'service', $3, $4, NULL, NULL) RETURNING id`,
      [`compassdocs-support-${randomBytes(6).toString("hex")}`, `${c.staff.name} (CompassDocs support)`.slice(0, 200), SUPPORT_PROVIDER, c.staff.email]
    );
    const principal = user.rows[0].id;
    const sess = await client.query<{ id: number }>(
      `INSERT INTO support_sessions (request_id, principal_id, token_id, level, started_at, expires_at, ip, user_agent, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $5) RETURNING id`,
      [requestId, principal, c.jti, c.level, new Date(now), new Date(ends), ip, (opts.userAgent ?? "").slice(0, 300) || null]
    );
    const token = `${SUPPORT_TOKEN_PREFIX[c.level]}${randomBytes(32).toString("hex")}`;
    await createSupportBrowserSession(client, token, principal, new Date(ends), sess.rows[0].id, ip, opts.userAgent);
    return { token, expiresAt: new Date(ends), level: c.level, sessionId: sess.rows[0].id, principal, requestId, emergency };
  }).catch((e: unknown) => {
    if (e instanceof Refused) return null;
    throw e;
  });
  if (!made) {
    const r = refusal as { message: string; code: string } | null;
    return refuse(r?.message ?? "The support sign-in was refused.", r?.code ?? "refused", c, ip, r?.code === "replayed" ? 409 : 403);
  }

  const actor = { id: made.principal, name: `${c.staff.name} (CompassDocs support)`, role: "support" };
  await audit({
    actor,
    action: made.emergency ? "support.emergency_access" : "support.signed_in",
    targetType: "support_request",
    targetId: made.requestId,
    targetLabel: c.staff.name,
    details: {
      staff_email: c.staff.email,
      level: c.level,
      ends_at: made.expiresAt.toISOString(),
      reason: c.reason,
      ...(made.emergency ? { emergency_reason: c.emergency } : {}),
    },
    ip,
  });
  if (made.emergency) {
    await bell(`${c.staff.name} from CompassDocs support used emergency access`, `${levelLabel(c.level)} until ${made.expiresAt.toISOString().slice(11, 16)} UTC: ${c.emergency}`);
    logEvent("warn", "support.emergency_access", { message: `Emergency support access by ${c.staff.email}`, level: c.level, request: made.requestId });
  }
  return { token: made.token, expiresAt: made.expiresAt, level: made.level, sessionId: made.sessionId };
}

// --- The session while it runs -----------------------------------------------------------------

export interface LiveSupportSession {
  sessionId: number;
  requestId: string;
  level: SupportLevel;
  staffName: string;
  staffEmail: string;
  reason: string;
  emergency: boolean;
  expiresAt: string;
}

/**
 * The support session behind a browser session (lib/auth currentSession),
 * or null when it is no longer valid: ended, past its end, its request no
 * longer approved, or support access switched off. A browser session whose
 * support session is gone is deleted.
 */
export async function liveSupportSession(supportSessionId: number, principalId: number): Promise<LiveSupportSession | null> {
  if (!supportAccessConfig()) return null;
  const { legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) return null;
  const r = await pool().query(
    `SELECT ss.id, ss.request_id, ss.level, ss.expires_at, sr.kind, sr.staff_name, sr.staff_email, sr.reason
       FROM support_sessions ss JOIN support_requests sr ON sr.id = ss.request_id
      WHERE ss.id = $1 AND ss.principal_id = $2 AND ss.ended_at IS NULL AND ss.expires_at > now() AND sr.status = 'approved'`,
    [supportSessionId, principalId]
  );
  const row = r.rows[0];
  if (!row) {
    await pool().query("DELETE FROM sessions WHERE support_session_id = $1", [supportSessionId]).catch(() => {});
    return null;
  }
  return {
    sessionId: row.id,
    requestId: row.request_id,
    level: row.level,
    staffName: row.staff_name,
    staffEmail: row.staff_email,
    reason: row.reason,
    emergency: row.kind === "emergency",
    expiresAt: iso(row.expires_at)!,
  };
}

export { SUPPORT_ACTIVITY_HEADER } from "./support-policy";

const seen = new Map<string, number>();

/**
 * Record what the request the proxy tagged did (lib/auth currentSession
 * calls this for a support session): a page viewed (GET of a page) or a
 * change (any other method). Once per request (the nonce), however many
 * times the session is read while serving it. Best effort.
 */
export async function recordSupportActivity(s: LiveSupportSession, principalId: number, tag: string | null): Promise<void> {
  if (!tag) return;
  const m = /^([A-Za-z0-9-]{8,64}) ([A-Z]{3,7}) (\/\S{0,1000})$/.exec(tag);
  if (!m) return;
  const [, nonce, method, path] = m;
  const now = Date.now();
  if (seen.has(nonce)) return;
  seen.set(nonce, now);
  if (seen.size > 2000) for (const [k, t] of seen) if (now - t > 60_000 || seen.size > 1000) seen.delete(k);
  const page = method === "GET";
  try {
    await pool().query(
      `UPDATE support_sessions SET ${page ? "pages = pages + 1" : "actions = actions + 1"}, last_seen_at = now() WHERE id = $1`,
      [s.sessionId]
    );
  } catch {
    /* the audit row below still says it */
  }
  await audit({
    actor: { id: principalId, name: `${s.staffName} (CompassDocs support)`, role: "support" },
    action: page ? "support.page_viewed" : "support.action",
    targetType: "support_request",
    targetId: s.requestId,
    targetLabel: path.slice(0, 300),
    details: page ? { path, level: s.level } : { method, path, level: s.level },
  });
}

// --- The end -----------------------------------------------------------------------------------

export type EndReason = "signed_out" | "expired" | "revoked";

async function endSessionsWhere(client: Queryable, where: string, params: unknown[], reason: EndReason, byName: string | null, at: Date): Promise<SupportSessionRow[]> {
  const n = params.length;
  const r = await client.query(
    `UPDATE support_sessions SET ended_at = $${n + 1}, end_reason = $${n + 2}, ended_by_name = $${n + 3}
      WHERE ${where} AND ended_at IS NULL RETURNING *`,
    [...params, at, reason, byName]
  );
  const ids = r.rows.map((x) => x.id as number);
  if (ids.length) await client.query("DELETE FROM sessions WHERE support_session_id = ANY($1::int[])", [ids]);
  return r.rows.map(sessionRow);
}

async function auditSessionEnd(s: SupportSessionRow, r: Pick<SupportRequestRow, "id" | "staff_name" | "staff_email">, reason: EndReason): Promise<void> {
  const minutes = Math.max(0, Math.round((new Date(s.ended_at ?? Date.now()).getTime() - new Date(s.started_at).getTime()) / 60_000));
  await audit({
    actor: reason === "revoked" && s.ended_by_name ? { name: s.ended_by_name } : staffActor(r.staff_name),
    action: "support.session_ended",
    targetType: "support_request",
    targetId: r.id,
    targetLabel: r.staff_name,
    details: { reason, staff_email: r.staff_email, level: s.level, minutes, pages_viewed: s.pages, changes: s.actions },
  });
}

/** The staff member ends their own session (the banner's End session, or signing out). */
export async function endOwnSupportSession(supportSessionId: number): Promise<void> {
  const ended = await withAdvisoryLock("support", (client) => endSessionsWhere(client, "id = $1", [supportSessionId], "signed_out", null, new Date()));
  for (const s of ended) {
    const r = await pool().query("SELECT id, staff_name, staff_email FROM support_requests WHERE id = $1", [s.request_id]);
    if (r.rows[0]) await auditSessionEnd(s, r.rows[0], "signed_out");
  }
}

/**
 * The minute tick (cloud mode with support access on): requests nobody
 * decided lapse, sessions past their end end (and say so in the audit
 * log), approved windows that closed are marked ended, and used token ids
 * long past their expiry are forgotten. Idempotent across replicas.
 */
export async function sweepSupport(now = Date.now()): Promise<{ lapsed: number; ended: number }> {
  if (!supportAccessConfig()) return { lapsed: 0, ended: 0 };
  const at = new Date(now);
  const out = await withAdvisoryLock("support", async (client) => {
    const lapsed = await client.query(`UPDATE support_requests SET status = 'expired', ended_at = $1, end_reason = 'not_decided' WHERE status = 'pending' AND expires_at <= $1 RETURNING *`, [at]);
    const ended = await endSessionsWhere(client, "expires_at <= $1", [at], "expired", null, at);
    await client.query(`UPDATE support_requests SET status = 'ended', ended_at = window_ends, end_reason = 'window_closed' WHERE status = 'approved' AND window_ends <= $1`, [at]);
    await client.query("DELETE FROM support_token_uses WHERE expires_at < $1", [at]);
    return { lapsed: lapsed.rows.map(requestRow), ended };
  });
  for (const r of out.lapsed) {
    await audit({ actor: { name: "system" }, action: "support.request_expired", targetType: "support_request", targetId: r.id, targetLabel: r.staff_name, details: { staff_email: r.staff_email, level: r.level } });
  }
  for (const s of out.ended) {
    const r = await pool().query("SELECT id, staff_name, staff_email FROM support_requests WHERE id = $1", [s.request_id]);
    if (r.rows[0]) await auditSessionEnd(s, r.rows[0], "expired");
  }
  return { lapsed: out.lapsed.length, ended: out.ended.length };
}

// --- Settings → Support access -----------------------------------------------------------------

export interface SupportAccessItem extends SupportRequestRow {
  sessions: SupportSessionRow[];
}

export interface SupportAccessOverview {
  settings: SupportSettings;
  /** Waiting for a decision. */
  pending: SupportAccessItem[];
  /** Approved and still open (emergency included). */
  active: SupportAccessItem[];
  /** Emergency access nobody has reviewed yet. */
  unreviewed: SupportAccessItem[];
  /** Everything else, newest first (the last HISTORY_LIMIT). */
  history: SupportAccessItem[];
  workspaceId: string;
}

export const HISTORY_LIMIT = 50;

export async function supportAccessOverview(now = Date.now()): Promise<SupportAccessOverview> {
  const cfg = config();
  await sweepSupport(now).catch(() => {});
  const [settings, reqs] = await Promise.all([
    supportSettings(),
    pool().query(
      `SELECT * FROM support_requests
        WHERE status IN ('pending', 'approved') OR (kind = 'emergency' AND reviewed_at IS NULL)
           OR id IN (SELECT id FROM support_requests ORDER BY requested_at DESC LIMIT ${HISTORY_LIMIT})
        ORDER BY requested_at DESC`
    ),
  ]);
  const rows = reqs.rows.map(requestRow);
  const sess = rows.length
    ? (await pool().query("SELECT * FROM support_sessions WHERE request_id = ANY($1::text[]) ORDER BY started_at DESC", [rows.map((r) => r.id)])).rows.map(sessionRow)
    : [];
  const items: SupportAccessItem[] = rows.map((r) => ({ ...r, sessions: sess.filter((s) => s.request_id === r.id) }));
  return {
    settings,
    pending: items.filter((i) => i.status === "pending"),
    active: items.filter((i) => i.status === "approved"),
    unreviewed: items.filter((i) => i.kind === "emergency" && !i.reviewed_at),
    history: items.filter((i) => i.status !== "pending" && i.status !== "approved"),
    workspaceId: cfg.workspaceId,
  };
}

/** Emergency access nobody has reviewed (the settings notice); 0 when support access is off. */
export async function unreviewedEmergencies(): Promise<number> {
  if (!supportAccessConfig()) return 0;
  try {
    const r = await pool().query<{ n: number }>("SELECT count(*)::int AS n FROM support_requests WHERE kind = 'emergency' AND reviewed_at IS NULL");
    return r.rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}
