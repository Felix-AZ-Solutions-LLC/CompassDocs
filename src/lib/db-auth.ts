// Signing in to PostgreSQL with Microsoft Entra (1.21.3): DATABASE_AUTH=entra.
//
// Opt-in, for an Azure Database for PostgreSQL flexible server: no database
// password exists anywhere. The user in DATABASE_URL is the PostgreSQL role
// of the app's managed identity (lib/azure-credential: the user-assigned one
// named by AZURE_CLIENT_ID, or the system-assigned one; workload identity
// when its variables are set), and the password of every connection is a
// Microsoft Entra access token for ENTRA_POSTGRES_SCOPE, fetched when the
// connection is made:
//
//   - the pool (lib/db: every query, the schema boot and its migrations);
//   - the helpdesk's LISTEN connection (lib/helpdesk/live), DATABASE_LISTEN_URL
//     or DATABASE_URL;
//   - pg_dump and pg_restore (lib/backup), through PGPASSWORD in the child's
//     environment only (never its arguments).
//
// The token is kept and renewed well before it expires (CachedToken), so a
// new connection always gets one with time left on it, and an open
// connection never needs one again (PostgreSQL checks it only at sign-in): a
// token service that is briefly unreachable costs nothing while a cached
// token is good. With no usable token left, a token service that does not
// answer is a connection error for lib/db-retry (the request waits, as for a
// database restart); a token that is refused (no such identity, not this
// app's) fails at once.
//
// SSL is required, and the server's certificate is verified against the
// public roots (Azure's flexible servers chain to DigiCert and Microsoft
// roots, both in Node's store and Alpine's): the token is a credential, and
// is never sent to a server that cannot prove its name.
// DATABASE_SSL=no-verify keeps the encryption and skips the name check (a
// private endpoint with its own certificate); `sslrootcert` in the URL names
// a CA file to verify against instead.
//
// Unset, or DATABASE_AUTH=password: DATABASE_URL and DATABASE_PASSWORD
// exactly as before (lib/db-url). Nothing here is loaded then beyond
// databaseAuth(), and @azure/identity never.

import { readFileSync } from "node:fs";
import type { ClientConfig } from "pg";
import { CachedToken, EntraTokenError, describeIdentity } from "./azure-credential";

export type Env = Record<string, string | undefined>;
export type DatabaseAuth = "password" | "entra";

/** The scope of an access token for Azure Database for PostgreSQL (and MySQL): the "ossrdbms" resource. */
export const ENTRA_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

/** How the app signs in to PostgreSQL: DATABASE_AUTH=entra, else a password (the default, as before 1.21.3). */
export function databaseAuth(env: Env = process.env): DatabaseAuth {
  return env.DATABASE_AUTH?.trim().toLowerCase() === "entra" ? "entra" : "password";
}

const LOOKS_INSECURE = new Set(["disable", "allow", "prefer"]);

function checkUrl(name: string, raw: string | undefined, fatal: string[]): void {
  if (!raw?.trim()) return;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fatal.push(`${name} must be a postgres:// URL with DATABASE_AUTH=entra (a key=value connection string can't carry the token).`);
    return;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    fatal.push(`${name} must be a postgres:// URL with DATABASE_AUTH=entra.`);
    return;
  }
  if (!u.username) {
    fatal.push(
      `${name} must name the managed identity's PostgreSQL role as its user, e.g. postgres://<role>@<server>.postgres.database.azure.com/<database>.`
    );
  }
  if (u.password) fatal.push(`${name} has a password in it. DATABASE_AUTH=entra signs in with a token: take the password out of the URL.`);
  const mode = u.searchParams.get("sslmode")?.toLowerCase();
  if (mode && LOOKS_INSECURE.has(mode)) fatal.push(`${name} says sslmode=${mode}. DATABASE_AUTH=entra requires SSL: remove sslmode or set it to require.`);
  const sslParam = u.searchParams.get("ssl")?.toLowerCase();
  if (sslParam === "false" || sslParam === "0") fatal.push(`${name} turns SSL off. DATABASE_AUTH=entra requires SSL.`);
}

/**
 * Why the database sign-in settings can't work, as one sentence each; empty
 * when they can. Checked at start-up in both modes (instrumentation) and
 * when the pool is made.
 */
export function databaseAuthProblems(env: Env = process.env): string[] {
  const fatal: string[] = [];
  const raw = env.DATABASE_AUTH?.trim().toLowerCase();
  if (raw && raw !== "entra" && raw !== "password") {
    fatal.push(`DATABASE_AUTH must be "entra" (a Microsoft Entra token for the managed identity) or "password" (the default); it is "${env.DATABASE_AUTH}".`);
    return fatal;
  }
  if (raw !== "entra") return fatal;
  if (env.DATABASE_PASSWORD) fatal.push("DATABASE_PASSWORD is set. DATABASE_AUTH=entra signs in with a token and no password: remove DATABASE_PASSWORD.");
  const ssl = env.DATABASE_SSL?.trim().toLowerCase();
  if (ssl === "disable") fatal.push("DATABASE_SSL=disable. DATABASE_AUTH=entra requires SSL: remove DATABASE_SSL (or set it to require or no-verify).");
  checkUrl("DATABASE_URL", env.DATABASE_URL, fatal);
  checkUrl("DATABASE_LISTEN_URL", env.DATABASE_LISTEN_URL, fatal);
  return fatal;
}

/** Is the server's certificate checked? Yes, unless DATABASE_SSL=no-verify. */
export function verifiesServerCertificate(env: Env = process.env): boolean {
  return env.DATABASE_SSL?.trim().toLowerCase() !== "no-verify";
}

// --- The token -------------------------------------------------------------------------

type Log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;

let log: Log = (level, event, fields) => {
  // Loaded when first needed: lib/log is server-only and this module is read by tests too.
  void import("./log").then(({ logEvent }) => logEvent(level, event, fields)).catch(() => {});
};

/** Tests: capture this module's lines. Returns the previous logger. */
export function setDbAuthLogForTests(fn: Log | null): Log {
  const prev = log;
  log = fn ?? ((level, event, fields) => void import("./log").then(({ logEvent }) => logEvent(level, event, fields)).catch(() => {}));
  return prev;
}

const G = globalThis as unknown as { __compassDbToken?: CachedToken; __compassDbTokenState?: { ok: boolean; failing: boolean } };

function cache(): CachedToken {
  if (!G.__compassDbToken) {
    G.__compassDbToken = new CachedToken(ENTRA_POSTGRES_SCOPE, {
      onRenewFailure: (e) =>
        log("warn", "db.entra_token_renewal_failed", {
          message: `${e.message} The token in hand is still good; renewing it is tried again shortly.`,
        }),
    });
  }
  return G.__compassDbToken;
}

/** Tests: start again with no token held. */
export function resetDatabaseTokenForTests(): void {
  G.__compassDbToken = undefined;
  G.__compassDbTokenState = undefined;
}

/**
 * The password for a new connection: an access token for the managed
 * identity, from the cache. A failure is logged once per run of failures
 * (one line naming the identity and the scope) and thrown as
 * EntraTokenError; the first token, and the first after a failure, is one
 * info line.
 */
export async function databaseToken(): Promise<string> {
  const state = (G.__compassDbTokenState ??= { ok: false, failing: false });
  try {
    const token = await cache().get();
    if (!state.ok || state.failing) {
      log("info", "db.entra_sign_in", {
        message: `Signing in to PostgreSQL with a Microsoft Entra token as the ${describeIdentity()}${state.failing ? " again" : ""}.`,
        identity: describeIdentity(),
      });
    }
    state.ok = true;
    state.failing = false;
    return token;
  } catch (e) {
    if (!state.failing) {
      state.failing = true;
      const transient = e instanceof EntraTokenError && e.transient;
      log(transient ? "warn" : "error", "db.entra_token_failed", {
        message:
          e instanceof EntraTokenError
            ? transient
              ? e.message
              : `${e.message} Check that the identity is assigned to this app and is a PostgreSQL role on the server (README "Signing in to PostgreSQL with Microsoft Entra").`
            : String(e),
        identity: describeIdentity(),
        scope: ENTRA_POSTGRES_SCOPE,
      });
    }
    throw e;
  }
}

// --- Connection settings -----------------------------------------------------------------

/** The TLS options: verified unless DATABASE_SSL=no-verify, with the URL's sslrootcert/sslcert/sslkey files. */
function tlsOptions(u: URL, env: Env): NonNullable<Exclude<ClientConfig["ssl"], boolean>> {
  const out: Record<string, unknown> = { rejectUnauthorized: verifiesServerCertificate(env) };
  const ca = u.searchParams.get("sslrootcert");
  if (ca && ca !== "system") out.ca = readFileSync(ca, "utf8");
  const cert = u.searchParams.get("sslcert");
  if (cert) out.cert = readFileSync(cert, "utf8");
  const key = u.searchParams.get("sslkey");
  if (key) out.key = readFileSync(key, "utf8");
  return out as NonNullable<Exclude<ClientConfig["ssl"], boolean>>;
}

/**
 * The driver settings for `raw` with DATABASE_AUTH=entra: the URL taken
 * apart (pg would let a connection string's empty password replace a
 * password function, so none is passed), SSL on, and the token as the
 * password of every connection. Throws the first start-up problem.
 */
export function entraClientConfig(raw: string, env: Env = process.env): ClientConfig {
  const problems = databaseAuthProblems({ ...env, DATABASE_URL: raw, DATABASE_LISTEN_URL: undefined });
  if (problems.length) throw new Error(problems[0]);
  const u = new URL(raw);
  const port = u.port ? Number(u.port) : 5432;
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || undefined;
  const config: ClientConfig = {
    host: u.hostname.replace(/^\[(.+)\]$/, "$1"),
    port,
    user: decodeURIComponent(u.username),
    ...(database ? { database } : {}),
    ssl: tlsOptions(u, env),
    password: () => databaseToken(),
  };
  const app = u.searchParams.get("application_name");
  if (app) config.application_name = app;
  const options = u.searchParams.get("options");
  if (options) config.options = options;
  return config;
}

/**
 * libpq's environment for pg_dump / pg_restore with DATABASE_AUTH=entra:
 * the URL's parts, a token as PGPASSWORD (in the child's environment only)
 * and SSL that verifies the server (verify-full against the system's roots,
 * or the URL's sslrootcert), or only encrypts with DATABASE_SSL=no-verify.
 */
export async function entraLibpqEnv(raw: string, env: Env = process.env): Promise<Record<string, string>> {
  const problems = databaseAuthProblems({ ...env, DATABASE_URL: raw, DATABASE_LISTEN_URL: undefined });
  if (problems.length) throw new Error(problems[0]);
  const u = new URL(raw);
  const out: Record<string, string> = {
    PGHOST: u.hostname.replace(/^\[(.+)\]$/, "$1"),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "compassdocs",
    PGPASSWORD: await databaseToken(),
  };
  if (verifiesServerCertificate(env)) {
    out.PGSSLMODE = "verify-full";
    out.PGSSLROOTCERT = u.searchParams.get("sslrootcert") || "system";
  } else {
    out.PGSSLMODE = "require";
  }
  return out;
}

/**
 * Start-up (instrumentation), in both modes: a DATABASE_AUTH setting that
 * can't work is one error line each, and the process exits 1 before it
 * serves anything. Nothing is said when DATABASE_AUTH is unset.
 */
export async function checkDatabaseAuthStartup(
  logLine: Log,
  exit: (code: number) => void = (code) => process.exit(code),
  env: Env = process.env
): Promise<boolean> {
  const fatal = databaseAuthProblems(env);
  if (fatal.length) {
    for (const f of fatal) logLine("error", "db.refused_to_start", { message: `The database sign-in can't start: ${f}` });
    await new Promise((r) => setTimeout(r, 200));
    exit(1);
    return false;
  }
  if (databaseAuth(env) === "entra") {
    let role = "";
    try {
      role = decodeURIComponent(new URL(env.DATABASE_URL ?? "").username);
    } catch {
      /* checked above */
    }
    logLine("info", "db.entra", {
      message: `PostgreSQL sign-in: Microsoft Entra token for the ${describeIdentity(env)}, as the role ${role}, over SSL${
        verifiesServerCertificate(env) ? " that verifies the server" : " (DATABASE_SSL=no-verify: the server's certificate is not checked)"
      }.`,
    });
  }
  return true;
}
