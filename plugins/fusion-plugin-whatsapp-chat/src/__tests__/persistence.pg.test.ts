/*
 * FNXC:WhatsAppPostgresPersistence 2026-07-13-23:40:
 * PostgreSQL persistence coverage uses the repository's reachability-aware harness so unavailable local PostgreSQL skips canonically while available runs prove project isolation, atomic replay claims, overwrites, and destructive auth operations.
 */
import { expect, it, vi } from "vitest";
import type { AsyncDataLayer } from "@fusion/core";
import type { PluginContext } from "@fusion/plugin-sdk";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../../packages/core/src/__test-utils__/pg-test-harness.js";
import { createWhatsAppPersistence } from "../persistence.js";

function bind(layer: AsyncDataLayer, projectId: string): AsyncDataLayer {
  return { ...layer, projectId };
}

function context(layer: AsyncDataLayer): PluginContext {
  return {
    pluginId: "fusion-plugin-whatsapp-chat",
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: { getAsyncLayer: () => layer } as unknown as PluginContext["taskStore"],
  };
}

pgDescribe("WhatsAppPersistence PostgreSQL", () => {
  it("round-trips and destructively updates state without crossing projects", async () => {
    const h = await createTaskStoreForTest({ prefix: "whatsapp_persistence" });
    try {
      const a = createWhatsAppPersistence(context(bind(h.layer, "project-a")));
      const b = createWhatsAppPersistence(context(bind(h.layer, "project-b")));
      const first = { role: "user" as const, text: "hello", createdAt: "2026-07-13T00:00:00.000Z" };
      const replacement = { role: "assistant" as const, text: "updated", createdAt: "2026-07-13T00:01:00.000Z" };

      await a.saveHistory("15551234", [first]);
      await a.saveHistory("15551234", [replacement]);
      expect(await a.loadHistory("15551234")).toEqual([replacement]);
      expect(await b.loadHistory("15551234")).toEqual([]);

      await a.saveCredentials("a-creds");
      await b.saveCredentials("b-creds");
      await a.writeAuthKeys("session", { keep: "a-key", remove: "old-key" });
      await a.writeAuthKeys("session", { remove: null });
      expect(await a.loadAuthKeys("session", ["keep", "remove"])).toEqual({ keep: "a-key" });
      expect(await b.loadCredentials()).toBe("b-creds");

      await a.clearAuthState();
      expect(await a.loadCredentials()).toBeNull();
      expect(await a.loadAuthKeys("session", ["keep"])).toEqual({});
      expect(await b.loadCredentials()).toBe("b-creds");
    } finally {
      await h.teardown();
    }
  });

  it("allows exactly one concurrent duplicate-delivery claimant per project", async () => {
    const h = await createTaskStoreForTest({ prefix: "whatsapp_claim" });
    try {
      const a = createWhatsAppPersistence(context(bind(h.layer, "project-a")));
      const b = createWhatsAppPersistence(context(bind(h.layer, "project-b")));

      const claims = await Promise.all(
        Array.from({ length: 8 }, () => a.claimMessage("same-message", "15551234", 7)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await a.wasProcessed("same-message")).toBe(true);
      expect(await b.claimMessage("same-message", "15551234", 7)).toBe(true);
    } finally {
      await h.teardown();
    }
  });
});
