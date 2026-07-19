import { vi } from "vitest";
import type { Mock } from "vitest";
import { installTaskWorktreeIdentityGuard } from "../worktree-hooks.js";
import type * as ReviewerModule from "../reviewer.js";

// Mock external dependencies
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  formatModelMarkerDetails: vi.fn((model: string, thinking?: string | null, annotations: string[] = []) => {
    const suffixes = [thinking ? `thinking effort: ${thinking}` : "", ...annotations].filter(Boolean);
    return suffixes.length ? `${model} ${suffixes.map((suffix) => `(${suffix})`).join(" ")}` : model;
  }),
  compactSessionContext: vi.fn(async (session, instructions) => {
    if (typeof (session as any).compact === "function") {
      return (session as any).compact(instructions);
    }
    return null;
  }),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
}));
/*
 * FNXC:WorkflowReviewers 2026-07-07-08:40:
 * Commit 3167dbc83 wired `proseSignalsClearApproval` + `extractJsonObjectCandidates` from reviewer.js into the workflow-step verdict parser (parseWorkflowStepVerdict). A mock that returns only `reviewStep` makes every executeWorkflowStep verdict parse throw `[vitest] No "extractJsonObjectCandidates" export`. Surface the real exports via importOriginal and stub only `reviewStep` (the agent-invoking seam these tests avoid); the verdict-parsing helpers then run for real.
 */
vi.mock("../reviewer.js", async (importOriginal) => {
  const actual = (await importOriginal()) as ReviewerModule;
  return { ...actual, reviewStep: vi.fn() };
});
vi.mock("../logger.js", () => {
  const createMockLogger = () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    createLogger: vi.fn(() => createMockLogger()),
    schedulerLog: createMockLogger(),
    executorLog: createMockLogger(),
    planLog: createMockLogger(),
    mergerLog: createMockLogger(),
    worktreePoolLog: createMockLogger(),
    reviewerLog: createMockLogger(),
    prMonitorLog: createMockLogger(),
    runtimeLog: createMockLogger(),
    ipcLog: createMockLogger(),
    projectManagerLog: createMockLogger(),
    hybridExecutorLog: createMockLogger(),
    formatError: (err: unknown) => {
      if (err instanceof Error) {
        const message = err.message || err.name || "Error";
        const stack = err.stack;
        return { message, stack, detail: stack ?? message };
      }
      const message = typeof err === "string" ? err : String(err);
      return { message, detail: message };
    },
  };
});
vi.mock("../merger.js", () => ({
  aiMergeTask: vi.fn(),
  findWorktreeUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("../agent-session-helpers.js", async () => {
  const { createFnAgent } = await import("../pi.js");
  return {
    createResolvedAgentSession: async (options: any) => {
      const result = await createFnAgent(options);
      return {
        session: result.session,
        sessionFile: result.sessionFile,
        runtimeId: "pi",
        wasConfigured: false,
      };
    },
    extractRuntimeHint: (runtimeConfig: Record<string, unknown> | undefined) => {
      const hint = runtimeConfig?.runtimeHint;
      return typeof hint === "string" && hint.trim().length > 0 ? hint.trim() : undefined;
    },
    resolveExecutorThinkingLevel: (taskThinkingLevel: string | undefined, settings: Record<string, unknown> | undefined) =>
      taskThinkingLevel
      ?? (typeof settings?.executionThinkingLevel === "string" ? settings.executionThinkingLevel : undefined)
      ?? (typeof settings?.executionGlobalThinkingLevel === "string" ? settings.executionGlobalThinkingLevel : undefined)
      ?? (typeof settings?.defaultThinkingLevelOverride === "string" ? settings.defaultThinkingLevelOverride : undefined)
      ?? (typeof settings?.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined),
    /*
     * FNXC:Settings-ThinkingLevel 2026-07-10-14:20:
     * FN-7794 added fallback-swap thinking resolvers (resolveExecutorFallbackThinkingLevel / resolveValidatorFallbackThinkingLevel) that executor.ts now calls unconditionally on the main session-creation and workflow-step-review hot paths. This shared harness mocks the whole `agent-session-helpers.js` module, so leaving these unmocked throws "No export is defined on the mock" for every test that reaches those paths (51 files depend on this harness). Mirror production's fallback-key -> lane-key -> default-override -> default precedence.
     */
    resolveExecutorFallbackThinkingLevel: (taskThinkingLevel: string | undefined, settings: Record<string, unknown> | undefined) =>
      (typeof settings?.fallbackThinkingLevel === "string" ? settings.fallbackThinkingLevel : undefined)
      ?? taskThinkingLevel
      ?? (typeof settings?.executionThinkingLevel === "string" ? settings.executionThinkingLevel : undefined)
      ?? (typeof settings?.executionGlobalThinkingLevel === "string" ? settings.executionGlobalThinkingLevel : undefined)
      ?? (typeof settings?.defaultThinkingLevelOverride === "string" ? settings.defaultThinkingLevelOverride : undefined)
      ?? (typeof settings?.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined),
    resolveValidatorThinkingLevel: (taskThinkingLevel: string | undefined, settings: Record<string, unknown> | undefined) =>
      (typeof settings?.validatorThinkingLevel === "string" ? settings.validatorThinkingLevel : undefined)
      ?? taskThinkingLevel
      ?? (typeof settings?.defaultThinkingLevelOverride === "string" ? settings.defaultThinkingLevelOverride : undefined)
      ?? (typeof settings?.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined),
    resolveValidatorFallbackThinkingLevel: (taskThinkingLevel: string | undefined, settings: Record<string, unknown> | undefined) =>
      (typeof settings?.validatorFallbackThinkingLevel === "string" ? settings.validatorFallbackThinkingLevel : undefined)
      ?? (typeof settings?.fallbackThinkingLevel === "string" ? settings.fallbackThinkingLevel : undefined)
      ?? (typeof settings?.validatorThinkingLevel === "string" ? settings.validatorThinkingLevel : undefined)
      ?? taskThinkingLevel
      ?? (typeof settings?.defaultThinkingLevelOverride === "string" ? settings.defaultThinkingLevelOverride : undefined)
      ?? (typeof settings?.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : undefined),
    resolveExecutorSessionModel: (
      taskModelProvider: string | undefined,
      taskModelId: string | undefined,
      settings: Record<string, unknown> | undefined,
      assignedAgentRuntimeConfig?: Record<string, unknown>,
    ) => {
      if (settings?.testMode === true || (typeof settings?.defaultProvider === "string" && settings.defaultProvider.trim().toLowerCase() === "mock")) {
        return { provider: "mock", modelId: "scripted" };
      }
      if (taskModelProvider && taskModelId) return { provider: taskModelProvider, modelId: taskModelId };
      if (typeof settings?.executionProvider === "string" && typeof settings?.executionModelId === "string") {
        return { provider: settings.executionProvider as string, modelId: settings.executionModelId as string };
      }
      if (typeof settings?.executionGlobalProvider === "string" && typeof settings?.executionGlobalModelId === "string") {
        return { provider: settings.executionGlobalProvider as string, modelId: settings.executionGlobalModelId as string };
      }
      if (typeof settings?.defaultProviderOverride === "string" && typeof settings?.defaultModelIdOverride === "string") {
        return { provider: settings.defaultProviderOverride as string, modelId: settings.defaultModelIdOverride as string };
      }
      if (typeof settings?.defaultProvider === "string" && typeof settings?.defaultModelId === "string") {
        return { provider: settings.defaultProvider as string, modelId: settings.defaultModelId as string };
      }
      const model = typeof assignedAgentRuntimeConfig?.model === "string" ? assignedAgentRuntimeConfig.model : "";
      const slash = model.indexOf("/");
      if (slash > 0 && slash < model.length - 1) {
        return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
      }
      return { provider: undefined, modelId: undefined };
    },
  };
});
vi.mock("../worktree-names.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree-names.js")>("../worktree-names.js");
  return {
    ...actual,
    generateWorktreeName: vi.fn().mockReturnValue("swift-falcon"),
  };
});
vi.mock("../worktree-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree-pool.js")>();
  const backend = await vi.importActual<typeof import("../worktree-backend.js")>("../worktree-backend.js");
  return {
    ...actual,
    ActiveSessionWorktreeRemovalError: backend.ActiveSessionWorktreeRemovalError,
    RemovalReason: backend.RemovalReason,
    removeWorktree: vi.fn(actual.removeWorktree),
    classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    describeRegisteredWorktrees: vi.fn().mockResolvedValue({ rawOutput: "", canonicalized: [] }),
    isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  };
});
vi.mock("../worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
}));

vi.mock("../worktree-stale-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree-stale-lock.js")>("../worktree-stale-lock.js");
  return {
    ...actual,
    parseIndexLockPath: vi.fn(actual.parseIndexLockPath),
    classifyStaleLock: vi.fn(),
    tryRemoveStaleLock: vi.fn(),
  };
});

vi.mock("../worktree-stale-registration.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree-stale-registration.js")>("../worktree-stale-registration.js");
  return {
    ...actual,
    parseStaleRegistrationPath: vi.fn(actual.parseStaleRegistrationPath),
    recoverStaleRegistration: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const { EventEmitter } = await import("node:events");
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const execSyncFn = vi.fn();
  const spawnFn = vi.fn((cmd: string, opts?: any) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn();
    queueMicrotask(() => {
      try {
        const out = execSyncFn(cmd, opts);
        const stdout = out === undefined ? "" : out.toString();
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        child.exitCode = 0;
        child.emit("close", 0, null);
      } catch (err) {
        const error = err as { stdout?: string; stderr?: string; status?: number; code?: number };
        const stdout = error?.stdout?.toString?.() ?? "";
        const stderr = error?.stderr?.toString?.() ?? "";
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.exitCode = error.status ?? error.code ?? 1;
        child.emit("close", child.exitCode, null);
      }
    });
    return child;
  });

  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    /*
    FNXC:PgMigrationQuarantine 2026-07-18-01:30:
    FN-8258's PG-backed executor audit suite shares this helper. Let its harness run
    psql for isolated fixture DDL while retaining mocked executor subprocess commands.
    */
    if (/^psql\s/.test(cmd.trim())) return actual.exec(cmd, opts as any, cb as any);
    const callback = typeof opts === "function" ? opts : cb;
    const forwardedOpts = typeof opts === "function" ? undefined : opts;
    try {
      const out = execSyncFn(cmd, forwardedOpts);
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });

  const execFileFn: any = vi.fn((_file: string, _args: string[] | undefined, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    if (typeof callback === "function") {
      callback(null, { stdout: "", stderr: "" });
    }
  });

  execFn[promisify.custom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          (err as Record<string, unknown>).stdout = stdout;
          (err as Record<string, unknown>).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  execFileFn[promisify.custom] = (_file: string, _args?: string[], _opts?: any) =>
    Promise.resolve({ stdout: "", stderr: "" });

  return { execSync: execSyncFn, exec: execFn, execFile: execFileFn, spawn: spawnFn };
});
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  realpathSync: vi.fn((path: string) => path),
  lstatSync: vi.fn(() => ({ isSymbolicLink: () => false, isDirectory: () => true })),
}));

export const mockExecuteAll: Mock<() => Promise<unknown[]>> = vi.fn().mockResolvedValue([]);
export const mockTerminateAllSessions: Mock<() => Promise<void>> = vi.fn().mockResolvedValue(undefined);
export const mockCleanup: Mock<() => Promise<void>> = vi.fn().mockResolvedValue(undefined);
export const mockSteerActiveSessions: Mock<(message: string) => Promise<void>> = vi.fn().mockResolvedValue(undefined);

vi.mock("../step-session-executor.js", () => ({
  StepSessionExecutor: vi.fn().mockImplementation(function () {
    return {
      executeAll: mockExecuteAll,
      terminateAllSessions: mockTerminateAllSessions,
      cleanup: mockCleanup,
      steerActiveSessions: mockSteerActiveSessions,
    };
  }),
  extractSection: (prompt: string, sectionName: string) => {
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^## ${escaped}\\s*$`, "m").exec(prompt);
    if (!match) return "";
    const start = match.index;
    const afterStart = start + match[0].length;
    const nextHeading = prompt.indexOf("\n## ", afterStart);
    const end = nextHeading === -1 ? prompt.length : nextHeading;
    return prompt.slice(start, end).trim();
  },
}));

vi.mock("../rate-limit-retry.js", () => ({
  withRateLimitRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({
    tasksCopied: 0,
    documentsCopied: 0,
    artifactsCopied: 0,
    degraded: false,
  }),
}));
vi.mock("../verification-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../verification-utils.js")>("../verification-utils.js");
  return {
    ...actual,
    runVerificationCommand: vi.fn(),
  };
});
vi.mock("@earendil-works/pi-coding-agent", () => {
  const mockSessionManager = {};
  return {
    SessionManager: {
      create: vi.fn().mockReturnValue(mockSessionManager),
      open: vi.fn().mockReturnValue(mockSessionManager),
      inMemory: vi.fn().mockReturnValue(mockSessionManager),
    },
    ModelRegistry: vi.fn().mockImplementation(function () {
      return {
        find: vi.fn(),
        refresh: vi.fn(),
      };
    }),
    LegacyCredentialStorage: {
      create: vi.fn().mockReturnValue({}),
    },
    getAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  };
});

import { createFnAgent } from "../pi.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { generateWorktreeName } from "../worktree-names.js";
import { findWorktreeUser } from "../merger.js";
import { StepSessionExecutor } from "../step-session-executor.js";
import { withRateLimitRetry } from "../rate-limit-retry.js";
import { exec, execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { hydrateWorktreeDb } from "../worktree-db-hydrate.js";
import { classifyTaskWorktree, describeRegisteredWorktrees, isUsableTaskWorktree } from "../worktree-pool.js";
import { classifyStaleLock, tryRemoveStaleLock } from "../worktree-stale-lock.js";
import { parseStaleRegistrationPath, recoverStaleRegistration } from "../worktree-stale-registration.js";
import { activeSessionRegistry, executingTaskLock } from "../active-session-registry.js";

export const mockedCreateFnAgent = vi.mocked(createFnAgent);
export const mockedSessionManager = vi.mocked(SessionManager);
export const mockedGenerateWorktreeName = vi.mocked(generateWorktreeName);
export const mockedFindWorktreeUser = vi.mocked(findWorktreeUser);
export const mockedStepSessionExecutor = vi.mocked(StepSessionExecutor);
export const mockedWithRateLimitRetry = vi.mocked(withRateLimitRetry);
export const mockedExec = vi.mocked(exec);
export const mockedExecSync = vi.mocked(execSync);
export const mockedExistsSync = vi.mocked(existsSync);
export const mockedRealpathSync = vi.mocked(realpathSync);
export const mockedHydrateWorktreeDb = vi.mocked(hydrateWorktreeDb);
export const mockedClassifyTaskWorktree = vi.mocked(classifyTaskWorktree);
export const mockedDescribeRegisteredWorktrees = vi.mocked(describeRegisteredWorktrees);
export const mockedIsUsableTaskWorktree = vi.mocked(isUsableTaskWorktree);
export const mockedClassifyStaleLock = vi.mocked(classifyStaleLock);
export const mockedTryRemoveStaleLock = vi.mocked(tryRemoveStaleLock);
export const mockedParseStaleRegistrationPath = vi.mocked(parseStaleRegistrationPath);
export const mockedRecoverStaleRegistration = vi.mocked(recoverStaleRegistration);
export const mockedInstallTaskWorktreeIdentityGuard = vi.mocked(installTaskWorktreeIdentityGuard);

export type EventListener = (...args: unknown[]) => void;

const withLegacyWorkflowFeatureDefaults = (settings: Record<string, unknown>) => ({
  ...settings,
  experimentalFeatures: {
    workflowColumns: false,
    workflowGraphExecutor: false,
    ...((settings.experimentalFeatures as Record<string, unknown> | undefined) ?? {}),
  },
});

const createLegacySettingsMock = (initialSettings: Record<string, unknown>) => {
  const mock = vi.fn().mockResolvedValue(withLegacyWorkflowFeatureDefaults(initialSettings));
  const mockResolvedValue = mock.mockResolvedValue.bind(mock);
  mock.mockResolvedValue = ((settings: Record<string, unknown>) =>
    mockResolvedValue(withLegacyWorkflowFeatureDefaults(settings))) as typeof mock.mockResolvedValue;
  return mock;
};

export function createMockStore() {
  const listeners = new Map<string, EventListener[]>();
  const store = {
    on: vi.fn((event: string, fn: EventListener) => {
      const existing = listeners.get(event) || [];
      existing.push(fn);
      listeners.set(event, existing);
    }),
    _trigger(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    /** Like `_trigger`, but awaits every (possibly async) listener — deterministic
     *  synchronization for tests asserting NEGATIVE outcomes after an event
     *  (e.g. "setModel was NOT called"), where `vi.waitFor` cannot apply and a
     *  bare `setTimeout(0)` is a brittle real-timer wait. */
    async _triggerAsync(event: string, ...args: unknown[]) {
      await Promise.allSettled(
        (listeners.get(event) || []).map((fn) => Promise.resolve(fn(...args))),
      );
    },
    emit: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    updateTask: vi.fn().mockResolvedValue({}),
    recordActivity: vi.fn().mockResolvedValue({}),
    moveTask: vi.fn().mockResolvedValue({}),
    handoffToReview: vi.fn().mockImplementation(async (id: string) => store.moveTask(id, "in-review")),
    mergeTask: vi.fn().mockResolvedValue({}),
    createTask: vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
      id: "FN-002",
      title: input.title,
      description: input.description,
      column: "triage",
      dependencies: input.dependencies ?? [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    logEntry: vi.fn().mockResolvedValue(undefined),
    addTaskComment: vi.fn().mockResolvedValue(undefined),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: createLegacySettingsMock({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: undefined,
    }),
    updateStep: vi.fn().mockResolvedValue({}),
    getWorkflowStep: vi.fn().mockResolvedValue(undefined),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    setPluginWorkflowStepTemplates: vi.fn(),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getGoalStore: vi.fn().mockReturnValue({
      listGoals: vi.fn().mockReturnValue([]),
    }),
    getFusionDir: vi.fn().mockReturnValue("/tmp/test/.fusion"),
    clearStaleExecutionStartBranchReferences: vi.fn().mockReturnValue([]),
    // FNXC:EngineTestDrift 2026-07-11-22:40:
    // FN-7750 / Runfusion#1980 made isLiveSharedBranchGroupMemberIntegration
    // require a live/open group from store.getBranchGroup(groupId) — a shared-
    // branch member is exempt from autoMerge:false only while its group is
    // open. The mock store must implement getBranchGroup or
    // isLiveSharedBranchGroupMember throws (caught by handleGraphFailure) and
    // shared-branch retry never fires. Default to an open group: executor-level
    // test tasks carrying a branchContext group are live by construction; group
    // staleness is unit-tested against the real store, not here.
    getBranchGroup: vi.fn().mockReturnValue({ id: "BG-test", status: "open", branchName: "fusion/bg-test" }),
    /*
    FNXC:EngineTests 2026-07-17-06:00:
    Executor graph path and backup dispatch now call getAgentLogCount / getGlobalSettingsDir
    on TaskStore. Without these stubs, nearly every execute()-path test rejects with
    "is not a function" and the full-suite engine shards go red.
    */
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getGlobalSettingsDir: vi.fn().mockReturnValue(undefined),
  };
  return store as any;
}

export function resetExecutorMocks() {
  vi.clearAllMocks();
  mockedExec.mockReset();
  mockedExecSync.mockReset();
  mockedIsUsableTaskWorktree.mockResolvedValue(true);
  mockedClassifyTaskWorktree.mockImplementation(async (rootDir: string, worktreePath: string) => {
    const usable = await mockedIsUsableTaskWorktree(rootDir, worktreePath);
    return usable
      ? { ok: true }
      : { ok: false, classification: "incomplete", reason: "missing or invalid .git metadata" };
  });
  mockedClassifyStaleLock.mockReset();
  mockedTryRemoveStaleLock.mockReset();
  mockedParseStaleRegistrationPath.mockReset();
  mockedRecoverStaleRegistration.mockReset();
  mockedInstallTaskWorktreeIdentityGuard.mockReset();
  mockedClassifyStaleLock.mockResolvedValue({ kind: "fresh", reason: "fresh" } as any);
  mockedParseStaleRegistrationPath.mockImplementation((value) => {
    if (!value) return null;
    const match = /'([^']+)'\s+is a missing but already registered worktree/i.exec(String(value));
    return match?.[1] ?? null;
  });
  mockedRecoverStaleRegistration.mockResolvedValue({ recovered: true, actions: ["prune"] });
  mockedInstallTaskWorktreeIdentityGuard.mockResolvedValue(undefined);
  mockedTryRemoveStaleLock.mockResolvedValue({ removed: true });
  mockExecuteAll.mockResolvedValue([]);
  mockTerminateAllSessions.mockResolvedValue(undefined);
  mockCleanup.mockResolvedValue(undefined);
  mockSteerActiveSessions.mockResolvedValue(undefined);
  // FNXC:ExecutorTests 2026-06-24-21:09: Executor liveness guards are process-wide module state, so test reset must clear both executing locks and active-session registry paths; otherwise earlier tests' claims can block later execute() calls with duplicate-execution or foreign active-session path symptoms.
  executingTaskLock._clearForTest();
  activeSessionRegistry.clear();
}
