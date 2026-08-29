import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import type { SecretAccessPolicy } from "../types.js";
import type { SecretScope } from "./secrets-store.js";

function deriveKey(
  passphrase: string,
  salt: Buffer,
  keyLen: number,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      passphrase,
      salt,
      keyLen,
      {
        ...params,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey as Buffer);
      },
    );
  });
}

export interface WrappedSecretsBundle {
  ciphertext: string;
  salt: string;
  nonce: string;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; keyLen: number };
  version: 1;
}

export class SecretsSyncError extends Error {
  constructor(public readonly code: "wrong-passphrase" | "version-mismatch" | "malformed", message: string) {
    super(message);
    this.name = "SecretsSyncError";
  }
}

export interface SecretsSyncRecord {
  key: string;
  value: string;
  scope: SecretScope;
  description?: string | null;
  accessPolicy: SecretAccessPolicy;
  envExportable: boolean;
  envExportKey: string | null;
}

const DEFAULT_KDF_PARAMS = { N: 32768, r: 8, p: 1, keyLen: 32 } as const;
// TODO(FN-4867): migrate to Argon2id when a vetted workspace implementation is available.

export async function wrapSecretsBundle(records: SecretsSyncRecord[], passphrase: string): Promise<WrappedSecretsBundle> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(passphrase, salt, DEFAULT_KDF_PARAMS.keyLen, DEFAULT_KDF_PARAMS);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const payload = Buffer.from(JSON.stringify(records), "utf8");
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([encrypted, authTag]);

  return {
    ciphertext: packed.toString("base64"),
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    kdf: "scrypt",
    kdfParams: { ...DEFAULT_KDF_PARAMS },
    version: 1,
  };
}

export async function unwrapSecretsBundle(envelope: WrappedSecretsBundle, passphrase: string): Promise<SecretsSyncRecord[]> {
  if (envelope.version !== 1) {
    throw new SecretsSyncError("version-mismatch", "Unsupported envelope version");
  }

  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const nonce = Buffer.from(envelope.nonce, "base64");
    const packed = Buffer.from(envelope.ciphertext, "base64");
    const authTag = packed.subarray(packed.length - 16);
    const encrypted = packed.subarray(0, packed.length - 16);

    const key = await deriveKey(passphrase, salt, envelope.kdfParams.keyLen, envelope.kdfParams);

    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(decrypted);
    if (!Array.isArray(parsed)) {
      throw new SecretsSyncError("malformed", "Envelope payload is not a record array");
    }
    return parsed as SecretsSyncRecord[];
  } catch (error) {
    if (error instanceof SecretsSyncError) {
      throw error;
    }
    if (error instanceof Error && /unable to authenticate data/i.test(error.message)) {
      throw new SecretsSyncError("wrong-passphrase", "Failed to decrypt envelope with supplied passphrase");
    }
    throw new SecretsSyncError("malformed", "Malformed secrets envelope");
  }
}
