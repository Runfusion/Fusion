import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

describe("even realities plugin", () => {
  it("has expected manifest and settings keys", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-even-realities-glasses");
    expect(Object.keys(plugin.manifest.settingsSchema ?? {}).sort()).toEqual([
      "apiKey",
      "companionWebhookUrl",
      "enableAgentActions",
      "fusionApiBaseUrl",
      "fusionApiToken",
      "glassesDeviceId",
      "notifyOnColumns",
      "pollingIntervalSeconds",
      "quickCaptureDefaultColumn",
    ]);
  });

  it("leaves schema creation to the registered PostgreSQL startup hook", () => {
    /* FNXC:EvenRealitiesPostgres 2026-07-14-17:55: Plugin runtime hooks no longer execute SQLite DDL; core's registered migration-connection hook owns PostgreSQL schema creation. */
    expect(plugin.hooks?.onSchemaInit).toBeUndefined();
  });

  it("returns 503 for unknown instance routes", async () => {
    const ctx = { pluginId: "unknown", settings: {}, logger: console } as never;
    const statusRoute = (plugin.routes ?? []).find((route) => route.method === "GET" && route.path === "/status");
    const actionRoute = (plugin.routes ?? []).find((route) => route.method === "POST" && route.path === "/actions/start-work");

    const statusRes = await statusRoute?.handler({}, ctx);
    const actionRes = await actionRoute?.handler({ body: { taskId: "FN-1" } }, ctx);

    expect(statusRes).toMatchObject({ status: 503, body: { error: expect.any(String) } });
    expect(actionRes).toMatchObject({ status: 503, body: { error: expect.any(String) } });
  });

  it("handles known instance route after load", async () => {
    const layer = { projectId: "known-project", db: {} };
    const ctx = {
      pluginId: "known",
      settings: {
        fusionApiToken: "token",
        fusionApiBaseUrl: "http://localhost:4040",
        companionWebhookUrl: "https://companion.example",
      },
      logger: console,
      taskStore: { getAsyncLayer: () => layer, listTasks: vi.fn(async () => []) },
    } as never;

    await plugin.hooks?.onLoad?.(ctx);
    const statusRoute = (plugin.routes ?? []).find((route) => route.method === "GET" && route.path === "/status");
    const res = await statusRoute?.handler({}, ctx);

    expect(res).toMatchObject({ status: 200, body: { connected: true } });
    await plugin.hooks?.onUnload?.(ctx);
  });
});
