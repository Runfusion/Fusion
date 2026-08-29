import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSecretCipher,
  SecretCryptoError,
  redactForLog,
  type EncryptedSecret,
  type MasterKeyProvider,
} from "../secrets/secrets-crypto.js";

function createCachedProvider(key?: Buffer): MasterKeyProvider {
  const resolved = key ?? randomBytes(32);
  return async () => resolved;
}

function randomUtf8Text(length: number): string {
  return randomBytes(length).toString("base64").slice(0, length);
}

describe("secrets-crypto", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it.each(["hello", "こんにちは世界", "🙂🔒 secret", "", randomUtf8Text(4096)])(
    "roundtrips plaintext: %s",
    async (plaintext) => {
      const cipher = createSecretCipher(createCachedProvider());
      const encrypted = await cipher.encrypt(plaintext);
      const decrypted = await cipher.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    },
  );

  it("uses unique nonces and distinct ciphertexts for repeated plaintext", async () => {
    const cipher = createSecretCipher(createCachedProvider());
    const nonceSet = new Set<string>();
    const ciphertextSet = new Set<string>();

    for (let i = 0; i < 100; i += 1) {
      const encrypted = await cipher.encrypt("same-secret");
      nonceSet.add(encrypted.nonce.toString("hex"));
      ciphertextSet.add(encrypted.ciphertext.toString("hex"));
    }

    expect(nonceSet.size).toBe(100);
    expect(ciphertextSet.size).toBe(100);
  });

  it("fails decrypt on tamper, wrong key, and invalid shapes", async () => {
    const key = randomBytes(32);
    const cipher = createSecretCipher(createCachedProvider(key));
    const encrypted = await cipher.encrypt("sensitive-value");

    const mutatedPayload: EncryptedSecret = {
      nonce: Buffer.from(encrypted.nonce),
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    mutatedPayload.ciphertext[0] ^= 0xff;

    await expect(cipher.decrypt(mutatedPayload)).rejects.toMatchObject({
      code: "decryption-failed",
    });

    const mutatedTag: EncryptedSecret = {
      nonce: Buffer.from(encrypted.nonce),
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    mutatedTag.ciphertext[mutatedTag.ciphertext.length - 1] ^= 0xff;

    await expect(cipher.decrypt(mutatedTag)).rejects.toMatchObject({
      code: "decryption-failed",
    });

    const mutatedNonce: EncryptedSecret = {
      nonce: Buffer.from(encrypted.nonce),
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    mutatedNonce.nonce[0] ^= 0xff;

    await expect(cipher.decrypt(mutatedNonce)).rejects.toMatchObject({
      code: "decryption-failed",
    });

    const wrongKeyCipher = createSecretCipher(createCachedProvider(randomBytes(32)));
    await expect(wrongKeyCipher.decrypt(encrypted)).rejects.toMatchObject({
      code: "decryption-failed",
    });

    await expect(
      cipher.decrypt({ nonce: Buffer.from("123"), ciphertext: Buffer.from(encrypted.ciphertext) }),
    ).rejects.toMatchObject({ code: "invalid-nonce-length" });

    await expect(
      cipher.decrypt({ nonce: Buffer.from(encrypted.nonce), ciphertext: Buffer.alloc(15) }),
    ).rejects.toMatchObject({ code: "invalid-ciphertext" });
  });

  it("rejects non-32-byte master keys", async () => {
    const shortKeyCipher = createSecretCipher(async () => Buffer.alloc(31));
    await expect(shortKeyCipher.encrypt("x")).rejects.toMatchObject({ code: "invalid-key-length" });
    await expect(
      shortKeyCipher.decrypt({ nonce: randomBytes(12), ciphertext: Buffer.concat([Buffer.from("a"), Buffer.alloc(16)]) }),
    ).rejects.toMatchObject({ code: "invalid-key-length" });
  });

  it("does not leak plaintext or key/ciphertext bytes through console output", async () => {
    const plaintext = "super-secret-plaintext";
    const key = randomBytes(32);
    const keyHex = key.toString("hex");
    const cipher = createSecretCipher(createCachedProvider(key));
    const encrypted = await cipher.encrypt(plaintext);
    const ciphertextHex = encrypted.ciphertext.toString("hex");

    await cipher.decrypt(encrypted);

    const tampered = {
      nonce: Buffer.from(encrypted.nonce),
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    tampered.ciphertext[0] ^= 0xff;
    await expect(cipher.decrypt(tampered)).rejects.toBeInstanceOf(SecretCryptoError);

    const calls = [
      ...logSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ];

    for (const call of calls) {
      const serialized = call
        .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
        .join(" ");
      expect(serialized).not.toContain(plaintext);
      expect(serialized).not.toContain(keyHex);
      expect(serialized).not.toContain(ciphertextHex);
    }
  });

  it("does not leak sensitive values in error message or stack", async () => {
    const plaintext = "ultra-sensitive-token";
    const key = randomBytes(32);
    const keyHex = key.toString("hex");
    const cipher = createSecretCipher(createCachedProvider(key));
    const encrypted = await cipher.encrypt(plaintext);

    const tampered = {
      nonce: Buffer.from(encrypted.nonce),
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    tampered.ciphertext[0] ^= 0xff;

    await expect(cipher.decrypt(tampered)).rejects.toMatchObject({
      code: "decryption-failed",
      message: "secret decryption failed",
    });

    const wrongKeyCipher = createSecretCipher(createCachedProvider(randomBytes(32)));
    const wrongKeyError = await wrongKeyCipher.decrypt(encrypted).catch((error: unknown) => error as Error);

    for (const error of [
      await cipher.decrypt(tampered).catch((caught: unknown) => caught as Error),
      wrongKeyError,
    ]) {
      const stack = error.stack ?? "";
      expect(error.message).not.toContain(plaintext);
      expect(error.message).not.toContain(keyHex);
      expect(error.message).not.toContain(encrypted.ciphertext.toString("hex"));
      expect(stack).not.toContain(plaintext);
      expect(stack).not.toContain(keyHex);
      expect(stack).not.toContain(encrypted.ciphertext.toString("hex"));
    }
  });

  it("redactForLog is stable and non-reversible", () => {
    const first = redactForLog("alpha-secret");
    const second = redactForLog("alpha-secret");
    const third = redactForLog("beta-secret");

    expect(first).toMatch(/^\[REDACTED:[0-9a-f]{8}\]$/);
    expect(first).toBe(second);
    expect(first).not.toBe(third);
  });
});
