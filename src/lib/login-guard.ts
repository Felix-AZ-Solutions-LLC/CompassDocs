import "server-only";

// In-memory login throttling. Counters are per-process (a single container in
// every supported deployment) and reset on restart — the goal is to make online
// password guessing impractically slow, not to be a distributed ban list.
//
// Policy:
//  - 5 failures for the same username+IP within the window → that pair is
//    locked for 15 minutes. The pair is keyed on the identifier as typed,
//    an email included (1.16.0), so a pair lock says nothing about which
//    account an email belongs to (the per-account budget below is
//    address-independent and answers the same for an unknown name).
//  - 30 failures from one IP across any usernames → the IP is locked for
//    15 minutes (catches sprays across many accounts).
//  - Any successful login clears the username+IP pair.
//  - The sign-in route counts an attempt as it starts (beginLoginAttempt),
//    in the same synchronous step as the check, and gives it back when it
//    did not fail (refundLoginAttempt): a burst sent at once can't all pass
//    the check before the first failure is counted.
//  - The typed signature (lib/attestation, 1.12.0) and the password change
//    (/api/auth/change-password) count against the username+IP pair only
//    (recordPairFailure / pairRetryAfter below), with no await between the
//    check and the count: a signed-in session has a fixed username, so the
//    pair already bounds the oracle to 5 guesses per address, and a
//    workforce signing a policy behind one NAT must not trip the spray
//    counter and lock sign-in for the whole office. A pair lock engaged
//    there holds for the sign-in form too when the username is typed (an
//    email is its own key); beginLoginAttempt and loginRetryAfter read the
//    same map.
//  - 1.20.27 (security review H2): a per-identifier budget that ignores the
//    address, so a spray from many addresses (or forged X-Forwarded-For
//    values on an install whose port 3000 is reachable) is slowed too.
//    Within an hour, the first ID_FREE failures for an identifier cost
//    nothing extra; after that each attempt must wait a delay that doubles
//    with every failure (1 s, 2 s, 4 s … capped at ID_MAX_DELAY_MS), and
//    ID_LIMIT failures soft-lock the identifier for the rest of the hour.
//    It can never lock the owner out for good: an address that has signed
//    in as this identifier in the last TRUSTED_MS is exempt (the owner's
//    office or home keeps working through an attack from elsewhere), the
//    lock ends with its hour, single sign-on never reads it, and an
//    administrator's password reset clears it (clearIdentifierThrottle).
//    No CAPTCHA: a soft lock answers 429 like the others.
//  - 1.20.27 (second review M1): the budget is the ACCOUNT's when the
//    identifier names one (LoginContext.account; its username and its email
//    share one budget), else the typed identifier's. "Known address" comes
//    from the database (lib/db knownSignInAddress: a session or a recorded
//    sign-in of this account from this address in the last 30 days), so a
//    restart, an update or a second instance does not forget it; the
//    in-memory map below is only a cache of it. An address known for the
//    account is never refused by any of the locks (pair, address or
//    budget): a stranger who forges it (X-Forwarded-For on an install whose
//    port 3000 is reachable) can only SLOW it. Its attempts are put in a
//    queue of their own per account: free for KNOWN_FREE failures an hour,
//    then each waits for a slot KNOWN_STEP_MS·2^n later (capped at
//    KNOWN_MAX_STEP_MS), the route holding the request until its slot
//    (LoginAttempt.slowMs); only a slot more than KNOWN_MAX_AHEAD_MS away is
//    refused, for a few seconds. A sign-in from it clears that queue.

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const PAIR_LIMIT = 5;
const IP_LIMIT = 30;
const MAX_ENTRIES = 50_000; // hard cap so a spray can't balloon memory

const ID_WINDOW_MS = 60 * 60 * 1000;
const ID_FREE = 10;
const ID_LIMIT = 50;
const ID_MAX_DELAY_MS = 5 * 60 * 1000;
const TRUSTED_MS = 30 * 24 * 60 * 60 * 1000;

const KNOWN_FREE = 5;
const KNOWN_STEP_MS = 1000;
const KNOWN_MAX_STEP_MS = 10_000;
const KNOWN_MAX_AHEAD_MS = 30_000;

/**
 * What the sign-in route knows about an attempt before it counts it
 * (1.20.27, second review M1): the account the identifier resolved to, if
 * any, and whether this address signed that account in during the last 30
 * days (from the database). Without it (older callers and tests), the
 * budget is the typed identifier's and "known" is the in-memory cache's.
 */
export interface LoginContext {
  account: number | null;
  known: boolean;
}

type Entry = { fails: number; first: number; lockedUntil: number };
const pairs = new Map<string, Entry>();
const ips = new Map<string, Entry>();
/** Per identifier, whatever the address (1.20.27): failures this hour and when the last one began. */
type IdEntry = { fails: number; first: number; last: number };
const idents = new Map<string, IdEntry>();
/** identifier|address pairs that signed in, and when (1.20.27): exempt from the identifier's budget. */
const trusted = new Map<string, number>();
/** A known address's queue per account (1.20.27): failures this hour, and the next free slot. */
type Lane = { fails: number; first: number; nextAt: number };
const lanes = new Map<string, Lane>();

function bump(map: Map<string, Entry>, key: string, limit: number, now: number): boolean {
  let e = map.get(key);
  if (!e || now - e.first > WINDOW_MS) {
    e = { fails: 0, first: now, lockedUntil: 0 };
    if (map.size >= MAX_ENTRIES) sweep(now);
    map.set(key, e);
  }
  e.fails++;
  if (e.fails >= limit && e.lockedUntil <= now) {
    e.lockedUntil = now + LOCK_MS;
    return true; // lock just engaged
  }
  return false;
}

function lockedFor(map: Map<string, Entry>, key: string, now: number): number {
  const e = map.get(key);
  if (!e || e.lockedUntil <= now) return 0;
  return Math.ceil((e.lockedUntil - now) / 1000);
}

function sweep(now: number): void {
  for (const map of [pairs, ips]) {
    for (const [k, e] of map) {
      if (now - e.first > WINDOW_MS && e.lockedUntil <= now) map.delete(k);
    }
  }
  for (const [k, e] of idents) if (now - e.first > ID_WINDOW_MS) idents.delete(k);
  for (const [k, at] of trusted) if (now - at > TRUSTED_MS) trusted.delete(k);
  for (const [k, l] of lanes) if (now - l.first > ID_WINDOW_MS && l.nextAt <= now) lanes.delete(k);
}

function idKey(username: string): string {
  return username.toLowerCase().trim();
}

/** The budget's key: the account's when the identifier names one (1.20.27), else the identifier's. */
function budgetKey(username: string, ctx?: LoginContext): string {
  return ctx?.account ? `#${ctx.account}` : idKey(username);
}

/** The trusted-address cache's key: per account when known, else per identifier. */
function trustKey(username: string, ip: string, ctx?: LoginContext): string {
  return ctx?.account ? `#${ctx.account}|${ip}` : pairKey(username, ip);
}

function laneStep(fails: number): number {
  if (fails < KNOWN_FREE) return 0;
  return Math.min(KNOWN_MAX_STEP_MS, KNOWN_STEP_MS * 2 ** Math.min(20, fails - KNOWN_FREE));
}

/** The delay owed before the next attempt after `fails` failures this hour. */
function idDelayMs(fails: number): number {
  if (fails < ID_FREE) return 0;
  return Math.min(ID_MAX_DELAY_MS, 1000 * 2 ** Math.min(20, fails - ID_FREE));
}

/** Seconds this identifier must wait whatever the address, or 0 (1.20.27). */
function identifierWait(key: string, now: number): number {
  const e = idents.get(key);
  if (!e || now - e.first > ID_WINDOW_MS) return 0;
  if (e.fails >= ID_LIMIT) return Math.ceil((e.first + ID_WINDOW_MS - now) / 1000);
  const until = e.last + idDelayMs(e.fails);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

function pairKey(username: string, ip: string): string {
  return `${username.toLowerCase().trim()}|${ip}`;
}

/** One counted attempt in one map: the entry it went into, and whether it engaged that entry's lock. */
type Slot = { key: string; entry: Entry; engaged: boolean };

/**
 * A sign-in attempt counted before its outcome is known. `wait` > 0: refused
 * and not counted. `lockEngaged`: counting it engaged the pair or IP lock, to
 * be audited once if the attempt fails.
 */
export type LoginAttempt = {
  wait: number;
  lockEngaged: boolean;
  pair?: Slot;
  ip?: Slot;
  /** The identifier's budget entry (1.20.27), absent for a trusted address; `last` before this attempt. */
  ident?: { key: string; entry: IdEntry; prevLast: number };
  /** Counting this attempt began the identifier's delays (ID_FREE reached): audited once if it fails. */
  identLockEngaged?: boolean;
  /** A known address's attempt (1.20.27): hold the request this long before checking the password. */
  slowMs?: number;
  /** Its queue entry, given back by refundLoginAttempt. */
  lane?: { key: string; entry: Lane };
  /** The trusted-address cache's key, set on a sign-in. */
  trustKey?: string;
};

function reserve(map: Map<string, Entry>, key: string, limit: number, now: number): Slot {
  const engaged = bump(map, key, limit, now);
  return { key, entry: map.get(key)!, engaged };
}

function release(map: Map<string, Entry>, slot: Slot): void {
  if (map.get(slot.key) !== slot.entry) return; // cleared, swept or a new window since
  slot.entry.fails = Math.max(0, slot.entry.fails - 1);
  if (slot.engaged) slot.entry.lockedUntil = 0;
}

/**
 * Check and count a sign-in attempt in one step: the caller must not await
 * between the two, or a burst sent at once all passes the check. A failed
 * attempt keeps its count; one that did not fail goes to refundLoginAttempt.
 */
export function beginLoginAttempt(username: string, ip: string, ctx?: LoginContext): LoginAttempt {
  const now = Date.now();
  const key = pairKey(username, ip);
  const tk = trustKey(username, ip, ctx);
  const known = (ctx?.known ?? false) || isTrusted(tk, now);
  const ik = budgetKey(username, ctx);
  if (known) {
    // Never refused by a lock: queued, and slowed once it has failed often (1.20.27, second review M1).
    let lane = lanes.get(ik);
    if (!lane || (now - lane.first > ID_WINDOW_MS && lane.nextAt <= now)) {
      lane = { fails: 0, first: now, nextAt: 0 };
      if (lanes.size >= MAX_ENTRIES) sweep(now);
      lanes.set(ik, lane);
    }
    const at = Math.max(now, lane.nextAt);
    if (at - now > KNOWN_MAX_AHEAD_MS) return { wait: Math.ceil((at - now - KNOWN_MAX_AHEAD_MS) / 1000) || 1, lockEngaged: false };
    lane.nextAt = at + laneStep(lane.fails);
    lane.fails++;
    const pair = reserve(pairs, key, PAIR_LIMIT, now);
    return { wait: 0, lockEngaged: false, pair, slowMs: at - now, lane: { key: ik, entry: lane }, trustKey: tk };
  }
  const wait = Math.max(lockedFor(pairs, key, now), lockedFor(ips, ip, now), identifierWait(ik, now));
  if (wait > 0) return { wait, lockEngaged: false };
  const pair = reserve(pairs, key, PAIR_LIMIT, now);
  const addr = reserve(ips, ip, IP_LIMIT, now);
  let ident: LoginAttempt["ident"];
  let identLockEngaged = false;
  {
    let e = idents.get(ik);
    if (!e || now - e.first > ID_WINDOW_MS) {
      e = { fails: 0, first: now, last: 0 };
      if (idents.size >= MAX_ENTRIES) sweep(now);
      idents.set(ik, e);
    }
    ident = { key: ik, entry: e, prevLast: e.last };
    e.fails++;
    e.last = now;
    identLockEngaged = e.fails === ID_FREE;
  }
  return { wait: 0, lockEngaged: pair.engaged || addr.engaged || identLockEngaged, pair, ip: addr, ident, identLockEngaged, trustKey: tk };
}

function isTrusted(key: string, now: number): boolean {
  const at = trusted.get(key);
  return at !== undefined && now - at <= TRUSTED_MS;
}

/**
 * Give back an attempt that did not fail: signed in (which also clears the
 * pair, as recordLoginSuccess does), or the right password with the code
 * still to come. A lock that counting it engaged is lifted. Once only.
 */
export function refundLoginAttempt(attempt: LoginAttempt, signedIn: boolean): void {
  const { pair, ip, ident, lane } = attempt;
  attempt.pair = attempt.ip = attempt.ident = attempt.lane = undefined;
  if (pair) {
    if (signedIn) {
      pairs.delete(pair.key);
      // The owner signed in from here: this address keeps working through an attack from elsewhere.
      if (trusted.size >= MAX_ENTRIES) sweep(Date.now());
      trusted.set(attempt.trustKey ?? pair.key, Date.now());
    } else release(pairs, pair);
  }
  if (lane && lanes.get(lane.key) === lane.entry) {
    if (signedIn) lanes.delete(lane.key);
    else lane.entry.fails = Math.max(0, lane.entry.fails - 1);
  }
  if (ip) release(ips, ip);
  if (ident && idents.get(ident.key) === ident.entry) {
    ident.entry.fails = Math.max(0, ident.entry.fails - 1);
    ident.entry.last = ident.prevLast;
  }
}

/**
 * Forget an identifier's address-independent budget (1.20.27): an
 * administrator reset the account's password, so its owner can sign in at
 * once whatever an attacker did to the identifier this hour.
 */
export function clearIdentifierThrottle(identifier: string | number): void {
  // An account id (1.20.27, second review M1): its budget and its known addresses' queue.
  if (typeof identifier === "number") {
    idents.delete(`#${identifier}`);
    lanes.delete(`#${identifier}`);
    return;
  }
  if (identifier) idents.delete(idKey(identifier));
}

/** Seconds the caller must wait before another attempt, or 0 if allowed. */
export function loginRetryAfter(username: string, ip: string, ctx?: LoginContext): number {
  const now = Date.now();
  const key = pairKey(username, ip);
  const tk = trustKey(username, ip, ctx);
  if ((ctx?.known ?? false) || isTrusted(tk, now)) {
    const lane = lanes.get(budgetKey(username, ctx));
    const ahead = lane ? Math.max(0, lane.nextAt - now) : 0;
    return ahead > KNOWN_MAX_AHEAD_MS ? Math.ceil((ahead - KNOWN_MAX_AHEAD_MS) / 1000) : 0;
  }
  return Math.max(lockedFor(pairs, key, now), lockedFor(ips, ip, now), identifierWait(budgetKey(username, ctx), now));
}

/** Record a failed attempt. Returns true if this failure engaged a new lock
 * (callers audit that moment once). */
export function recordLoginFailure(username: string, ip: string): boolean {
  const now = Date.now();
  const pairLocked = bump(pairs, pairKey(username, ip), PAIR_LIMIT, now);
  const ipLocked = bump(ips, ip, IP_LIMIT, now);
  return pairLocked || ipLocked;
}

export function recordLoginSuccess(username: string, ip: string): void {
  pairs.delete(pairKey(username, ip));
}

/** Seconds the username+IP pair is locked for, or 0 if allowed; the IP spray lock is not consulted. */
export function pairRetryAfter(username: string, ip: string): number {
  return lockedFor(pairs, pairKey(username, ip), Date.now());
}

/** Record a failed attempt against the username+IP pair only. Returns true if this failure engaged the pair's lock. */
export function recordPairFailure(username: string, ip: string): boolean {
  return bump(pairs, pairKey(username, ip), PAIR_LIMIT, Date.now());
}
