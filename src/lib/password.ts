import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";

// Local password hashing using Node's built-in scrypt — no external dependency.
// Stored as a hex hash + hex salt pair on the users table.
//
// 1.20.27 (security review M7): new hashes use scrypt N=2^17, r=8, p=1 (the
// OWASP recommendation; 128 MiB of memory per hash), computed asynchronously
// on libuv's thread pool so a sign-in never blocks the event loop. They are
// stored as "s2$<hex>" so the parameters are known from the row; a bare
// 128-hex hash is the pre-1.20.27 format (Node's defaults, N=2^14) and still
// verifies. needsRehash() says when a successful sign-in should store the
// password again under the current parameters (lib/auth login does).
//
// 1.20.27 (second review M2): at most HASH_CONCURRENCY derivations run at
// once (default 2, COMPASSDOCS_PASSWORD_HASH_CONCURRENCY 1–4), so a flood of
// sign-in attempts can neither take every libuv thread (which also serve
// file reads and DNS lookups, so the whole app would stall) nor use more
// than about 256 MiB. A check (verifyPassword, verifyNothing: every sign-in,
// the typed signature, the password change) waits in a queue of at most
// VERIFY_QUEUE_MAX; with that full it fails at once with PasswordBusyError,
// which the routes answer 503. Making a hash (an account created, a
// password set) waits however long the queue is: it is never refused.
//
// Timing (second review, Low): every check spends one current and one
// legacy derivation, whichever format the stored hash is in (the other is
// spent on a dummy), and so does a check for an unknown account: the time
// says neither whether an account exists nor that it still has a
// pre-1.20.27 hash.

/** The current scrypt parameters: N=2^17, r=8, p=1, a 64-byte key. */
const CURRENT = { N: 2 ** 17, r: 8, p: 1, keylen: 64 } as const;
/** Pre-1.20.27 hashes: Node's scrypt defaults. */
const LEGACY = { N: 2 ** 14, r: 8, p: 1, keylen: 64 } as const;
/** scrypt needs 128·N·r bytes; Node's default maxmem (32 MiB) is too small for N=2^17. */
const MAXMEM = 256 * 1024 * 1024;
const CURRENT_TAG = "s2$";

/** Derivations allowed at once. */
function hashConcurrency(): number {
  const n = Number(process.env.COMPASSDOCS_PASSWORD_HASH_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 2;
}
/** Checks allowed to wait for a free slot before the next is refused (about 5 s of work at the default). */
export const VERIFY_QUEUE_MAX = 32;

/** Too many password checks are waiting: answer 503 and let the client retry (1.20.27). */
export class PasswordBusyError extends Error {
  readonly retryAfter = 5;
  constructor() {
    super("Too many sign-ins are being checked right now. Try again in a few seconds.");
    this.name = "PasswordBusyError";
  }
}

let running = 0;
/** Waiting derivations, in order; `bounded` ones count against VERIFY_QUEUE_MAX. */
const waiting: { go: () => void; bounded: boolean }[] = [];
let boundedWaiting = 0;

async function acquire(bounded: boolean): Promise<void> {
  if (running < hashConcurrency()) {
    running++;
    return;
  }
  if (bounded && boundedWaiting >= VERIFY_QUEUE_MAX) throw new PasswordBusyError();
  if (bounded) boundedWaiting++;
  await new Promise<void>((go) => waiting.push({ go, bounded }));
  // release() handed this slot over: `running` already counts it.
}

function release(): void {
  const next = waiting.shift();
  if (!next) {
    running--;
    return;
  }
  if (next.bounded) boundedWaiting--;
  next.go();
}

/** Derivations running and waiting now (tests and diagnostics). */
export function passwordHashLoad(): { running: number; waiting: number; limit: number } {
  return { running, waiting: waiting.length, limit: hashConcurrency() };
}

async function derive(password: string, salt: string, params: { N: number; r: number; p: number; keylen: number }, bounded: boolean): Promise<Buffer> {
  await acquire(bounded);
  try {
    return await new Promise((resolve, reject) => {
      scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM }, (err, key) =>
        err ? reject(err) : resolve(key)
      );
    });
  } finally {
    release();
  }
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = CURRENT_TAG + (await derive(password, salt, CURRENT, false)).toString("hex");
  return { hash, salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  if (!hash || !salt) {
    await verifyNothing(password);
    return false;
  }
  const current = hash.startsWith(CURRENT_TAG);
  const expected = Buffer.from(current ? hash.slice(CURRENT_TAG.length) : hash, "hex");
  // One derivation of each kind, the real one and a dummy, so both formats take the same time.
  const candidate = await derive(password, salt, current ? CURRENT : LEGACY, true);
  await derive(password, DUMMY_SALT, current ? LEGACY : CURRENT, true);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** A stored hash made with older parameters: store the password again after it verifies. */
export function needsRehash(hash: string | null | undefined): boolean {
  return !!hash && !hash.startsWith(CURRENT_TAG);
}

/** The salt of the dummy derivations: random per process, never a user's. */
const DUMMY_SALT = randomBytes(16).toString("hex");

/**
 * Spend one password check's worth of work and fail: for an unknown,
 * disabled or password-less account (1.16.0), so the response time does not
 * say whether the account exists. The same two derivations a real check
 * spends, through the same queue (PasswordBusyError when it is full).
 */
export async function verifyNothing(password: string): Promise<false> {
  await derive(password, DUMMY_SALT, CURRENT, true);
  await derive(password, DUMMY_SALT, LEGACY, true);
  return false;
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}
