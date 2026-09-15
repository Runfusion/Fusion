// @vitest-environment node

/*
FNXC:UiStyleAxis 2026-09-15-00:20:
FN-399's `uiStyle` is a GLOBAL appearance preference. It must round-trip through the real
`GET/PUT /settings/global` routes backed by a real isolated `GlobalSettingsStore`, and the generic
project endpoint must keep refusing it as a global-only key so no project override can ever exist.
Writes must carry only the requested keys, so choosing a style never rewrites a colour preference.
*/

import express from "express";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSettingsStore, GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS } from "@fusion/core";
import { registerSettingsMemoryRoutes } from "../register-settings-memory-routes.js";
import { request as performRequest } from "../../test-request.js";

function createApp(globalDir: string) {
  const router = express.Router();
  const globalStore = new GlobalSettingsStore(globalDir);

  const scopedStore = {
    getSettings: vi.fn(async () => ({})),
    getSettingsFast: vi.fn(async () => ({})),
    getRootDir: vi.fn(() => globalDir),
    getFusionDir: vi.fn(() => join(globalDir, ".fusion")),
    getAsyncLayer: vi.fn(() => undefined),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  };

  const store = {
    getGlobalSettingsStore: () => globalStore,
    getSettings: async () => globalStore.getSettings(),
    updateGlobalSettings: async (patch: Record<string, unknown>) => globalStore.updateSettings(patch),
  };

  registerSettingsMemoryRoutes(
    {
      router,
      options: {},
      store: store as never,
      runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      getProjectContext: vi.fn(async () => ({
        store: scopedStore,
        engine: { getProjectId: () => "p1", getRoutineStore: () => undefined },
        projectId: "p1",
      })) as never,
      rethrowAsApiError: (err: unknown) => {
        throw err;
      },
    } as never,
    {
      githubToken: undefined,
      validateModelPresets: vi.fn(() => undefined),
      sanitizeBooleanSetting: vi.fn(() => undefined),
      sanitizeOverlapIgnorePaths: vi.fn(() => undefined),
      discoverDashboardPiExtensions: vi.fn(async () => ({ manifestPaths: [], disabledIds: [] })),
    } as never,
  );

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((err: never, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const error = err as { statusCode?: number; message?: string };
    res.status(error?.statusCode ?? 500).json({ error: error?.message ?? String(err) });
  });

  return { app, globalStore, scopedStore };
}

describe("uiStyle global settings routes", () => {
  let globalDir: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "fn-399-ui-style-"));
  });

  afterEach(async () => {
    await rm(globalDir, { recursive: true, force: true });
  });

  it("classifies uiStyle as a global-only settings key", () => {
    expect(GLOBAL_SETTINGS_KEYS as readonly string[]).toContain("uiStyle");
    expect(PROJECT_SETTINGS_KEYS as readonly string[]).not.toContain("uiStyle");
  });

  it("returns the default interface style from GET /settings/global on a fresh install", async () => {
    const { app } = createApp(globalDir);

    const res = await performRequest(app, "GET", "/api/settings/global");

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).uiStyle).toBe("classic");
  });

  it("round-trips a clean selection through PUT then GET without touching colour preferences", async () => {
    const { app, globalStore } = createApp(globalDir);
    await globalStore.updateSettings({ colorTheme: "ocean", themeMode: "light" });

    const put = await performRequest(
      app,
      "PUT",
      "/api/settings/global",
      JSON.stringify({ uiStyle: "clean" }),
      { "Content-Type": "application/json" },
    );
    expect(put.status).toBe(200);

    const get = await performRequest(app, "GET", "/api/settings/global");
    const settings = get.body as Record<string, unknown>;
    expect(settings.uiStyle).toBe("clean");
    expect(settings.colorTheme).toBe("ocean");
    expect(settings.themeMode).toBe("light");

    // A fresh store instance must observe the same durable value.
    await expect(new GlobalSettingsStore(globalDir).getSettings()).resolves.toMatchObject({
      uiStyle: "clean",
      colorTheme: "ocean",
    });
  });

  it("normalizes an unknown interface style written through the route back to classic", async () => {
    const { app } = createApp(globalDir);

    const put = await performRequest(
      app,
      "PUT",
      "/api/settings/global",
      JSON.stringify({ uiStyle: "epure" }),
      { "Content-Type": "application/json" },
    );
    expect(put.status).toBe(200);

    const get = await performRequest(app, "GET", "/api/settings/global");
    expect((get.body as Record<string, unknown>).uiStyle).toBe("classic");
  });

  it("refuses uiStyle on the project settings endpoint and never writes a project override", async () => {
    const { app, scopedStore } = createApp(globalDir);

    const res = await performRequest(
      app,
      "PUT",
      "/api/settings",
      JSON.stringify({ uiStyle: "clean" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("uiStyle");
    expect(scopedStore.updateSettings).not.toHaveBeenCalled();
  });
});
