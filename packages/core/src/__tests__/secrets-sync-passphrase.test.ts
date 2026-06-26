import { describe, expect, it } from "vitest";
import { createTestProject } from "./test-project.js";
import {
  RESERVED_SYNC_PASSPHRASE_KEY,
  clearSyncPassphrase,
  getSyncPassphrase,
  hasSyncPassphraseConfigured,
  setSyncPassphrase,
} from "../secrets-sync-passphrase.js";
import { wrapSecretsBundle } from "../secrets-sync.js";
import { CentralCore } from "../central-core.js";
import { MasterKeyManager } from "../master-key.js";
import { SecretsStore, type SecretRecord } from "../secrets-store.js";

async function createSecretsStore(fixture: Awaited<ReturnType<typeof createTestProject>>): Promise<SecretsStore> {
  const central = new CentralCore(fixture.globalDir);
  await central.init();
  const centralDb = (central as unknown as { db: import("../central-db.js").CentralDatabase | null }).db;
  if (!centralDb) {
    throw new Error("central db unavailable");
  }
  const masterKeyManager = new MasterKeyManager({ globalDir: fixture.globalDir });
  return new SecretsStore(fixture.store.getDatabase(), centralDb, () => masterKeyManager.getOrCreateKey());
}

describe("secrets-sync-passphrase", () => {
  it("set/get roundtrips and clear resets to null", async () => {
    const fixture = await createTestProject();
    try {
      const secrets = await createSecretsStore(fixture);
      await setSyncPassphrase(secrets, "pass-1");
      expect(await getSyncPassphrase(secrets)).toBe("pass-1");

      await clearSyncPassphrase(secrets);
      expect(await getSyncPassphrase(secrets)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects empty or whitespace passphrases", async () => {
    const fixture = await createTestProject();
    try {
      const secrets = await createSecretsStore(fixture);
      await expect(setSyncPassphrase(secrets, "")).rejects.toThrow("Sync passphrase must be a non-empty string");
      await expect(setSyncPassphrase(secrets, "   ")).rejects.toThrow("Sync passphrase must be a non-empty string");
    } finally {
      await fixture.cleanup();
    }
  });

  it("re-setting overwrites existing passphrase", async () => {
    const fixture = await createTestProject();
    try {
      const secrets = await createSecretsStore(fixture);
      await setSyncPassphrase(secrets, "first");
      await setSyncPassphrase(secrets, "second");
      expect(await getSyncPassphrase(secrets)).toBe("second");
      expect((await secrets.listSecrets("global")).filter((record) => record.key === RESERVED_SYNC_PASSPHRASE_KEY)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("hasSyncPassphraseConfigured flips false -> true -> false", async () => {
    const fixture = await createTestProject();
    try {
      const secrets = await createSecretsStore(fixture);
      expect(await hasSyncPassphraseConfigured(secrets)).toBe(false);
      await setSyncPassphrase(secrets, "ready");
      expect(await hasSyncPassphraseConfigured(secrets)).toBe(true);
      await clearSyncPassphrase(secrets);
      expect(await hasSyncPassphraseConfigured(secrets)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("stores reserved row with deny access and non-exportable flags", async () => {
    const fixture = await createTestProject();
    try {
      const secrets = await createSecretsStore(fixture);
      await setSyncPassphrase(secrets, "policy-check");
      const row = (await secrets.listSecrets("global")).find((record) => record.key === RESERVED_SYNC_PASSPHRASE_KEY);
      expect(row).toBeTruthy();
      expect(row?.accessPolicy).toBe("deny");
      expect(row?.envExportable).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reserved passphrase row is filtered from wrapped bundles", async () => {
    const fixture = await createTestProject();
    try {
      const secrets = await createSecretsStore(fixture);
      await setSyncPassphrase(secrets, "shared");
      await secrets.createSecret({
        scope: "global",
        key: "REAL_SECRET",
        plaintextValue: "value",
      });

      const passphrase = await getSyncPassphrase(secrets);
      const records = [] as Array<{ key: string; value: string; scope: SecretRecord["scope"]; description?: string | null; accessPolicy: SecretRecord["accessPolicy"]; envExportable: boolean; envExportKey?: string | null }>;
      for (const record of await secrets.listSecrets()) {
        if (record.key === RESERVED_SYNC_PASSPHRASE_KEY) {
          continue;
        }
        const revealed = await secrets.revealSecret(record.id, record.scope, { agentId: null, userId: null });
        records.push({
          key: record.key,
          value: revealed.plaintextValue,
          scope: record.scope,
          description: record.description,
          accessPolicy: record.accessPolicy,
          envExportable: record.envExportable,
          envExportKey: record.envExportKey,
        });
      }

      const envelope = await wrapSecretsBundle(records, passphrase!);
      expect(JSON.stringify(envelope)).not.toContain(RESERVED_SYNC_PASSPHRASE_KEY);
      expect(records.map((record) => record.key)).toEqual(["REAL_SECRET"]);
    } finally {
      await fixture.cleanup();
    }
  });
});
