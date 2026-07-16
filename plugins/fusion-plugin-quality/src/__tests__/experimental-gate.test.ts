import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "@fusion/core";
import { ensureQualitySchema } from "../quality-schema.js";
import {
  createQualityRoutes,
  loadTaskStoreSettings,
  requireQualityExperimental,
} from "../routes/create-routes.js";

function makeCtx(getSettings?: () => unknown) {
  const db = new DatabaseSync(":memory:");
  ensureQualitySchema(db as never);
  return {
    taskStore: {
      getDatabase: () => db,
      getAsyncLayer: () => ({ projectId: "proj-1", db: { execute: vi.fn().mockResolvedValue([]) } }),
      getSettings: getSettings ?? (() => Promise.resolve({})),
      getRootDir: () => "/tmp",
      getTask: vi.fn(),
    },
    settings: {},
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as never;
}

describe("Quality experimental gate settings load", () => {
  it("awaits async getSettings and reads experimentalFeatures", async () => {
    const settings = await loadTaskStoreSettings(
      makeCtx(() =>
        Promise.resolve({
          experimentalFeatures: { qualityPlugin: true },
          testCommand: "pnpm test",
        }),
      ),
    );
    expect(settings.experimentalFeatures).toEqual({ qualityPlugin: true });
    expect(settings.testCommand).toBe("pnpm test");
  });

  it("treats a bare Promise getSettings result as disabled when features are missing", async () => {
    await expect(requireQualityExperimental(makeCtx(() => Promise.resolve({})))).rejects.toMatchObject({
      message: expect.stringContaining("experimentalFeatures.qualityPlugin"),
      statusCode: 404,
    });
  });

  it("allows the gate when qualityPlugin is true on merged settings", async () => {
    await expect(
      requireQualityExperimental(
        makeCtx(() => Promise.resolve({ experimentalFeatures: { qualityPlugin: true } })),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("createQualityRoutes experimental wrapping", () => {
  it("returns a structured 404 when the experimental flag is off (async settings)", async () => {
    const routes = createQualityRoutes();
    const presets = routes.find((r) => r.method === "GET" && r.path === "/presets");
    expect(presets).toBeDefined();
    const result = await presets!.handler({}, makeCtx(() => Promise.resolve({ experimentalFeatures: {} })));
    expect(result).toEqual({
      status: 404,
      body: {
        error: "Quality plugin is experimental; enable experimentalFeatures.qualityPlugin to use it",
      },
    });
  });

  it("passes through when experimentalFeatures.qualityPlugin is true", async () => {
    const routes = createQualityRoutes();
    const presets = routes.find((r) => r.method === "GET" && r.path === "/presets");
    const result = await presets!.handler(
      {},
      makeCtx(() => Promise.resolve({ experimentalFeatures: { qualityPlugin: true } })),
    );
    expect(result).toMatchObject({ presets: expect.any(Array) });
  });

  it("lists runs when enabled (regression: async settings used to always 404)", async () => {
    const routes = createQualityRoutes();
    const list = routes.find((r) => r.method === "GET" && r.path === "/runs");
    const result = await list!.handler(
      { query: { projectId: "proj-1" } },
      makeCtx(() => Promise.resolve({ experimentalFeatures: { qualityPlugin: true } })),
    );
    expect(result).toEqual({ runs: [] });
  });
});
