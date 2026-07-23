import { describe, expect, it } from "vitest";
import { SecretsSyncError, unwrapSecretsBundle, wrapSecretsBundle } from "../secrets/secrets-sync.js";

describe("secrets-sync", () => {
  const records = [{ key: "A", value: "v", scope: "project" as const, accessPolicy: "auto" as const, envExportable: true, envExportKey: null }];

  it("roundtrips", async () => {
    const envelope = await wrapSecretsBundle(records, "pass");
    const unwrapped = await unwrapSecretsBundle(envelope, "pass");
    expect(unwrapped).toEqual(records);
  });

  it("rejects wrong passphrase", async () => {
    const envelope = await wrapSecretsBundle(records, "pass");
    await expect(unwrapSecretsBundle(envelope, "wrong")).rejects.toMatchObject({ code: "wrong-passphrase" } satisfies Partial<SecretsSyncError>);
  });

  it("rejects version mismatch and malformed payload", async () => {
    const envelope = await wrapSecretsBundle(records, "pass");
    await expect(unwrapSecretsBundle({ ...envelope, version: 2 as 1 }, "pass")).rejects.toMatchObject({ code: "version-mismatch" });
    await expect(unwrapSecretsBundle({ ...envelope, ciphertext: "x" }, "pass")).rejects.toMatchObject({ code: "malformed" });
  });

  it("uses fresh salt and nonce", async () => {
    const a = await wrapSecretsBundle(records, "pass");
    const b = await wrapSecretsBundle(records, "pass");
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
  });
});
