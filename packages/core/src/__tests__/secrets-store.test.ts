import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestProject } from "./test-project.js";
import { CentralCore } from "../central-core.js";
import { MasterKeyManager } from "../master-key.js";
import { SecretsStore } from "../secrets-store.js";

async function createSecretsStore(auditEmitter?: (event: any) => void) {
  const fixture = await createTestProject();
  const central = new CentralCore(fixture.globalDir);
  await central.init();
  const centralDb = (central as unknown as { db: import("../central-db.js").CentralDatabase | null }).db;
  if (!centralDb) throw new Error("central db unavailable");
  const masterKeyManager = new MasterKeyManager({ globalDir: fixture.globalDir });
  const store = new SecretsStore(fixture.store.getDatabase(), centralDb, () => masterKeyManager.getOrCreateKey(), { auditEmitter });
  return { fixture, store };
}

describe("SecretsStore audit emitter", () => {
  const emitter = vi.fn();

  beforeEach(() => {
    emitter.mockReset();
  });

  it("emits create/update/delete/read without secret values", async () => {
    const { fixture, store } = await createSecretsStore(emitter);
    try {
      const created = await store.createSecret({ scope: "project", key: "API_KEY", plaintextValue: "secret-a" });
      await store.updateSecret(created.id, "project", { plaintextValue: "secret-b", key: "API_KEY_2" });
      await store.revealSecret(created.id, "project", { agentId: "agent-1" });
      await store.deleteSecret(created.id, "project");

      expect(emitter).toHaveBeenCalledTimes(4);
      for (const event of emitter.mock.calls.map((call) => call[0])) {
        expect(event).toHaveProperty("key");
        expect(event).toHaveProperty("scope");
        expect(event).not.toHaveProperty("plaintextValue");
        expect(event).not.toHaveProperty("value");
        expect(event).not.toHaveProperty("ciphertext");
        expect(event).not.toHaveProperty("nonce");
      }
      expect(emitter.mock.calls[2][0]).toMatchObject({ mutationType: "secret:read", actor: { agentId: "agent-1" } });
    } finally {
      await fixture.cleanup();
    }
  });

  it("swallows emitter exceptions", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { fixture, store } = await createSecretsStore(() => {
      throw new Error("boom");
    });
    try {
      await expect(store.createSecret({ scope: "project", key: "API_KEY", plaintextValue: "secret-a" })).resolves.toBeTruthy();
    } finally {
      warnSpy.mockRestore();
      await fixture.cleanup();
    }
  });
});

describe("SecretsStore.listEnvExportable", () => {
  it("returns empty for empty store", async () => {
    const { fixture, store } = await createSecretsStore();
    try {
      await expect(store.listEnvExportable()).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("filters exportables, applies keyPrefix, prefers project collisions, and skips decrypt failures", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { fixture, store } = await createSecretsStore();
    try {
      const project = await store.createSecret({
        scope: "project",
        key: "STRIPE_PROJECT",
        plaintextValue: "project-value",
        envExportable: true,
        envExportKey: "STRIPE_KEY",
      });
      await store.createSecret({
        scope: "global",
        key: "STRIPE_GLOBAL",
        plaintextValue: "global-value",
        envExportable: true,
        envExportKey: "STRIPE_KEY",
      });
      await store.createSecret({
        scope: "project",
        key: "PLAIN",
        plaintextValue: "plain-value",
        envExportable: true,
      });
      const broken = await store.createSecret({
        scope: "project",
        key: "STRIPE_BROKEN",
        plaintextValue: "broken",
        envExportable: true,
      });
      await store.createSecret({
        scope: "project",
        key: "HIDDEN",
        plaintextValue: "hidden",
        envExportable: false,
      });

      fixture.store.getDatabase().prepare("UPDATE secrets SET value_ciphertext = ? WHERE id = ?").run(Buffer.from("bad"), broken.id);

      const all = await store.listEnvExportable();
      expect(all.map((item) => item.exportKey).sort()).toEqual(["PLAIN", "STRIPE_KEY"]);
      expect(all.find((item) => item.exportKey === "STRIPE_KEY")?.id).toBe(project.id);
      expect(all.find((item) => item.exportKey === "STRIPE_KEY")?.scope).toBe("project");

      const prefixed = await store.listEnvExportable({ keyPrefix: "STRIPE_" });
      expect(prefixed.map((item) => item.exportKey)).toEqual(["STRIPE_KEY"]);

      expect(debugSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      await fixture.cleanup();
    }
  });
});
