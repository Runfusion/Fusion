import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const pluginStoreInstances: Array<{
    init: ReturnType<typeof vi.fn>;
    registerPlugin: ReturnType<typeof vi.fn>;
    listPlugins: ReturnType<typeof vi.fn>;
    getPlugin: ReturnType<typeof vi.fn>;
  }> = [];

  let loaderTaskStore: { getRootDir?: () => string } | undefined;
  let loaderRootDir: string | undefined;

  const PluginStore = vi.fn().mockImplementation(() => {
    const instance = {
      init: vi.fn().mockResolvedValue(undefined),
      registerPlugin: vi.fn().mockResolvedValue({
        id: "paperclip-runtime",
        enabled: true,
      }),
      listPlugins: vi.fn().mockResolvedValue([]),
      getPlugin: vi.fn(),
    };
    pluginStoreInstances.push(instance);
    return instance;
  });

  const PluginLoader = vi.fn().mockImplementation((options: { taskStore: { getRootDir?: () => string } }) => {
    loaderTaskStore = options.taskStore;
    return {
      loadPlugin: vi.fn().mockImplementation(async () => {
        loaderRootDir = options.taskStore.getRootDir?.();
      }),
    };
  });

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
      PluginStore.mockClear();
      PluginLoader.mockClear();
    },
  };
});

vi.mock("@fusion/core", () => ({
  PluginStore: mocks.PluginStore,
  PluginLoader: mocks.PluginLoader,
  validatePluginManifest: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}));

vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn().mockResolvedValue({ projectPath: "/tmp/fn-project" }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(
    JSON.stringify({
      id: "paperclip-runtime",
      name: "Paperclip Runtime",
      version: "1.0.0",
    }),
  ),
}));

import { runPluginInstall } from "../plugin.js";

describe("runPluginInstall", () => {
  beforeEach(() => {
    mocks.reset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes getRootDir on the plugin loader taskStore mock (FN-2687)", async () => {
    await expect(runPluginInstall("/plugins/paperclip-runtime")).resolves.toBeUndefined();

    const taskStore = mocks.getLoaderTaskStore();
    expect(taskStore).toBeDefined();
    expect(taskStore?.getRootDir).toBeTypeOf("function");
    expect(taskStore?.getRootDir?.()).toBe("/tmp/fn-project");
    expect(mocks.getLoaderRootDir()).toBe("/tmp/fn-project");
  });
});
