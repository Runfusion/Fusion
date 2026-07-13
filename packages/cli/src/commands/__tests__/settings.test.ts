import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    GlobalSettingsStore: makeConstructibleMock(),
    DEFAULT_SETTINGS,
    SUPPORTED_LOCALES: ["en", "zh-CN", "zh-TW", "fr", "es", "ko"],
    resolveWorktrunkSettings: (globalValue: any, projectValue: any) => ({
      enabled: projectValue?.enabled ?? globalValue?.enabled ?? false,
      ...(projectValue?.binaryPath ?? globalValue?.binaryPath ? { binaryPath: projectValue?.binaryPath ?? globalValue?.binaryPath } : {}),
      onFailure: projectValue?.onFailure ?? globalValue?.onFailure ?? "fail",
    }),
  };
});

vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn(),
}));

const { resolveWorktrunkBinaryMock, probeWorktrunkMock } = vi.hoisted(() => ({
  resolveWorktrunkBinaryMock: vi.fn(),
  probeWorktrunkMock: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  resolveWorktrunkBinary: resolveWorktrunkBinaryMock,
  probeWorktrunk: probeWorktrunkMock,
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
    resolveWorktrunkBinaryMock.mockResolvedValue({ binaryPath: "/usr/local/bin/worktrunk" });
    probeWorktrunkMock.mockResolvedValue({ ok: true, version: "1.0.0" });
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
    expect(VALID_SETTINGS).toContain("integrationBranch");
    // baseBranch is a per-Task/Mission field, NOT a ProjectSettings key — it must
    // never be added to VALID_SETTINGS/PROJECT_ONLY_SETTINGS/STRING_SETTINGS.
    expect(VALID_SETTINGS).not.toContain("baseBranch");
    // Moved keys are NOT settable via the CLI (they live in workflow settings).
    expect(VALID_SETTINGS).not.toContain("runStepsInNewSessions");
    expect(VALID_SETTINGS).not.toContain("maxParallelSteps");
    expect(VALID_SETTINGS).not.toContain("requirePlanApproval");
    expect(parseValue("ntfyEnabled", "yes")).toBe(true);
    expect(parseValue("maxConcurrent", "4")).toBe(4);
    expect(parseValue("worktreeNaming", "task-id")).toBe("task-id");
    expect(parseValue("worktreesDir", "~/.fn-worktrees/{repo}")).toBe("~/.fn-worktrees/{repo}");
    expect(parseValue("defaultNodeId", "node-abc-123")).toBe("node-abc-123");
    expect(parseValue("integrationBranch", "  master  ")).toBe("master");
    expect(parseValue("unavailableNodePolicy", "block")).toBe("block");
    expect(parseValue("unavailableNodePolicy", "fallback-local")).toBe("fallback-local");
    expect(() => parseValue("unavailableNodePolicy", "invalid")).toThrow(/block, fallback-local/);
    expect(parseValue("worktrunk.enabled", "true" as any)).toBe(true);
    expect(parseValue("worktrunk.enabled", "yes" as any)).toBe(true);
    expect(parseValue("worktrunk.enabled", "false" as any)).toBe(false);
    expect(parseValue("worktrunk.enabled", "no" as any)).toBe(false);
    expect(() => parseValue("worktrunk.enabled", "maybe" as any)).toThrow(/Invalid boolean value/);
    expect(parseValue("worktrunk.binaryPath", "  /usr/local/bin/worktrunk  " as any)).toBe("/usr/local/bin/worktrunk");
    expect(parseValue("worktrunk.onFailure", "fail" as any)).toBe("fail");
    expect(parseValue("worktrunk.onFailure", "fallback-native" as any)).toBe("fallback-native");
    expect(() => parseValue("worktrunk.onFailure", "crash" as any)).toThrow(/fail, fallback-native/);
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

  it("runSettingsSet language persists a supported locale globally", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ language: "zh-TW" } as any));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ language: "zh-TW" } as any));
    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      updateSettings,
      getSettings,
    }));

    await runSettingsSet("language", "zh-TW");

    expect(updateSettings).toHaveBeenCalledWith({ language: "zh-TW" });
  });

  it("runSettingsSet language auto clears the persisted locale (null-as-delete)", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({}));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({}));
    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      updateSettings,
      getSettings,
    }));

    await runSettingsSet("language", "auto");

    expect(updateSettings).toHaveBeenCalledWith({ language: null });
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

  it("rejects setting a moved key (runStepsInNewSessions) and prints the workflow-settings redirect hint", async () => {
    const updateSettings = vi.fn();
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettings: vi.fn() } as any,
    });

    await expect(runSettingsSet("runStepsInNewSessions", "true", "demo-project")).rejects.toThrow("process.exit:1");

    expect(updateSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Error: Unknown setting "runStepsInNewSessions"');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("workflow settings"));
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

  it("rejects setting a moved key (maxParallelSteps) — it lives in workflow settings now", async () => {
    const updateSettings = vi.fn();
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettings: vi.fn() } as any,
    });

    await expect(runSettingsSet("maxParallelSteps", "3", "demo-project")).rejects.toThrow("process.exit:1");

    expect(updateSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Error: Unknown setting "maxParallelSteps"');
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

  it("runSettingsSet with project updates integrationBranch", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ integrationBranch: "master" }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ integrationBranch: "master" }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings, getSettings } as any,
    });

    await runSettingsSet("integrationBranch", "master", "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(updateSettings).toHaveBeenCalledWith({ integrationBranch: "master" });
  });

  it("rejects setting integrationBranch without explicit project scope", async () => {
    await expect(runSettingsSet("integrationBranch", "master")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith('Error: Setting "integrationBranch" is project-only. Use --project or run from a project directory.');
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it("rejects values outside range for a still-valid numeric setting (maxWorktrees)", async () => {
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { updateSettings: vi.fn(), getSettings: vi.fn() } as any,
    });

    await expect(runSettingsSet("maxWorktrees", "99", "demo-project")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Value out of range for maxWorktrees"));
  });

  it("runSettingsShow prints the workflow-settings redirect hint and no longer lists moved step settings", async () => {
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
    // Moved step settings are no longer listed; the redirect hint points users
    // to workflow settings.
    expect(output).not.toContain("Run Steps In New Sessions");
    expect(output).not.toContain("Max Parallel Steps");
    expect(output).toContain("workflow settings");
  });

  it("rejects enabling worktrunk when binary is not verified", async () => {
    const updateSettings = vi.fn();
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ worktrunk: { enabled: false, onFailure: "fail" } }));
    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      updateSettings,
      getSettings,
    }));
    resolveWorktrunkBinaryMock.mockRejectedValueOnce(new Error("missing"));

    await expect(runSettingsSet("worktrunk.enabled", "true")).rejects.toThrow("process.exit:1");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("worktrunk.enabled cannot be set to true until the binary is installed and verified"),
    );
  });

  it("allows disabling worktrunk without binary verification", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings({ worktrunk: { enabled: false, onFailure: "fail" } }));
    const getSettings = vi.fn().mockResolvedValue(makeSettings({ worktrunk: { enabled: true, onFailure: "fail" } }));
    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      updateSettings,
      getSettings,
    }));
    await runSettingsSet("worktrunk.enabled", "false");

    expect(updateSettings).toHaveBeenCalledWith({ worktrunk: { enabled: false, onFailure: "fail" } });
    expect(resolveWorktrunkBinaryMock).not.toHaveBeenCalled();
    expect(probeWorktrunkMock).not.toHaveBeenCalled();
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

  // Core/project stores use top-level shallow patch merge, so dotted updates must re-emit sibling fields.
  it("runSettingsSet preserves existing project worktrunk sibling fields", async () => {
    const updateSettings = vi.fn().mockResolvedValue(makeSettings());
    const getSettingsByScope = vi.fn().mockResolvedValue({
      global: makeSettings(),
      project: {
        worktrunk: {
          binaryPath: "/x",
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

    await runSettingsSet("worktrunk.enabled", "true", "demo-project");

    expect(updateSettings).toHaveBeenCalledWith({
      worktrunk: {
        binaryPath: "/x",
        enabled: true,
      },
    });
  });

  it("runSettingsSet with --project updates project store without mutating global store", async () => {
    const globalUpdateSettings = vi.fn();
    (GlobalSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      updateSettings: globalUpdateSettings,
      getSettings: vi.fn().mockResolvedValue(makeSettings()),
    }));

    const projectUpdateSettings = vi.fn().mockResolvedValue(makeSettings());
    const getSettingsByScope = vi.fn().mockResolvedValue({
      global: makeSettings(),
      project: { worktrunk: {} },
    });
    const projectGetSettings = vi.fn().mockResolvedValue(makeSettings());
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: {
        updateSettings: projectUpdateSettings,
        getSettingsByScope,
        getSettings: projectGetSettings,
      } as any,
    });

    await runSettingsSet("worktrunk.onFailure", "fallback-native", "demo-project");

    expect(projectUpdateSettings).toHaveBeenCalledWith({
      worktrunk: { onFailure: "fallback-native" },
    });
    expect(globalUpdateSettings).not.toHaveBeenCalled();
  });

  it("rejects unknown worktrunk dotted subkeys", async () => {
    await expect(runSettingsSet("worktrunk.bogus", "true")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith('Error: Unknown setting "worktrunk.bogus"');
  });

  it("runSettingsShow includes Worktrunk Integration section and dotted values", async () => {
    const getSettings = vi.fn().mockResolvedValue(makeSettings({
      worktrunk: {
        enabled: true,
        binaryPath: undefined,
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
    expect(output).toContain("Worktrunk Integration:");
    expect(output).toContain("Worktrunk Enabled");
    expect(output).toContain("true");
    expect(output).toContain("Worktrunk On Failure");
    expect(output).toContain('"fallback-native"');
    expect(output).toContain("Worktrunk Binary Path");
    expect(output).toContain("(not set)");
  });

  it("runSettingsShow omits Worktrunk Integration section when worktrunk is absent", async () => {
    const getSettings = vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      autoResolveConflicts: true,
      smartConflictResolution: true,
      requirePlanApproval: false,
      ntfyEnabled: false,
      taskPrefix: "FN",
      worktreeNaming: "random",
    });
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: { getSettings } as any,
    });

    await runSettingsShow("demo-project");

    const output = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).not.toContain("Worktrunk Integration:");
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
