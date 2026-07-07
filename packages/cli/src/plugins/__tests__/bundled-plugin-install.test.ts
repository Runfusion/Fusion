/**
 * FNXC:PluginLoader 2026-07-07-00:00:
 * bundled-plugin-install.ts is now a thin CLI adapter that delegates the pure
 * install/update/fail-soft-load logic to @fusion/core's host-agnostic shared
 * helper (packages/core/src/plugins/bundled-plugin-install.ts) — see that
 * package's own test suite for full EnsureBundledResult coverage (installed /
 * updated / already-installed / missing-bundle) and resolvePluginEntryPath
 * coverage (packages/core/src/__tests__/plugin-loader.test.ts). This file only
 * asserts the CLI-specific concern: candidate bundle-directory resolution from
 * `import.meta.url`, i.e. the `<cli>/dist/plugins/<id>` staged-runtime layout
 * and its dev/source fallbacks (FN-7637).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExistsSync, mockReaddirSync, mockStatSync, mockReadFile, mockFsStat, mockCopyFile, mockValidatePluginManifest } =
  vi.hoisted(() => ({
    mockExistsSync: vi.fn<(path: string) => boolean>(),
    mockReaddirSync: vi.fn<
      (path: string, options: { withFileTypes: true; encoding: "utf8" }) => Array<{ name: string; isDirectory: () => boolean }>
    >(),
    mockStatSync: vi.fn<(path: string) => { isDirectory: () => boolean; mtimeMs?: number }>(),
    mockReadFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
    mockFsStat: vi.fn<(path: string) => Promise<{ isDirectory: () => boolean }>>(),
    mockCopyFile: vi.fn<(src: string, dest: string) => Promise<void>>(),
    mockValidatePluginManifest: vi.fn<(manifest: unknown) => { valid: boolean; errors: string[] }>(),
  }));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  stat: mockFsStat,
  copyFile: mockCopyFile,
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, validatePluginManifest: mockValidatePluginManifest };
});

import {
  BUNDLED_PLUGIN_IDS,
  ensureBundledDependencyGraphPluginInstalled,
  ensureBundledCursorRuntimePluginInstalled,
  ensureBundledPluginInstalled,
} from "../bundled-plugin-install.js";

function makeManifest(overrides?: Partial<{ id: string; version: string; name: string }>) {
  return {
    id: "fusion-plugin-dependency-graph",
    name: "Dependency Graph",
    version: "0.1.0",
    description: "Top-level dependency graph dashboard view",
    dashboardViews: [
      { viewId: "graph", label: "Graph", componentPath: "./dashboard-view", icon: "Network", placement: "more", order: 40 },
    ],
    ...overrides,
  };
}

function makePluginStore() {
  const plugins = new Map<string, { path: string; version: string; enabled: boolean; id: string }>();
  return {
    getPlugin: vi.fn(async (id: string) => {
      const plugin = plugins.get(id);
      if (!plugin) throw Object.assign(new Error(`Plugin "${id}" not found`), { code: "ENOENT" });
      return { ...plugin };
    }),
    registerPlugin: vi.fn(async (input: { manifest: unknown; path: string }) => {
      const manifest = input.manifest as ReturnType<typeof makeManifest>;
      const plugin = { id: manifest.id ?? "", version: manifest.version ?? "0.0.0", path: input.path, enabled: true };
      plugins.set(plugin.id, plugin);
      return plugin;
    }),
    updatePlugin: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const plugin = plugins.get(id);
      if (!plugin) throw new Error(`Plugin "${id}" not found`);
      const updated = { ...plugin, ...updates };
      plugins.set(id, updated);
      return updated;
    }),
  };
}

function makePluginLoader() {
  return { loadPlugin: vi.fn(async () => {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockReturnValue([{ name: "index.ts", isDirectory: () => false }]);
  mockStatSync.mockImplementation(() => ({ isDirectory: () => false, mtimeMs: 0 }));
  mockFsStat.mockImplementation(async () => ({ isDirectory: () => false }));
  mockCopyFile.mockResolvedValue();
});

describe("bundled plugin id set", () => {
  it("re-exports the full BUNDLED_PLUGIN_IDS set from @fusion/core", () => {
    expect(BUNDLED_PLUGIN_IDS).toContain("fusion-plugin-dependency-graph");
    expect(BUNDLED_PLUGIN_IDS).toContain("fusion-plugin-hermes-runtime");
    expect(BUNDLED_PLUGIN_IDS.length).toBeGreaterThan(0);
  });
});

describe("CLI candidate bundle-directory resolution", () => {
  it("installs from the bundled/global runtime layout (<cli>/dist/plugins/<id>/bundled.js — global install regression)", async () => {
    const PAPERCLIP_PLUGIN_ID = "fusion-plugin-paperclip-runtime";
    const globalDistPluginRoot = `/opt/homebrew/lib/node_modules/@runfusion/fusion/dist/plugins/${PAPERCLIP_PLUGIN_ID}`;

    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p !== "string") return false;
      if (p.includes("/@runfusion/dist/plugins/")) return false;
      return p === `${globalDistPluginRoot}/manifest.json` || p === `${globalDistPluginRoot}/bundled.js`;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(makeManifest({ id: PAPERCLIP_PLUGIN_ID, name: "Paperclip Runtime" })));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });

    vi.resetModules();
    vi.doMock("node:url", () => ({
      fileURLToPath: vi.fn(() => "/opt/homebrew/lib/node_modules/@runfusion/fusion/dist/bin.js"),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: mockExistsSync,
      readdirSync: mockReaddirSync,
      statSync: mockStatSync,
    }));
    vi.doMock("node:fs/promises", () => ({
      readFile: mockReadFile,
      stat: mockFsStat,
      copyFile: mockCopyFile,
    }));
    vi.doMock("@fusion/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@fusion/core")>();
      return { ...actual, validatePluginManifest: mockValidatePluginManifest };
    });

    const store = makePluginStore();
    const loader = makePluginLoader();
    const { ensureBundledPluginInstalled: ensureFromBundledBuild } = await import("../bundled-plugin-install.js");

    const result = await ensureFromBundledBuild(store as never, loader as never, PAPERCLIP_PLUGIN_ID);

    expect(result).toBe("installed");
    const registerCall = store.registerPlugin.mock.calls[0]?.[0] as { path: string };
    expect(registerCall.path.endsWith(`/fusion-plugin-paperclip-runtime/bundled.js`)).toBe(true);
  });

  it("falls back to the dev dist/plugins candidate when the bundled-runtime candidate is absent", async () => {
    const PAPERCLIP_PLUGIN_ID = "fusion-plugin-paperclip-runtime";
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p !== "string") return false;
      if (p.includes("/src/plugins/plugins/")) return false;
      return (
        p.includes(`/dist/plugins/${PAPERCLIP_PLUGIN_ID}/manifest.json`)
        || p.includes(`/dist/plugins/${PAPERCLIP_PLUGIN_ID}/src/index.ts`)
      );
    });
    mockReadFile.mockResolvedValue(JSON.stringify(makeManifest({ id: PAPERCLIP_PLUGIN_ID, name: "Paperclip Runtime" })));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });

    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(store as never, loader as never, PAPERCLIP_PLUGIN_ID);

    expect(result).toBe("installed");
    const registerCall = store.registerPlugin.mock.calls[0]?.[0] as { path: string };
    expect(registerCall.path).toContain(`/dist/plugins/${PAPERCLIP_PLUGIN_ID}/src/index.ts`);
  });

  it("dedicated Cursor runtime helper resolves through the same CLI candidate dirs", async () => {
    const CURSOR_PLUGIN_ID = "fusion-plugin-cursor-runtime";
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("manifest.json") && p.includes(CURSOR_PLUGIN_ID)) return true;
      if (p.endsWith("/src/index.ts") && p.includes(CURSOR_PLUGIN_ID)) return true;
      return false;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(makeManifest({ id: CURSOR_PLUGIN_ID, name: "Cursor Runtime" })));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });

    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledCursorRuntimePluginInstalled(store as never, loader as never);

    expect(result).toBe("installed");
    const registerCall = store.registerPlugin.mock.calls[0]?.[0] as { path: string };
    expect(registerCall.path).toContain(CURSOR_PLUGIN_ID);
  });

  it("deprecated Dependency Graph helper resolves through the same CLI candidate dirs", async () => {
    const DEP_GRAPH_ID = "fusion-plugin-dependency-graph";
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("manifest.json") && p.includes(DEP_GRAPH_ID)) return true;
      if (p.endsWith("/src/index.ts") && p.includes(DEP_GRAPH_ID)) return true;
      return false;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(makeManifest()));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });

    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledDependencyGraphPluginInstalled(store as never, loader as never);

    expect(result).toBe("installed");
  });

  it("returns missing-bundle when no CLI candidate dir has a manifest", async () => {
    mockExistsSync.mockReturnValue(false);
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(store as never, loader as never, "fusion-plugin-roadmap");

    expect(result).toBe("missing-bundle");
    expect(store.registerPlugin).not.toHaveBeenCalled();
  });
});
