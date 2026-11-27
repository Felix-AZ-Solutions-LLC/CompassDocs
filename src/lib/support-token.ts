// Support tokens (1.21.4, lib/support): what the CompassDocs console's
// signing service signs and a cloud workspace verifies.
//
// A token is the license's shape, `base64url(payload).base64url(signature)`:
// the payload is UTF-8 JSON, the signature is Ed25519 over the payload's
// bytes exactly as sent (the decoded first part), made with the signing
// service's key and checked here against COMPASSDOCS_SUPPORT_PUBLIC_KEY
// (lib/cloud supportAccessConfig), never the license key. Two kinds, told
// apart by `typ` inside the signed payload so one can never pass for the
// other:
//
//   compassdocs.support_request   the console asks for access (POST
//                                 /api/support/requests); a workspace admin
//                                 approves or denies it in the app.
//   compassdocs.support_grant     a staff member signs in (the
//                                 /support/sign-in page): either for an
//                                 approved request (`request`), or an
//                                 emergency grant (`emergency`, a reason)
//                                 where the workspace allows those.
//
// The claims are listed in README "Support access". Every check is here and
// pure (the clock and the keys are passed in): the signature, the kind, the
// version, this workspace, the times (not before `nbf`, not after `exp`,
// CLOCK_SKEW_S either way, and never longer than MAX_ACCESS_SECONDS), and
// the shape of every claim. One-time use of `jti` is lib/support's (the
// database remembers every id it has accepted until long after it expires).
//
// No "server-only" marker: the tests import it.

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { SupportAccessConfig } from "./cloud";

export const SUPPORT_TOKEN_VERSION = 1;
export const REQUEST_TYP = "compassdocs.support_request";
export const GRANT_TYP = "compassdocs.support_grant";
export type SupportTokenKind = "request" | "grant";

/** Clock difference tolerated between the signing service and the workspace, each way. */
export const CLOCK_SKEW_S = 60;
/** The longest access a token can name: `exp` − `nbf` (and a request's duration). */
export const MAX_ACCESS_SECONDS = 8 * 60 * 60;
/** The shortest access a request can ask for. */
export const MIN_DURATION_MINUTES = 15;
/** A request token is a message, not access: it is used within this long of being signed. */
export const MAX_REQUEST_TOKEN_SECONDS = 60 * 60;
/** The largest token read (the body of a request, the sign-in page's fragment). */
export const MAX_TOKEN_BYTES = 8 * 1024;

export type SupportLevel = "read_only" | "admin";
export const SUPPORT_LEVELS: readonly SupportLevel[] = ["read_only", "admin"];

export interface StaffMember {
  name: string;
  email: string;
}

interface CommonClaims {
  typ: string;
  v: number;
  /** The token's id: used once (lib/support), 16–64 of A–Z a–z 0–9 _ -. */
  jti: string;
  /** COMPASSDOCS_WORKSPACE_ID of the workspace the token is for. */
  workspace: string;
  staff: StaffMember;
  /** Why (shown to the workspace's administrators and kept in its audit log). */
  reason: string;
  level: SupportLevel;
  /** Unix seconds. */
  iat: number;
  nbf: number;
  exp: number;
}

export interface RequestClaims extends CommonClaims {
  typ: typeof REQUEST_TYP;
  /** How long the access lasts once approved, in minutes (MIN_DURATION_MINUTES … MAX_ACCESS_SECONDS / 60). */
  duration_minutes: number;
}

export interface GrantClaims extends CommonClaims {
  typ: typeof GRANT_TYP;
  /** The approved request this sign-in is for (its id, the request token's jti). */
  request?: string;
  /** An emergency grant: why it couldn't wait for approval. Exactly one of `request` and `emergency`. */
  emergency?: string;
}

export type SupportTokenError =
  | "malformed"
  | "bad_signature"
  | "wrong_kind"
  | "wrong_workspace"
  | "not_yet_valid"
  | "expired"
  | "too_long"
  | "invalid_claims";

export type Verified<T> = { ok: true; claims: T } | { ok: false; code: SupportTokenError; message: string };

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** C0 and C1 controls and the bidirectional overrides: never in a name, an email or a reason. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

function fail<T>(code: SupportTokenError, message: string): Verified<T> {
  return { ok: false, code, message };
}

function text(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < min || s.length > max || UNSAFE_TEXT.test(s)) return null;
  return s;
}

function seconds(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

const keyCache = new Map<string, KeyObject>();
function keyObject(der: Buffer): KeyObject {
  const id = der.toString("base64");
  let k = keyCache.get(id);
  if (!k) {
    k = createPublicKey({ key: der, format: "der", type: "spki" });
    keyCache.set(id, k);
  }
  return k;
}

/** The payload's bytes when the signature verifies with one of `keys`; null otherwise (or when the shape is wrong). */
function signedPayload(raw: string, keys: Buffer[]): { payload: Buffer } | { error: SupportTokenError } {
  const token = raw.trim();
  if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES || !TOKEN_SHAPE.test(token)) return { error: "malformed" };
  const [body, sig] = token.split(".");
  const payload = Buffer.from(body, "base64url");
  const signature = Buffer.from(sig, "base64url");
  // base64url that doesn't round-trip (stray bits) is a token someone edited.
  if (payload.toString("base64url") !== body || signature.toString("base64url") !== sig || signature.length !== 64) return { error: "malformed" };
  for (const der of keys) {
    try {
      if (verify(null, payload, keyObject(der), signature)) return { payload };
    } catch {
      /* a key that can't be used: the next */
    }
  }
  return { error: "bad_signature" };
}

/**
 * Verify a support token of `kind` for this workspace at `now` (ms). Pure:
 * the keys and the workspace come from `cfg` (lib/cloud supportAccessConfig).
 * The message is one sentence for the caller (the console, or the staff
 * member on the sign-in page); it never repeats the token.
 */
export function verifySupportToken(kind: "request", raw: string, cfg: SupportAccessConfig, now: number): Verified<RequestClaims>;
export function verifySupportToken(kind: "grant", raw: string, cfg: SupportAccessConfig, now: number): Verified<GrantClaims>;
export function verifySupportToken(kind: SupportTokenKind, raw: string, cfg: SupportAccessConfig, now: number): Verified<RequestClaims | GrantClaims> {
  if (typeof raw !== "string") return fail("malformed", "The support token is not a signed token.");
  const signed = signedPayload(raw, cfg.keys);
  if ("error" in signed) {
    return signed.error === "bad_signature"
      ? fail("bad_signature", "The support token's signature does not verify with this workspace's support key.")
      : fail("malformed", "The support token is not a signed token.");
  }
  let c: Record<string, unknown>;
  try {
    const parsed = JSON.parse(signed.payload.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    c = parsed as Record<string, unknown>;
  } catch {
    return fail("malformed", "The support token's payload is not a JSON object.");
  }

  const typ = kind === "request" ? REQUEST_TYP : GRANT_TYP;
  if (c.typ !== typ) return fail("wrong_kind", `This is not a ${kind === "request" ? "support request" : "support sign-in"} token.`);
  if (c.v !== SUPPORT_TOKEN_VERSION) return fail("invalid_claims", `The support token's version is not ${SUPPORT_TOKEN_VERSION}.`);
  if (c.workspace !== cfg.workspaceId) return fail("wrong_workspace", "The support token is for another workspace.");

  const jti = typeof c.jti === "string" && ID_RE.test(c.jti) ? c.jti : null;
  const iat = seconds(c.iat);
  const nbf = seconds(c.nbf);
  const exp = seconds(c.exp);
  if (!jti) return fail("invalid_claims", "The support token's id (jti) is missing or malformed.");
  if (iat === null || nbf === null || exp === null) return fail("invalid_claims", "The support token's times (iat, nbf, exp) are missing.");

  const t = Math.floor(now / 1000);
  if (exp <= nbf) return fail("invalid_claims", "The support token ends before it starts.");
  if (exp - nbf > MAX_ACCESS_SECONDS) return fail("too_long", `The support token lasts longer than ${MAX_ACCESS_SECONDS / 3600} hours.`);
  if (iat > t + CLOCK_SKEW_S) return fail("not_yet_valid", "The support token was signed in the future: check the signing service's clock.");
  if (t + CLOCK_SKEW_S < nbf) return fail("not_yet_valid", "The support token is not valid yet.");
  if (t - CLOCK_SKEW_S >= exp) return fail("expired", "The support token has expired.");
  if (kind === "request" && exp - iat > MAX_REQUEST_TOKEN_SECONDS) {
    return fail("too_long", `A support request token is valid for at most ${MAX_REQUEST_TOKEN_SECONDS / 60} minutes.`);
  }

  const s = c.staff as Record<string, unknown> | null;
  const name = s && typeof s === "object" ? text(s.name, 1, 120) : null;
  const email = s && typeof s === "object" ? text(s.email, 3, 254) : null;
  if (!name || !email || !EMAIL_RE.test(email)) return fail("invalid_claims", "The support token must name the staff member (staff.name, staff.email).");
  const reason = text(c.reason, 1, 500);
  if (!reason) return fail("invalid_claims", "The support token must give a reason (up to 500 characters).");
  const level = c.level === undefined ? "read_only" : c.level;
  if (level !== "read_only" && level !== "admin") return fail("invalid_claims", 'The support token\'s level must be "read_only" or "admin".');
  const common = { typ, v: SUPPORT_TOKEN_VERSION, jti, workspace: cfg.workspaceId, staff: { name, email: email.toLowerCase() }, reason, level: level as SupportLevel, iat, nbf, exp };

  if (kind === "request") {
    const d = c.duration_minutes;
    if (typeof d !== "number" || !Number.isSafeInteger(d) || d < MIN_DURATION_MINUTES || d > MAX_ACCESS_SECONDS / 60) {
      return fail("invalid_claims", `The support request's duration_minutes must be a whole number from ${MIN_DURATION_MINUTES} to ${MAX_ACCESS_SECONDS / 60}.`);
    }
    return { ok: true, claims: { ...common, typ: REQUEST_TYP, duration_minutes: d } };
  }

  const request = c.request === undefined ? undefined : typeof c.request === "string" && ID_RE.test(c.request) ? c.request : null;
  const emergency = c.emergency === undefined ? undefined : text(c.emergency, 1, 500);
  if (request === null) return fail("invalid_claims", "The support token's request id is malformed.");
  if (emergency === null) return fail("invalid_claims", "The emergency reason must be 1 to 500 characters.");
  if ((request === undefined) === (emergency === undefined)) {
    return fail("invalid_claims", "A support sign-in token names either an approved request or an emergency reason, not both.");
  }
  return { ok: true, claims: { ...common, typ: GRANT_TYP, ...(request ? { request } : { emergency: emergency! }) } };
}

/** "Read-only" / "Administrator": a level as people read it. */
export function levelLabel(level: SupportLevel): string {
  return level === "admin" ? "Administrator" : "Read-only";
}
