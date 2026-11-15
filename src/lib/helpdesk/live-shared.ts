// Helpdesk 1.20.19: live queue updates, the parts the desk and the server
// share (lib/helpdesk/live is the server's bus, components/helpdesk/desk/live
// the desk's listener, GET /api/helpdesk/live the stream between them).
//
// A signal says only "something in your queues changed": no ticket, no
// number, no subject, no count. The desk answers it by reloading the list
// and the counts through the ordinary APIs, which apply the agent's scope.

export const LIVE_LIMITS = {
  /** A burst of changes is folded into one signal sent at least this long after the first. */
  debounceMs: 250,
  /** The least time between two signals to one stream... */
  minGapMs: 1_500,
  /** ...growing by this much per open stream on the server (so 100 streams: 2 s), */
  gapPerStreamMs: 20,
  /** ...up to this. */
  maxGapMs: 15_000,
  /**
   * Every process hands out at most this many signals a second (a token
   * bucket, this deep): each signal costs the desk two requests (the list and
   * the counts) plus the saved views' counts at most every 5 s.
   */
  signalsPerSecond: 25,
  /** A comment line this often keeps proxies from closing an idle stream. */
  heartbeatMs: 25_000,
  /** A stream ends after this (plus up to 30 s) and the browser reconnects: the sign-in, licence and scope are checked again. */
  maxStreamMs: 5 * 60_000,
  /** The agent's session, desk standing and teams are looked up again this often while a stream is open. */
  scopeRefreshMs: 60_000,
  /** Open streams per person (desk tabs); long polls count too. */
  perUser: 6,
  /** Open streams per server process; past it the desk falls back to polling. */
  perProcess: 5_000,
  /** New connections (stream or long poll) per person per minute. */
  connectsPerMinute: 30,
  /** A long poll (?wait=) holds at most this many seconds. */
  maxWaitSeconds: 25,
  /** Changes are remembered this long, so a reconnect can tell whether it missed one of its own... */
  ringMs: 10 * 60_000,
  /** ...up to this many (past it the oldest go, and an older cursor counts as "missed"). */
  ringMax: 50_000,
  /** A cursor from another process: changes up to this much before it count as possibly missed (clock and delivery skew). */
  skewMs: 2_000,
  /** The listener proves itself this often: a NOTIFY through the pool must come back... */
  selfCheckMs: 45_000,
  /** ...within this. */
  selfCheckTimeoutMs: 5_000,
  /** The listener's reconnect back-off: from this... */
  reconnectMinMs: 1_000,
  /** ...doubling up to this. */
  reconnectMaxMs: 60_000,
} as const;

/** How long the desk waits for the stream's hello before trusting it is buffered and switching to long polling. */
export const LIVE_HELLO_TIMEOUT_MS = 8_000;
/** With no stream and no long poll, the desk reloads this often while visible. */
export const LIVE_FALLBACK_POLL_MS = 30_000;
/** A hidden desk tab closes its stream after this; showing it again reconnects and catches up. */
export const LIVE_HIDDEN_CLOSE_MS = 60_000;
/** From a fallback, the desk tries the stream again after this, doubling per failure up to LIVE_RETRY_MAX_MS, ±50 %. */
export const LIVE_RETRY_MIN_MS = 30_000;
export const LIVE_RETRY_MAX_MS = 10 * 60_000;
/** A long poll that answered "changed": the next one waits about this long (± jitter) so a busy desk can't spin. */
export const LIVE_LONGPOLL_PAUSE_MS = 2_000;

/** The gap between two signals to one stream with `streams` open on the server. */
export function liveGapMs(streams: number): number {
  return Math.min(LIVE_LIMITS.maxGapMs, Math.max(LIVE_LIMITS.minGapMs, streams * LIVE_LIMITS.gapPerStreamMs));
}

/** One change as the trigger reports it: the ticket's team and owner before and after. */
export interface LiveChange {
  teams: number[];
  users: number[];
  /** Missed changes (the listener reconnected): everyone reloads. */
  all?: boolean;
}

/** "oldTeam,oldOwner,newTeam,newOwner" (lib/helpdesk/live-schema) → the teams and owners it touches; null when malformed. */
export function parseLivePayload(payload: string): LiveChange | null {
  const parts = payload.split(",");
  if (parts.length !== 4) return null;
  const ids = parts.map((p) => (p === "" ? null : /^\d{1,10}$/.test(p) ? Number(p) : NaN));
  if (ids.some((n) => typeof n === "number" && Number.isNaN(n))) return null;
  const [ot, oa, nt, na] = ids as (number | null)[];
  const teams = [...new Set([ot, nt].filter((n): n is number => n !== null))];
  const users = [...new Set([oa, na].filter((n): n is number => n !== null))];
  return { teams, users };
}

/** Whether a change concerns an agent with these teams ("all": agent_all) and this id (what they own). */
export function liveConcerns(change: LiveChange, scope: { teams: ReadonlySet<number> | "all"; userId: number }): boolean {
  if (change.all || scope.teams === "all") return true;
  for (const t of change.teams) if (scope.teams.has(t)) return true;
  return change.users.includes(scope.userId);
}

/**
 * A cursor is the server's clock when it last spoke to the stream, and the
 * process that said it: "<ms base 36>.<boot>". It moves with time only, so
 * it says nothing about changes the reader can't see.
 */
export function formatLiveCursor(ms: number, boot: string): string {
  return `${Math.floor(ms).toString(36)}.${boot}`;
}

export function parseLiveCursor(raw: string | null | undefined): { ms: number; boot: string } | null {
  const m = /^([0-9a-z]{1,11})\.([0-9a-f]{8})$/.exec(raw ?? "");
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  return Number.isFinite(ms) ? { ms, boot: m[2] } : null;
}
