/*
 * FNXC:WhatsAppPostgresPersistence 2026-07-13-23:40:
 * PostgreSQL persistence coverage uses the repository's reachability-aware harness so unavailable local PostgreSQL skips canonically while available runs prove project isolation, atomic replay claims, overwrites, and destructive auth operations.
 */
import { expect, it, vi } from "vitest";
import type { AsyncDataLayer } from "@fusion/core";
import type { PluginContext } from "@fusion/plugin-sdk";
import { sql } from "drizzle-orm";
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

      await a.appendHistory("15551234", [first], 10);
      await a.appendHistory("15551234", [replacement], 10);
      expect(await a.loadHistory("15551234")).toEqual([first, replacement]);
      expect(await b.loadHistory("15551234")).toEqual([]);

      await a.saveCredentials("a-creds");
      await b.saveCredentials("b-creds");
      await a.writeAuthKeys({
        session: { keep: "a-key", remove: "old-key" },
        "sender-key": { sender: "sender-key-value" },
      });
      await a.writeAuthKeys({ session: { remove: null } });
      expect(await a.loadAuthKeys("session", ["keep", "remove"])).toEqual({ keep: "a-key" });
      expect(await a.loadAuthKeys("sender-key", ["sender"])).toEqual({ sender: "sender-key-value" });
      expect(await b.loadCredentials()).toBe("b-creds");

      await a.clearAuthState();
      expect(await a.loadCredentials()).toBeNull();
      expect(await a.loadAuthKeys("session", ["keep"])).toEqual({});
      expect(await b.loadCredentials()).toBe("b-creds");
    } finally {
      await h.teardown();
    }
  });

  it("preserves every concurrent append for one sender", async () => {
    const h = await createTaskStoreForTest({ prefix: "whatsapp_history_append" });
    try {
      const persistence = createWhatsAppPersistence(context(bind(h.layer, "project-a")));
      const turns = Array.from({ length: 8 }, (_, index) => ({
        role: "user" as const,
        text: `message-${index}`,
        createdAt: `2026-07-14T00:00:0${index}.000Z`,
      }));

      await Promise.all(turns.map((turn) => persistence.appendHistory("15551234", [turn], 20)));

      expect((await persistence.loadHistory("15551234")).map((turn) => turn.text).sort())
        .toEqual(turns.map((turn) => turn.text).sort());
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

  it("prunes only expired dedupe rows inside the bound project", async () => {
    const h = await createTaskStoreForTest({ prefix: "whatsapp_retention" });
    try {
      const persistence = createWhatsAppPersistence(context(bind(h.layer, "project-a")));
      const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const recent = new Date(Date.now() - 3_600_000).toISOString();
      await h.adminDb.execute(sql`INSERT INTO project.whatsapp_chat_dedupe(project_id, message_id, sender, received_at)
        VALUES ('project-a', 'old-id', 'sender', ${old}), ('project-a', 'recent-id', 'sender', ${recent}),
          ('project-b', 'old-id', 'sender', ${old})`);

      await persistence.markProcessed("new-id", "sender", 7);

      expect(await persistence.wasProcessed("old-id")).toBe(false);
      expect(await persistence.wasProcessed("recent-id")).toBe(true);
      expect(await persistence.wasProcessed("new-id")).toBe(true);
      const otherProject = createWhatsAppPersistence(context(bind(h.layer, "project-b")));
      expect(await otherProject.wasProcessed("old-id")).toBe(true);
    } finally {
      await h.teardown();
    }
  });
});
