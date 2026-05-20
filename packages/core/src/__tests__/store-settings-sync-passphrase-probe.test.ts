import { describe, expect, it, vi } from "vitest";
import { createTestProject } from "./test-project.js";
import { clearSyncPassphrase, setSyncPassphrase } from "../secrets-sync-passphrase.js";
import { CentralCore } from "../central-core.js";
import { MasterKeyManager } from "../master-key.js";
import { SecretsStore } from "../secrets-store.js";

async function createSecretsStore(fixture: Awaited<ReturnType<typeof createTestProject>>): Promise<SecretsStore> {
  const central = new CentralCore(fixture.globalDir);
  await central.init();
  const centralDb = (central as unknown as { db: import("../central-db.js").CentralDatabase | null }).db;
  if (!centralDb) throw new Error("central db unavailable");
  const masterKeyManager = new MasterKeyManager({ globalDir: fixture.globalDir });
  return new SecretsStore(fixture.store.getDatabase(), centralDb, () => masterKeyManager.getOrCreateKey());
}

describe("TaskStore secretsSyncPassphraseConfigured probe", () => {
  it("returns false when reserved passphrase row is absent", async () => {
    const fixture = await createTestProject();
    try {
      expect((await fixture.store.getSettings()).secretsSyncPassphraseConfigured).toBe(false);
      expect((await fixture.store.getSettingsFast()).secretsSyncPassphraseConfigured).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("flips false -> true -> false as passphrase is set and cleared", async () => {
    const fixture = await createTestProject();
    try {
      const secrets = await createSecretsStore(fixture);
      const spy = vi.spyOn(fixture.store, "getSecretsStore").mockResolvedValue(secrets);
      expect((await fixture.store.getSettings()).secretsSyncPassphraseConfigured).toBe(false);

      await setSyncPassphrase(secrets, "pp");
      expect((await fixture.store.getSettings()).secretsSyncPassphraseConfigured).toBe(true);
      expect((await fixture.store.getSettingsFast()).secretsSyncPassphraseConfigured).toBe(true);

      await clearSyncPassphrase(secrets);
      expect((await fixture.store.getSettings()).secretsSyncPassphraseConfigured).toBe(false);
      expect((await fixture.store.getSettingsFast()).secretsSyncPassphraseConfigured).toBe(false);
      spy.mockRestore();
    } finally {
      await fixture.cleanup();
    }
  });

  it("exposes probe under global scope only", async () => {
    const fixture = await createTestProject();
    try {
      const byScope = await fixture.store.getSettingsByScope();
      const byScopeFast = await fixture.store.getSettingsByScopeFast();
      expect(byScope.global.secretsSyncPassphraseConfigured).toBe(false);
      expect(byScopeFast.global.secretsSyncPassphraseConfigured).toBe(false);
      expect(byScope.project).not.toHaveProperty("secretsSyncPassphraseConfigured");
      expect(byScopeFast.project).not.toHaveProperty("secretsSyncPassphraseConfigured");
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not persist writable overrides from updateSettings", async () => {
    const fixture = await createTestProject();
    try {
      await fixture.store.updateSettings({ secretsSyncPassphraseConfigured: true });
      expect((await fixture.store.getSettings()).secretsSyncPassphraseConfigured).toBe(false);

      await fixture.store.updateGlobalSettings({ secretsSyncPassphraseConfigured: true });
      expect((await fixture.store.getSettings()).secretsSyncPassphraseConfigured).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("falls back to false when secrets store lookup throws", async () => {
    const fixture = await createTestProject();
    try {
      const spy = vi.spyOn(fixture.store, "getSecretsStore").mockRejectedValueOnce(new Error("boom"));
      await expect(fixture.store.getSettings()).resolves.toMatchObject({ secretsSyncPassphraseConfigured: false });
      spy.mockRestore();
    } finally {
      await fixture.cleanup();
    }
  });
});
