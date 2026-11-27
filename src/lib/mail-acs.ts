// 1.21.5: the workspace's email through Azure Communication Services Email,
// the client: two REST calls, made directly (no @azure/communication-email).
//
//   send     POST {endpoint}/emails:send?api-version=2023-03-31
//            with an Operation-Id of our own (a UUID), so a send whose answer
//            never came can still be looked up. 202 Accepted: ACS has the
//            message and will try to deliver it; nothing is known yet.
//   result   GET {endpoint}/emails/operations/{id}?api-version=2023-03-31
//            NotStarted | Running, then Succeeded | Failed | Canceled (with
//            ACS's error). Always built from our endpoint and the id, never
//            from the Operation-Location header, so no address from a
//            response is ever fetched.
//
// Sign-in: the managed identity's Entra token for
// https://communication.azure.com/.default (lib/azure-credential CachedToken:
// cached, renewed ahead of expiry, never logged), or, for development, the
// connection string's access key (HMAC-SHA256 over the method, path, date,
// host and body hash, as ACS's REST authentication describes). Neither the
// token nor the key is ever logged or put in an error: a refusal is one
// MailSendError sentence.
//
// What a refusal means for the outbox is read by lib/mail-outbox-shared
// classifySendError from the error's status, code and kind: 429 (and 503)
// slow down with Retry-After; 401/403 (the identity may not send), 404 (no
// such resource) and a sender ACS refuses (the domain is not linked or the
// MailFrom address does not exist) repeat for every message and pause the
// outbox; 400 is this message's; 500/502 are tried again; no answer after
// the request left is "uncertain" and settled by looking the operation up.
//
// No "server-only" marker, like lib/azure-credential: the tests import it.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { CachedToken, EntraTokenError } from "./azure-credential";
import { ACS_API_VERSION, MAIL_ACS_MAX_BYTES, acsConfig, type AcsConfig } from "./mail-acs-config";
import { acsRequestBytes, acsRequestFromMime, MimeReadError, type AcsEmailRequest } from "./mail-acs-mime";
import { MailSendError, MailTooLargeError } from "./mail-send-error";

export { MailSendError };

export type AcsOperationStatus = "NotStarted" | "Running" | "Succeeded" | "Failed" | "Canceled";

export interface AcsOperation {
  id: string;
  status: AcsOperationStatus;
  /** ACS's reason for Failed or Canceled ('' otherwise). */
  error: string;
  /** How long ACS asked us to wait before asking again. */
  retryAfterMs: number | null;
}

const SEND_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
const SERVICE = "Azure Communication Services";

// --- Sign-in -------------------------------------------------------------------------------------

const G = globalThis as unknown as { __compassAcsTokens?: Map<string, CachedToken> };

function tokenFor(scope: string): CachedToken {
  G.__compassAcsTokens ??= new Map();
  let t = G.__compassAcsTokens.get(scope);
  if (!t) {
    t = new CachedToken(scope);
    G.__compassAcsTokens.set(scope, t);
  }
  return t;
}

/** Tests: forget the cached token (the next call asks the credential again). */
export function resetAcsForTests(): void {
  G.__compassAcsTokens = undefined;
}

/**
 * The Authorization (and, with a key, the signed date and hash) headers for
 * one request. Throws MailSendError (kind "auth" when the identity is refused,
 * status 0 and kind "signin" when the token service did not answer).
 */
export async function acsAuthHeaders(c: AcsConfig, method: string, url: URL, body: string): Promise<Record<string, string>> {
  if (c.auth.kind === "entra") {
    try {
      return { authorization: `Bearer ${await tokenFor(c.auth.scope).get()}` };
    } catch (e) {
      if (e instanceof EntraTokenError) {
        throw new MailSendError(
          `${e.message.replace(/\.$/, "")}. ${e.transient ? "Nothing was sent; it is tried again shortly." : "Check the app's managed identity and its role on the Communication Services resource."}`,
          0,
          e.code,
          e.transient ? "signin" : "auth"
        );
      }
      throw e;
    }
  }
  const date = new Date().toUTCString();
  const hash = createHash("sha256").update(body, "utf8").digest("base64");
  const pathAndQuery = `${url.pathname}${url.search}`;
  const toSign = `${method.toUpperCase()}\n${pathAndQuery}\n${date};${url.host};${hash}`;
  const signature = createHmac("sha256", Buffer.from(c.auth.accessKey, "base64")).update(toSign, "utf8").digest("base64");
  return {
    "x-ms-date": date,
    "x-ms-content-sha256": hash,
    authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
  };
}

/**
 * Sign in before a send (the outbox), so a token service that does not
 * answer is known to have sent nothing. A key needs no sign-in. Throws
 * MailSendError.
 */
export async function acsSignIn(c: AcsConfig): Promise<void> {
  if (c.auth.kind === "entra") await acsAuthHeaders(c, "POST", new URL(`${c.endpoint}/`), "");
}

// --- Answers -------------------------------------------------------------------------------------

/** Retry-After as milliseconds: retry-after-ms, x-ms-retry-after-ms, then retry-after (seconds or a date). */
export function retryAfterMs(h: Headers, now = Date.now()): number | null {
  for (const name of ["retry-after-ms", "x-ms-retry-after-ms"]) {
    const v = Number(h.get(name));
    if (h.get(name) && Number.isFinite(v) && v >= 0) return Math.round(v);
  }
  const raw = h.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** A sender ACS refuses: every message would be refused alike. */
const SENDER_PROBLEM = /sender|mailfrom|domain|not linked/i;

const clean = (s: string) => s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);

/** An ACS answer that is not what was asked for, as one MailSendError. */
async function refusal(res: Response, what: string): Promise<MailSendError> {
  let code = res.headers.get("x-ms-error-code") ?? "";
  let message = "";
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    code = j?.error?.code || code;
    message = j?.error?.message || "";
  } catch {
    /* no JSON body */
  }
  const why = clean(message || code || res.statusText || "no reason given");
  const ra = retryAfterMs(res.headers);
  const s = res.status;
  if (s === 429) return new MailSendError(`${SERVICE} asked to slow down (429): the sending limit was reached. The email waits and goes out later.`, 429, code, "rate", ra);
  if (s === 401 || s === 403) {
    return new MailSendError(
      `${SERVICE} refused to ${what} (${s}): ${why}. The app's identity needs the Communication and Email Service Owner role (or a custom role with the email send permissions) on the Communication Services resource.`,
      s,
      code,
      "auth"
    );
  }
  if (s === 404) return new MailSendError(`${SERVICE} answered 404 to ${what}: ${why}. Check COMPASSDOCS_ACS_ENDPOINT names the Communication Services resource.`, 404, code, "config");
  if (s === 413) return new MailSendError(`This email is too large for ${SERVICE} (413): at most 10 MB with its attachments base64-encoded.`, 413, code || "too_large", "too_large");
  if (s === 400 && SENDER_PROBLEM.test(`${code} ${message}`)) {
    return new MailSendError(`${SERVICE} refused the sender (${why}). Check COMPASSDOCS_ACS_SENDER is a MailFrom address of a verified domain linked to the resource.`, 400, code || "sender", "config");
  }
  if (s >= 500) return new MailSendError(`${SERVICE} had a problem (${s}): ${why}.`, s, code, "", ra);
  return new MailSendError(`${SERVICE} refused this email (${s}): ${why}.`, s, code);
}

async function call(c: AcsConfig, method: "GET" | "POST", path: string, body: string, extra: Record<string, string>, timeoutMs: number, what: string): Promise<Response> {
  const url = new URL(`${path}${path.includes("?") ? "&" : "?"}api-version=${ACS_API_VERSION}`, `${c.endpoint}/`);
  const headers: Record<string, string> = {
    ...(await acsAuthHeaders(c, method, url, body)),
    "x-ms-client-request-id": randomUUID(),
    accept: "application/json",
    ...extra,
  };
  if (method === "POST") headers["content-type"] = "application/json";
  try {
    return await fetch(url, { method, headers, body: method === "POST" ? body : undefined, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    const cause = e instanceof Error ? clean(String((e as { cause?: { code?: string } }).cause?.code ?? e.message)) : "network error";
    throw new MailSendError(`${SERVICE} didn't answer when asked to ${what} (${timeout ? "timed out" : cause}).`, 0, "", timeout ? "timeout" : "network");
  }
}

// --- Send and look up ----------------------------------------------------------------------------

/** Operation ids are UUIDs (ours) or what ACS made; nothing else is put in a path. */
const OP_ID = /^[A-Za-z0-9-]{8,80}$/;

/**
 * One POST of one request, no second try (the outbox paces and retries).
 * Answers the operation as ACS accepted it. Throws MailSendError.
 */
export async function postAcsEmail(req: AcsEmailRequest, c: AcsConfig, operationId: string = randomUUID()): Promise<AcsOperation> {
  if (!OP_ID.test(operationId)) throw new MailSendError("That operation id can't be used.", 400, "bad_operation");
  const body = JSON.stringify(req);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAIL_ACS_MAX_BYTES) throw acsTooLarge(bytes);
  const res = await call(c, "POST", "/emails:send", body, { "operation-id": operationId }, SEND_TIMEOUT_MS, "send this email");
  if (res.status !== 202 && res.status !== 200) throw await refusal(res, "send this email");
  const j = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: { message?: string } };
  return { id: typeof j.id === "string" && OP_ID.test(j.id) ? j.id : operationId, status: asStatus(j.status) ?? "Running", error: clean(j.error?.message ?? ""), retryAfterMs: retryAfterMs(res.headers) };
}

function asStatus(v: unknown): AcsOperationStatus | null {
  const s = String(v ?? "").toLowerCase();
  if (s === "notstarted") return "NotStarted";
  if (s === "running") return "Running";
  if (s === "succeeded") return "Succeeded";
  if (s === "failed") return "Failed";
  if (s === "canceled" || s === "cancelled") return "Canceled";
  return null;
}

/** Where a send stands. Throws MailSendError (404, code "not_found": ACS knows no such operation). */
export async function getAcsOperation(id: string, c: AcsConfig): Promise<AcsOperation> {
  if (!OP_ID.test(id)) throw new MailSendError("That operation id can't be looked up.", 400, "bad_operation");
  const res = await call(c, "GET", `/emails/operations/${encodeURIComponent(id)}`, "", {}, STATUS_TIMEOUT_MS, "say how an email went");
  if (res.status === 404) {
    const e = await refusal(res, "say how an email went");
    return Promise.reject(Object.assign(e, { code: "not_found" }));
  }
  if (!res.ok) throw await refusal(res, "say how an email went");
  const j = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: { code?: string; message?: string } };
  const status = asStatus(j.status);
  if (!status) throw new MailSendError(`${SERVICE} answered with an operation status this version doesn't know (${clean(String(j.status ?? ""))}).`, 502, "bad_status");
  return { id, status, error: clean(j.error?.message || j.error?.code || ""), retryAfterMs: retryAfterMs(res.headers) };
}

/** The sentence for a message over ACS's request limit. */
export function acsTooLarge(bytes: number): MailTooLargeError {
  return new MailTooLargeError(bytes, acsTooLargeSentence(bytes));
}

export function acsTooLargeSentence(bytes: number): string {
  const mb = (n: number) => (n / 1_000_000).toFixed(1);
  return `This email is ${mb(bytes)} MB with its attachments (base64-encoded). ${SERVICE} takes at most ${mb(MAIL_ACS_MAX_BYTES)} MB per email, about 7.5 MB of files. Attach smaller files or share a link to them.`;
}

/** What a finished operation means, as one sentence ('' for Succeeded). */
export function operationSentence(op: AcsOperation): string {
  if (op.status === "Failed") return `${SERVICE} could not deliver this email${op.error ? `: ${op.error}` : "."}`.replace(/([^.])$/, "$1.");
  if (op.status === "Canceled") return `${SERVICE} canceled this email${op.error ? `: ${op.error}` : "."}`.replace(/([^.])$/, "$1.");
  return "";
}

/** A built message as the request, its size checked. Throws MailSendError (too large, or a message that can't be read). */
export function acsRequestFor(mime: Buffer, c: AcsConfig, opts: { rcpt?: string[]; replyTo?: string } = {}): AcsEmailRequest {
  let req: AcsEmailRequest;
  try {
    req = acsRequestFromMime(mime, { sender: c.sender, rcpt: opts.rcpt, replyTo: opts.replyTo || c.replyTo });
  } catch (e) {
    if (e instanceof MimeReadError) throw new MailSendError(`This email can't be sent through ${SERVICE}: ${e.message}`, 400, "unreadable");
    throw e;
  }
  const bytes = acsRequestBytes(req);
  if (bytes > MAIL_ACS_MAX_BYTES) throw acsTooLarge(bytes);
  return req;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let wait = sleep;
/** Tests: how waits inside a direct send pass (null restores real time). */
export function setAcsWaitForTests(fn: ((ms: number) => Promise<unknown>) | null): void {
  wait = (fn as typeof sleep) ?? sleep;
}

/**
 * A send now, outside the outbox (the test email, a newsletter recipient,
 * the desk's test mails). A 429 with Retry-After up to a minute is waited
 * out twice at most (unless `wait429` is false). With `waitResult` (the test
 * emails, whose sender is watching) the result is looked up for up to
 * 30 seconds and a Failed or Canceled one throws; without it, accepted is
 * the answer. Throws MailSendError.
 */
export async function sendAcsNow(
  mime: Buffer,
  opts: { rcpt?: string[]; replyTo?: string; wait429?: boolean; waitResult?: boolean; config?: AcsConfig } = {}
): Promise<AcsOperation> {
  const c = opts.config ?? acsConfig();
  if (!c) throw new MailSendError(`${SERVICE} isn't set up: set COMPASSDOCS_ACS_ENDPOINT and COMPASSDOCS_ACS_SENDER.`, 0, "not_set_up");
  const req = acsRequestFor(mime, c, opts);
  let op: AcsOperation | null = null;
  for (let attempt = 0; !op; attempt++) {
    try {
      op = await postAcsEmail(req, c);
    } catch (e) {
      const ms = e instanceof MailSendError ? (e.retryAfterMs ?? 2_000) : 0;
      if (e instanceof MailSendError && e.status === 429 && opts.wait429 !== false && attempt < 2 && ms <= 60_000) {
        await wait(ms);
        continue;
      }
      throw e;
    }
  }
  if (!opts.waitResult) return op;
  const deadline = Date.now() + 30_000;
  let next = Math.min(10_000, Math.max(1_000, op.retryAfterMs ?? 2_000));
  while (op.status === "NotStarted" || op.status === "Running") {
    if (Date.now() + next > deadline) return op;
    await wait(next);
    try {
      op = await getAcsOperation(op.id, c);
    } catch (e) {
      if (e instanceof MailSendError && e.status === 429) {
        next = Math.max(next, e.retryAfterMs ?? 5_000);
        continue;
      }
      throw e;
    }
    next = Math.min(10_000, Math.max(2_000, op.retryAfterMs ?? next * 2));
  }
  const why = operationSentence(op);
  if (why) throw new MailSendError(why, 422, `operation_${op.status.toLowerCase()}`);
  return op;
}

/**
 * Whether the configuration signs in and reaches the resource, sending
 * nothing: one status lookup of an operation that does not exist. 404 is the
 * good answer (ACS checked the credential, then found nothing); 401/403
 * mean the identity may not use the resource. One sentence either way.
 */
export async function probeAcs(c: AcsConfig | null = acsConfig()): Promise<{ ok: boolean; message: string }> {
  if (!c) return { ok: false, message: `${SERVICE} isn't set up.` };
  try {
    await getAcsOperation(randomUUID(), c);
    return { ok: true, message: `Signed in to ${new URL(c.endpoint).host}. Nothing was sent.` };
  } catch (e) {
    if (e instanceof MailSendError && e.code === "not_found") return { ok: true, message: `Signed in to ${new URL(c.endpoint).host} as the app's ${c.auth.kind === "entra" ? "managed identity" : "access key"}. Nothing was sent.` };
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
