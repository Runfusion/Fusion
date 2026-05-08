import { vi } from "vitest";

// Mock external dependencies
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
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
vi.mock("../reviewer.js", () => ({
  reviewStep: vi.fn(),
}));
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
    resolveExecutorSessionModel: (
      taskModelProvider: string | undefined,
      taskModelId: string | undefined,
      settings: Record<string, unknown> | undefined,
      assignedAgentRuntimeConfig?: Record<string, unknown>,
    ) => {
      const model = typeof assignedAgentRuntimeConfig?.model === "string" ? assignedAgentRuntimeConfig.model : "";
      const slash = model.indexOf("/");
      if (slash > 0 && slash < model.length - 1) {
        return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
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

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const { EventEmitter } = await import("node:events");
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
  return { execSync: execSyncFn, exec: execFn, spawn: spawnFn };
});
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

export const mockExecuteAll = vi.fn().mockResolvedValue([]);
export const mockTerminateAllSessions = vi.fn().mockResolvedValue(undefined);
export const mockCleanup = vi.fn().mockResolvedValue(undefined);

vi.mock("../step-session-executor.js", () => ({
  StepSessionExecutor: vi.fn().mockImplementation(() => ({
    executeAll: mockExecuteAll,
    terminateAllSessions: mockTerminateAllSessions,
    cleanup: mockCleanup,
  })),
}));

vi.mock("../rate-limit-retry.js", () => ({
  withRateLimitRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("../verification-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../verification-utils.js")>("../verification-utils.js");
  return {
    ...actual,
    runVerificationCommand: vi.fn(),
  };
});
vi.mock("@mariozechner/pi-coding-agent", () => {
  const mockSessionManager = {};
  return {
    SessionManager: {
      create: vi.fn().mockReturnValue(mockSessionManager),
      open: vi.fn().mockReturnValue(mockSessionManager),
      inMemory: vi.fn().mockReturnValue(mockSessionManager),
    },
    ModelRegistry: vi.fn().mockImplementation(() => ({
      find: vi.fn(),
      refresh: vi.fn(),
    })),
    AuthStorage: {
      create: vi.fn().mockReturnValue({}),
    },
    getAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  };
});

import { createFnAgent } from "../pi.js";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { generateWorktreeName } from "../worktree-names.js";
import { findWorktreeUser } from "../merger.js";
import { StepSessionExecutor } from "../step-session-executor.js";
import { withRateLimitRetry } from "../rate-limit-retry.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

export const mockedCreateFnAgent = vi.mocked(createFnAgent);
export const mockedSessionManager = vi.mocked(SessionManager);
export const mockedGenerateWorktreeName = vi.mocked(generateWorktreeName);
export const mockedFindWorktreeUser = vi.mocked(findWorktreeUser);
export const mockedStepSessionExecutor = vi.mocked(StepSessionExecutor);
export const mockedWithRateLimitRetry = vi.mocked(withRateLimitRetry);
export const mockedExecSync = vi.mocked(execSync);
export const mockedExistsSync = vi.mocked(existsSync);

export type EventListener = (...args: unknown[]) => void;

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
    moveTask: vi.fn().mockResolvedValue({}),
    mergeTask: vi.fn().mockResolvedValue({}),
    logEntry: vi.fn().mockResolvedValue(undefined),
    addTaskComment: vi.fn().mockResolvedValue(undefined),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({
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
    getFusionDir: vi.fn().mockReturnValue("/tmp/test/.fusion"),
    clearStaleExecutionStartBranchReferences: vi.fn().mockReturnValue([]),
  };
  return store as any;
}

export function resetExecutorMocks() {
  vi.clearAllMocks();
  mockExecuteAll.mockResolvedValue([]);
  mockTerminateAllSessions.mockResolvedValue(undefined);
  mockCleanup.mockResolvedValue(undefined);
}
