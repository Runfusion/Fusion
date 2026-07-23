/**
 * Secret crypto primitives for at-rest secret protection.
 *
 * Security contract:
 * - Uses AES-256-GCM via Node's built-in crypto module.
 * - Uses a fresh random 12-byte nonce for every encrypt call.
 * - Appends the 16-byte GCM auth tag to the returned ciphertext buffer.
 * - Never logs or throws plaintext, key material, or raw ciphertext bytes.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const NONCE_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const REDACTED_PREFIX_LENGTH_HEX = 8;

/**
 * Async provider that resolves a 32-byte AES-256 master key.
 */
export type MasterKeyProvider = () => Promise<Buffer>;

/**
 * AES-GCM encrypted secret payload.
 *
 * `ciphertext` includes the auth tag appended as the trailing 16 bytes.
 */
export interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * Non-sensitive error type for secret crypto failures.
 *
 * Messages are fixed, non-revealing strings and never include secret data.
 */
export class SecretCryptoError extends Error {
  readonly code:
    | "invalid-key-length"
    | "invalid-nonce-length"
    | "decryption-failed"
    | "invalid-ciphertext";

  constructor(params: {
    code:
      | "invalid-key-length"
      | "invalid-nonce-length"
      | "decryption-failed"
      | "invalid-ciphertext";
    message: string;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = "SecretCryptoError";
    this.code = params.code;
    if (params.cause !== undefined) {
      this.cause = params.cause;
    }
  }
}

/**
 * Return a stable, non-reversible secret log reference.
 *
 * The output format is `[REDACTED:<sha256-first-8-hex>]`.
 */
export function redactForLog(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `[REDACTED:${digest.slice(0, REDACTED_PREFIX_LENGTH_HEX)}]`;
}

function toValidatedKey(rawKey: Buffer): Buffer {
  if (rawKey.length !== 32) {
    throw new SecretCryptoError({
      code: "invalid-key-length",
      message: "secret key length is invalid",
    });
  }

  return Buffer.from(rawKey);
}

function assertEncryptedSecretShape(encrypted: EncryptedSecret): void {
  if (encrypted.nonce.length !== NONCE_LENGTH_BYTES) {
    throw new SecretCryptoError({
      code: "invalid-nonce-length",
      message: "secret nonce length is invalid",
    });
  }

  if (encrypted.ciphertext.length < AUTH_TAG_LENGTH_BYTES) {
    throw new SecretCryptoError({
      code: "invalid-ciphertext",
      message: "secret ciphertext is invalid",
    });
  }
}

/**
 * Create an AES-256-GCM secret cipher bound to a master-key provider.
 */
export function createSecretCipher(provider: MasterKeyProvider): {
  encrypt(plaintext: string): Promise<EncryptedSecret>;
  decrypt(encrypted: EncryptedSecret): Promise<string>;
} {
  return {
    async encrypt(plaintext: string): Promise<EncryptedSecret> {
      if (typeof plaintext !== "string") {
        throw new SecretCryptoError({
          code: "invalid-ciphertext",
          message: "secret plaintext is invalid",
        });
      }

      const rawKey = await provider();
      const key = toValidatedKey(rawKey);

      try {
        const nonce = randomBytes(NONCE_LENGTH_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        const payload = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const authTag = cipher.getAuthTag();

        return {
          ciphertext: Buffer.concat([payload, authTag]),
          nonce,
        };
      } finally {
        key.fill(0);
      }
    },

    async decrypt(encrypted: EncryptedSecret): Promise<string> {
      assertEncryptedSecretShape(encrypted);

      const rawKey = await provider();
      const key = toValidatedKey(rawKey);

      try {
        const payloadEnd = encrypted.ciphertext.length - AUTH_TAG_LENGTH_BYTES;
        const payload = encrypted.ciphertext.subarray(0, payloadEnd);
        const authTag = encrypted.ciphertext.subarray(payloadEnd);

        try {
          const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce);
          decipher.setAuthTag(authTag);
          const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
          return plaintext.toString("utf8");
        } catch {
          throw new SecretCryptoError({
            code: "decryption-failed",
            message: "secret decryption failed",
          });
        }
      } finally {
        key.fill(0);
      }
    },
  };
}
