// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";

import { createPluginRouter } from "../plugin-routes.js";
import { get as performGet, request as performRequest } from "../test-request.js";

describe("createPluginRouter wiring under /api/plugins", () => {
  function buildApp() {
    const enablePlugin = vi.fn(async (id: string) => ({ id, enabled: true }));
    const pluginStore = {
      listPlugins: vi.fn(async () => [{ id: "test-plugin", name: "Test Plugin", enabled: false }]),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: false, manifest: { id, name: id, version: "1.0.0", description: "" } })),
      enablePlugin,
      disablePlugin: vi.fn(),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;

    const taskStore = {
      listTasks: vi.fn(async () => []),
    } as any;

    const helloHandler = vi.fn(async () => ({ ok: true }));
    const collidingEnableHandler = vi.fn(async () => ({ pluginEnable: true }));
    const taskStoreHandler = vi.fn(async (_req: unknown, ctx: { taskStore: { listTasks: () => Promise<unknown[]> } }) => {
      await ctx.taskStore.listTasks();
      return { usedTaskStore: true };
    });

    const pluginLoader = {
      getPlugin: vi.fn((id: string) => {
        if (id === "test-plugin" || id === "collision-plugin") {
          return { manifest: { id } };
        }
        return undefined;
      }),
      createRouteContext: vi.fn(async (_id: string, overrides: { taskStore: unknown; settings: Record<string, unknown> }) => ({
        pluginId: "test-plugin",
        taskStore: overrides.taskStore,
        settings: overrides.settings,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      })),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const pluginRunner = {
      getPluginRoutes: vi.fn(() => [
        { pluginId: "test-plugin", route: { method: "GET", path: "/hello", handler: helloHandler } },
        { pluginId: "test-plugin", route: { method: "GET", path: "/use-task-store", handler: taskStoreHandler } },
        { pluginId: "collision-plugin", route: { method: "POST", path: "/enable", handler: collidingEnableHandler } },
      ]),
    } as any;

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner, taskStore));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    return {
      app,
      pluginStore,
      taskStore,
      handlers: { helloHandler, collidingEnableHandler, taskStoreHandler },
    };
  }

  it("resolves plugin-defined dynamic GET route", async () => {
    const { app } = buildApp();
    const res = await performGet(app, "/api/plugins/test-plugin/hello");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("keeps management routes working alongside dynamic routes", async () => {
    const { app, pluginStore } = buildApp();

    const list = await performGet(app, "/api/plugins/");
    expect(list.status).toBe(200);
    expect(pluginStore.listPlugins).toHaveBeenCalled();

    const enable = await performRequest(app, "POST", "/api/plugins/test-plugin/enable");
    expect(enable.status).toBe(200);
    expect(pluginStore.enablePlugin).toHaveBeenCalledWith("test-plugin");
  });

  it("prioritizes management /:id/enable over plugin-defined /enable route collisions", async () => {
    const { app, pluginStore, handlers } = buildApp();

    const res = await performRequest(app, "POST", "/api/plugins/collision-plugin/enable");
    expect(res.status).toBe(200);
    expect(pluginStore.enablePlugin).toHaveBeenCalledWith("collision-plugin");
    expect(handlers.collidingEnableHandler).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/plugins/does-not-exist/anything", 404],
    ["GET", "/api/plugins/missing/hello", 404],
  ])("returns %i for unknown plugin IDs (%s %s)", async (method, path, expectedStatus) => {
    const { app } = buildApp();
    const res = await performRequest(app, method as "GET", path);
    expect(res.status).toBe(expectedStatus);
  });

  it("plumbs default taskStore to plugin route context", async () => {
    const { app, taskStore, handlers } = buildApp();

    const res = await performGet(app, "/api/plugins/test-plugin/use-task-store");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ usedTaskStore: true });
    expect(taskStore.listTasks).toHaveBeenCalled();
    expect(handlers.taskStoreHandler).toHaveBeenCalled();
  });

  /*
  FNXC:PluginRoutes 2026-07-22-09:55:
  UI-only / --no-engine dashboards pass pluginRunner=undefined (Grok dual-remediation)
  while still loading plugins on pluginLoader. Compound Engineering's bundled view then
  painted while /sessions and /artifacts hit the catch-all 404 "Not found". Mount routes
  from the loader when the runner is absent so CE and other plugin APIs stay reachable.
  */
  it("mounts plugin-defined routes from pluginLoader when pluginRunner is undefined", async () => {
    const sessionsHandler = vi.fn(async () => ({ sessions: [] }));
    const artifactsHandler = vi.fn(async () => ({ groups: [], totalArtifacts: 0, totalErrors: 0 }));
    const startHandler = vi.fn(async () => ({ session: { id: "ce-1", status: "launching" } }));

    const pluginStore = {
      listPlugins: vi.fn(async () => [{ id: "fusion-plugin-compound-engineering", name: "Compound Engineering", enabled: true }]),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: true, manifest: { id, name: id, version: "0.1.0", description: "" } })),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;

    const pluginLoader = {
      getPlugin: vi.fn((id: string) => (id === "fusion-plugin-compound-engineering" ? { manifest: { id } } : undefined)),
      getPluginRoutes: vi.fn(() => [
        { pluginId: "fusion-plugin-compound-engineering", route: { method: "GET", path: "/sessions", handler: sessionsHandler } },
        { pluginId: "fusion-plugin-compound-engineering", route: { method: "GET", path: "/artifacts", handler: artifactsHandler } },
        { pluginId: "fusion-plugin-compound-engineering", route: { method: "POST", path: "/sessions", handler: startHandler } },
      ]),
      createRouteContext: vi.fn(async () => ({
        pluginId: "fusion-plugin-compound-engineering",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      })),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const app = express();
    app.use(express.json());
    // No pluginRunner — mirrors UI-only dashboard wiring.
    app.use("/api/plugins", createPluginRouter(pluginStore, pluginLoader, undefined, {} as any));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    const sessions = await performGet(app, "/api/plugins/fusion-plugin-compound-engineering/sessions");
    expect(sessions.status).toBe(200);
    expect(sessions.body).toEqual({ sessions: [] });
    expect(sessionsHandler).toHaveBeenCalled();

    const artifacts = await performGet(app, "/api/plugins/fusion-plugin-compound-engineering/artifacts");
    expect(artifacts.status).toBe(200);
    expect(artifacts.body).toEqual({ groups: [], totalArtifacts: 0, totalErrors: 0 });
    expect(artifactsHandler).toHaveBeenCalled();

    const started = await performRequest(
      app,
      "POST",
      "/api/plugins/fusion-plugin-compound-engineering/sessions",
      JSON.stringify({ stage: "strategy" }),
      { "content-type": "application/json" },
    );
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ session: { id: "ce-1", status: "launching" } });
    expect(startHandler).toHaveBeenCalled();
  });

  /*
  FNXC:PluginRoutes 2026-07-22-20:30:
  Plugin routes were a boot-time snapshot of the launch loader. Two failure modes survived
  the loader-mount fix above: a plugin enabled AFTER boot rendered its dashboard view
  (served live) while its API routes 404'd until restart, and a plugin enabled only in a
  NON-LAUNCH project never got routes at all. Dispatch is per-request now — these tests
  pin both invariants.
  */
  it("serves routes for a plugin enabled after the router was created (no restart)", async () => {
    const helloHandler = vi.fn(async () => ({ ok: true }));
    const routeTable: Array<{ pluginId: string; route: { method: string; path: string; handler: unknown } }> = [];

    const pluginStore = {
      listPlugins: vi.fn(async () => []),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: true, manifest: { id, name: id, version: "1.0.0", description: "" } })),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;

    const pluginLoader = {
      getPlugin: vi.fn((id: string) => (id === "late-plugin" && routeTable.length > 0 ? { manifest: { id } } : undefined)),
      getPluginRoutes: vi.fn(() => [...routeTable]),
      createRouteContext: vi.fn(async () => ({
        pluginId: "late-plugin",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      })),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStore, pluginLoader, undefined, {} as any));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    // Before enable: no routes exist for the plugin.
    const before = await performGet(app, "/api/plugins/late-plugin/hello");
    expect(before.status).toBe(404);

    // Enable-after-boot: the loader's route table grows; no router rebuild or restart.
    routeTable.push({ pluginId: "late-plugin", route: { method: "GET", path: "/hello", handler: helloHandler } });

    const after = await performGet(app, "/api/plugins/late-plugin/hello");
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ ok: true });
    expect(helloHandler).toHaveBeenCalled();
  });

  it("serves routes from the request's project-scoped loader and executes against it", async () => {
    const projectHandler = vi.fn(async () => ({ project: true }));

    const pluginStore = {
      listPlugins: vi.fn(async () => []),
      getPlugin: vi.fn(async (id: string) => ({ id, settings: {}, enabled: true, manifest: { id, name: id, version: "1.0.0", description: "" } })),
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
      updatePluginSettings: vi.fn(),
      updatePluginState: vi.fn(),
    } as any;

    // Launch/host loader has NO plugins — mirrors a daemon launched from a project
    // where the plugin is not enabled.
    const hostLoader = {
      getPlugin: vi.fn(() => undefined),
      getPluginRoutes: vi.fn(() => []),
      createRouteContext: vi.fn(),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const projectRouteContext = {
      pluginId: "project-only-plugin",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    };
    const projectLoader = {
      getPlugin: vi.fn((id: string) => (id === "project-only-plugin" ? { manifest: { id } } : undefined)),
      getPluginRoutes: vi.fn(() => [
        { pluginId: "project-only-plugin", route: { method: "GET", path: "/data", handler: projectHandler } },
      ]),
      createRouteContext: vi.fn(async () => projectRouteContext),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
    } as any;

    const resolveProjectPluginLoader = vi.fn(async () => projectLoader);

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStore, hostLoader, undefined, {} as any, resolveProjectPluginLoader));
    app.use((_req, res) => res.status(404).json({ error: "Not found" }));

    const res = await performGet(app, "/api/plugins/project-only-plugin/data");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ project: true });
    expect(projectHandler).toHaveBeenCalled();
    expect(resolveProjectPluginLoader).toHaveBeenCalled();
    // Execution resolved through the project loader, never the host loader.
    expect(projectLoader.createRouteContext).toHaveBeenCalledWith("project-only-plugin", expect.anything());
    expect(hostLoader.createRouteContext).not.toHaveBeenCalled();
  });
});
