import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────
// vi.mock factories are hoisted, so we use vi.hoisted() for mock references.

const { mockExistsSync, mockReadFile, mockValidatePluginManifest } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockReadFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
  mockValidatePluginManifest: vi.fn<(manifest: unknown) => { valid: boolean; errors: string[] }>(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("@fusion/core", () => ({
  validatePluginManifest: mockValidatePluginManifest,
}));

// Import SUT after mocks are in place
import {
  BUNDLED_PLUGIN_IDS,
  ensureBundledDependencyGraphPluginInstalled,
  ensureBundledCursorRuntimePluginInstalled,
  ensureBundledPluginInstalled,
  resolvePluginEntryPath,
} from "../bundled-plugin-install.js";

// ── Helpers ──────────────────────────────────────────────────────────

const BUNDLED_PLUGIN_ID = "fusion-plugin-dependency-graph";
const HERMES_PLUGIN_ID = "fusion-plugin-hermes-runtime";
const CURSOR_PLUGIN_ID = "fusion-plugin-cursor-runtime";
const ROADMAP_PLUGIN_ID = "fusion-plugin-roadmap";
const REPORTS_PLUGIN_ID = "fusion-plugin-reports";
const CLI_PRINTING_PRESS_PLUGIN_ID = "fusion-plugin-cli-printing-press";

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

/**
 * Setup: bundled manifest exists at the first candidate path and is valid.
 * The resolver's first candidate includes "dist/plugins/..." when running from source.
 */
function setupBundleExists(manifestOverrides?: Partial<{ id: string; version: string }>) {
  const manifest = makeManifest(manifestOverrides);
  mockExistsSync.mockImplementation((p: string) => {
    if (typeof p !== "string") return false;
    if (p.endsWith("manifest.json") && p.includes("dist")) return true;
    if (p.includes("dist") && (p.endsWith("/bundled.js") || p.endsWith("/src/index.ts") || p.endsWith("/dist/index.js"))) {
      return true;
    }
    return false;
  });
  mockReadFile.mockResolvedValue(JSON.stringify(manifest));
  mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });
  return manifest;
}

/** Setup: no bundled manifest found on any candidate path. */
function setupBundleMissing() {
  mockExistsSync.mockReturnValue(false);
}

/** Setup: bundled manifest found but invalid. */
function setupBundleInvalid() {
  mockExistsSync.mockImplementation((p: string) => {
    if (typeof p === "string" && p.endsWith("manifest.json") && p.includes("dist")) return true;
    return false;
  });
  const badManifest = { id: "bad" };
  mockReadFile.mockResolvedValue(JSON.stringify(badManifest));
  mockValidatePluginManifest.mockReturnValue({
    valid: false,
    errors: ["Missing required field: name"],
  });
}

/**
 * Probe the resolver to determine the actual resolved bundled path.
 * Registers the plugin and captures the path from the registerPlugin call.
 */
async function getResolvedBundledPath(): Promise<string> {
  setupBundleExists();
  const probeStore = makePluginStore();
  const probeLoader = makePluginLoader();
  await ensureBundledDependencyGraphPluginInstalled(
    probeStore as unknown as import("@fusion/core").PluginStore,
    probeLoader as unknown as import("@fusion/core").PluginLoader,
  );
  const call = probeStore.registerPlugin.mock.calls[0];
  const path = (call?.[0] as { path: string })?.path ?? "";
  expect(path.endsWith(".js") || path.endsWith(".ts")).toBe(true);
  return path;
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolvePluginEntryPath", () => {
  it("prefers bundled.js when both bundled and source entries exist", () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith("/src/index.ts") || p.endsWith("/bundled.js"));
    expect(resolvePluginEntryPath("/tmp/plugin")).toBe("/tmp/plugin/bundled.js");
  });

  it("prefers bundled.js when source entry is unavailable", () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith("/bundled.js"));
    expect(resolvePluginEntryPath("/tmp/plugin")).toBe("/tmp/plugin/bundled.js");
  });

  it("prefers dist/index.js when bundled.js is unavailable", () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith("/src/index.ts") || p.endsWith("/dist/index.js"));
    expect(resolvePluginEntryPath("/tmp/plugin")).toBe("/tmp/plugin/dist/index.js");
  });

  it("falls back to src/index.ts for workspace-dev plugins without build outputs", () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith("/src/index.ts"));
    expect(resolvePluginEntryPath("/tmp/plugin")).toBe("/tmp/plugin/src/index.ts");
  });
});

describe("ensureBundledDependencyGraphPluginInstalled", () => {
  it("includes roadmap plugin in bundled plugin ids", () => {
    expect(BUNDLED_PLUGIN_IDS).toContain(ROADMAP_PLUGIN_ID);
  });

  it("includes CLI printing press plugin in bundled plugin ids", () => {
    expect(BUNDLED_PLUGIN_IDS).toContain(CLI_PRINTING_PRESS_PLUGIN_ID);
  });

  it("includes reports plugin in bundled plugin ids", () => {
    expect(BUNDLED_PLUGIN_IDS).toContain(REPORTS_PLUGIN_ID);
  });
  it("fresh install: registers and loads the plugin when not in DB", async () => {
    setupBundleExists();
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledDependencyGraphPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
    );

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledOnce();
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: BUNDLED_PLUGIN_ID }),
      }),
    );
    // Fresh install → enabled by default → should be loaded
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("already installed with matching path/version → returns already-installed without DB writes", async () => {
    // First probe to get the actual resolved path
    const bundledPath = await getResolvedBundledPath();

    vi.clearAllMocks();
    const manifest = setupBundleExists();
    const store = makePluginStore();
    const loader = makePluginLoader();

    // Inject a plugin that matches the current bundle path and version
    store._inject(makePlugin({ path: bundledPath, version: manifest.version }));

    const result = await ensureBundledDependencyGraphPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
    );

    expect(result).toBe("already-installed");
    expect(store.updatePlugin).not.toHaveBeenCalled();
    expect(store.registerPlugin).not.toHaveBeenCalled();
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("already installed with stale path → updates path to current bundled path", async () => {
    const bundledPath = await getResolvedBundledPath();
    const OLD_PATH = "/old/cli/dist/plugins/fusion-plugin-dependency-graph";

    vi.clearAllMocks();
    const manifest = setupBundleExists();
    const store = makePluginStore();
    const loader = makePluginLoader();

    // Plugin registered with the OLD path, but current version
    store._inject(makePlugin({ path: OLD_PATH, version: manifest.version }));

    const result = await ensureBundledDependencyGraphPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
    );

    expect(result).toBe("updated");
    expect(store.updatePlugin).toHaveBeenCalledWith(
      BUNDLED_PLUGIN_ID,
      expect.objectContaining({ path: bundledPath }),
    );
    // Plugin was enabled → should be loaded
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("already installed with stale version → updates version to current manifest version", async () => {
    const bundledPath = await getResolvedBundledPath();

    vi.clearAllMocks();
    const manifest = setupBundleExists({ version: "0.2.0" });
    const store = makePluginStore();
    const loader = makePluginLoader();

    // Plugin registered with old version but same path
    store._inject(makePlugin({ path: bundledPath, version: "0.1.0" }));

    const result = await ensureBundledDependencyGraphPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
    );

    expect(result).toBe("updated");
    expect(store.updatePlugin).toHaveBeenCalledWith(
      BUNDLED_PLUGIN_ID,
      expect.objectContaining({ version: "0.2.0" }),
    );
    expect(loader.loadPlugin).toHaveBeenCalledWith(BUNDLED_PLUGIN_ID);
  });

  it("disabled plugin → path/version updated but plugin NOT loaded (user choice respected)", async () => {
    setupBundleExists({ version: "0.2.0" });
    const store = makePluginStore();
    const loader = makePluginLoader();

    // Plugin explicitly disabled by user with stale version
    // Use a path that definitely won't match the resolved path
    store._inject(makePlugin({ path: "/stale/path/plugin", version: "0.1.0", enabled: false }));

    const result = await ensureBundledDependencyGraphPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
    );

    expect(result).toBe("updated");
    expect(store.updatePlugin).toHaveBeenCalled();
    // User disabled the plugin → should NOT be loaded
    expect(loader.loadPlugin).not.toHaveBeenCalled();
  });

  it("missing bundle (no bundled manifest found) → returns missing-bundle without error", async () => {
    setupBundleMissing();
    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledDependencyGraphPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
    );

    expect(result).toBe("missing-bundle");
    expect(store.registerPlugin).not.toHaveBeenCalled();
    expect(store.updatePlugin).not.toHaveBeenCalled();
    expect(loader.loadPlugin).not.toHaveBeenCalled();
  });

  it("invalid bundled manifest → throws descriptive error", async () => {
    setupBundleInvalid();
    const store = makePluginStore();
    const loader = makePluginLoader();

    await expect(
      ensureBundledDependencyGraphPluginInstalled(
        store as unknown as import("@fusion/core").PluginStore,
        loader as unknown as import("@fusion/core").PluginLoader,
      ),
    ).rejects.toThrow("Invalid plugin manifest");
  });

  it("registers Cursor runtime through the dedicated helper", async () => {
    const manifest = makeManifest({ id: CURSOR_PLUGIN_ID, name: "Cursor Runtime" });
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("manifest.json") && p.includes(CURSOR_PLUGIN_ID)) return true;
      if (p.endsWith("/src/index.ts") && p.includes(CURSOR_PLUGIN_ID)) return true;
      return false;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(manifest));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });

    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledCursorRuntimePluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
    );

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: CURSOR_PLUGIN_ID }) }),
    );
  });

  it("registers roadmap plugin via generic bundled installer", async () => {
    const manifest = makeManifest({ id: ROADMAP_PLUGIN_ID, name: "Roadmaps" });
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("manifest.json") && p.includes(ROADMAP_PLUGIN_ID)) return true;
      if (p.endsWith("/src/index.ts") && p.includes(ROADMAP_PLUGIN_ID)) return true;
      return false;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(manifest));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });

    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
      ROADMAP_PLUGIN_ID,
    );

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: ROADMAP_PLUGIN_ID }) }),
    );
  });

  it("registers reports plugin via generic bundled installer", async () => {
    const manifest = makeManifest({ id: REPORTS_PLUGIN_ID, name: "Reports" });
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("manifest.json") && p.includes(REPORTS_PLUGIN_ID)) return true;
      if (p.endsWith("/src/index.ts") && p.includes(REPORTS_PLUGIN_ID)) return true;
      return false;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(manifest));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });

    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
      REPORTS_PLUGIN_ID,
    );

    expect(result).toBe("installed");
    expect(store.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: REPORTS_PLUGIN_ID }) }),
    );
    const registerCall = store.registerPlugin.mock.calls[0]?.[0] as { path: string };
    expect(registerCall.path).toContain(REPORTS_PLUGIN_ID);
  });

  it("registers Hermes from bundled.js when bundled, src, and dist entries all exist", async () => {
    const manifest = makeManifest({ id: HERMES_PLUGIN_ID, name: "Hermes Runtime" });
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("manifest.json") && p.includes(HERMES_PLUGIN_ID)) return true;
      if (p.endsWith("/bundled.js") && p.includes(HERMES_PLUGIN_ID)) return true;
      if (p.endsWith("/src/index.ts") && p.includes(HERMES_PLUGIN_ID)) return true;
      if (p.endsWith("/dist/index.js") && p.includes(HERMES_PLUGIN_ID)) return true;
      return false;
    });
    mockReadFile.mockResolvedValue(JSON.stringify(manifest));
    mockValidatePluginManifest.mockReturnValue({ valid: true, errors: [] });

    const store = makePluginStore();
    const loader = makePluginLoader();

    const result = await ensureBundledPluginInstalled(
      store as unknown as import("@fusion/core").PluginStore,
      loader as unknown as import("@fusion/core").PluginLoader,
      HERMES_PLUGIN_ID,
    );

    expect(result).toBe("installed");
    const registerCall = store.registerPlugin.mock.calls[0]?.[0] as { path: string };
    expect(registerCall.path).toContain(`${HERMES_PLUGIN_ID}/bundled.js`);
  });
});
