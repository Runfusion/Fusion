/*
FNXC:Identity 2026-08-09-03:04:
U6 — THE MACHINE-TOKEN PATH (R7, R11, KTD4). Separate module from `./credentials.ts` BY DESIGN.

This module must never import the password module, and the password module must never import this
one. The reason is a performance cliff with a security shape: a slow KDF is correct for a password
and catastrophic for a token. GitLab measured bcrypt-hashed API keys at ~946ms per request, dropping
to ~4ms once verification moved to HMAC-SHA256; this repo's own password path measures ~212ms per
derivation. A token is presented on EVERY request, so a shared "hash helper" would put a 200ms
derivation on the hot path of every agent tool call. `identity-credentials.test.ts` asserts the
non-sharing at import level so the property survives a refactor that looks harmless in review.

A fast hash is safe here and unsafe there for one reason: a machine token's secret is 256 bits of
CSPRNG output, so there is no dictionary to grind. A password is human-chosen and there is.

TOKEN SHAPE — `prefix_lookupid_secret`:
  - `prefix` identifies what kind of credential this is, so a leaked string is classifiable at a
    glance (and greppable by a secret scanner).
  - `lookupid` is a public, non-secret handle. It is what makes verification an INDEXED single-row
    lookup followed by one constant-time compare. Without it the only way to find the matching row is
    to hash the presented secret and scan — which is precisely the defect in the pre-existing
    `AgentApiKey` shape (`randomBytes(32)` hex, bare unsalted SHA-256, no prefix, no lookup id, no
    expiry). To be exact about the defect: that unsalted SHA-256 is NOT weak at 256 bits of entropy.
    The problem is the missing lookup id, and therefore the table scan.
  - `secret` is the only secret-bearing segment and is never stored anywhere.

`timingSafeEqual` THROWS on a length mismatch rather than returning false, so every compare here is
length-guarded first. An unguarded call converts "attacker sent a differently-sized secret" into a
500, which is a louder oracle than the timing signal the function exists to suppress.
*/

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Credential-class prefixes. Distinct values so a leaked string says what it opens, and so a session
 * value can never be replayed against the machine-token table (the parse rejects the wrong class
 * before any database work happens).
 */
export const TOKEN_PREFIX = {
  /** A long-lived machine token held by an agent or an external integration (R7). */
  machine: "fnm",
  /** An opaque session value (R11). Same construction, different table and different lifetime policy. */
  session: "fns",
  /** An agent API key stored in `project.agent_api_keys` — the migrated `AgentApiKey` format (KTD4). */
  agentKey: "fnk",
} as const;

export type TokenPrefix = (typeof TOKEN_PREFIX)[keyof typeof TOKEN_PREFIX];

/** Bytes of randomness in the public lookup id. Non-secret, but wide enough that ids never collide. */
export const TOKEN_LOOKUP_ID_BYTES = 12;
/** Bytes of randomness in the secret segment. 256 bits — the reason a fast hash is sufficient here. */
export const TOKEN_SECRET_BYTES = 32;

/*
FNXC:Identity 2026-08-09-03:04:
Segments are HEX, not base64url, because the format's separator is `_` and base64url's alphabet
contains `_`. Encoding a secret in base64url would make `prefix_lookupid_secret` ambiguous to parse
and would let a crafted value smuggle an extra separator into the secret segment.
*/
const HEX_SEGMENT = /^[0-9a-f]+$/;

/** A parsed token. `secret` is the ONLY field that must never be logged or persisted. */
export interface ParsedToken {
  prefix: string;
  lookupId: string;
  secret: string;
}

/** A freshly minted token: the display value (returned to the caller exactly once) plus what to store. */
export interface MintedToken {
  /** The full `prefix_lookupid_secret` string. Shown once, never stored. */
  token: string;
  /** Public handle; persist this in an indexed column. */
  lookupId: string;
  /** HMAC-SHA256 of the secret under the server key. Persist this; it is not reversible to the token. */
  secretHash: string;
}

/*
FNXC:Identity 2026-08-09-03:04:
THE SERVER HMAC KEY (a pepper). It is NOT a salt: the secrets are already unique and high-entropy,
so per-row salting buys nothing. What the key buys is that a database dump alone — a backup file, or
the "local shell user reaches Postgres directly" residual the plan accepts — does not let the holder
verify or forge a token without also holding the key, which lives outside the database.

Resolution order is env first, explicit argument at the call site otherwise. When NOTHING is
configured we fall back to a FIXED, PUBLIC constant rather than a random per-process value, and the
choice is deliberate in both directions:
  - A random per-process key would make every token and every session invalid the moment the daemon
    restarts, which destroys R11's durability guarantee outright — the failure would look like random
    logouts, not like a missing setting.
  - A public constant reduces the construction to a plain keyed-but-not-secret hash, i.e. exactly the
    security level `AgentApiKey`'s unsalted SHA-256 already had. So the fallback is NOT a regression,
    and the lookup-id defect this module exists to fix is repaired regardless.
Provisioning a durable per-install key belongs to the unit that owns settings/secrets; until then the
pepper is defense-in-depth that an operator can switch on with an env var.
*/
export const TOKEN_HMAC_KEY_ENV = "FUSION_IDENTITY_HMAC_KEY";
const UNCONFIGURED_TOKEN_HMAC_KEY = "fusion.identity.unconfigured-pepper.v1";

/** Derive the HMAC key material from a secret string. */
export function tokenHmacKeyFromSecret(secret: string): Buffer {
  return Buffer.from(secret, "utf8");
}

/** Resolve the server HMAC key: explicit argument, then `FUSION_IDENTITY_HMAC_KEY`, then the documented public fallback. */
export function resolveTokenHmacKey(explicit?: string | Buffer): Buffer {
  if (explicit !== undefined) {
    return typeof explicit === "string" ? tokenHmacKeyFromSecret(explicit) : explicit;
  }
  const fromEnv = process.env[TOKEN_HMAC_KEY_ENV]?.trim();
  if (fromEnv) return tokenHmacKeyFromSecret(fromEnv);
  return tokenHmacKeyFromSecret(UNCONFIGURED_TOKEN_HMAC_KEY);
}

/** True when a durable pepper is configured; false means the documented public fallback is in use. */
export function isTokenHmacKeyConfigured(): boolean {
  return Boolean(process.env[TOKEN_HMAC_KEY_ENV]?.trim());
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * HMAC-SHA256 over the secret segment. Single pass, ~microseconds — the whole point of KTD4. Never
 * substitute a KDF here, and never route this through `./credentials.ts`.
 */
export function hashTokenSecret(secret: string, key: Buffer | string = resolveTokenHmacKey()): string {
  return createHmac("sha256", typeof key === "string" ? tokenHmacKeyFromSecret(key) : key)
    .update(secret, "utf8")
    .digest("hex");
}

/** Mint a token of `prefix`. The returned `token` is the only time the secret exists outside the caller. */
export function mintToken(prefix: TokenPrefix | string, key: Buffer | string = resolveTokenHmacKey()): MintedToken {
  const lookupId = randomBytes(TOKEN_LOOKUP_ID_BYTES).toString("hex");
  const secret = randomBytes(TOKEN_SECRET_BYTES).toString("hex");
  return {
    token: `${prefix}_${lookupId}_${secret}`,
    lookupId,
    secretHash: hashTokenSecret(secret, key),
  };
}

/**
 * Parse a presented token. Returns null — never throws — for anything malformed, so a garbage bearer
 * header is an authentication failure rather than a 500. Callers do the database lookup ONLY after
 * this returns, so an unparseable value costs no query at all.
 */
export function parseToken(token: string, expectedPrefix?: TokenPrefix | string): ParsedToken | null {
  if (typeof token !== "string") return null;
  const parts = token.trim().split("_");
  if (parts.length !== 3) return null;
  const [prefix, lookupId, secret] = parts;
  if (!prefix || !lookupId || !secret) return null;
  if (!HEX_SEGMENT.test(lookupId) || !HEX_SEGMENT.test(secret)) return null;
  if (expectedPrefix !== undefined && prefix !== expectedPrefix) return null;
  return { prefix, lookupId, secret };
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Constant-time compare of a presented secret against a stored hash, LENGTH-GUARDED because
 * `timingSafeEqual` throws (`ERR_CRYPTO_TIMING_SAFE_EQUAL_DATA_TYPE_OR_LENGTH`) rather than
 * returning false when the two buffers differ in size. A secret that differs in LENGTH from the one
 * that produced the stored hash must fail cleanly — that is a test case, not a theoretical edge.
 *
 * The length guard is on the two HMAC DIGESTS, which are always 32 bytes, so the guard can only fire
 * on a corrupt stored value; the presented secret's own length is absorbed by the HMAC. That is the
 * property that makes this compare genuinely constant-time with respect to attacker input.
 */
export function verifyTokenSecret(
  secret: string,
  storedHash: string,
  key: Buffer | string = resolveTokenHmacKey(),
): boolean {
  if (typeof secret !== "string" || typeof storedHash !== "string" || storedHash.length === 0) return false;
  const computed = Buffer.from(hashTokenSecret(secret, key), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (computed.length === 0 || computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

/** Convenience: parse and verify in one step against an already-fetched stored hash. */
export function verifyToken(
  token: string,
  storedHash: string,
  options?: { expectedPrefix?: TokenPrefix | string; key?: Buffer | string },
): boolean {
  const parsed = parseToken(token, options?.expectedPrefix);
  if (!parsed) return false;
  return verifyTokenSecret(parsed.secret, storedHash, options?.key ?? resolveTokenHmacKey());
}
