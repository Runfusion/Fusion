import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FusionPlugin, PluginLoader, PluginStore, TaskStore } from "@fusion/core";
import { PluginRunner } from "../plugins/plugin-runner.js";
import { createLogger } from "../logger.js";

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  executorLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("PluginRunner.collectExecutorRuntimeEnv", () => {
  const createMockPlugin = (id: string, executorRuntimeEnv?: FusionPlugin["executorRuntimeEnv"]): FusionPlugin => ({
    manifest: { id, name: id, version: "1.0.0" },
    state: "started",
    hooks: {},
    executorRuntimeEnv,
  });

  const createRunner = (plugins: FusionPlugin[]) => {
    const pluginLoader = {
      getLoadedPlugins: vi.fn().mockReturnValue(plugins),
      getPlugin: vi.fn(),
      getPluginTools: vi.fn().mockReturnValue([]),
      getPluginRoutes: vi.fn().mockReturnValue([]),
      getPluginUiSlots: vi.fn().mockReturnValue([]),
      getPluginUiContributions: vi.fn().mockReturnValue([]),
      getPluginRuntimes: vi.fn().mockReturnValue([]),
      getCliProviderContributions: vi.fn().mockReturnValue([]),
      getPluginSkills: vi.fn().mockReturnValue([]),
      getPluginWorkflowSteps: vi.fn().mockReturnValue([]),
      getPluginWorkflowStepTemplates: vi.fn().mockReturnValue([]),
      getPluginPromptContributions: vi.fn().mockReturnValue([]),
      getPluginSetupInfo: vi.fn().mockReturnValue([]),
      on: vi.fn(),
      off: vi.fn(),
      invokeHook: vi.fn(),
      loadAllPlugins: vi.fn(),
      stopAllPlugins: vi.fn(),
      getPluginSchemaInitHooks: vi.fn().mockReturnValue([]),
      checkPluginSetup: vi.fn(),
      installPluginSetup: vi.fn(),
      uninstallPluginSetup: vi.fn(),
      loadPlugin: vi.fn(),
      stopPlugin: vi.fn(),
      reloadPlugin: vi.fn(),
    } as unknown as PluginLoader;

    const pluginStore = {
      getPlugin: vi.fn(async (pluginId: string) => ({ id: pluginId, settings: {} })),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as PluginStore;

    const taskStore = {
      on: vi.fn(),
      off: vi.fn(),
      getDatabase: vi.fn(),
    } as unknown as TaskStore;

    return new PluginRunner({ pluginLoader, pluginStore, taskStore, rootDir: "/repo" });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty env/path when no plugins contribute", async () => {
    const runner = createRunner([]);
    const result = await runner.collectExecutorRuntimeEnv({ taskId: "FN-1", worktreePath: "/tmp/wt", rootDir: "/repo" });

    expect(result).toEqual({ env: {}, pathPrepend: [], perPluginErrors: [] });
  });

  it("collects env/path from one plugin", async () => {
    const runner = createRunner([
      createMockPlugin("plugin-a", () => ({ pathPrepend: ["/opt/plugin-a/bin"], env: { A_TOKEN: "a" } })),
    ]);

    const result = await runner.collectExecutorRuntimeEnv({ taskId: "FN-1", worktreePath: "/tmp/wt", rootDir: "/repo" });

    expect(result.env).toEqual({ A_TOKEN: "a" });
    expect(result.pathPrepend).toEqual(["/opt/plugin-a/bin"]);
    expect(result.perPluginErrors).toEqual([]);
  });

  it("merges plugins with later env overriding and later path entries first", async () => {
    const runner = createRunner([
      createMockPlugin("plugin-a", () => ({ pathPrepend: ["/opt/a/bin"], env: { SHARED: "a", A_ONLY: "1" } })),
      createMockPlugin("plugin-b", () => ({ pathPrepend: ["/opt/b/bin"], env: { SHARED: "b", B_ONLY: "1" } })),
    ]);

    const result = await runner.collectExecutorRuntimeEnv({ taskId: "FN-1", worktreePath: "/tmp/wt", rootDir: "/repo" });

    expect(result.env).toEqual({ SHARED: "b", A_ONLY: "1", B_ONLY: "1" });
    expect(result.pathPrepend).toEqual(["/opt/b/bin", "/opt/a/bin"]);
  });

  it("records per-plugin errors when plugin throws", async () => {
    const runner = createRunner([
      createMockPlugin("plugin-ok", () => ({ env: { OK: "1" } })),
      createMockPlugin("plugin-bad", () => {
        throw new Error("boom");
      }),
    ]);

    const result = await runner.collectExecutorRuntimeEnv({ taskId: "FN-1", worktreePath: "/tmp/wt", rootDir: "/repo" });

    expect(result.env).toEqual({ OK: "1" });
    expect(result.perPluginErrors).toHaveLength(1);
    expect(result.perPluginErrors[0]?.pluginId).toBe("plugin-bad");
    expect(result.perPluginErrors[0]?.error.message).toContain("boom");
  });

  it("records schema errors for invalid contribution shapes", async () => {
    const runner = createRunner([
      createMockPlugin("plugin-path", () => ({ pathPrepend: ["relative/bin"] })),
      createMockPlugin("plugin-path-env", () => ({ env: { PATH: "forbidden" } })),
      createMockPlugin("plugin-value", () => ({ env: { GOOD: "ok", BAD: 42 as unknown as string } })),
    ]);

    const result = await runner.collectExecutorRuntimeEnv({ taskId: "FN-1", worktreePath: "/tmp/wt", rootDir: "/repo" });

    expect(result.env).toEqual({});
    expect(result.pathPrepend).toEqual([]);
    expect(result.perPluginErrors).toHaveLength(3);
    expect(result.perPluginErrors.map((item) => item.pluginId)).toEqual([
      "plugin-path",
      "plugin-path-env",
      "plugin-value",
    ]);
  });

  it("logs warnings when env keys are overridden", async () => {
    const runner = createRunner([
      createMockPlugin("plugin-a", () => ({ env: { SHARED: "a" } })),
      createMockPlugin("plugin-b", () => ({ env: { SHARED: "b" } })),
    ]);

    await runner.collectExecutorRuntimeEnv({ taskId: "FN-1", worktreePath: "/tmp/wt", rootDir: "/repo" });

    const logger = vi.mocked(createLogger).mock.results.at(-1)?.value as { warn: ReturnType<typeof vi.fn> };
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("key override: SHARED"));
  });
});
