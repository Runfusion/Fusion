import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";

const connectionInstances: Array<{
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  requestPairingCode: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
}> = [];

/**
 * FNXC:WhatsAppPluginTest 2026-06-17-10:07:
 * Vitest 4 requires vi.fn() mocks used with new to use a function or class implementation; an arrow-backed mock makes new WhatsAppConnection(...) throw TypeError because the implementation is not constructable.
 */
vi.mock("../connection.js", () => {
  const ctor = vi.fn(function WhatsAppConnectionMock(ctx: PluginContext) {
    const root = ctx.taskStore.getRootDir();
    const instance = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({ state: "open", jid: root })),
      requestPairingCode: vi.fn(async () => "123-456"),
      logout: vi.fn(async () => {}),
    };
    connectionInstances.push(instance);
    return instance;
  });
  (ctor as unknown as { splitMessageForWhatsapp: (text: string) => string[] }).splitMessageForWhatsapp =
    (text: string) => (text.length > 4096 ? [text.slice(0, 4096), text.slice(4096, 8192), text.slice(8192)] : [text]);
  return { WhatsAppConnection: ctor };
});

import plugin, { ensureSchema, getDedupeRetentionDays, markProcessed, splitMessageForWhatsapp, wasProcessed } from "../index.js";
import { WhatsAppConnection } from "../connection.js";

function createInMemoryDb() {
  const dedupe = new Map<string, { sender: string; receivedAt: string }>();

  return {
    exec(_sql: string) {},
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes("FROM whatsapp_chat_dedupe") && sql.includes("messageId = ?")) {
            const row = dedupe.get(args[0] as string);
            return row ? { found: 1, ...row } : undefined;
          }
          return undefined;
        },
        run: (...args: unknown[]) => {
          if (sql.includes("INSERT INTO whatsapp_chat_dedupe")) {
            dedupe.set(args[0] as string, {
              sender: args[1] as string,
              receivedAt: args[2] as string,
            });
          }
          if (sql.includes("DELETE FROM whatsapp_chat_dedupe WHERE receivedAt < ?")) {
            const cutoff = args[0] as string;
            for (const [id, row] of dedupe.entries()) {
              if (row.receivedAt < cutoff) dedupe.delete(id);
            }
          }
        },
      };
    },
    _dedupe: dedupe,
  };
}

describe("whatsapp plugin", () => {
  beforeEach(() => {
    connectionInstances.length = 0;
    vi.clearAllMocks();
  });
  it("registers schema init hook", () => {
    expect(plugin.hooks?.onSchemaInit).toBeDefined();
  });

  it("registers pairing routes", () => {
    const paths = (plugin.routes ?? []).map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain("GET /status");
    expect(paths).toContain("GET /qr");
    expect(paths).toContain("POST /pair-code");
    expect(paths).toContain("POST /logout");
  });

  it("uses only pairing-era settings", () => {
    const schema = plugin.manifest.settingsSchema ?? {};
    expect(Object.keys(schema).sort()).toEqual([
      "agentSystemPrompt",
      "allowedSenders",
      "dedupeRetentionDays",
      "historyTurnLimit",
      "pairingMode",
      "pairingPhoneNumber",
    ]);
  });

  it("splits oversized messages", () => {
    const chunks = splitMessageForWhatsapp("x".repeat(9000));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBeLessThanOrEqual(4096);
  });
});

describe("multi-project isolation", () => {
  it("keeps project contexts isolated with shared plugin id", async () => {
    const db = createInMemoryDb();
    const makeCtx = (rootDir: string): PluginContext => ({
      pluginId: "fusion-plugin-whatsapp-chat",
      settings: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      emitEvent: vi.fn(),
      taskStore: {
        getRootDir: () => rootDir,
        getPluginStore: () => ({
          db,
        }),
      } as unknown as PluginContext["taskStore"],
    });

    const ctxA = makeCtx("/repo-a");
    const ctxB = makeCtx("/repo-b");

    await plugin.hooks!.onLoad!(ctxA);
    await plugin.hooks!.onLoad!(ctxB);

    expect(WhatsAppConnection).toHaveBeenCalledTimes(2);
    expect(connectionInstances[0]?.start).toHaveBeenCalledTimes(1);
    expect(connectionInstances[1]?.start).toHaveBeenCalledTimes(1);

    const statusRoute = plugin.routes!.find((route) => route.method === "GET" && route.path === "/status")!;

    const statusA = await statusRoute.handler({} as never, ctxA) as { status: number; body: unknown };
    const statusB = await statusRoute.handler({} as never, ctxB) as { status: number; body: unknown };
    expect(statusA.status).toBe(200);
    expect((statusA.body as { jid: string }).jid).toBe("/repo-a");
    expect(statusB.status).toBe(200);
    expect((statusB.body as { jid: string }).jid).toBe("/repo-b");

    await plugin.hooks!.onUnload!(ctxA);
    expect(connectionInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(connectionInstances[1]?.stop).not.toHaveBeenCalled();

    const afterUnloadA = await statusRoute.handler({} as never, ctxA) as { status: number; body: unknown };
    const afterUnloadB = await statusRoute.handler({} as never, ctxB) as { status: number; body: unknown };
    expect(afterUnloadA.status).toBe(503);
    expect(afterUnloadB.status).toBe(200);
    expect((afterUnloadB.body as { jid: string }).jid).toBe("/repo-b");

    await plugin.hooks!.onUnload!(ctxB);
    expect(connectionInstances[1]?.stop).toHaveBeenCalledTimes(1);

    const finalStatusA = await statusRoute.handler({} as never, ctxA) as { status: number; body: unknown };
    const finalStatusB = await statusRoute.handler({} as never, ctxB) as { status: number; body: unknown };
    expect(finalStatusA.status).toBe(503);
    expect(finalStatusB.status).toBe(503);
  });
});

describe("markProcessed retention", () => {
  it("prunes rows older than retention and keeps recent rows", () => {
    const db = createInMemoryDb();
    ensureSchema(db as any);
    const now = Date.now();

    db.prepare("INSERT INTO whatsapp_chat_dedupe(messageId, sender, receivedAt) VALUES(?, ?, ?)").run(
      "old-id",
      "sender",
      new Date(now - 30 * 86_400_000).toISOString(),
    );
    db.prepare("INSERT INTO whatsapp_chat_dedupe(messageId, sender, receivedAt) VALUES(?, ?, ?)").run(
      "recent-id",
      "sender",
      new Date(now - 3_600_000).toISOString(),
    );

    markProcessed(db as any, "new-id", "sender", 7);

    const oldRow = db.prepare("SELECT 1 as found FROM whatsapp_chat_dedupe WHERE messageId = ?").get("old-id") as { found?: number } | undefined;
    const recentRow = db.prepare("SELECT 1 as found FROM whatsapp_chat_dedupe WHERE messageId = ?").get("recent-id") as { found?: number } | undefined;
    expect(Boolean(oldRow?.found)).toBe(false);
    expect(Boolean(recentRow?.found)).toBe(true);
    expect(wasProcessed(db as any, "new-id")).toBe(true);
  });

  it("keeps entries inside retention window", () => {
    const db = createInMemoryDb();
    ensureSchema(db as any);

    db.prepare("INSERT INTO whatsapp_chat_dedupe(messageId, sender, receivedAt) VALUES(?, ?, ?)").run(
      "one-day-old-id",
      "sender",
      new Date(Date.now() - 86_400_000).toISOString(),
    );

    markProcessed(db as any, "new-id", "sender", 7);

    const oneDayOld = db.prepare("SELECT 1 as found FROM whatsapp_chat_dedupe WHERE messageId = ?").get("one-day-old-id") as { found?: number } | undefined;
    expect(Boolean(oneDayOld?.found)).toBe(true);
  });

  it("parses dedupeRetentionDays safely", () => {
    expect(getDedupeRetentionDays({})).toBe(7);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: undefined })).toBe(7);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: null })).toBe(7);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: 0 })).toBe(7);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: -3 })).toBe(7);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: "foo" })).toBe(7);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: Number.POSITIVE_INFINITY })).toBe(7);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: 14 })).toBe(14);
    expect(getDedupeRetentionDays({ dedupeRetentionDays: 3.7 })).toBe(3);
  });
});
