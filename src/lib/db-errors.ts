// Which database errors mean "the database is not there right now" (1.21.2).
//
// Plain functions with no imports, so lib/shutdown and the tests can ask
// without loading the Postgres driver. lib/db-retry decides what is retried;
// this module only names the errors.

/** Socket-level codes Node gives a connection that was refused, reset or cut off. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
]);

/**
 * SQLSTATEs a server sends while it stops, restarts or fails over:
 * 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now
 * (starting up, shutting down, in recovery), 53300 too_many_connections
 * (a restarted server filling up again), and class 08, connection
 * exception.
 */
const SERVER_CODES = new Set(["57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08004", "08006"]);

/** The driver's own messages for a connection that went away (pg 8 and pg-pool 3). */
const DRIVER_MESSAGES = [
  /^Connection terminated unexpectedly$/,
  /^Connection terminated due to connection timeout$/,
  /^timeout exceeded when trying to connect$/,
  /^Client has encountered a connection error and is not queryable$/,
  /^Client was closed and is not queryable$/,
  /^terminating connection due to administrator command$/,
  /^the database system is (starting up|shutting down|in recovery mode|not yet accepting connections)/,
  /^Client network socket disconnected before secure TLS connection was established$/,
];

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  name?: unknown;
}

function asErrorLike(e: unknown): ErrorLike | null {
  return e && typeof e === "object" ? (e as ErrorLike) : null;
}

/**
 * The connection to the database failed or was lost: refused, reset, timed
 * out, terminated by the server (restart, failover, scale) or by the
 * driver. Never a statement's own error (a constraint, a syntax error, a
 * deadlock, a cancelled query), never authentication or a missing
 * database: those are not an outage and waiting does not fix them.
 */
export function isConnectionError(e: unknown, depth = 0): boolean {
  const x = asErrorLike(e);
  if (!x) return false;
  if (x.name === "DatabaseUnavailableError") return true;
  const code = typeof x.code === "string" ? x.code : "";
  if (NETWORK_CODES.has(code) || SERVER_CODES.has(code)) return true;
  const message = typeof x.message === "string" ? x.message : "";
  if (DRIVER_MESSAGES.some((re) => re.test(message))) return true;
  // pg-pool wraps a timed-out connect around its cause; an AggregateError (dual-stack connect) holds several.
  if (depth < 3 && x.cause) return isConnectionError(x.cause, depth + 1);
  const errors = (x as { errors?: unknown }).errors;
  if (depth < 3 && Array.isArray(errors)) return errors.some((inner) => isConnectionError(inner, depth + 1));
  return false;
}

/**
 * The statement was never written to the server: pg refuses a query on a
 * client whose connection already failed or that is closing, before sending
 * anything. The only failure after a client is in hand that is safe to try
 * again on another connection.
 */
export function isNeverSentError(e: unknown): boolean {
  const message = asErrorLike(e)?.message;
  return (
    message === "Client has encountered a connection error and is not queryable" || message === "Client was closed and is not queryable"
  );
}

/** A short name for the error in a log line: its code, or its message. */
export function connectionErrorLabel(e: unknown): string {
  const x = asErrorLike(e);
  if (!x) return String(e);
  const code = typeof x.code === "string" && x.code ? x.code : "";
  const message = typeof x.message === "string" ? x.message : String(e);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}
