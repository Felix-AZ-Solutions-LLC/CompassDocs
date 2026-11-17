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
// Memory: at most UV_THREADPOOL_SIZE (default 4) hashes run at once, so the
// peak is about 512 MiB during a burst of sign-ins, freed straight after.

/** The current scrypt parameters: N=2^17, r=8, p=1, a 64-byte key. */
const CURRENT = { N: 2 ** 17, r: 8, p: 1, keylen: 64 } as const;
/** Pre-1.20.27 hashes: Node's scrypt defaults. */
const LEGACY = { N: 2 ** 14, r: 8, p: 1, keylen: 64 } as const;
/** scrypt needs 128·N·r bytes; Node's default maxmem (32 MiB) is too small for N=2^17. */
const MAXMEM = 256 * 1024 * 1024;
const CURRENT_TAG = "s2$";

function derive(password: string, salt: string, params: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = CURRENT_TAG + (await derive(password, salt, CURRENT)).toString("hex");
  return { hash, salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  if (!hash || !salt) return false;
  const current = hash.startsWith(CURRENT_TAG);
  const expected = Buffer.from(current ? hash.slice(CURRENT_TAG.length) : hash, "hex");
  const candidate = await derive(password, salt, current ? CURRENT : LEGACY);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** A stored hash made with older parameters: store the password again after it verifies. */
export function needsRehash(hash: string | null | undefined): boolean {
  return !!hash && !hash.startsWith(CURRENT_TAG);
}

// A hash nobody's password matches, made once, so a sign-in for an unknown,
// disabled or password-less account costs the same scrypt as a real one
// (1.16.0): the response time no longer says whether the account exists.
let dummy: Promise<{ hash: string; salt: string }> | null = null;

/** Spend one password check's worth of work and fail. */
export async function verifyNothing(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(32).toString("hex"));
  const d = await dummy;
  await verifyPassword(password, d.hash, d.salt);
  return false;
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}
