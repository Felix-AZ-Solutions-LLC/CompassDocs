// The app's Microsoft Entra identity (1.21.3; the credential itself since 1.21.2).
//
// Who the app is when it signs in to an Azure service with no key or
// password: workload identity when AZURE_FEDERATED_TOKEN_FILE, AZURE_TENANT_ID
// and AZURE_CLIENT_ID are set, else the container's managed identity (the
// user-assigned one named by AZURE_CLIENT_ID, or the system-assigned one).
// Never a key, never a client secret, never the developer credentials
// DefaultAzureCredential would also try. One credential per process, shared
// by everything that signs in:
//
//   - lib/file-store: Azure Blob Storage (1.21.2);
//   - lib/db-auth: PostgreSQL with DATABASE_AUTH=entra (1.21.3);
//   - lib/license-pull: the CompassDocs console's licence endpoint, with
//     COMPASSDOCS_LICENSE_AUDIENCE (1.21.3).
//
// CachedToken keeps one access token per scope and renews it well before it
// expires: callers always get a token with time left on it, the token
// service is asked at most once at a time per scope, and a token service
// that is briefly unreachable while the cached token is still good costs
// nothing (the renewal is tried again a little later). Only when there is no
// usable token left does a caller wait for, or fail with, the token service.
//
// A token is never logged, never put in an error message and never kept
// anywhere but this process's memory. A failure is one EntraTokenError: one
// line naming the identity and the scope, and whether it is transient (the
// token service did not answer: waiting may fix it) or not (the identity is
// missing, unknown, or may not have the token: waiting will not).
//
// @azure/identity is imported only when a token is first wanted, so a
// self-hosted install never loads it. No "server-only" marker: the tests
// import this module.

export type Env = Record<string, string | undefined>;

/** The shape of @azure/identity's TokenCredential that this module uses. */
export interface TokenSource {
  getToken(
    scopes: string | string[],
    options?: { abortSignal?: AbortSignal }
  ): Promise<{ token: string; expiresOnTimestamp: number; refreshAfterTimestamp?: number } | null>;
}

/** Which identity signs in, for a person (log lines, Diagnostics). Never a secret. */
export function describeIdentity(env: Env = process.env): string {
  const clientId = env.AZURE_CLIENT_ID?.trim();
  if (env.AZURE_FEDERATED_TOKEN_FILE?.trim() && env.AZURE_TENANT_ID?.trim() && clientId) return `workload identity ${clientId}`;
  return clientId ? `user-assigned managed identity ${clientId}` : "system-assigned managed identity";
}

/**
 * The credential the app signs in to Azure with: workload identity
 * (AZURE_FEDERATED_TOKEN_FILE, AZURE_TENANT_ID, AZURE_CLIENT_ID), then the
 * managed identity (user-assigned by AZURE_CLIENT_ID, or system-assigned).
 */
export async function azureCredential(env: Env = process.env): Promise<TokenSource> {
  const id = await import("@azure/identity");
  const clientId = env.AZURE_CLIENT_ID?.trim() || undefined;
  const chain: import("@azure/identity").TokenCredential[] = [];
  const tokenFile = env.AZURE_FEDERATED_TOKEN_FILE?.trim();
  const tenantId = env.AZURE_TENANT_ID?.trim();
  if (tokenFile && tenantId && clientId) chain.push(new id.WorkloadIdentityCredential({ clientId, tenantId, tokenFilePath: tokenFile }));
  chain.push(clientId ? new id.ManagedIdentityCredential({ clientId }) : new id.ManagedIdentityCredential());
  return chain.length === 1 ? chain[0] : new id.ChainedTokenCredential(...chain);
}

const G = globalThis as unknown as {
  __compassAzureCredential?: Promise<TokenSource>;
  __compassAzureCredentialForTests?: TokenSource | null;
};

/** The process's one credential (made on first use). */
export function sharedAzureCredential(env: Env = process.env): Promise<TokenSource> {
  if (G.__compassAzureCredentialForTests) return Promise.resolve(G.__compassAzureCredentialForTests);
  if (!G.__compassAzureCredential) {
    const made = azureCredential(env);
    G.__compassAzureCredential = made;
    made.catch(() => {
      if (G.__compassAzureCredential === made) G.__compassAzureCredential = undefined;
    });
  }
  return G.__compassAzureCredential;
}

/** Tests: stand in for the managed identity (null puts the real one back). */
export function setAzureCredentialForTests(source: TokenSource | null): void {
  G.__compassAzureCredentialForTests = source;
  G.__compassAzureCredential = undefined;
}

// --- Errors ------------------------------------------------------------------------------

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
const TRANSIENT_TEXT = /Network unreachable|network_error|timed? ?out|socket hang up|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|temporarily unavailable/i;

/**
 * Did the token service not answer (transient: waiting may fix it), rather
 * than refuse? A network error anywhere in the cause chain, a timeout, an
 * HTTP 429 or 5xx. An identity that does not exist, is not assigned to this
 * app or may not have the token is not transient.
 */
export function isTransientTokenFailure(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 4) return false;
  const x = e as { code?: unknown; errorCode?: unknown; statusCode?: unknown; status?: unknown; message?: unknown; cause?: unknown; name?: unknown };
  if (x.name === "AbortError" || x.name === "TimeoutError") return true;
  if (typeof x.code === "string" && NETWORK_CODES.has(x.code)) return true;
  if (x.errorCode === "network_error") return true;
  for (const s of [x.statusCode, x.status]) if (typeof s === "number" && (s === 429 || (s >= 500 && s < 600))) return true;
  if (typeof x.message === "string" && TRANSIENT_TEXT.test(x.message)) return true;
  return isTransientTokenFailure(x.cause, depth + 1);
}

/** A token could not be had: one line naming the identity and the scope, never a token. */
export class EntraTokenError extends Error {
  /** ENTRA_TOKEN_UNAVAILABLE (transient) or ENTRA_TOKEN_REFUSED. lib/db-errors counts only the first as a connection error. */
  readonly code: "ENTRA_TOKEN_UNAVAILABLE" | "ENTRA_TOKEN_REFUSED";
  constructor(
    readonly identity: string,
    readonly scope: string,
    readonly transient: boolean,
    reason: string,
    cause?: unknown
  ) {
    super(
      `Could not get a Microsoft Entra token for ${scope} as the ${identity}: ${reason}${
        transient ? " (the token service did not answer; trying again)" : ""
      }`,
      { cause }
    );
    this.name = "EntraTokenError";
    this.code = transient ? "ENTRA_TOKEN_UNAVAILABLE" : "ENTRA_TOKEN_REFUSED";
  }
}

/** The first line of an SDK error, shortened, with anything shaped like a token taken out. */
function reasonOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw
      .split("\n")[0]
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]")
      .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
      .slice(0, 300) || "no reason given"
  );
}

// --- One cached token per scope ----------------------------------------------------------

/** Renew this long before expiry at most (a 24-hour managed-identity token renews 30 minutes before). */
export const MAX_RENEW_AHEAD_MS = 30 * 60_000;
/** A cached token with less than this left is not handed out: the caller waits for a new one. */
export const MIN_TOKEN_LIFE_MS = 60_000;
/** After a renewal (good or failed), the next one is not tried for this long. */
export const RENEW_RETRY_MS = 30_000;
/** A failed fetch with no usable token is remembered this long, so a burst of new connections asks once. */
export const FAILURE_MEMO_MS = 2_000;
/** One token request waits this long at most. */
export const TOKEN_TIMEOUT_MS = 20_000;

interface Held {
  token: string;
  expiresAt: number;
  renewAt: number;
}

export interface CachedTokenOptions {
  /** The credential; default the process's one (sharedAzureCredential). */
  source?: () => Promise<TokenSource>;
  /** Names the identity in errors; default describeIdentity(). */
  identity?: string;
  now?: () => number;
  /** A renewal failed while the cached token was still good (logged once per run of failures). */
  onRenewFailure?: (e: EntraTokenError) => void;
  /** A token was had again after a failure. */
  onRecovered?: () => void;
}

/**
 * An access token for one scope, kept and renewed ahead of expiry. get()
 * answers from the cache while the token has life left, starts a renewal in
 * the background once it is due, and waits for the token service only when
 * nothing usable is held.
 */
export class CachedToken {
  private held: Held | null = null;
  private inflight: Promise<Held> | null = null;
  private nextRenewAttempt = 0;
  private lastFailure: { error: EntraTokenError; at: number } | null = null;
  private failing = false;
  private readonly now: () => number;

  constructor(
    readonly scope: string,
    private readonly opts: CachedTokenOptions = {}
  ) {
    this.now = opts.now ?? Date.now;
  }

  private identity(): string {
    return this.opts.identity ?? describeIdentity();
  }

  /** When to renew a token: the earlier of the service's own hint and expiry less min(half its life, 30 min). */
  static renewAt(issuedAt: number, expiresAt: number, refreshAfter?: number): number {
    const life = Math.max(0, expiresAt - issuedAt);
    const ahead = Math.min(MAX_RENEW_AHEAD_MS, life / 2);
    const at = expiresAt - ahead;
    return typeof refreshAfter === "number" && refreshAfter > issuedAt && refreshAfter < at ? refreshAfter : at;
  }

  private fetch(): Promise<Held> {
    if (this.inflight) return this.inflight;
    const started = this.now();
    const p = (async () => {
      let source: TokenSource;
      try {
        source = await (this.opts.source ?? (() => sharedAzureCredential()))();
      } catch (e) {
        throw new EntraTokenError(this.identity(), this.scope, false, `@azure/identity could not be loaded (${reasonOf(e)})`, e);
      }
      let got: Awaited<ReturnType<TokenSource["getToken"]>>;
      try {
        got = await source.getToken(this.scope, { abortSignal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
      } catch (e) {
        throw new EntraTokenError(this.identity(), this.scope, isTransientTokenFailure(e), reasonOf(e), e);
      }
      if (!got?.token || !Number.isFinite(got.expiresOnTimestamp)) {
        throw new EntraTokenError(this.identity(), this.scope, false, "the token service answered with no token");
      }
      const now = this.now();
      if (got.expiresOnTimestamp - now < MIN_TOKEN_LIFE_MS) {
        throw new EntraTokenError(this.identity(), this.scope, true, "the token service answered with a token that is about to expire");
      }
      return { token: got.token, expiresAt: got.expiresOnTimestamp, renewAt: CachedToken.renewAt(started, got.expiresOnTimestamp, got.refreshAfterTimestamp) };
    })();
    this.inflight = p;
    p.then(
      (h) => {
        this.held = h;
        this.lastFailure = null;
        if (this.failing) {
          this.failing = false;
          this.opts.onRecovered?.();
        }
      },
      (e: EntraTokenError) => {
        this.lastFailure = { error: e, at: this.now() };
      }
    ).finally(() => {
      if (this.inflight === p) this.inflight = null;
      this.nextRenewAttempt = this.now() + RENEW_RETRY_MS;
    });
    return p;
  }

  /** A token with life left on it, renewed ahead of expiry. Throws EntraTokenError when none can be had. */
  async get(): Promise<string> {
    const now = this.now();
    const h = this.held;
    if (h && h.expiresAt - now >= MIN_TOKEN_LIFE_MS) {
      if (now >= h.renewAt && now >= this.nextRenewAttempt && !this.inflight) {
        // Renew in the background; the held token serves meanwhile.
        this.fetch().catch((e: EntraTokenError) => {
          if (!this.failing) {
            this.failing = true;
            this.opts.onRenewFailure?.(e);
          }
        });
      }
      return h.token;
    }
    // Nothing usable held: wait for the token service (a burst of callers shares one request).
    if (!this.inflight && this.lastFailure && now - this.lastFailure.at < FAILURE_MEMO_MS) throw this.lastFailure.error;
    try {
      return (await this.fetch()).token;
    } catch (e) {
      this.failing = true;
      throw e;
    }
  }

  /** Tests and diagnostics: what is held (never the token). */
  peek(): { expiresAt: number; renewAt: number } | null {
    return this.held ? { expiresAt: this.held.expiresAt, renewAt: this.held.renewAt } : null;
  }

  /** Forget the token (a sign-in was refused with it). */
  clear(): void {
    this.held = null;
  }
}
