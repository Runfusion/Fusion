/**
 * FNXC:Identity 2026-08-09-03:04:
 * U6 — the password path (KTD3) and the machine-token path (KTD4).
 *
 * What these tests exist to catch, beyond "hashing works":
 *   - `scrypt` at the OWASP floor THROWS at Node's default `maxmem`. A change that raises `N` without
 *     raising `maxmem` in the same edit breaks every login, and nothing else in the suite notices.
 *     The parameter test asserts BOTH directions — naive params throw, configured params do not — so
 *     it fails loudly rather than silently passing under a weakened constant.
 *   - `timingSafeEqual` throws on a length mismatch instead of returning false, so an unguarded
 *     compare turns "attacker sent a differently-sized secret" into a 500.
 *   - The password module and the token module must not share a hashing path. This is asserted at
 *     IMPORT level because the failure mode is a well-intentioned refactor ("reuse the hash helper")
 *     that puts a ~200ms KDF on every agent tool call — a performance cliff no behavioural test in
 *     this file would notice.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID, scryptSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTaskStoreForTest, pgDescribe } from "../__test-utils__/pg-test-harness.js";
import {
  findApiKeyByLookupId,
  insertApiKey,
  writeAgent,
} from "../async-stores/async-agent-store.js";
import {
  PASSWORD_SCRYPT_PARAMS,
  hashPassword,
  hashPasswordSync,
  passwordNeedsRehash,
  verifyPassword,
  verifyPasswordSync,
} from "../identity/credentials.js";
import {
  TOKEN_PREFIX,
  hashTokenSecret,
  mintToken,
  parseToken,
  resolveTokenHmacKey,
  tokenHmacKeyFromSecret,
  verifyToken,
  verifyTokenSecret,
} from "../identity/tokens.js";

describe("identity credentials: password path (KTD3)", () => {
  it("verifies a correct password and rejects an incorrect one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("never stores the plaintext password", async () => {
    const stored = await hashPassword("hunter2-is-not-a-good-password");
    expect(stored).not.toContain("hunter2");
    expect(stored.startsWith("scrypt$")).toBe(true);
  });

  it("salts per password, so two identical passwords produce different stored values", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  /*
   * FNXC:Identity 2026-08-09-03:04:
   * The KTD3 trap, pinned in both directions. The first assertion is what fails if someone "simplifies"
   * the params object by dropping `maxmem`; the second is what fails if `N` is quietly lowered back
   * under the OWASP floor, since the naive call would then stop throwing.
   */
  it("throws at Node's default maxmem and succeeds at the configured limit", () => {
    const salt = randomBytes(16);
    expect(() =>
      scryptSync("pw", salt, 32, {
        N: PASSWORD_SCRYPT_PARAMS.N,
        r: PASSWORD_SCRYPT_PARAMS.r,
        p: PASSWORD_SCRYPT_PARAMS.p,
      }),
    ).toThrow(/memory limit exceeded|Invalid scrypt param/i);

    expect(() => scryptSync("pw", salt, 32, { ...PASSWORD_SCRYPT_PARAMS })).not.toThrow();
  });

  it("keeps N at or above the OWASP floor of 2^17", () => {
    expect(PASSWORD_SCRYPT_PARAMS.N).toBeGreaterThanOrEqual(1 << 17);
    // 128 * N * r is scrypt's own REQUIREMENT floor, not the factor this module allocates at:
    // `maxmemFor` uses SCRYPT_MAXMEM_FACTOR (256) for headroom. Asserting the floor here proves the
    // configured constant is legal at all; the factor is asserted where it is defined.
    expect(PASSWORD_SCRYPT_PARAMS.maxmem).toBeGreaterThan(
      128 * PASSWORD_SCRYPT_PARAMS.N * PASSWORD_SCRYPT_PARAMS.r,
    );
  });

  it("does not throw on a malformed or truncated stored hash", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$N=1", "scrypt$N=0,r=8,p=1$aaaa$bbbb", "argon2$x$y$z"]) {
      expect(await verifyPassword("whatever", bad)).toBe(false);
    }
  });

  it("verifies a hash stored under weaker parameters and flags it for rehash", () => {
    // A hash produced under the pre-upgrade default: self-describing, so it must still verify.
    const salt = randomBytes(16);
    const weak = scryptSync("legacy-password", salt, 32, { N: 1 << 14, r: 8, p: 1 });
    const stored = `scrypt$N=${1 << 14},r=8,p=1$${salt.toString("base64")}$${weak.toString("base64")}`;
    expect(verifyPasswordSync("legacy-password", stored)).toBe(true);
    expect(verifyPasswordSync("wrong", stored)).toBe(false);
    expect(passwordNeedsRehash(stored)).toBe(true);
    expect(passwordNeedsRehash(hashPasswordSync("fresh"))).toBe(false);
  });
});

describe("identity credentials: machine tokens (KTD4)", () => {
  const key = tokenHmacKeyFromSecret("test-pepper");

  it("mints a prefix_lookupid_secret token and stores only a lookup id and an HMAC", () => {
    const minted = mintToken(TOKEN_PREFIX.machine, key);
    const parsed = parseToken(minted.token, TOKEN_PREFIX.machine);
    expect(parsed).not.toBeNull();
    expect(parsed!.lookupId).toBe(minted.lookupId);
    // The stored material must not contain the secret in any form.
    expect(minted.secretHash).not.toContain(parsed!.secret);
    expect(minted.token).not.toContain(minted.secretHash);
    expect(minted.secretHash).toBe(hashTokenSecret(parsed!.secret, key));
  });

  it("verifies a valid token by lookup id plus constant-time compare", () => {
    const minted = mintToken(TOKEN_PREFIX.machine, key);
    expect(verifyToken(minted.token, minted.secretHash, { expectedPrefix: TOKEN_PREFIX.machine, key })).toBe(true);
  });

  /*
   * FNXC:Identity 2026-08-09-03:04:
   * The lookup id is PUBLIC, so "right handle, wrong secret" is the attacker's actual position. It
   * must fail on the compare, not on the lookup.
   */
  it("rejects a valid lookup id paired with a wrong secret", () => {
    const minted = mintToken(TOKEN_PREFIX.machine, key);
    const parsed = parseToken(minted.token, TOKEN_PREFIX.machine)!;
    const forged = `${TOKEN_PREFIX.machine}_${parsed.lookupId}_${"0".repeat(parsed.secret.length)}`;
    const reparsed = parseToken(forged, TOKEN_PREFIX.machine)!;
    expect(reparsed.lookupId).toBe(minted.lookupId);
    expect(verifyToken(forged, minted.secretHash, { expectedPrefix: TOKEN_PREFIX.machine, key })).toBe(false);
  });

  /*
   * FNXC:Identity 2026-08-09-03:04:
   * `timingSafeEqual` THROWS on a length mismatch. This asserts the guard by comparing the raw
   * result, not by catching — a throw here would fail the test as an unhandled error, which is
   * exactly the regression signal wanted.
   */
  it("rejects a secret that differs in LENGTH without throwing", () => {
    const minted = mintToken(TOKEN_PREFIX.machine, key);
    const parsed = parseToken(minted.token, TOKEN_PREFIX.machine)!;
    expect(verifyTokenSecret(parsed.secret.slice(0, 8), minted.secretHash, key)).toBe(false);
    expect(verifyTokenSecret(`${parsed.secret}deadbeef`, minted.secretHash, key)).toBe(false);
    expect(verifyTokenSecret("", minted.secretHash, key)).toBe(false);
    // And a stored hash of the wrong length must also fail rather than throw.
    expect(verifyTokenSecret(parsed.secret, minted.secretHash.slice(0, 10), key)).toBe(false);
    expect(verifyTokenSecret(parsed.secret, "", key)).toBe(false);
  });

  it("refuses a token whose prefix belongs to another credential class", () => {
    const session = mintToken(TOKEN_PREFIX.session, key);
    expect(parseToken(session.token, TOKEN_PREFIX.machine)).toBeNull();
    expect(verifyToken(session.token, session.secretHash, { expectedPrefix: TOKEN_PREFIX.machine, key })).toBe(false);
    expect(verifyToken(session.token, session.secretHash, { expectedPrefix: TOKEN_PREFIX.session, key })).toBe(true);
  });

  it("returns null for malformed tokens instead of querying or throwing", () => {
    for (const bad of ["", "fnm", "fnm_only-two", "fnm_a_b_c", "fnm__secret", "fnm_ZZZZ_abc", "fnm_abc_ZZZZ"]) {
      expect(parseToken(bad, TOKEN_PREFIX.machine)).toBeNull();
    }
  });

  it("binds the hash to the server key, so a different pepper does not verify", () => {
    const minted = mintToken(TOKEN_PREFIX.machine, key);
    const other = tokenHmacKeyFromSecret("a-different-pepper");
    expect(verifyToken(minted.token, minted.secretHash, { expectedPrefix: TOKEN_PREFIX.machine, key: other })).toBe(
      false,
    );
  });

  it("resolves a deterministic key so tokens survive a daemon restart (R11)", () => {
    // A random per-process key would invalidate every session on restart.
    expect(resolveTokenHmacKey().equals(resolveTokenHmacKey())).toBe(true);
  });
});

/*
FNXC:Identity 2026-08-09-03:04:
KTD4's separation, asserted structurally rather than by behaviour.

Behavioural tests cannot see this: merging the two paths would leave every assertion above green
while making each agent tool call ~200ms. So the assertions are on the module graph and on the
source text — the token module must not reach the password module (directly or transitively) and
must not name a KDF at all.
*/
describe("identity credentials: the password path and the token path are separate (KTD4)", () => {
  const tokensSource = readFileSync(fileURLToPath(new URL("../identity/tokens.ts", import.meta.url)), "utf8");
  const credentialsSource = readFileSync(
    fileURLToPath(new URL("../identity/credentials.ts", import.meta.url)),
    "utf8",
  );

  function importSpecifiers(source: string): string[] {
    return [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  }

  it("the token module does not import the password module", () => {
    expect(importSpecifiers(tokensSource)).not.toContain("./credentials.js");
    expect(tokensSource).not.toContain("credentials.js");
  });

  it("the password module does not import the token module", () => {
    expect(importSpecifiers(credentialsSource)).not.toContain("./tokens.js");
    expect(credentialsSource).not.toContain("tokens.js");
  });

  it("the token module never calls a slow KDF", () => {
    for (const kdf of ["scrypt", "pbkdf2", "argon2", "bcrypt"]) {
      // Comments in this module discuss the password path; only CALLS matter.
      expect(tokensSource).not.toMatch(new RegExp(`${kdf}(Sync)?\\s*\\(`, "i"));
    }
  });

  it("the token module does not reach the password module transitively", () => {
    const tokensUrl = new URL("../identity/tokens.ts", import.meta.url);
    const seen = new Set<string>();
    const queue = [tokensUrl];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const path = fileURLToPath(current);
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      expect(path.endsWith("credentials.ts")).toBe(false);
      const source = readFileSync(path, "utf8");
      for (const kdf of ["scrypt", "pbkdf2", "argon2", "bcrypt"]) {
        expect(source).not.toMatch(new RegExp(`${kdf}(Sync)?\\s*\\(`, "i"));
      }
      for (const spec of importSpecifiers(source)) {
        if (!spec.startsWith(".")) continue;
        queue.push(new URL(spec.replace(/\.js$/, ".ts"), current));
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("the password module never uses the token module's fast HMAC construction for passwords", () => {
    expect(credentialsSource).not.toMatch(/createHmac\s*\(/);
  });

  it("the agent API-key mint path hashes through the token module, never the password module", () => {
    const agentStoreSource = readFileSync(
      fileURLToPath(new URL("../agents/agent-store.ts", import.meta.url)),
      "utf8",
    );
    expect(agentStoreSource).toContain("identity/tokens.js");
    expect(agentStoreSource).not.toContain("identity/credentials.js");
    // The pre-U6 bare-SHA-256 mint must be gone, not merely bypassed.
    expect(agentStoreSource).not.toMatch(/createHash\s*\(\s*["']sha256["']\s*\)/);
  });

  it("the two modules produce different verifiers for the same input", async () => {
    const secret = "a".repeat(64);
    const passwordHash = await hashPassword(secret);
    const tokenHash = hashTokenSecret(secret, tokenHmacKeyFromSecret("pepper"));
    expect(passwordHash).not.toBe(tokenHash);
    // A token hash is not a valid stored password hash, and vice versa.
    expect(await verifyPassword(secret, tokenHash)).toBe(false);
    expect(verifyTokenSecret(secret, passwordHash, tokenHmacKeyFromSecret("pepper"))).toBe(false);
  });
});

/*
FNXC:Identity 2026-08-09-03:04:
KTD4's agent-key migration, against a real database.

The pre-U6 `AgentApiKey` mint stored a bare unsalted SHA-256 with no lookup id, so the ONLY possible
verification was "hash the presented value and scan the table". These tests assert the replacement:
a single-row resolution on the token's public lookup id, and a legacy row that is unreachable through
that path by construction (rather than silently reinstating the scan as a fallback).
*/
pgDescribe("identity credentials: agent API keys use the KTD4 format", () => {
  it("resolves a minted key by its lookup id and refuses a wrong secret", async () => {
    const projectId = "p-identity-keys";
    const h = await createTaskStoreForTest({ prefix: "fusion_agentkeys", projectId });
    try {
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      await writeAgent(h.layer.db, {
        id: agentId,
        name: `Seed ${agentId}`,
        role: "worker",
        state: "active",
        createdAt: now,
        updatedAt: now,
        metadata: {},
      } as never, projectId);

      const minted = mintToken(TOKEN_PREFIX.agentKey);
      await insertApiKey(h.layer.db, {
        id: `key-${randomUUID().slice(0, 8)}`,
        agentId,
        lookupId: minted.lookupId,
        secretHash: minted.secretHash,
        createdAt: now,
      }, projectId);

      const parsed = parseToken(minted.token, TOKEN_PREFIX.agentKey)!;
      const found = await findApiKeyByLookupId(h.layer.db, parsed.lookupId, projectId);
      expect(found).not.toBeNull();
      expect(found!.agentId).toBe(agentId);
      // The raw token is never persisted; only the lookup id and the HMAC are.
      expect(JSON.stringify(found)).not.toContain(parsed.secret);
      expect(verifyTokenSecret(parsed.secret, found!.secretHash!)).toBe(true);
      expect(verifyTokenSecret(`${parsed.secret.slice(0, -2)}ff`, found!.secretHash!)).toBe(false);
      // A length-differing secret must fail cleanly, not throw.
      expect(verifyTokenSecret(parsed.secret.slice(0, 10), found!.secretHash!)).toBe(false);

      // An unknown lookup id resolves to nothing rather than falling back to a scan.
      expect(await findApiKeyByLookupId(h.layer.db, "ff".repeat(12), projectId)).toBeNull();
      // Missing project scope must not fall open to an unscoped lookup.
      expect(await findApiKeyByLookupId(h.layer.db, parsed.lookupId)).toBeNull();
      expect(await findApiKeyByLookupId(h.layer.db, parsed.lookupId, "   ")).toBeNull();
    } finally {
      await h.teardown();
    }
  });

  it("leaves LEGACY pre-U6 rows unreachable through the lookup path", async () => {
    const projectId = "p-identity-keys-legacy";
    const h = await createTaskStoreForTest({ prefix: "fusion_agentkeys_legacy", projectId });
    try {
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      await writeAgent(h.layer.db, {
        id: agentId,
        name: `Seed ${agentId}`,
        role: "worker",
        state: "active",
        createdAt: now,
        updatedAt: now,
        metadata: {},
      } as never, projectId);
      // The old shape: a bare SHA-256, no lookup id, no prefix.
      await insertApiKey(h.layer.db, {
        id: `key-${randomUUID().slice(0, 8)}`,
        agentId,
        tokenHash: "a".repeat(64),
        createdAt: now,
      }, projectId);

      expect(await findApiKeyByLookupId(h.layer.db, "a".repeat(64), projectId)).toBeNull();
      expect(await findApiKeyByLookupId(h.layer.db, "")).toBeNull();
    } finally {
      await h.teardown();
    }
  });
});
