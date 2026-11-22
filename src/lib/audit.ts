// Append-only audit log of security- and content-significant actions. Writes
// are best-effort: recording an audit entry must never break the action it
// describes, so failures are swallowed (and logged to the server console).
//
// Server-only: uses the Postgres pool.

import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { pool, getAckDecision } from "./db";
import { logEvent } from "./log";
import { getMasterKey } from "./secretbox";
import type { AckOutcomeInfo, SessionUser } from "./types";

export interface AuditActor {
  id?: number | null;
  name?: string;
  role?: string | null;
}

export interface AuditEntry {
  actor?: AuditActor | null;
  action: string; // dot-namespaced, e.g. "document.publish", "user.role_change"
  targetType?: string | null;
  targetId?: string | number | null;
  targetLabel?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

export interface AuditRow {
  id: string;
  at: string;
  actor_id: number | null;
  actor_name: string;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

/** Build an actor descriptor from a signed-in session user. */
export function actorFrom(user: Pick<SessionUser, "id" | "name" | "username" | "role"> | null | undefined): AuditActor {
  if (!user) return { name: "system" };
  return { id: user.id, name: user.name || user.username, role: user.role };
}

/**
 * Client IP from proxy headers. X-Forwarded-For is a client-appendable list;
 * the LEFTMOST entry is attacker-controlled, so trusting it lets an attacker
 * rotate a spoofed IP to defeat the login throttle. We instead take the entry
 * added by our own trusted proxy: the Nth-from-the-right, where N is the number
 * of trusted proxies in front of the app (COMPASSDOCS_TRUSTED_PROXY_HOPS,
 * default 1 for the bundled Caddy). Set it higher when another proxy
 * (Cloudflare, a load balancer) sits in front of Caddy.
 *
 * 1.20.27 (security review H2): only a well-formed address is believed. A
 * value that is not an IP (a forged header carrying text, a formula meant
 * for a spreadsheet export) is no address at all: null, never stored. An
 * IPv4-mapped IPv6 address ("::ffff:203.0.113.9") reads as its IPv4 form,
 * so one client never counts as two in the sign-in throttle. Nothing in the
 * app can see the TCP peer behind these headers (Next fills the header from
 * the socket only when it is missing), so an install that publishes port
 * 3000 directly AND sits behind a proxy must keep 3000 off the network:
 * deploy/docker-compose.yml binds it to COMPASSDOCS_BIND for that.
 */
export function ipFrom(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) {
      const hops = Math.max(1, Math.floor(Number(process.env.COMPASSDOCS_TRUSTED_PROXY_HOPS)) || 1);
      // Rightmost is the proxy's own peer; step left by (hops-1) trusted hops.
      const idx = Math.max(0, parts.length - hops);
      return cleanIp(parts[idx]);
    }
  }
  return cleanIp(req.headers.get("x-real-ip"));
}

/** A literal IP address, normalised; null for anything else (1.20.27). */
export function cleanIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  // "[2001:db8::1]:443" and "203.0.113.9:443" carry a port some proxies add.
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) v = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.replace(/:\d+$/, "");
  if (v.length > 64 || !isIP(v)) return null;
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(v);
  return (mapped ? mapped[1] : v).toLowerCase();
}

// --- The stdout mirror (1.20.27, security review M3) --------------------------------
//
// Every audit row is also written to the structured logger (lib/log; one
// JSON line with COMPASSDOCS_LOG_FORMAT=json), so a log shipper hands it to
// a SIEM the moment it happens and a later change to the table (a restore,
// someone with database access) cannot take back what was already shipped.
// Written even when the database insert fails. Never carries a secret:
// details keys that name one are redacted, long strings are cut, and the
// value is bounded in depth and size. COMPASSDOCS_AUDIT_STDOUT=0 turns it off.

const SECRET_KEY = /(secret|password|passwd|passcode|token(?!_id|_name|s_revoked|_count)|api_?key|authorization|cookie|recovery|private_?key|signature)/i;

function redact(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  if (depth >= 4) return "[…]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
      out[k] = SECRET_KEY.test(k) && x !== null && typeof x !== "boolean" && typeof x !== "number" ? "[redacted]" : redact(x, depth + 1);
    }
    return out;
  }
  return String(v);
}

/** The fields the mirror writes for one entry (exported for tests). */
/**
 * Actions whose actor name and target label are what someone TYPED into
 * the sign-in form (1.20.27, second review, Low): a password typed into
 * the username field must not reach the log shipper. The stdout mirror
 * carries a fingerprint instead (the same text gives the same one, so
 * attempts still correlate); the audit log in the database keeps the text,
 * as before, for the administrators who read it.
 */
const TYPED_IDENTIFIER_ACTIONS = new Set(["auth.login_failed", "auth.lockout", "auth.lookup_throttled"]);

/** The fingerprint key: undefined until first needed, null once deriving it failed (not retried per sign-in). */
let fingerprintKey: Buffer | null | undefined;

function typedFingerprint(v: string | null): string | null {
  if (v == null || v === "system") return v;
  // Keyed (HMAC under a key derived from the master key), not a bare hash: a
  // plain SHA-256 of a password typed into the username field could be
  // guessed back from the log by anyone with a wordlist. Without a usable
  // master key the field carries no fingerprint at all; that outcome is
  // kept, so a burst of failed sign-ins doesn't re-read the key file each time.
  if (fingerprintKey === undefined) {
    try {
      fingerprintKey = createHmac("sha256", getMasterKey()).update("compassdocs-audit-typed-v1").digest();
    } catch {
      fingerprintKey = null;
    }
  }
  if (!fingerprintKey) return "typed:unavailable";
  return `typed:${createHmac("sha256", fingerprintKey).update(v.toLowerCase().trim()).digest("hex").slice(0, 12)}`;
}

export function auditLogFields(entry: AuditEntry): Record<string, unknown> {
  const typed = TYPED_IDENTIFIER_ACTIONS.has(entry.action) && entry.actor?.id == null;
  return {
    action: entry.action,
    actor_id: entry.actor?.id ?? null,
    actor_name: typed ? typedFingerprint(entry.actor?.name ?? "system") : redact(entry.actor?.name ?? "system"),
    actor_role: entry.actor?.role ?? null,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId != null ? String(entry.targetId) : null,
    target_label: typed ? typedFingerprint(entry.targetLabel ?? null) : redact(entry.targetLabel ?? null),
    details: entry.details ? redact(entry.details) : null,
    ip: entry.ip ?? null,
  };
}

function mirror(entry: AuditEntry): void {
  if (process.env.COMPASSDOCS_AUDIT_STDOUT === "0") return;
  try {
    logEvent("info", "audit", auditLogFields(entry));
  } catch {
    /* the mirror is never load-bearing */
  }
}

/** Record an audit entry. Never throws. */
export async function audit(entry: AuditEntry): Promise<void> {
  mirror(entry);
  try {
    await pool().query(
      `INSERT INTO audit_log
         (actor_id, actor_name, actor_role, action, target_type, target_id, target_label, details, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.actor?.id ?? null,
        entry.actor?.name ?? "system",
        entry.actor?.role ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId != null ? String(entry.targetId) : null,
        entry.targetLabel ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip ?? null,
      ]
    );
  } catch (e) {
    logEvent("error", "audit.write_failed", {
      action: entry.action,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// --- Read confirmation audit family (C1) -------------------------------------

/**
 * Every audit key the read-confirmation feature emits, as literals so a grep
 * for a key finds it here and at its call sites. New keys are namespaced
 * under "ack." (auditCategories groups them); the three document.* keys stay
 * for compatibility with logs written before 1.10.0. Each has a label in
 * lib/audit-labels (test/ack-ledger.test.ts checks).
 */
export const ACK_AUDIT_ACTIONS = [
  "document.acknowledge",
  "document.ack_required",
  "document.ack_removed",
  "ack.requested",
  "ack.reminder_sent",
  "ack.reconfirmation_requested",
  "ack.confirmations_kept",
  "ack.confirmations_reset",
  "ack.reset_notified",
  "ack.notice_failed",
  "ack.edit_default_set",
  "ack.settings_changed",
  "ack.export",
  "ack.retired",
  "ack.unretired",
  "ack.exempted",
  "ack.exemption_revoked",
  "ack.due_extended",
  "ack.due_extension_undone",
  "ack.bulk_extended",
  "ack.snoozed",
  "ack.unsnoozed",
  "ack.escalated",
  "ack.reminder_auto",
  "ack.recert",
  "ack.due_set",
  "ack.due_moved",
  "ack.defaults_set",
  "ack.snapshot",
  "ack.audit_export",
  "ack.retention_purge",
  "ack.anonymised",
] as const;
export type AckAuditAction = (typeof ACK_AUDIT_ACTIONS)[number];

/**
 * The details every ack-family entry carries: {doc_id, version_id, version,
 * content_sha256, source, reason}, plus whatever counts the action has
 * (`details`). Missing contract keys are written as null / "" so an export
 * always has the same columns.
 */
export interface AckAuditExtra {
  actor?: AuditActor | null;
  ip?: string | null;
  version_id?: number | null;
  /** The Version-history number ("v12" is 12). */
  version?: number | null;
  content_sha256?: string | null;
  source?: string | null;
  reason?: string | null;
  /** Counts and action-specific keys (acked, required, pending, user_agent, ...). */
  details?: Record<string, unknown>;
}

/** Record an ack-family audit entry against a document. Never throws (see audit). */
export async function auditAck(
  action: AckAuditAction,
  doc: { id: number; title: string },
  extra: AckAuditExtra = {}
): Promise<void> {
  await audit({
    actor: extra.actor,
    action,
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: {
      doc_id: doc.id,
      version_id: extra.version_id ?? null,
      version: extra.version ?? null,
      content_sha256: extra.content_sha256 ?? null,
      source: extra.source ?? null,
      reason: extra.reason ?? "",
      ...(extra.details ?? {}),
    },
    ip: extra.ip,
  });
}

/**
 * Echo the confirmation decision a save just took into the audit log (C1):
 * the ledger row is the record, the audit entry is its echo with the same
 * version, counts and reason. A decision is taken only when the text of a
 * confirmed, published document changed (updateDocument's `decides`), so
 * anything else, including a silent marker advance with the requirement off,
 * writes nothing. Every caller that takes a decision (PUT, merge, restore,
 * the v1 API, the MCP connector, change-request approval, the scheduler)
 * uses this one helper so the echo cannot drift between them.
 *
 * The row is read by the id the writer returned (`ack_outcome.decision_id`),
 * never as "the newest row for the document": a concurrent save of the same
 * document could otherwise have its decision echoed under this actor.
 */
export async function auditAckDecision(
  before: { ack_required: number },
  doc:
    | {
        id: number;
        title: string;
        content: string;
        status: string;
        ack_outcome?: AckOutcomeInfo & { decision_id?: number | null };
      }
    | undefined,
  extra: Pick<AckAuditExtra, "actor" | "ip"> = {}
): Promise<void> {
  const outcome = doc?.ack_outcome;
  if (!doc || !outcome?.substantive || before.ack_required !== 1 || doc.status !== "published") return;
  if (outcome.decision_id == null) return;
  const decision = await getAckDecision(outcome.decision_id);
  if (!decision) return;
  await auditAck(outcome.reset ? "ack.confirmations_reset" : "ack.confirmations_kept", doc, {
    actor: extra.actor,
    ip: extra.ip,
    version_id: decision.version_id,
    version: decision.rev,
    content_sha256: createHash("sha256").update(doc.content).digest("hex"),
    source: decision.source,
    reason: decision.reason,
    details: {
      confirmations_affected: decision.confirmations_affected,
      eligible: decision.eligible,
      suggested: decision.suggested,
      overrode_suggestion: decision.overrode_suggestion,
      change_pct: decision.change_pct,
    },
  });
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  actorId?: number;
  action?: string; // exact match, or a "prefix." wildcard like "user."
  category?: string; // the part before the first dot (e.g. "document")
  from?: string; // ISO timestamp — include entries at/after this instant
  to?: string; // ISO timestamp — include entries before this instant
}

/** Shared WHERE-clause builder for list + export so filters can't drift. */
function auditWhere(opts: AuditQuery): { clause: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.actorId != null) {
    params.push(opts.actorId);
    where.push(`actor_id = $${params.length}`);
  }
  if (opts.action) {
    params.push(opts.action);
    where.push(`action = $${params.length}`);
  }
  if (opts.category) {
    params.push(`${opts.category}.%`);
    where.push(`action LIKE $${params.length}`);
  }
  if (opts.from) {
    params.push(opts.from);
    where.push(`at >= $${params.length}::timestamptz`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`at < $${params.length}::timestamptz`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** List audit entries, newest first, with optional filters + total count. */
export async function listAuditLog(
  opts: AuditQuery = {}
): Promise<{ rows: AuditRow[]; total: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const { clause, params } = auditWhere(opts);

  const totalRes = await pool().query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n FROM audit_log ${clause}`,
    params
  );
  const total = Number(totalRes.rows[0]?.n ?? 0);

  params.push(limit, offset);
  const rowsRes = await pool().query<AuditRow>(
    `SELECT id::text, at, actor_id, actor_name, actor_role, action, target_type, target_id, target_label, details, ip
     FROM audit_log ${clause}
     ORDER BY at DESC, audit_log.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rowsRes.rows, total };
}

/**
 * Iterate matching audit entries newest-first in fixed-size batches (keyset
 * pagination on the identity PK, so memory stays bounded no matter how large
 * the log is). Powers the enterprise export streamer.
 */
export async function* iterAuditLog(
  opts: Omit<AuditQuery, "limit" | "offset"> = {},
  batchSize = 1000
): AsyncGenerator<AuditRow[]> {
  const { clause, params } = auditWhere(opts);
  let cursor: string | null = null;
  for (;;) {
    const batchParams = [...params];
    let cursorCond = "";
    if (cursor !== null) {
      batchParams.push(cursor);
      cursorCond = `${clause ? "AND" : "WHERE"} id < $${batchParams.length}`;
    }
    batchParams.push(batchSize);
    const res = await pool().query<AuditRow>(
      // NB: order by the table column, not the `id::text` output alias —
      // ORDER BY prefers the alias, which would sort lexicographically.
      `SELECT id::text, at, actor_id, actor_name, actor_role, action, target_type, target_id, target_label, details, ip
       FROM audit_log ${clause} ${cursorCond}
       ORDER BY audit_log.id DESC
       LIMIT $${batchParams.length}`,
      batchParams
    );
    if (res.rows.length === 0) return;
    yield res.rows;
    if (res.rows.length < batchSize) return;
    cursor = res.rows[res.rows.length - 1].id;
  }
}

/** Distinct action categories present in the log (for the filter dropdown). */
export async function auditCategories(): Promise<string[]> {
  const res = await pool().query<{ c: string }>(
    `SELECT DISTINCT split_part(action, '.', 1) AS c FROM audit_log ORDER BY c`
  );
  return res.rows.map((r) => r.c).filter(Boolean);
}
