import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import * as schema from "../../../../core/src/postgres/schema/index.js";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const mocks = vi.hoisted(() => {
  const pluginStoreInstances: Array<{
    init: ReturnType<typeof vi.fn>;
    registerPlugin: ReturnType<typeof vi.fn>;
    listPlugins: ReturnType<typeof vi.fn>;
    getPlugin: ReturnType<typeof vi.fn>;
    updatePluginSettings: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  let loaderTaskStore: { getRootDir?: () => string } | undefined;
  let loaderRootDir: string | undefined;

  const PluginStore = makeConstructibleMock();

  const PluginLoader = makeConstructibleMock();

  const setupDefaults = () => {
    PluginStore.mockImplementation(() => {
      const instance = {
        init: vi.fn().mockResolvedValue(undefined),
        registerPlugin: vi.fn().mockResolvedValue({
          id: "paperclip-runtime",
          enabled: true,
        }),
        listPlugins: vi.fn().mockResolvedValue([]),
        getPlugin: vi.fn(),
        updatePluginSettings: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      pluginStoreInstances.push(instance);
      return instance;
    });

    PluginLoader.mockImplementation((options: { taskStore: { getRootDir?: () => string } }) => {
      loaderTaskStore = options.taskStore;
      return {
        loadPlugin: vi.fn().mockImplementation(async () => {
          loaderRootDir = options.taskStore.getRootDir?.();
        }),
      };
    });
  };

  setupDefaults();

  return {
    PluginStore,
    PluginLoader,
    pluginStoreInstances,
    getLoaderTaskStore: () => loaderTaskStore,
    getLoaderRootDir: () => loaderRootDir,
    reset: () => {
      loaderTaskStore = undefined;
      loaderRootDir = undefined;
      pluginStoreInstances.length = 0;
      PluginStore.mockReset();
      PluginLoader.mockReset();
      setupDefaults();
    },
  };
});

vi.mock("@fusion/core", () => ({
  PluginStore: mocks.PluginStore,
  PluginLoader: mocks.PluginLoader,
  CentralCore: vi.fn(function CentralCore() {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      asyncLayer: undefined,
    };
  }),
  validatePluginManifest: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  resolveGlobalDir: vi.fn().mockReturnValue("/tmp/fusion-global"),
}));

vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn().mockResolvedValue({ projectPath: "/tmp/fn-project" }),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) => actual.existsSync(path)),
  };
});

import {
  resolvePluginEntryFile,
  runPluginAvailable,
  runPluginInstall,
  runPluginSettings,
  runPluginRescan,
} from "../plugin.js";
import { resolveProject } from "../../project-context.js";

async function createTempPluginFixture(
  files: Array<{ path: string; content: string }>,
): Promise<string> {
  const pluginDir = await mkdtemp(join(tmpdir(), "fn-plugin-test-"));
  for (const file of files) {
    const target = join(pluginDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf-8");
  }
  return pluginDir;
}

describe("plugin commands", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    /*
     * FNXC:CliTests 2026-06-14-01:28:
     * FN-6430's plugin-suite rescue depends on clearing loader path state before every case so a package-load sibling cannot inherit the previous taskStore root.
     * Reset the hoisted PluginLoader/PluginStore mocks rather than widening timeouts or serializing the whole CLI lane.
     */
    mocks.reset();
    vi.mocked(resolveProject).mockResolvedValue({ projectPath: "/tmp/fn-project" } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("resolves package exports import entry to dist/index.js", async () => {
    const pluginDir = await createTempPluginFixture([
      {
        path: "package.json",
        content: JSON.stringify({ exports: { ".": { import: "./dist/index.js" } } }),
      },
      { path: "dist/index.js", content: "export default {};" },
    ]);
    tempDirs.push(pluginDir);

    await expect(resolvePluginEntryFile(pluginDir)).resolves.toBe(resolve(pluginDir, "dist/index.js"));
  });

  it("uses resolved TaskStore plugin store when available", async () => {
    const contextStore = {
      getPluginStore: vi.fn().mockReturnValue({
        init: vi.fn().mockResolvedValue(undefined),
        registerPlugin: vi.fn().mockResolvedValue({ id: "paperclip-runtime", enabled: true }),
        listPlugins: vi.fn().mockResolvedValue([]),
        getPlugin: vi.fn(),
        updatePluginSettings: vi.fn().mockResolvedValue(undefined),
      }),
    };
    vi.mocked(resolveProject).mockResolvedValue({
      projectPath: "/tmp/fn-project",
      store: contextStore,
    } as never);

    const pluginDir = await createTempPluginFixture([
      {
        path: "manifest.json",
        content: JSON.stringify({ id: "paperclip-runtime", name: "Paperclip Runtime", version: "1.0.0" }),
      },
      {
        path: "package.json",
        content: JSON.stringify({ exports: { ".": { import: "./dist/index.js" } } }),
      },
      {
        path: "dist/index.js",
        content:
          "export default { manifest: { id: 'paperclip-runtime', name: 'Paperclip Runtime', version: '1.0.0' }, async onLoad() {}, async onUnload() {} };",
      },
    ]);
    tempDirs.push(pluginDir);

    await expect(runPluginInstall(pluginDir)).resolves.toBeUndefined();

    expect(contextStore.getPluginStore).toHaveBeenCalledTimes(1);
    expect(mocks.PluginStore).not.toHaveBeenCalled();
  });


  it("includes getRootDir on the plugin loader taskStore mock (FN-2687)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const pluginDir = await createTempPluginFixture([
      {
        path: "manifest.json",
        content: JSON.stringify({ id: "paperclip-runtime", name: "Paperclip Runtime", version: "1.0.0" }),
      },
      {
        path: "package.json",
        content: JSON.stringify({ exports: { ".": { import: "./dist/index.js" } } }),
      },
      {
        path: "dist/index.js",
        content:
          "export default { manifest: { id: 'paperclip-runtime', name: 'Paperclip Runtime', version: '1.0.0' }, async onLoad() {}, async onUnload() {} };",
      },
    ]);
    tempDirs.push(pluginDir);

    await expect(runPluginInstall(pluginDir)).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();

    const registerCall = mocks.pluginStoreInstances[0]?.registerPlugin.mock.calls[0]?.[0];
    expect(registerCall.path).toBe(resolve(pluginDir, "dist/index.js"));

    const taskStore = mocks.getLoaderTaskStore();
    expect(taskStore).toBeDefined();
    expect(taskStore?.getRootDir).toBeTypeOf("function");
    expect(taskStore?.getRootDir?.()).toBe("/tmp/fn-project");
    expect(mocks.getLoaderRootDir()).toBe("/tmp/fn-project");
  });

  it("exits non-zero when plugin entry cannot resolve to built JavaScript", async () => {
    const pluginDir = await createTempPluginFixture([
      {
        path: "manifest.json",
        content: JSON.stringify({ id: "paperclip-runtime", name: "Paperclip Runtime", version: "1.0.0" }),
      },
      {
        path: "package.json",
        content: JSON.stringify({ exports: { ".": { import: "./src/index.ts" } } }),
      },
      { path: "src/index.ts", content: "export default {};" },
    ]);
    tempDirs.push(pluginDir);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(runPluginInstall(pluginDir)).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Build the plugin first"),
    );
  });

  it("prints built-in plugin catalog", async () => {
    await expect(runPluginAvailable()).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Installable"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("fusion-plugin-agent-browser"));
  });

  it("exits non-zero when rescan verdict is blocked", async () => {
    const storeInstance = {
      init: vi.fn().mockResolvedValue(undefined),
      registerPlugin: vi.fn(),
      listPlugins: vi.fn(),
      getPlugin: vi
        .fn()
        .mockResolvedValueOnce({ id: "paperclip-runtime", name: "Paperclip Runtime", enabled: true, state: "started" })
        .mockResolvedValueOnce({ id: "paperclip-runtime", name: "Paperclip Runtime", enabled: true, state: "error", lastSecurityScan: { verdict: "blocked", summary: "blocked", findings: [], scannedAt: "now", scannedFiles: [] } }),
      updatePluginSettings: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mocks.PluginStore.mockImplementationOnce(() => storeInstance as never);
    mocks.PluginLoader.mockImplementationOnce(() => ({ loadPlugin: vi.fn(), reloadPlugin: vi.fn().mockResolvedValue(undefined) }) as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);

    await expect(runPluginRescan("paperclip-runtime", { projectName: "demo" })).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reads and updates plugin settings", async () => {
    const storeInstance = {
      init: vi.fn().mockResolvedValue(undefined),
      registerPlugin: vi.fn(),
      listPlugins: vi.fn(),
      getPlugin: vi.fn().mockResolvedValue({
        id: "paperclip-runtime",
        settings: { enabled: true, retries: 2 },
      }),
      updatePluginSettings: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mocks.PluginStore.mockImplementationOnce(() => storeInstance as never);
    await runPluginSettings("paperclip-runtime", undefined, undefined, { projectName: "demo" });

    mocks.PluginStore.mockImplementationOnce(() => storeInstance as never);
    await runPluginSettings("paperclip-runtime", "enabled", undefined, { projectName: "demo" });

    mocks.PluginStore.mockImplementationOnce(() => storeInstance as never);
    await runPluginSettings("paperclip-runtime", "enabled", "false", { projectName: "demo" });

    expect(storeInstance.getPlugin).toHaveBeenCalledTimes(3);
    expect(storeInstance.updatePluginSettings).toHaveBeenCalledWith("paperclip-runtime", { enabled: false });
  });
});

/*
 * FNXC:CliTests 2026-07-16-05:20:
 * FN-8091 moves the central-only install persistence assertion off the removed SQLite central/local database runtime.
 * The PostgreSQL harness preserves the invariant: one global installation and one path-scoped project state are written without constructing a local plugin store.
 */
pgDescribe("runPluginInstall central-only persistence (PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fn_plugin_install" });

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    vi.mocked(resolveProject).mockResolvedValue({
      projectPath: h.rootDir(),
      store: h.store(),
    } as never);
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("writes runPluginInstall metadata to central tables only", async () => {
    const pluginStore = h.store().getPluginStore();
    expect(pluginStore.backendMode).toBe(true);

    const pluginDir = await createTempPluginFixture([
      {
        path: "manifest.json",
        content: JSON.stringify({ id: "paperclip-runtime", name: "Paperclip Runtime", version: "1.0.0" }),
      },
      {
        path: "package.json",
        content: JSON.stringify({ exports: { ".": { import: "./dist/index.js" } } }),
      },
      {
        path: "dist/index.js",
        content:
          "export default { manifest: { id: 'paperclip-runtime', name: 'Paperclip Runtime', version: '1.0.0' }, async onLoad() {}, async onUnload() {} };",
      },
    ]);

    try {
      await expect(runPluginInstall(pluginDir)).resolves.toBeUndefined();

      const installs = await h.layer().db.select().from(schema.central.pluginInstalls);
      const states = await h.layer().db.select().from(schema.central.projectPluginStates);

      expect(installs.filter(({ id }) => id === "paperclip-runtime")).toHaveLength(1);
      expect(
        states.filter(
          ({ pluginId, projectPath }) =>
            pluginId === "paperclip-runtime" && projectPath === h.rootDir(),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
});
