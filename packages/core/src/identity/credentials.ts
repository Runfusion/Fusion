/*
FNXC:Identity 2026-08-09-03:04:
U6 — THE PASSWORD PATH (R7, KTD3). This module is deliberately the ONLY place a deliberately-slow
key derivation function is called, and it deliberately imports nothing from the machine-token module (`./tokens.ts`).

Why the separation is structural rather than stylistic: a slow KDF is CORRECT for a password
(entered by a human, at most a few times a day, where the attacker's advantage is offline guessing)
and WRONG for a machine token (presented on every request, where the secret already carries 256 bits
of entropy so there is nothing to guess). GitLab measured bcrypt-hashed API keys at ~946ms per
request against ~4ms on HMAC-SHA256. If one module owned both, a later "let's reuse the hashing
helper" refactor puts the 200ms KDF on the hot token path and nothing in the type system objects.
`identity-credentials.test.ts` asserts at IMPORT level that this module and `tokens.ts` share no
hashing path, so the separation is enforced rather than merely intended.

KTD3 — WHY scrypt AND NOT Argon2id. OWASP prefers Argon2id (m=19456 KiB, t=2, p=1). Node's stdlib
`crypto.argon2` landed in 24.7, and this repo's CI pins Node 22 (`engines: node >=22.5.0`), so the
stdlib implementation is not available on the supported floor. The WASM alternative named in KTD3,
`argon2id@1.0.1` from the OpenPGP.js team, was evaluated and REJECTED on evidence: its entry point is
`import wasmSIMD from './dist/simd.wasm'`, a bundler-plugin import. Under plain Node ESM — which is
how `@fusion/core` is consumed by `@fusion/engine` after `tsc` emit, with no bundler in the path — it
fails at import time with `ERR_MODULE_NOT_FOUND: Cannot find package 'env' imported from
.../dist/simd.wasm`, because Node's wasm-module resolver tries to resolve the module's `env` import
as a package. It would additionally ship two loose `.wasm` assets that every non-tsup consumer
(desktop packaging in particular) has to stage by hand. KTD3 names `scryptSync` as the sanctioned
fallback for exactly this case.

The scrypt parameter trap KTD3 warns about is real and is proven by test: Node's default `N` is 2^14,
which is BELOW the OWASP floor of 2^17, and raising `N` to the floor throws
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS` ("memory limit exceeded") unless `maxmem` is also raised past its
32 MiB default — scrypt at N=2^17, r=8 needs 128 * N * r = 128 MiB. Measured at 212ms per hash on the
development machine, which is the right order of magnitude for a login and far too slow for a token.
*/

import { randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * FNXC:Identity 2026-08-09-03:04:
 * OWASP's scrypt floor plus the `maxmem` that makes it legal.
 *
 * `N: 1 << 17` is the OWASP minimum work factor. `maxmem` MUST exceed `128 * N * r` (= 128 MiB here)
 * or every call throws before doing any work; the headroom to 192 MiB covers Node's own accounting
 * without inviting a caller to raise `N` again without re-checking. Raising `N` without raising
 * `maxmem` in the same edit is the documented failure mode — `identity-credentials.test.ts` pins it.
 */
export const PASSWORD_SCRYPT_PARAMS = {
  N: 1 << 17,
  r: 8,
  p: 1,
  maxmem: 192 * 1024 * 1024,
} as const;

/** Derived-key length in bytes. */
export const PASSWORD_KEY_LENGTH = 32;
/** Salt length in bytes. Per-password and random: scrypt is not a keyed construction. */
export const PASSWORD_SALT_LENGTH = 16;

/** The algorithm tag written into every stored hash, so a future algorithm swap is detectable. */
const PASSWORD_ALGORITHM = "scrypt";

/** Parsed form of a stored password hash. */
interface ParsedPasswordHash {
  algorithm: string;
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  derived: Buffer;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Stored hashes are SELF-DESCRIBING (`scrypt$N=…,r=…,p=…$salt$hash`, PHC-shaped).
 *
 * The parameters travel with the hash rather than being read from
 * {@link PASSWORD_SCRYPT_PARAMS} at verification time. Without this, the day someone raises `N` every
 * existing operator is locked out of their own install, because their stored hash would be re-derived
 * under parameters it was never produced with. {@link passwordNeedsRehash} is how a raised cost
 * actually reaches old rows: on the next successful login, re-hash and store.
 */
function formatPasswordHash(params: { N: number; r: number; p: number }, salt: Buffer, derived: Buffer): string {
  return [
    PASSWORD_ALGORITHM,
    `N=${params.N},r=${params.r},p=${params.p}`,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split("$");
  if (parts.length !== 4) return null;
  const [algorithm, paramPart, saltPart, hashPart] = parts;
  if (algorithm !== PASSWORD_ALGORITHM) return null;
  const params: Record<string, number> = {};
  for (const entry of paramPart.split(",")) {
    const [key, rawValue] = entry.split("=");
    const value = Number(rawValue);
    if (!key || !Number.isInteger(value) || value <= 0) return null;
    params[key] = value;
  }
  if (!params.N || !params.r || !params.p) return null;
  try {
    const salt = Buffer.from(saltPart, "base64");
    const derived = Buffer.from(hashPart, "base64");
    if (salt.length === 0 || derived.length === 0) return null;
    return { algorithm, N: params.N, r: params.r, p: params.p, salt, derived };
  } catch {
    return null;
  }
}

/**
 * `maxmem` large enough for the parameters actually being used, never smaller than the configured
 * ceiling. A hash stored under a LOWER `N` than today's must still verify, and a hash stored under a
 * higher one (a downgrade of the constant) must not silently throw at verification time.
 */
function maxmemFor(params: { N: number; r: number }): number {
  return Math.max(PASSWORD_SCRYPT_PARAMS.maxmem, 256 * params.N * params.r);
}

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }, keylen: number): Buffer {
  return scryptSync(Buffer.from(password, "utf8"), salt, keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
}

function deriveAsync(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      Buffer.from(password, "utf8"),
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (error, derived) => (error ? reject(error) : resolve(derived as Buffer)),
    );
  });
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * `timingSafeEqual` THROWS `ERR_CRYPTO_TIMING_SAFE_EQUAL_DATA_TYPE_OR_LENGTH` on a length mismatch
 * instead of returning false. Every comparison in the identity path therefore goes through a length
 * guard first: an unguarded call turns "the attacker submitted a differently-sized value" into a
 * 500 rather than a clean authentication failure, and a thrown error is a louder oracle than the
 * timing difference the function exists to hide.
 */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Hash a password for storage. Synchronous variant; prefer {@link hashPassword} on a request path. */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(PASSWORD_SALT_LENGTH);
  const derived = derive(password, salt, PASSWORD_SCRYPT_PARAMS, PASSWORD_KEY_LENGTH);
  return formatPasswordHash(PASSWORD_SCRYPT_PARAMS, salt, derived);
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Async by default because the derivation is ~200ms of CPU by design. `scryptSync` on the daemon's
 * event loop would stall every other in-flight request — including unrelated agent heartbeats — for
 * the duration of one operator's login attempt. The libuv-threadpool callback form does the work off
 * the loop.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_LENGTH);
  const derived = await deriveAsync(password, salt, PASSWORD_SCRYPT_PARAMS, PASSWORD_KEY_LENGTH);
  return formatPasswordHash(PASSWORD_SCRYPT_PARAMS, salt, derived);
}

/** Verify a password against a stored hash. Returns false — never throws — for a malformed stored value. */
export function verifyPasswordSync(password: string, stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const derived = derive(password, parsed.salt, parsed, parsed.derived.length);
  return safeEqual(derived, parsed.derived);
}

/** Async verification. See {@link hashPassword} for why the async form is the default. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const derived = await deriveAsync(password, parsed.salt, parsed, parsed.derived.length);
  return safeEqual(derived, parsed.derived);
}

/**
 * True when `stored` was produced under weaker parameters than {@link PASSWORD_SCRYPT_PARAMS}, or
 * under a different algorithm. The caller re-hashes on the next SUCCESSFUL verification — the only
 * moment the plaintext is legitimately in hand.
 */
export function passwordNeedsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return true;
  return (
    parsed.algorithm !== PASSWORD_ALGORITHM ||
    parsed.N < PASSWORD_SCRYPT_PARAMS.N ||
    parsed.r < PASSWORD_SCRYPT_PARAMS.r ||
    parsed.p < PASSWORD_SCRYPT_PARAMS.p
  );
}
