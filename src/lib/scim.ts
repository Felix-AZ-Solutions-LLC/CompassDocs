import "server-only";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { getSetting, setSetting } from "./db";
import { featureEnabled, featureEnforced } from "./ee";
import type { User } from "./types";
import { NON_GALLERY_TEMPLATE_ID, type ScimEntraState, type ScimStatus, type SsoAppKind } from "./scim-setup-shared";

// SCIM 2.0 service-provider support (enterprise): Microsoft Entra ID (or any
// SCIM client) pushes user lifecycle changes — create, update, deactivate —
// to /api/scim/v2. Authentication is a single long-lived bearer token,
// generated in Settings → Single sign-on and stored only as a SHA-256 hash.
//
// Provisioned users are created with auth_provider "oidc" and the client's
// externalId, so the SSO login path links them by (provider, external_id)
// first and by email as a fallback. Deletes are soft: users are disabled,
// never removed, so document attribution and audit history stay intact.

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export function scimJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/scim+json; charset=utf-8" },
  });
}

export function scimError(status: number, detail: string, scimType?: string): Response {
  return scimJson(
    { schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) },
    status
  );
}

// --- Auth ---------------------------------------------------------------------

export function hashScimToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newScimToken(): string {
  return "cdscim_" + randomBytes(24).toString("hex");
}

/**
 * Make `raw` THE token (1.20.27; the Generate button and the setup with
 * Microsoft both come here): only its hash is kept, the previous token stops
 * working at once, and the endpoint is switched on. `replaced` says whether
 * there was a previous token.
 */
export async function storeScimToken(raw: string): Promise<{ replaced: boolean; at: string }> {
  const replaced = Boolean(await getSetting("scim_token_hash"));
  const at = new Date().toISOString();
  await setSetting("scim_token_hash", hashScimToken(raw));
  await setSetting("scim_token_at", at);
  await setSetting("scim_enabled", "1");
  return { replaced, at };
}

// --- Set up with Microsoft (1.20.27) --------------------------------------------

export const SCIM_ENTRA_KEY = "scim_entra";
/** Which app the one-click single sign-on setup made: { client_id, template_id }. */
export const SSO_APP_KEY = "sso_app_template";

export async function getScimEntraState(): Promise<ScimEntraState | null> {
  try {
    const v = JSON.parse((await getSetting(SCIM_ENTRA_KEY)) || "null");
    return v && typeof v === "object" && typeof v.sp_id === "string" ? (v as ScimEntraState) : null;
  } catch {
    return null;
  }
}

export async function saveScimEntraState(state: ScimEntraState): Promise<void> {
  await setSetting(SCIM_ENTRA_KEY, JSON.stringify(state));
}

/** The single sign-on setup records the template its app came from (empty: App registrations). */
export async function recordSsoApp(clientId: string, templateId: string): Promise<void> {
  await setSetting(SSO_APP_KEY, JSON.stringify({ client_id: clientId.toLowerCase(), template_id: templateId }));
}

/** Can the single sign-on app carry provisioning too? Known only for apps the one-click setup made. */
export async function ssoAppKind(): Promise<SsoAppKind> {
  const { getSsoConfig } = await import("./sso-config");
  const [cfg, raw] = await Promise.all([getSsoConfig(), getSetting(SSO_APP_KEY)]);
  if (!cfg.clientId) return "none";
  try {
    const rec = JSON.parse(raw || "null");
    if (rec?.client_id && rec.client_id === cfg.clientId.trim().toLowerCase()) {
      return rec.template_id === NON_GALLERY_TEMPLATE_ID ? "provisioning" : "sign_in_only";
    }
  } catch {
    /* unreadable: unknown */
  }
  return "unknown";
}

/** The SCIM card's state (the admin route and the Single sign-on page). */
export async function scimAdminStatus(baseUrl: string): Promise<ScimStatus> {
  const [licensed, enabled, tokenHash, lastRequest, tokenAt, entra, sso] = await Promise.all([
    featureEnabled("scim"),
    getSetting("scim_enabled"),
    getSetting("scim_token_hash"),
    getSetting("scim_last_request_at"),
    getSetting("scim_token_at"),
    getScimEntraState(),
    ssoAppKind(),
  ]);
  return {
    licensed,
    enabled: enabled === "1",
    token_set: Boolean(tokenHash),
    last_request_at: lastRequest || null,
    base_url: baseUrl,
    entra,
    // A token made here after the setup put its own in Entra (the Generate button): Entra's copy no longer works.
    entra_token_stale: Boolean(entra && tokenAt && entra.token_at && tokenAt > entra.token_at),
    sso_app: sso,
  };
}

/**
 * Gate a SCIM request: enterprise feature licensed, provisioning enabled, and
 * a valid bearer token. Returns null when authorized, else the error response.
 */
export async function scimGuard(req: Request): Promise<Response | null> {
  // 1.20.27 (security review M4): a licence that has lapsed still lets the
  // identity provider in, so leavers are still deactivated; what it may do
  // then is narrowed by scimLapsed (no new or changed accounts).
  if (!(await featureEnforced("scim"))) {
    return scimError(403, "SCIM provisioning is not included in this workspace's license.");
  }
  const storedHash = (await getSetting("scim_token_hash")) || "";
  if ((await getSetting("scim_enabled")) !== "1" || !storedHash) {
    return scimError(403, "SCIM provisioning is not enabled on this workspace.");
  }
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) {
    return new Response(
      JSON.stringify({
        schemas: [SCIM_ERROR_SCHEMA],
        status: "401",
        detail: "Bearer token required.",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/scim+json; charset=utf-8",
          "WWW-Authenticate": 'Bearer realm="CompassDocs SCIM"',
        },
      }
    );
  }
  const candidate = Buffer.from(hashScimToken(m[1]), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    return scimError(401, "Invalid bearer token.");
  }
  // Best-effort liveness marker for the admin UI ("Entra last called …").
  setSetting("scim_last_request_at", new Date().toISOString()).catch(() => {});
  return null;
}

/**
 * After scimGuard (1.20.27): true when the licence that granted SCIM has
 * lapsed. Then only deactivation is carried out (PATCH or PUT active=false,
 * DELETE): accounts are not created, changed or re-activated until it is
 * renewed.
 */
export async function scimLapsed(): Promise<boolean> {
  return !(await featureEnabled("scim"));
}

export const SCIM_LAPSED_DETAIL =
  "This workspace's license has lapsed: SCIM can still deactivate accounts, but cannot create, change or re-activate them until it is renewed.";

// --- Mapping ------------------------------------------------------------------

export function toScimUser(user: User, origin: string): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: String(user.id),
    ...(user.external_id ? { externalId: user.external_id } : {}),
    userName: user.username,
    active: user.status === "active",
    displayName: user.name || user.username,
    name: { formatted: user.name || user.username },
    ...(user.email
      ? { emails: [{ value: user.email, type: "work", primary: true }] }
      : {}),
    meta: {
      resourceType: "User",
      location: `${origin}/api/scim/v2/Users/${user.id}`,
    },
  };
}

export interface ScimUserInput {
  userName?: string;
  name?: string;
  email?: string;
  active?: boolean;
  externalId?: string;
}

function firstEmail(emails: unknown): string | undefined {
  if (!Array.isArray(emails)) return undefined;
  const objs = emails.filter((e) => e && typeof e === "object") as any[];
  const primary = objs.find((e) => e.primary) ?? objs.find((e) => e.type === "work") ?? objs[0];
  const v = primary?.value;
  return typeof v === "string" && v.includes("@") ? v : undefined;
}

/** Truthiness for SCIM `active`, tolerating Entra's string booleans. */
export function scimBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
  }
  return undefined;
}

function displayNameFrom(payload: any): string | undefined {
  if (typeof payload?.displayName === "string" && payload.displayName.trim()) {
    return payload.displayName.trim();
  }
  const n = payload?.name;
  if (n && typeof n === "object") {
    if (typeof n.formatted === "string" && n.formatted.trim()) return n.formatted.trim();
    const parts = [n.givenName, n.familyName].filter((p) => typeof p === "string" && p.trim());
    if (parts.length) return parts.join(" ");
  }
  return undefined;
}

/** Extract the fields we store from a full SCIM User payload (POST/PUT). */
export function parseScimUser(payload: any): ScimUserInput {
  return {
    userName:
      typeof payload?.userName === "string" && payload.userName.trim()
        ? payload.userName.trim()
        : undefined,
    name: displayNameFrom(payload),
    email: firstEmail(payload?.emails),
    active: scimBool(payload?.active),
    externalId:
      typeof payload?.externalId === "string" && payload.externalId.trim()
        ? payload.externalId.trim()
        : undefined,
  };
}

/**
 * Apply a SCIM PatchOp to produce a partial update. Handles the shapes Entra
 * actually sends: path-form ops (`"path": "active"`), sub-attribute paths
 * (`name.givenName`, `emails[type eq "work"].value`), and no-path ops whose
 * value is an object of attributes.
 */
export function applyScimPatch(operations: any[]): ScimUserInput & { nameParts?: { given?: string; family?: string } } {
  const out: ScimUserInput & { nameParts?: { given?: string; family?: string } } = {};
  for (const op of Array.isArray(operations) ? operations : []) {
    const kind = String(op?.op ?? "").toLowerCase();
    if (kind !== "replace" && kind !== "add") continue;
    const path = typeof op?.path === "string" ? op.path.trim() : "";
    const value = op?.value;

    if (!path) {
      const parsed = parseScimUser(value ?? {});
      if (parsed.userName !== undefined) out.userName = parsed.userName;
      if (parsed.name !== undefined) out.name = parsed.name;
      if (parsed.email !== undefined) out.email = parsed.email;
      if (parsed.active !== undefined) out.active = parsed.active;
      if (parsed.externalId !== undefined) out.externalId = parsed.externalId;
      continue;
    }

    const p = path.toLowerCase();
    if (p === "active") {
      const b = scimBool(value);
      if (b !== undefined) out.active = b;
    } else if (p === "username") {
      if (typeof value === "string" && value.trim()) out.userName = value.trim();
    } else if (p === "displayname" || p === "name.formatted") {
      if (typeof value === "string" && value.trim()) out.name = value.trim();
    } else if (p === "name.givenname") {
      out.nameParts = { ...out.nameParts, given: String(value ?? "").trim() };
    } else if (p === "name.familyname") {
      out.nameParts = { ...out.nameParts, family: String(value ?? "").trim() };
    } else if (p === "externalid") {
      if (typeof value === "string" && value.trim()) out.externalId = value.trim();
    } else if (p.startsWith("emails")) {
      const email =
        typeof value === "string" ? value : firstEmail(Array.isArray(value) ? value : [value]);
      if (email && email.includes("@")) out.email = email;
    }
    // Unknown paths are ignored (SCIM clients send attributes we don't store).
  }
  return out;
}

// --- Filters ------------------------------------------------------------------

/** Parse the tiny filter subset provisioning clients use: `attr eq "value"`. */
export function parseScimFilter(
  raw: string
): { attr: "userName" | "externalId" | "id"; value: string } | { error: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = /^(\w+)\s+eq\s+"([^"]*)"$/i.exec(trimmed);
  if (!m) return { error: `Unsupported filter: ${raw}` };
  const attr = m[1].toLowerCase();
  if (attr === "username") return { attr: "userName", value: m[2] };
  if (attr === "externalid") return { attr: "externalId", value: m[2] };
  if (attr === "id") return { attr: "id", value: m[2] };
  return { error: `Unsupported filter attribute: ${m[1]}` };
}
