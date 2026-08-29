// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import type { PluginInstallation, PluginStore } from "@fusion/core";

import { buildRegistryPluginEntries, createPluginRouter, loadRegistryManifest } from "../plugin-routes.js";
import { get as performGet } from "../test-request.js";
import * as projectStoreResolver from "../project-store-resolver.js";

function createInstalledPlugin(overrides: Partial<PluginInstallation> & { id: string }): PluginInstallation {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    version: overrides.version ?? "9.9.9",
    description: overrides.description ?? "Installed plugin",
    author: overrides.author ?? "Installed Author",
    homepage: overrides.homepage,
    path: overrides.path ?? `/plugins/${overrides.id}/dist/index.js`,
    enabled: overrides.enabled ?? true,
    state: overrides.state ?? "started",
    settings: overrides.settings ?? {},
    dependencies: overrides.dependencies ?? [],
    createdAt: overrides.createdAt ?? "2026-06-09T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-09T00:00:00.000Z",
  } as PluginInstallation;
}

function createMockPluginStore(installed: PluginInstallation[] = []): PluginStore {
  const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
  return {
    listPlugins: vi.fn(async () => installed),
    getPlugin: vi.fn(async (id: string) => {
      const plugin = installedById.get(id);
      if (!plugin) {
        throw Object.assign(new Error(`Plugin "${id}" not found`), { code: "ENOENT" });
      }
      return plugin;
    }),
    registerPlugin: vi.fn(),
    unregisterPlugin: vi.fn(),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
    updatePluginState: vi.fn(),
    updatePluginSettings: vi.fn(),
    updatePlugin: vi.fn(),
  } as unknown as PluginStore;
}

function buildApp(pluginStore: PluginStore) {
  const app = express();
  app.use(express.json());
  app.use("/api/plugins", createPluginRouter(pluginStore, { loadPlugin: vi.fn(), stopPlugin: vi.fn() } as any));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

describe("GET /api/plugins/registry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns all manifest entries when no filters are provided", async () => {
    const pluginStore = createMockPluginStore();
    const res = await performGet(buildApp(pluginStore), "/api/plugins/registry");

    expect(res.status).toBe(200);
    const registryManifest = await loadRegistryManifest();
    const manifestPlugins = Array.isArray(registryManifest.plugins) ? registryManifest.plugins : [];

    // Registry currently includes Agent Browser as metadata-only plus 3 discovery-only partner/plugin ideas.
    expect(manifestPlugins.filter((plugin) => typeof plugin === "object" && plugin && !("path" in plugin))).toHaveLength(4);
    expect((res.body as { plugins: unknown[] }).plugins).toHaveLength(manifestPlugins.length);
  });

  it("filters by q across searchable text", async () => {
    const pluginStore = createMockPluginStore();
    const res = await performGet(buildApp(pluginStore), "/api/plugins/registry?q=whatsapp");

    expect(res.status).toBe(200);
    expect((res.body as { plugins: Array<{ id: string }> }).plugins.map((plugin) => plugin.id)).toEqual([
      "fusion-plugin-whatsapp-chat",
    ]);

    const linearRes = await performGet(buildApp(pluginStore), "/api/plugins/registry?q=linear");
    expect((linearRes.body as { plugins: Array<{ id: string }> }).plugins.map((plugin) => plugin.id)).toEqual([
      "fusion-plugin-linear-import",
    ]);
  });

  it("filters by category", async () => {
    const pluginStore = createMockPluginStore();
    const res = await performGet(buildApp(pluginStore), "/api/plugins/registry?category=runtime");

    expect(res.status).toBe(200);
    const plugins = (res.body as { plugins: Array<{ category: string }> }).plugins;
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins.every((plugin) => plugin.category === "runtime")).toBe(true);
  });

  it("annotates installed state for installed and missing plugins", async () => {
    const installed = createInstalledPlugin({
      id: "fusion-plugin-hermes-runtime",
      version: "2.0.0",
      state: "loaded",
    });
    const pluginStore = createMockPluginStore([installed]);
    const res = await performGet(buildApp(pluginStore), "/api/plugins/registry?q=runtime");

    expect(res.status).toBe(200);
    const plugins = (res.body as { plugins: Array<{ id: string; installed: boolean; state?: string; installedVersion?: string }> }).plugins;
    expect(plugins.find((plugin) => plugin.id === "fusion-plugin-hermes-runtime")).toMatchObject({
      installed: true,
      state: "loaded",
      installedVersion: "2.0.0",
    });
    expect(plugins.find((plugin) => plugin.id === "fusion-plugin-paperclip-runtime")).toMatchObject({
      installed: false,
    });
  });

  it("sets canInstall from manifest path presence", async () => {
    const pluginStore = createMockPluginStore();
    const res = await performGet(buildApp(pluginStore), "/api/plugins/registry");

    expect(res.status).toBe(200);
    const plugins = (res.body as { plugins: Array<{ id: string; canInstall: boolean }> }).plugins;
    expect(plugins.find((plugin) => plugin.id === "fusion-plugin-hermes-runtime")).toMatchObject({ canInstall: true });
    expect(plugins.find((plugin) => plugin.id === "fusion-plugin-agent-browser")).toMatchObject({ canInstall: false });
    expect(plugins.find((plugin) => plugin.id === "fusion-plugin-slack-bridge")).toMatchObject({ canInstall: false });
  });

  it("handles missing or empty manifest shapes gracefully", async () => {
    const pluginStore = createMockPluginStore();

    await expect(buildRegistryPluginEntries({}, pluginStore)).resolves.toEqual([]);
    await expect(buildRegistryPluginEntries({ plugins: [] }, pluginStore)).resolves.toEqual([]);
    await expect(buildRegistryPluginEntries({ plugins: "not-an-array" }, pluginStore)).resolves.toEqual([]);
  });

  it("filters invalid manifest entry shapes", async () => {
    const pluginStore = createMockPluginStore();

    await expect(
      buildRegistryPluginEntries({ plugins: [null, undefined, "string-entry", 42] }, pluginStore),
    ).resolves.toEqual([]);
    await expect(
      buildRegistryPluginEntries({ plugins: [{ id: 123, name: null }] }, pluginStore),
    ).resolves.toEqual([]);
  });

  describe("input sanitization", () => {
    it.each([
      ["HTML/script injection", "<script>alert(1)</script>"],
      ["SQL-injection-like text", "' OR 1=1 --"],
      ["extremely long text", "x".repeat(10_001)],
      ["regex-special characters", "[.*+]"],
    ])("treats %s in q as plain search text", async (_label, query) => {
      const pluginStore = createMockPluginStore();
      const res = await performGet(buildApp(pluginStore), `/api/plugins/registry?q=${encodeURIComponent(query)}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ plugins: [] });
    });

    it.each(["nonexistent", "../../etc", "runtime<script>"])(
      "treats invalid category %s as a non-matching literal filter",
      async (category) => {
        const pluginStore = createMockPluginStore();
        const res = await performGet(buildApp(pluginStore), `/api/plugins/registry?category=${encodeURIComponent(category)}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ plugins: [] });
      },
    );
  });

  it("uses the project-scoped plugin store when projectId is provided", async () => {
    const globalStore = createMockPluginStore();
    const projectStore = createMockPluginStore([
      createInstalledPlugin({ id: "fusion-plugin-reports", state: "started", version: "3.0.0" }),
    ]);
    const getPluginStore = vi.fn(() => projectStore);
    const getOrCreateProjectStore = vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue({
      getPluginStore,
    } as any);

    const res = await performGet(buildApp(globalStore), "/api/plugins/registry?projectId=project-one&q=side-by-side");

    expect(res.status).toBe(200);
    expect(getOrCreateProjectStore).toHaveBeenCalledWith("project-one");
    expect(getPluginStore).toHaveBeenCalled();
    expect(globalStore.getPlugin).not.toHaveBeenCalled();
    expect((projectStore.getPlugin as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("fusion-plugin-reports");
    expect((res.body as { plugins: Array<{ id: string; installed: boolean }> }).plugins).toEqual([
      expect.objectContaining({ id: "fusion-plugin-reports", installed: true }),
    ]);
  });

  describe("project-scoped store failures", () => {
    it("returns 500 when resolving the project store fails", async () => {
      const globalStore = createMockPluginStore();
      const getOrCreateProjectStore = vi
        .spyOn(projectStoreResolver, "getOrCreateProjectStore")
        .mockRejectedValue(new Error("store unavailable"));

      const res = await performGet(buildApp(globalStore), "/api/plugins/registry?projectId=bad-project");

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "store unavailable" });
      expect(getOrCreateProjectStore).toHaveBeenCalledWith("bad-project");
    });

    it("returns 500 when the scoped store cannot provide a plugin store", async () => {
      const globalStore = createMockPluginStore();
      const getPluginStore = vi.fn(() => {
        throw new Error("plugin store unavailable");
      });
      vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue({ getPluginStore } as any);

      const res = await performGet(buildApp(globalStore), "/api/plugins/registry?projectId=bad-project");

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "plugin store unavailable" });
      expect(getPluginStore).toHaveBeenCalled();
      expect(globalStore.getPlugin).not.toHaveBeenCalled();
    });
  });
});
