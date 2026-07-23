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
  const probe = process.env.FUSION_TEST_LOG_PROBE === "1"
    ? (...a: unknown[]) => console.error("[probe]", ...a)
    : undefined;
  const createMockLogger = () => ({
    log: vi.fn(probe),
    warn: vi.fn(probe),
    error: vi.fn(probe),
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
    piLog: createMockLogger(),
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
/*
FNXC:EngineTests 2026-07-19-06:00 (U5f / R9):
Session-shape defaults. ~419 per-file `mockedCreateFnAgent.mockResolvedValue({session:{...}})`
sites each hand-roll a session stub, and almost all of them define only `prompt`/`dispose` —
the surface the LEGACY execute path touched. Once every run is graph-owned, those same tests
also reach the workflow-STEP session, which subscribes to the stream (`session.subscribe(...)`
in executor.ts), so each of those stubs would throw "subscribe is not a function". That was
the single largest failure class when the store was made workflow-aware (38 of 59 in the
measured sample).

Rather than edit 419 literals, fill the gaps at the ONE seam every executor session is built
through. A stub's own methods always win — this only supplies what a stub omitted, so no test
loses control of behavior it actually asserts.
*/
/*
FNXC:EngineTests 2026-07-19-12:10 (U5g pt2):
Verdict-shaped default stream for REVIEW sessions. A workflow review step reads its verdict
from the session's streamed text (`session.subscribe` -> `output` -> `parseWorkflowStepVerdict`
in executor.ts). A stub that streams nothing therefore always produces "malformed output (no
parseable verdict)", which under graph ownership routes the run into `plan-replan` -> triage
instead of the behavior under test. Emitting APPROVE is the neutral default: it makes a review
step inert, matching what these tests assumed back when reviewers were not in their loop.
Keyed on the "## Feedback Format" block that `verdictBlock` puts in a review step's system
prompt, so implementation sessions keep a silent stream, and any stub that defines its own
`subscribe` (including tests deliberately asserting malformed or REVISE output) still wins.
*/
const REVIEW_MARKER = "## Feedback Format";
const APPROVE_OUTPUT = "{\"verdict\":\"APPROVE\",\"notes\":\"\"}";

function withSessionDefaults(session: any, options?: { systemPrompt?: unknown }): any {
  if (!session || typeof session !== "object") return session;
  if (typeof session.subscribe !== "function") {
    const isReview = typeof options?.systemPrompt === "string" && options.systemPrompt.includes(REVIEW_MARKER);
    session.subscribe = isReview
      ? vi.fn((listener: (e: unknown) => void) => {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: APPROVE_OUTPUT, partial: APPROVE_OUTPUT } });
        return vi.fn();
      })
      : vi.fn(() => vi.fn());
  }
  if (typeof session.prompt !== "function") session.prompt = vi.fn().mockResolvedValue(undefined);
  if (typeof session.dispose !== "function") session.dispose = vi.fn();
  return session;
}

vi.mock("../agent-session-helpers.js", async () => {
  const { createFnAgent } = await import("../pi.js");
  return {
    createResolvedAgentSession: async (options: any) => {
      const result = await createFnAgent(options);
      return {
        session: withSessionDefaults(result?.session, options),
        sessionFile: result?.sessionFile,
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
  statSync: vi.fn(() => ({ isDirectory: () => true })),
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
import { existsSync, realpathSync, statSync } from "node:fs";
import { hydrateWorktreeDb } from "../worktree-db-hydrate.js";
import { classifyTaskWorktree, describeRegisteredWorktrees, isUsableTaskWorktree } from "../worktree-pool.js";
import { classifyStaleLock, tryRemoveStaleLock } from "../worktree-stale-lock.js";
import { parseStaleRegistrationPath, recoverStaleRegistration } from "../worktree-stale-registration.js";
import { activeSessionRegistry, executingTaskLock } from "../active-session-registry.js";
import { TaskExecutor } from "../executor.js";

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
export const mockedStatSync = vi.mocked(statSync);
export const mockedHydrateWorktreeDb = vi.mocked(hydrateWorktreeDb);
export const mockedClassifyTaskWorktree = vi.mocked(classifyTaskWorktree);
export const mockedDescribeRegisteredWorktrees = vi.mocked(describeRegisteredWorktrees);
export const mockedIsUsableTaskWorktree = vi.mocked(isUsableTaskWorktree);
export const mockedClassifyStaleLock = vi.mocked(classifyStaleLock);
export const mockedTryRemoveStaleLock = vi.mocked(tryRemoveStaleLock);
export const mockedParseStaleRegistrationPath = vi.mocked(parseStaleRegistrationPath);
export const mockedRecoverStaleRegistration = vi.mocked(recoverStaleRegistration);
export const mockedInstallTaskWorktreeIdentityGuard = vi.mocked(installTaskWorktreeIdentityGuard);

/*
FNXC:EngineTests 2026-07-19-14:20 (U10b — the merge-requester harness seam):
Under graph ownership the in-review handoff IS the merge boundary: the `requestMerge` seam calls
`ensureWorkflowMergeBoundaryTask` and then moves the task to the merge node's column. There is no
completion-path `moveTask(id, "in-review")` any more. But `requestMerge` short-circuits to
`merge-unavailable` BEFORE any row mutation when `mergeRequester` is unset, so a bare
`new TaskExecutor(store, root)` — which is how ~40 legacy-shaped test files build one — terminated
the graph with ZERO moveTask calls. Production always injects a requester (the work engine wires
it), so this is harness absence, not the contract under test.

Injected by patching the two entry points rather than by a prototype accessor: TS class fields
define an own `mergeRequester` (undefined) per instance, which SHADOWS any prototype accessor. A
test that calls `setMergeRequester` itself still wins — this only fills the hole when nothing set
one. The default is deliberately a no-op queue result, not a success: it proves the boundary was
reached without asserting a merge landed.
*/
const DEFAULT_TEST_MERGE_RESULT = { merged: false, noOp: false, reason: "queued" };
const executorProto = TaskExecutor.prototype as unknown as Record<string, any>;
for (const method of ["execute", "resumeTaskForAgent"] as const) {
  const original = executorProto[method];
  if (typeof original !== "function" || original.__fusionDefaultMergeRequester) continue;
  const patched = function (this: any, ...args: unknown[]) {
    if (!this.mergeRequester) {
      this.setMergeRequester(async () => DEFAULT_TEST_MERGE_RESULT as any);
    }
    return original.apply(this, args);
  };
  (patched as any).__fusionDefaultMergeRequester = true;
  executorProto[method] = patched;
}

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
  /*
  FNXC:EngineTests 2026-07-19-09:10 (U5g):
  Write-through task state. `updateTask` used to be a black hole (`mockResolvedValue({})`) while
  `getTask` returned a frozen literal, so nothing the executor persisted was ever readable back.
  The legacy execute path tolerated that because it carried the in-memory `task` object forward.
  The graph does not: the write-capable-node isolation guard re-reads the row
  (`executionTarget = await this.store.getTask(live.id)`, executor.ts) precisely so it cannot
  trust a stale in-memory copy, and then rejects with `no-worktree-for-write-node` because the
  frozen literal has no worktree — 41 failures across 4 files, all of them worktree-mechanics
  tests that never reached the assertion under test.
  Recording `updateTask` patches and replaying them from `getTask` is what a real store does, so
  this closes the gap at the shared seam rather than per file. Files that install their own
  `getTask`/`updateTask` implementations replace these outright and are unaffected.
  */
  const patches = new Map<string, Record<string, unknown>>();
  const applyPatch = (id: string, patch: Record<string, unknown> | undefined) => {
    if (!patch || typeof patch !== "object") return;
    patches.set(id, { ...(patches.get(id) ?? {}), ...patch });
  };
  /*
  FNXC:EngineTests 2026-07-19-14:45 (U10b):
  Write-through survives a per-file `getTask` override. U5g made the DEFAULT `getTask` replay
  `updateTask` patches, but ~10 files on this surface install their own `getTask` returning a
  frozen literal — so for them the row never reflected anything the executor persisted (no
  worktree, steps never terminal), and the graph rejected at the write-capable-node guard or the
  merge implementation-proof gate before the assertion under test ran.
  Wrapping `mockImplementation`/`mockResolvedValue` (rather than editing each file) keeps the
  override's INTENT — it still decides the row's shape — while the executor's own writes are
  layered on top, which is what a real store does. Patches win: they are the later writes.
  */
  const makeWriteThroughGetTask = (defaultImpl: (id?: string) => Promise<any>) => {
    const mock = vi.fn(defaultImpl);
    const merge = (id: string | undefined, result: unknown) =>
      result && typeof result === "object"
        ? { ...(result as Record<string, unknown>), ...(patches.get(id ?? "FN-001") ?? {}) }
        : result;
    const rawImpl = mock.mockImplementation.bind(mock);
    const rawResolved = mock.mockResolvedValue.bind(mock);
    mock.mockImplementation = ((fn: (id?: string) => unknown) =>
      rawImpl(async (id?: string) => merge(id, await fn(id)))) as typeof mock.mockImplementation;
    mock.mockResolvedValue = ((value: unknown) =>
      rawImpl(async (id?: string) => merge(id, value))) as typeof mock.mockResolvedValue;
    void rawResolved;
    return mock;
  };
  /*
  FNXC:EngineTests 2026-07-19-15:05 (U10b):
  `moveTask` must return the LIVE row, not a literal. The graph's merge boundary
  (`ensureWorkflowMergeBoundaryTask`) returns `store.moveTask(...)`'s result and feeds it
  straight into the implementation-proof gate, so a mock returning `{}` (or a captured
  pre-execution task literal) reported zero/pending steps and the merge failed
  `implementation-incomplete` — after the implementation had provably completed and
  `updateStep` had written every step `done`. Same wrapper treatment as `getTask` so per-file
  overrides keep choosing the row's shape while the executor's own writes layer on top.
  */
  const makeWriteThroughMoveTask = () => {
    const finish = async (id: string, column: string, result?: unknown) => {
      applyPatch(id, { column });
      const live = await store.getTask(id);
      return result && typeof result === "object"
        ? { ...(result as Record<string, unknown>), ...(patches.get(id) ?? {}), ...(live ?? {}) }
        : live;
    };
    const mock = vi.fn(async (id: string, column: string) => finish(id, column));
    const rawImpl = mock.mockImplementation.bind(mock);
    mock.mockImplementation = ((fn: (...a: any[]) => unknown) =>
      rawImpl(async (id: string, column: string, ...rest: unknown[]) =>
        finish(id, column, await (fn as any)(id, column, ...rest)))) as typeof mock.mockImplementation;
    mock.mockResolvedValue = ((value: unknown) =>
      rawImpl(async (id: string, column: string) => finish(id, column, value))) as typeof mock.mockResolvedValue;
    return mock;
  };
  const store = {
    /*
    FNXC:EngineTests 2026-07-19-15:30 (U10b):
    Test-side write into the same patch log the executor writes to. Needed because patches WIN
    over a per-file `getTask` override (the executor's writes are the later ones), so a test that
    simulates an EXTERNAL mutation by mutating its own captured literal — "the worktree vanished
    under us" — would be silently overwritten by the executor's earlier `updateTask`. Routing
    that simulated mutation through `_setRow` restores correct ordering without polluting the
    `updateTask` spy, which several of these tests assert negatively on.
    */
    _setRow(id: string, patch: Record<string, unknown>) {
      applyPatch(id, patch);
    },
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
    getTask: makeWriteThroughGetTask(async (id?: string) => ({
      id: id ?? "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      /*
      FNXC:EngineTests 2026-07-19-12:10 (U5g pt2):
      No optional pre-merge gates on the minimal fake's default task. These legacy-shaped tests
      hand-roll a session stub assuming the FIRST session is the IMPLEMENTATION session; under
      graph ownership the first session is Plan Review, so a stub's side effects (pausing,
      disposing, triggering store events) fired against the wrong session. Declaring the gates
      off restores that premise without weakening any assertion — a test that wants a gate sets
      one explicitly. This MUST live on the store's task, not on the literals passed to
      `execute()`: the graph re-reads the row rather than trusting the passed object, which is
      why the same value on an inline literal provably does nothing.
      */
      enabledWorkflowSteps: [],
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(patches.get(id ?? "FN-001") ?? {}),
    })),
    updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      applyPatch(id, patch);
      return { ...(patches.get(id) ?? {}), id };
    }),
    recordActivity: vi.fn().mockResolvedValue({}),
    moveTask: makeWriteThroughMoveTask(),
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
    /*
    FNXC:EngineTests 2026-07-19-14:20 (U10b):
    Write-through step state, for the same reason `updateTask` became write-through (U5g).
    `updateStep` was a black hole while `getTask` replayed only `updateTask` patches, so the
    graph's `steps#N:step-execute` node re-read the projection, saw the step still `pending`,
    and terminated with `step N not completed by implementation pass` — before the assertion
    under test. Land this WITH the workflow-selection flip: on its own (no flip) it costs a red
    in `executor-task-done-invariant`, because without the flip nothing reads the projection back.
    */
    updateStep: vi.fn(async (id: string, stepIndex: number, status: string) => {
      const current = await store.getTask(id);
      const steps = ((current?.steps as Array<Record<string, unknown>> | undefined) ?? []).map(
        (s, i) => (i === stepIndex ? { ...s, status } : s),
      );
      applyPatch(id, { steps });
      return { ...current, steps };
    }),
    // FNXC:EngineTests 2026-07-22-10:30: Mirror the production atomic-start surface while retaining this helper's write-through projection behavior.
    startStep: vi.fn(async (id: string, stepIndex: number, options?: { source?: "graph" }) => {
      const task = await store.updateStep(id, stepIndex, "in-progress", options);
      return {
        task,
        accepted: task.steps?.[stepIndex]?.status === "in-progress",
        disposition: task.steps?.[stepIndex]?.status === "in-progress" ? "started" as const : "blocked" as const,
      };
    }),
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
    /*
FNXC:TaskVerificationRequest 2026-07-19-04:30 (merged with U5f 2026-07-19-06:00):
    Executor execute() claims pending chat-enqueued verification requests via
    getTaskVerificationRequestAsync / claim / finish, and the completion path also
    reads the sync getTaskVerificationRequest on stores that expose it. Default all
    of them to "no pending request" so execute-path tests keep no-verification
    behavior (28 failures at HEAD without these stubs; same fix landed on main in
    #2332 and in the cutover's U5f — this block is the union).
    */
    getTaskVerificationRequestAsync: vi.fn().mockResolvedValue(null),
    getTaskVerificationRequest: vi.fn().mockReturnValue(null),
    claimTaskVerificationRequest: vi.fn().mockResolvedValue(null),
    finishTaskVerificationRequest: vi.fn().mockResolvedValue(undefined),
    createTaskVerificationRequest: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:EngineTests 2026-07-19-09:40 (U5g):
    Step-source artifact for the graph's `parse` node. The builtin coding graph parses PROMPT.md
    into the task step list before it ever reaches the implementation node, and
    `readTaskArtifact` resolves that artifact as `getTaskDocument(id,"PROMPT.md")` first, falling
    back to `getTask().prompt`. The fallback is not reachable for most of this surface: ~10 files
    install their own `store.getTask` implementation returning a task literal with no `prompt`, so
    the artifact read returns undefined, `parse` fails `parse-error`, and the graph terminates
    BEFORE any agent session exists — which is why the captured `fn_task_done` tool was null in 59
    tests. `getTaskDocument` is not overridden anywhere on this surface, so supplying it here fixes
    every one of those files at the shared seam instead of per file.
    */
    getTaskDocument: vi.fn(async (_taskId: string, key: string) =>
      key === "PROMPT.md"
        ? { content: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check" }
        : undefined,
    ),
    /*
    FNXC:EngineTests 2026-07-19-14:20 (U10b — THE FLIP):
    The workflow-selection readers. Their ABSENCE is what routed this whole surface down
    `maybeExecuteWorkflowGraph`'s legacy fallback (executor.ts, the
    `typeof getTaskWorkflowSelection* !== "function"` block). Production TaskStores always
    expose them, so the fallback existed only for minimal/older adapters — and this harness
    was its largest consumer. Supplying them here is the cutover's flip: the surface now runs
    the graph, which is the precondition for deleting that fallback (U10 step 4) and making
    `graphCompletion` mandatory. A test that wants the pre-flip shape must delete these
    explicitly, and after the fallback's deletion no such shape exists.
    */
    getTaskWorkflowSelectionAsync: vi
      .fn()
      .mockResolvedValue({ workflowId: "builtin:coding", stepIds: [] }),
    getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
  };
  return store as any;
}

/*
FNXC:ExecutorTests 2026-07-19-09:40:
Under graph ownership mockedCreateFnAgent fires once per graph session (e.g. Plan
Review, then implementation), so a bare `customTools.find(...)` assignment on a
session WITHOUT the tool would clobber an already-captured reference with
undefined. Shared capture guard: keep the previous capture when the current
session's customTools lacks the named tool.
*/
export function captureNamedTool<T extends { name: string }>(
  customTools: T[] | undefined,
  name: string,
  previous: T | undefined,
): T | undefined {
  return customTools?.find((tool) => tool.name === name) ?? previous;
}

export function resetExecutorMocks() {
  vi.clearAllMocks();
  mockedExec.mockReset();
  mockedExecSync.mockReset();
  mockedStatSync.mockReset();
  mockedStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
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
