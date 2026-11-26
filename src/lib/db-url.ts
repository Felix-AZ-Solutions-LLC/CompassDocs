// The database address with its password (1.21.0).
//
// DATABASE_PASSWORD, when set, is the password for DATABASE_URL (and
// DATABASE_LISTEN_URL), replacing any password written in the URL. It lets a
// platform keep the address in plain configuration and the password in a
// secret store: Azure Container Apps maps a Key Vault secret reference to
// DATABASE_PASSWORD. Unset, the URLs are used exactly as given, as before.
// Read by lib/db (the pool), lib/backup (pg_dump) and the helpdesk's LISTEN
// connection. Pure, so tests read it directly.

type Env = Record<string, string | undefined>;

/** `raw` with DATABASE_PASSWORD put in as its password; `raw` unchanged when the variable is unset or `raw` is not a URL. */
export function withDatabasePassword(raw: string, env: Env = process.env): string {
  const password = env.DATABASE_PASSWORD;
  if (!password) return raw;
  try {
    const u = new URL(raw);
    if (!u.username) return raw; // a password needs a user: libpq's default user takes none from the URL
    u.password = encodeURIComponent(password);
    return u.toString();
  } catch {
    return raw; // a key=value DSN: the pool passes the password separately
  }
}

/** The password to hand the driver beside a connection string it cannot write into (a key=value DSN), else undefined. */
export function separateDatabasePassword(raw: string, env: Env = process.env): string | undefined {
  if (!env.DATABASE_PASSWORD) return undefined;
  return withDatabasePassword(raw, env) === raw ? env.DATABASE_PASSWORD : undefined;
}
