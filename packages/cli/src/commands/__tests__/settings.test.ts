import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@fusion/core", () => {
  const DEFAULT_SETTINGS = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    autoResolveConflicts: true,
    smartConflictResolution: true,
    requirePlanApproval: false,
    ntfyEnabled: false,
    ntfyTopic: undefined,
    worktreeNaming: "random",
    githubTokenConfigured: false,
    defaultProvider: undefined,
    defaultModelId: undefined,
    defaultNodeId: undefined,
    unavailableNodePolicy: undefined,
    worktrunk: {
      enabled: false,
      binaryPath: undefined,
      onFailure: "fail",
    },
  };

  return {
    GlobalSettingsStore: vi.fn(),
    DEFAULT_SETTINGS,
  };
});

vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn(),
}));

import { GlobalSettingsStore, DEFAULT_SETTINGS } from "@fusion/core";
import { resolveProject } from "../../project-context.js";
import { runSettingsShow, runSettingsSet, parseValue, VALID_SETTINGS } from "../settings.js";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("settings commands", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("exposes expected valid settings and parser behavior", () => {
    expect(VALID_SETTINGS).toContain("maxConcurrent");
    expect(VALID_SETTINGS).toContain("defaultNodeId");
    expect(VALID_SETTINGS).toContain("unavailableNodePolicy");
    expect(VALID_SETTINGS).toContain("worktrunk.enabled");
    expect(VALID_SETTINGS).toContain("worktrunk.binaryPath");
    expect(VALID_SETTINGS).toContain("worktrunk.onFailure");
    expect(parseValue("ntfyEnabled", "yes")).toBe(true);
    expect(parseValue("maxConcurrent", "4")).toBe(4);
    expect(parseValue("worktreeNaming", "task-id")).toBe("task-id");
    expect(parseValue("worktreesDir", "~/.fn-worktrees/{repo}")).toBe("~/.fn-worktrees/{repo}");
    expect(parseValue("defaultNodeId", "node-abc-123")).toBe("node-abc-123");
    expect(parseValue("unavailableNodePolicy", "block")).toBe("block");
    expect(parseValue("unavailableNodePolicy", "fallback-local")).toBe("fallback-local");
    expect(() => parseValue("unavailableNodePolicy", "invalid")).toThrow(/block, fallback-local/);
    expect(parseValue("worktrunk.enabled", "true" as any)).toBe(true);
    expect(parseValue("worktrunk.binaryPath", "/usr/local/bin/worktrunk" as any)).toBe("/usr/local/bin/worktrunk");
    expect(parseValue("worktrunk.onFailure", "fallback-native" as any)).toBe("fallback-native");
    expect(() => parseValue("worktrunk.onFailure", "ignore" as any)).toThrow(/fail, fallback-native/);
  });

  it("runSettingsShow without project uses global settings even if a project could resolve", async () => {
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ ntfyEnabled: true }));
    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      getSettings,
    }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getSettings: vi.fn() } as any,
    });

    await runSettingsShow();

    expect(getSettings).toHaveBeenCalled();
    expect(resolveProject).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("  fn Global Settings");
  });

  it("runSettingsShow with project uses project store", async () => {
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ maxConcurrent: 5 }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getSettings } as any,
    });

    await runSettingsShow("demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(logSpy).toHaveBeenCalledWith("  fn Settings for project 'demo-project'");
  });

  it("runSettingsSet without project updates global-only settings", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ ntfyEnabled: true }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ ntfyEnabled: true }));
    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      updateSettings,
      getSettings,
    }));

    await runSettingsSet("ntfyEnabled", "true");

    expect(updateSettings).toHaveBeenCalledWith({ ntfyEnabled: true });
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it("runSettingsSet with project updates project-only settings", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ maxConcurrent: 6 }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ maxConcurrent: 6 }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettings } as any,
    });

    await runSettingsSet("maxConcurrent", "6", "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(updateSettings).toHaveBeenCalledWith({ maxConcurrent: 6 });
  });

  it("rejects global-only settings for project scope", async () => {
    await expect(runSettingsSet("ntfyEnabled", "true", "demo-project")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith('Error: Setting "ntfyEnabled" is global-only. Omit --project to update it.');
  });

  it("rejects project-only settings without explicit project scope", async () => {
    await expect(runSettingsSet("maxConcurrent", "4")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith('Error: Setting "maxConcurrent" is project-only. Use --project or run from a project directory.');
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it("runSettingsSet with project updates runStepsInNewSessions", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ runStepsInNewSessions: true }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ runStepsInNewSessions: true }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettings } as any,
    });

    await runSettingsSet("runStepsInNewSessions", "true", "demo-project");

    expect(updateSettings).toHaveBeenCalledWith({ runStepsInNewSessions: true });
  });

  it("runSettingsSet with project updates worktreesDir", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ worktreesDir: "~/.fn-worktrees/{repo}" }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ worktreesDir: "~/.fn-worktrees/{repo}" }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettings } as any,
    });

    await runSettingsSet("worktreesDir", "~/.fn-worktrees/{repo}", "demo-project");

    expect(updateSettings).toHaveBeenCalledWith({ worktreesDir: "~/.fn-worktrees/{repo}" });
  });

  it("runSettingsSet with project updates maxParallelSteps", async () => {    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ maxParallelSteps: 3 }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ maxParallelSteps: 3 }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettings } as any,
    });

    await runSettingsSet("maxParallelSteps", "3", "demo-project");

    expect(updateSettings).toHaveBeenCalledWith({ maxParallelSteps: 3 });
  });

  it("runSettingsSet updates defaultNodeId and unavailableNodePolicy", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ defaultNodeId: "my-node", unavailableNodePolicy: "fallback-local" }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ defaultNodeId: "my-node", unavailableNodePolicy: "fallback-local" }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettings } as any,
    });

    await runSettingsSet("defaultNodeId", "my-node", "demo-project");
    await runSettingsSet("unavailableNodePolicy", "fallback-local", "demo-project");

    expect(updateSettings).toHaveBeenNthCalledWith(1, { defaultNodeId: "my-node" });
    expect(updateSettings).toHaveBeenNthCalledWith(2, { unavailableNodePolicy: "fallback-local" });
  });

  it("rejects maxParallelSteps values outside range", async () => {
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings: vi.fn(), getSettings: vi.fn() } as any,
    });

    await expect(runSettingsSet("maxParallelSteps", "5", "demo-project")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Value out of range for maxParallelSteps"));
  });

  it("runSettingsShow displays Execution section with step-session settings", async () => {
    const getSettings = vi.fn().mockResolvedValue(makeSettings({
      runStepsInNewSessions: true,
      maxParallelSteps: 3,
    }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getSettings } as any,
    });

    await runSettingsShow("demo-project");

    const output = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("Execution");
    expect(output).toContain("Run Steps In New Sessions");
    expect(output).toContain("Max Parallel Steps");
  });

  it("runSettingsSet supports worktrunk dotted keys in global scope", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({
      worktrunk: { enabled: true, binaryPath: "/usr/local/bin/worktrunk", onFailure: "fail" },
    }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({
      worktrunk: { enabled: false, binaryPath: "/usr/local/bin/worktrunk", onFailure: "fail" },
    }));

    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      updateSettings,
      getSettings,
    }));

    await runSettingsSet("worktrunk.enabled", "true");
    await runSettingsSet("worktrunk.onFailure", "fallback-native");
    await runSettingsSet("worktrunk.binaryPath", "/usr/local/bin/worktrunk");

    expect(updateSettings).toHaveBeenNthCalledWith(1, {
      worktrunk: { enabled: true, binaryPath: "/usr/local/bin/worktrunk", onFailure: "fail" },
    });
    expect(updateSettings).toHaveBeenNthCalledWith(2, {
      worktrunk: { enabled: false, binaryPath: "/usr/local/bin/worktrunk", onFailure: "fallback-native" },
    });
    expect(updateSettings).toHaveBeenNthCalledWith(3, {
      worktrunk: { enabled: false, binaryPath: "/usr/local/bin/worktrunk", onFailure: "fail" },
    });
  });

  it("runSettingsSet rejects invalid worktrunk onFailure enum", async () => {
    const updateSettings = vi.fn();
    const getSettings = vi.fn().mockResolvedValue(makeSettings());
    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      updateSettings,
      getSettings,
    }));

    await expect(runSettingsSet("worktrunk.onFailure", "ignore")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Valid options: fail, fallback-native"));
  });

  it("runSettingsSet preserves existing project worktrunk sibling fields", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings());
    const getSettingsByScope = vi.fn().mockResolvedValue({
      global: makeSettings(),
      project: {
        worktrunk: {
          enabled: true,
          binaryPath: "/opt/bin/worktrunk",
          onFailure: "fallback-native",
        },
      },
    });
    const getSettings = vi.fn().mockResolvedValue(makeSettings());

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettingsByScope, getSettings } as any,
    });

    await runSettingsSet("worktrunk.enabled", "false", "demo-project");

    expect(updateSettings).toHaveBeenCalledWith({
      worktrunk: {
        enabled: false,
        binaryPath: "/opt/bin/worktrunk",
        onFailure: "fallback-native",
      },
    });
  });

  it("runSettingsShow includes Worktrunk integration section", async () => {
    const getSettings = vi.fn().mockResolvedValue(makeSettings({
      worktrunk: {
        enabled: true,
        binaryPath: "/usr/local/bin/worktrunk",
        onFailure: "fallback-native",
      },
    }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getSettings } as any,
    });

    await runSettingsShow("demo-project");

    const output = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("Worktrunk integration");
    expect(output).toContain("Worktrunk Enabled");
    expect(output).toContain("Worktrunk Binary Path");
    expect(output).toContain("Worktrunk On Failure");
  });

  it("runSettingsShow includes Node Routing section", async () => {
    const getSettings = vi.fn().mockResolvedValue(makeSettings({
      defaultNodeId: "node-abc",
      unavailableNodePolicy: "block",
    }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getSettings } as any,
    });

    await runSettingsShow("demo-project");

    const output = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("Node Routing");
    expect(output).toContain("Default Node Id");
    expect(output).toContain("Unavailable Node Policy");
  });
});
