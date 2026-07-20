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

import plugin, { getDedupeRetentionDays, splitMessageForWhatsapp } from "../index.js";
import { WhatsAppConnection } from "../connection.js";
import { createWhatsAppPersistence } from "../persistence.js";

describe("whatsapp plugin", () => {
  beforeEach(() => {
    connectionInstances.length = 0;
    vi.clearAllMocks();
  });
  it("leaves schema creation to the registered PostgreSQL startup hook", () => {
    /* FNXC:WhatsAppPostgresPersistence 2026-07-14-18:05: Runtime hooks no longer expose SQLite DDL; the core migration connection owns the registered WhatsApp PostgreSQL schema hook. */
    expect(plugin.hooks?.onSchemaInit).toBeUndefined();
  });

  it("fails closed without a project-bound AsyncDataLayer", () => {
    const ctx = (layer: unknown) => ({
      taskStore: { getAsyncLayer: () => layer },
    }) as unknown as PluginContext;
    expect(() => createWhatsAppPersistence(ctx(null))).toThrow("requires a PostgreSQL AsyncDataLayer");
    expect(() => createWhatsAppPersistence(ctx({ projectId: "" }))).toThrow("project-bound");
  });

  it("registers pairing routes", () => {
    const paths = (plugin.routes ?? []).map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain("GET /status");
    expect(paths).toContain("GET /qr");
    expect(paths).toContain("POST /pair-code");
    expect(paths).toContain("POST /logout");
  });

  it("returns pairing data in status for the settings panel", async () => {
    const ctx = {
      pluginId: "fusion-plugin-whatsapp-chat",
      settings: { allowedSenders: ["15550001111"] },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
      taskStore: {
        getRootDir: () => "/repo-status",
        getAsyncLayer: () => ({ projectId: "/repo-status" }),
      },
    } as unknown as PluginContext;
    await plugin.hooks!.onLoad!(ctx);
    connectionInstances[0]?.getStatus.mockReturnValue({
      state: "awaiting-qr",
      qrDataUrl: "data:image/png;base64,pairing",
      pairingCode: "123-456",
    });

    const statusRoute = plugin.routes!.find((route) => route.method === "GET" && route.path === "/status")!;
    const response = await statusRoute.handler({} as never, ctx) as { status: number; body: Record<string, unknown> };

    expect(response).toMatchObject({
      status: 200,
      body: {
        status: "awaiting-qr",
        qrDataUrl: "data:image/png;base64,pairing",
        pairingCode: "123-456",
        allowedSenders: ["15550001111"],
      },
    });
    await plugin.hooks!.onUnload!(ctx);
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
        getAsyncLayer: () => ({ projectId: rootDir }),
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

describe("dedupe retention settings", () => {
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
