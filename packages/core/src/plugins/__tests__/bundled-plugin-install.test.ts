import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────
// vi.mock factories are hoisted, so we use vi.hoisted() for mock references.

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

vi.mock("../../plugin-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugin-types.js")>();
  return { ...actual, validatePluginManifest: mockValidatePluginManifest };
});

// Import SUT after mocks are in place
import {
  BUNDLED_PLUGIN_IDS,
  ensureBundledDependencyGraphPluginInstalled,
  ensureBundledCursorRuntimePluginInstalled,
  ensureBundledPluginInstalled,
  type BundledPluginDirResolver,
} from "../bundled-plugin-install.js";

// ── Helpers ──────────────────────────────────────────────────────────

const BUNDLED_PLUGIN_ID = "fusion-plugin-dependency-graph";
const HERMES_PLUGIN_ID = "fusion-plugin-hermes-runtime";
const CURSOR_PLUGIN_ID = "fusion-plugin-cursor-runtime";
const ROADMAP_PLUGIN_ID = "fusion-plugin-roadmap";
const REPORTS_PLUGIN_ID = "fusion-plugin-reports";
const LINEAR_IMPORT_PLUGIN_ID = "fusion-plugin-linear-import";

function makeManifest(overrides?: Partial<{ id: string; version: string; name: string }>) {
  return {
    id: BUNDLED_PLUGIN_ID,
    name: "Dependency Graph",
    version: "0.1.0",
    description: "Top-level dependency graph dashboard view",
    dashboardViews: [
      {
        viewId: "graph",
        label: "Graph",
        componentPath: "./dashboard-view",
        icon: "Network",
        placement: "more",
        order: 40,
      },
    ],
    ...overrides,
  };
}

interface PluginLike {
  id: string;
  name: string;
  version: string;
  description?: string;
  path: string;
  enabled: boolean;
  state: string;
  settings: Record<string, unknown>;
  dependencies?: string[];
  createdAt: string;
  updatedAt: string;
}

function makePlugin(overrides?: Partial<PluginLike>): PluginLike {
  return {
    id: BUNDLED_PLUGIN_ID,
    name: "Dependency Graph",
    version: "0.1.0",
    description: "Top-level dependency graph dashboard view",
    path: "", // callers should set this
    enabled: true,
    state: "installed",
    settings: {},
    dependencies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePluginStore() {
  const plugins = new Map<string, PluginLike>();
  return {
    getPlugin: vi.fn(async (id: string) => {
      const plugin = plugins.get(id);
      if (!plugin)
        throw Object.assign(new Error(`Plugin "${id}" not found`), { code: "ENOENT" });
      return { ...plugin };
    }),
    registerPlugin: vi.fn(async (input: { manifest: unknown; path: string }) => {
      const manifest = input.manifest as ReturnType<typeof makeManifest>;
      const plugin = makePlugin({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        path: input.path,
      });
      plugins.set(manifest.id, plugin);
      return plugin;
    }),
    updatePlugin: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const plugin = plugins.get(id);
      if (!plugin) throw new Error(`Plugin "${id}" not found`);
      const updated = { ...plugin, ...updates, updatedAt: new Date().toISOString() };
      plugins.set(id, updated);
      return updated;
    }),
    /** Directly inject a plugin record for test setup */
    _inject(plugin: PluginLike) {
      plugins.set(plugin.id, { ...plugin });
    },
  };
}

function makePluginLoader() {
  return {
    loadPlugin: vi.fn(async () => {}),
    unloadPlugin: vi.fn(async () => {}),
    getLoadedPlugins: vi.fn(() => new Map()),
    isPluginLoaded: vi.fn(() => false),
  };
}

/** A CLI-shaped resolver: single candidate dir per plugin id (mirrors <cli>/dist/plugins/<id>). */
function cliShapedResolver(pluginId: string): string[] {
  return [`/cli/dist/plugins/${pluginId}`];
}

/** A desktop-shaped resolver: single candidate dir per plugin id (mirrors node_modules/@fusion-plugin-examples/<short>). */
function desktopShapedResolver(pluginId: string): string[] {
  const shortName = pluginId.replace(/^fusion-plugin-/, "");
  return [`/desktop/node_modules/@fusion-plugin-examples/${shortName}`];
}

function setupBundleExists(resolver: BundledPluginDirResolver, manifestOverrides?: Partial<{ id: string; version: string }>) {
  const manifest = makeManifest(manifestOverrides);
  const [dir] = resolver(manifest.id ?? BUNDLED_PLUGIN_ID);
  mockExistsSync.mockImplementation((p: string) => {
    if (typeof p !== "string") return false;
    return p === `${dir}/manifest.json` || p === `${dir}/src/index.ts`;
  });
  mockReadFile.mockResolvedValue(JSON.stringify(manifest));
  mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });
  return { manifest, dir };
}

function setupBundleMissing() {
  mockExistsSync.mockReturnValue(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockReturnValue([{ name: "index.ts", isDirectory: () => false }]);
  mockStatSync.mockImplementation(() => ({ isDirectory: () => false, mtimeMs: 0 }));
  mockFsStat.mockImplementation(async () => ({ isDirectory: () => false }));
  mockCopyFile.mockResolvedValue();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("ensureBundledPluginInstalled (host-agnostic shared helper)", () => {
  it("includes the full bundled plugin id set", () => {
    expect(BUNDLED_PLUGIN_IDS).toContain(ROADMAP_PLUGIN_ID);
    expect(BUNDLED_PLUGIN_IDS).toContain(REPORTS_PLUGIN_ID);
    expect(BUNDLED_PLUGIN_IDS).toContain(LINEAR_IMPORT_PLUGIN_ID);
    expect(BUNDLED_PLUGIN_IDS).toContain(HERMES_PLUGIN_ID);
  });

  it("fresh install: registers and loads the plugin when not in DB (CLI-shaped resolver)", async () => {
    const { dir } = setupBundleExists(cliShapedResolver);
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(store as never, loader as never, BUNDLED_PLUGIN_ID, cliShapedResolver);

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${dir}/src/index.ts`, manifest: expect.objectContaining({ id: BUNDLED_PLUGIN_ID }) }),
    );
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("fresh install: registers and loads the plugin when not in DB (desktop-shaped resolver)", async () => {
    const { dir } = setupBundleExists(desktopShapedResolver, { id: HERMES_PLUGIN_ID });
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(store as never, loader as never, HERMES_PLUGIN_ID, desktopShapedResolver);

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${dir}/src/index.ts`, manifest: expect.objectContaining({ id: HERMES_PLUGIN_ID }) }),
    );
    expect(loader.loadPlugin).toHaveBeenCalledWith(HERMES_PLUGIN_ID);
  });

  it("already installed with matching path/version → returns already-installed without DB writes", async () => {
    const { manifest, dir } = setupBundleExists(cliShapedResolver);
    const store = makePluginStore();
    const loader = makePluginLoader();
    store._inject(makePlugin({ path: `${dir}/src/index.ts`, version: manifest.version }));

    const result = await ensureBundledPluginInstalled(store as never, loader as never, BUNDLED_PLUGIN_ID, cliShapedResolver);

    expect(result).toBe("already-installed");
    expect(store.updatePlugin).not.toHaveBeenCalled();
    expect(store.registerPlugin).not.toHaveBeenCalled();
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("already installed with stale path → updates path to current bundled path", async () => {
    const { manifest, dir } = setupBundleExists(cliShapedResolver);
    const store = makePluginStore();
    const loader = makePluginLoader();
    store._inject(makePlugin({ path: "/old/path/bundled.js", version: manifest.version }));

    const result = await ensureBundledPluginInstalled(store as never, loader as never, BUNDLED_PLUGIN_ID, cliShapedResolver);

    expect(result).toBe("updated");
    expect(store.updatePlugin).toHaveBeenCalledWith(
      BUNDLED_PLUGIN_ID,
      expect.objectContaining({ path: `${dir}/src/index.ts` }),
    );
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("already installed with stale version → updates version to current manifest version", async () => {
    const { dir } = setupBundleExists(cliShapedResolver, { version: "0.2.0" });
    const store = makePluginStore();
    const loader = makePluginLoader();
    store._inject(makePlugin({ path: `${dir}/src/index.ts`, version: "0.1.0" }));

    const result = await ensureBundledPluginInstalled(store as never, loader as never, BUNDLED_PLUGIN_ID, cliShapedResolver);

    expect(result).toBe("updated");
    expect(store.updatePlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID, expect.objectContaining({ version: "0.2.0" }));
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("disabled plugin → path/version updated but plugin NOT loaded (user choice respected)", async () => {
    setupBundleExists(cliShapedResolver, { version: "0.2.0" });
    const store = makePluginStore();
    const loader = makePluginLoader();
    store._inject(makePlugin({ path: "/stale/path/plugin", version: "0.1.0", enabled: false }));

    const result = await ensureBundledPluginInstalled(store as never, loader as never, BUNDLED_PLUGIN_ID, cliShapedResolver);

    expect(result).toBe("updated");
    expect(store.updatePlugin).toHaveBeenCalled();
    expect(loader.loadPlugin).not.toHaveBeenCalled();
  });

  it("migrates an existing directory-backed install to the resolved entry file", async () => {
    const { dir } = setupBundleExists(cliShapedResolver);
    const staleDirectoryPath = `${dir}`;
    mockStatSync.mockImplementation((path: string) => ({
      isDirectory: () => path === staleDirectoryPath,
    }));
    const store = makePluginStore();
    const loader = makePluginLoader();
    store._inject(makePlugin({ path: staleDirectoryPath }));

    const result = await ensureBundledPluginInstalled(store as never, loader as never, BUNDLED_PLUGIN_ID, cliShapedResolver);

    expect(result).toBe("updated");
    expect(store.updatePlugin).toHaveBeenCalledWith(
      BUNDLED_PLUGIN_ID,
      expect.objectContaining({ path: `${dir}/src/index.ts` }),
    );
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("returns missing-bundle when manifest exists but no loadable entry file exists", async () => {
    const dir = "/cli/dist/plugins/fusion-plugin-dependency-graph";
    mockExistsSync.mockImplementation((p: string) => typeof p === "string" && p === `${dir}/manifest.json`);
    mockReadFile.mockResolvedValue(JSON.stringify(makeManifest()));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(store as never, loader as never, BUNDLED_PLUGIN_ID, cliShapedResolver);

    expect(result).toBe("missing-bundle");
    expect(store.registerPlugin).not.toHaveBeenCalled();
    expect(store.updatePlugin).not.toHaveBeenCalled();
    expect(loader.loadPlugin).not.toHaveBeenCalled();
  });

  it("missing bundle (no bundled manifest found anywhere, e.g. desktop closure lacking the package) → returns missing-bundle without error", async () => {
    setupBundleMissing();
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(store as never, loader as never, REPORTS_PLUGIN_ID, desktopShapedResolver);

    expect(result).toBe("missing-bundle");
    expect(store.registerPlugin).not.toHaveBeenCalled();
    expect(store.updatePlugin).not.toHaveBeenCalled();
    expect(loader.loadPlugin).not.toHaveBeenCalled();
  });

  it("invalid bundled manifest → throws descriptive error", async () => {
    const dir = "/cli/dist/plugins/fusion-plugin-dependency-graph";
    mockExistsSync.mockImplementation((p: string) => typeof p === "string" && p === `${dir}/manifest.json`);
    mockReadFile.mockResolvedValue(JSON.stringify({ id: "bad" }));
    mockValidatePluginManifest.mockReturnValue({ valid: false, errors: ["Missing required field: name"] });
    const store = makePluginStore();
    const loader = makePluginLoader();

    await expect(
      ensureBundledPluginInstalled(store as never, loader as never, BUNDLED_PLUGIN_ID, cliShapedResolver),
    ).rejects.toThrow("Invalid plugin manifest");
  });

  it("registers Cursor runtime through the dedicated helper", async () => {
    setupBundleExists(cliShapedResolver, { id: CURSOR_PLUGIN_ID });
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledCursorRuntimePluginInstalled(store as never, loader as never, cliShapedResolver);

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: CURSOR_PLUGIN_ID }) }),
    );
  });

  it("registers Dependency Graph through the deprecated dedicated helper", async () => {
    setupBundleExists(cliShapedResolver);
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledDependencyGraphPluginInstalled(store as never, loader as never, cliShapedResolver);

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: BUNDLED_PLUGIN_ID }) }),
    );
  });

  it("registers Linear import plugin via generic bundled installer (desktop-shaped resolver)", async () => {
    setupBundleExists(desktopShapedResolver, { id: LINEAR_IMPORT_PLUGIN_ID });
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(store as never, loader as never, LINEAR_IMPORT_PLUGIN_ID, desktopShapedResolver);

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: LINEAR_IMPORT_PLUGIN_ID }) }),
    );
  });

  it("registers roadmap plugin via generic bundled installer", async () => {
    setupBundleExists(cliShapedResolver, { id: ROADMAP_PLUGIN_ID });
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(store as never, loader as never, ROADMAP_PLUGIN_ID, cliShapedResolver);

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: ROADMAP_PLUGIN_ID }) }),
    );
  });
});
