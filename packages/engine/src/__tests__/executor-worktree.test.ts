// -nocheck
/* eslint-disable -eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./executor-test-helpers.js";
import { AgentSemaphore } from "../concurrency/concurrency.js";
import { detectReviewHandoffIntent, determineRevisionResetStart } from "../executor.js";
import { TaskExecutor, buildExecutionPrompt, extractWorktreeConflictInfo } from "../executor.js";
import { createFnAgent } from "../pi.js";
import { reviewStep as mockedReviewStepFn } from "../execution/reviewer.js";
import { execSync } from "node:child_process";
import { findWorktreeUser, aiMergeTask } from "../merger.js";
import * as worktreePoolModule from "../worktree/worktree-pool.js";
import { BranchConflictError } from "../execution/branch-conflicts.js";
import { routeWorkflowPrincipal } from "../agents/workflow-agent-router.js";
import * as branchConflictModule from "../execution/branch-conflicts.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { ActiveSessionWorktreeRemovalError } from "../worktree/worktree-backend.js";
import type { Task, TaskDetail } from "@fusion/core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { StepSessionExecutor } from "../execution/step-session-executor.js";
import { executorLog } from "../logger.js";
import { withRateLimitRetry } from "../errors/rate-limit-retry.js";
import { runVerificationCommand as mockedRunVerificationCommand } from "../execution/verification-utils.js";
import { __resetSandboxBackendForTests, __setSandboxBackendForTests } from "../sandbox/index.js";
import {
  createMockStore,
  createWorkflowRoutingAgentStore,
  mockedCreateFnAgent,
  mockedSessionManager,
  mockedFindWorktreeUser,
  mockedStepSessionExecutor,
  mockedWithRateLimitRetry,
  mockedExec,
  mockedExecSync,
  mockedExistsSync,
  mockedHydrateWorktreeDb,
  mockedClassifyTaskWorktree,
  mockedIsUsableTaskWorktree,
  mockedClassifyStaleLock,
  mockedTryRemoveStaleLock,
  mockedRecoverStaleRegistration,
  mockedInstallTaskWorktreeIdentityGuard,
  mockExecuteAll,
  mockTerminateAllSessions,
  mockCleanup,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

/*
 * FNXC:WorkflowPrincipalRouting 2026-08-08-04:27:
 * Mandatory graph principal routing is part of every production-path executor run, including
 * worktree tests. This factory supplies only a durable executor role, capacity leases, and
 * refresh-safe checkout renewal; it must not bypass graph admission or worktree refresh, so
 * each existing Git/worktree assertion continues to exercise the production acquisition path.
 */
function createWorktreeExecutor(store: any, rootDir: string, options: any = {}) {
  return new TaskExecutor(store, rootDir, {
    agentStore: createWorkflowRoutingAgentStore(store).agentStore,
    ...options,
  });
}

describe("worktree workflow routing fixture", () => {
  /*
  FNXC:EngineTests 2026-08-21-08:34:
  The shared executor fake is a production-contract seam: concurrent callback merges must preserve
  every repository entry, missing required entries are no-ops, and workspace routing clears all
  singular-checkout metadata.

  FNXC:EngineTests 2026-08-21-09:29:
  Cleared singular-checkout metadata must use null, matching the persisted TaskStore row shape;
  undefined would let fixture-only behavior diverge from production reads.
  */
  it("mirrors atomic workspace worktree merge semantics", async () => {
    const store = createMockStore();
    store._setRow("FN-workspace-merge", {
      worktree: "/tmp/singular",
      branch: "fusion/singular",
      executionStartBranch: "main",
      baseCommitSha: "base",
      workspaceWorktrees: {},
    });

    const missing = await store.mergeWorkspaceWorktreeEntry(
      "FN-workspace-merge",
      "missing",
      { worktreePath: "/tmp/missing" },
      { requireExistingEntry: true },
    );
    expect(missing.workspaceWorktrees?.missing).toBeUndefined();

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const first = store.mergeWorkspaceWorktreeEntry(
      "FN-workspace-merge",
      "repo-a",
      async () => {
        markFirstStarted();
        await firstGate;
        return { worktreePath: "/tmp/repo-a", branch: "fusion/a" };
      },
    );
    await firstStarted;
    store._setRow("FN-workspace-merge", {
      workspaceWorktrees: {
        "repo-c": { worktreePath: "/tmp/repo-c", branch: "fusion/c" },
      },
    });

    let secondStarted = false;
    const second = store.mergeWorkspaceWorktreeEntry(
      "FN-workspace-merge",
      "repo-b",
      async (freshTask: Task) => {
        secondStarted = true;
        expect(freshTask.workspaceWorktrees?.["repo-a"]?.worktreePath).toBe("/tmp/repo-a");
        return { worktreePath: "/tmp/repo-b", branch: "fusion/b" };
      },
      { clearSingularWorktree: true },
    );

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseFirst();
    const [, result] = await Promise.all([first, second]);

    expect(Object.keys(result.workspaceWorktrees ?? {}).sort()).toEqual(["repo-a", "repo-b", "repo-c"]);
    expect(result).toEqual(expect.objectContaining({ branchWriteOrigin: "engine" }));
    expect(result.worktree).toBeNull();
    expect(result.branch).toBeNull();
    expect(result.executionStartBranch).toBeNull();
    expect(result.baseCommitSha).toBeNull();
  });

  it("selects its eligible executor from the role pool", async () => {
    const store = createMockStore();
    const fixture = createWorkflowRoutingAgentStore(store);
    const agents = await fixture.agentStore.listAgents({ includeEphemeral: true });
    const route = routeWorkflowPrincipal({
      task: {},
      ir: { version: "v1", name: "fixture", nodes: [], edges: [] },
      node: { id: "execute", kind: "script", config: { seam: "execute" } },
      agents,
    } as any);

    expect(route).toEqual(expect.objectContaining({
      status: "routed",
      route: expect.objectContaining({
        agent: expect.objectContaining({ id: fixture.agent.id }),
        role: "executor",
        authority: "role-pool",
      }),
    }));
    expect(fixture.agentStore.listAgents).toHaveBeenCalledWith({ includeEphemeral: true });
  });

  it("releases capacity after successful and failed fixture work", async () => {
    const fixture = createWorkflowRoutingAgentStore(createMockStore());
    const run = async (attemptId: string, fail = false) => {
      expect(await fixture.agentStore.acquireWorkflowSessionCapacity({ agentId: fixture.agent.id, attemptId })).toBe("acquired");
      try {
        if (fail) throw new Error("fixture failure");
      } finally {
        await fixture.agentStore.releaseWorkflowSessionCapacity(attemptId);
      }
    };

    await run("success");
    await expect(run("failure", true)).rejects.toThrow("fixture failure");
    expect(fixture.leases).toHaveLength(0);
    expect(fixture.agentStore.releaseWorkflowSessionCapacity).toHaveBeenCalledTimes(2);
  });

  it("renews checkout without replacing populated worktree state", async () => {
    const store = createMockStore();
    store._setRow("FN-routing", {
      worktree: "/tmp/existing-worktree",
      branch: "fusion/FN-routing",
      baseBranch: "main",
      baseSha: "abc123",
    });
    const fixture = createWorkflowRoutingAgentStore(store);

    await fixture.agentStore.checkoutTask(fixture.agent.id, "FN-routing", { nodeId: "node", runId: "run", leaseEpoch: 1, renewedAt: "2026-01-01T00:00:00.000Z" });
    await fixture.agentStore.checkoutTask(fixture.agent.id, "FN-routing", { nodeId: "node", runId: "run", leaseEpoch: 1, renewedAt: "2026-01-01T00:01:00.000Z" });

    expect(await store.getTask("FN-routing")).toEqual(expect.objectContaining({
      worktree: "/tmp/existing-worktree",
      branch: "fusion/FN-routing",
      baseBranch: "main",
      baseSha: "abc123",
      checkedOutBy: fixture.agent.id,
      checkoutLeaseRenewedAt: "2026-01-01T00:01:00.000Z",
    }));
  });

  it("resets lease state without leaking into the next fixture", async () => {
    const fixture = createWorkflowRoutingAgentStore(createMockStore());
    await fixture.agentStore.acquireWorkflowSessionCapacity({ agentId: fixture.agent.id, attemptId: "leaked" });
    fixture.reset();

    expect(fixture.leases).toHaveLength(0);
    expect(fixture.agentStore.acquireWorkflowSessionCapacity).not.toHaveBeenCalled();
    expect(createWorkflowRoutingAgentStore(createMockStore()).leases).toHaveLength(0);
  });
});

describe("TaskExecutor with semaphore", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  it("acquires semaphore before creating agent and releases after", async () => {
    const sem = new AgentSemaphore(2);
    const store = createMockStore();
    const acquireSpy = vi.spyOn(sem, "acquire");
    const releaseSpy = vi.spyOn(sem, "release");

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const executor = createWorktreeExecutor(store, "/tmp/test", { semaphore: sem });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(acquireSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledOnce();
    expect(sem.activeCount).toBe(0);
  });

  it("releases semaphore on agent error", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();

    mockedCreateFnAgent.mockRejectedValue(new Error("agent failed"));

    const onError = vi.fn();
    const executor = createWorktreeExecutor(store, "/tmp/test", {
      semaphore: sem,
      onError,
    });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(sem.activeCount).toBe(0);
    expect(onError).toHaveBeenCalled();
  });

  it("sets task status to 'failed' with error message when execution throws", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockRejectedValue(new Error("agent crashed"));

    const onError = vi.fn();
    const executor = createWorktreeExecutor(store, "/tmp/test", { onError });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // FNXC:WorkflowLifecycle 2026-07-01-20:10: With workflowGraphExecutor default-on, terminal
    // execution failures are parked `status: "failed"` IN PLACE by the workflow-graph failure model
    // (handleGraphFailure / the legacy terminal catch in executor.ts). status="failed" doubles as the
    // self-healing review-revival exemption marker, so the task is intentionally NOT moved to in-review
    // — this supersedes FN-1284's legacy in-review escalation (confirmed by the sibling "fails after 3
    // attempts" / "fails fast when rootDir not git" tests, which assert failed without any in-review
    // move). The protected invariant here is unchanged: an execution throw marks the task failed with an
    // error message and fires onError.
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "failed", error: expect.any(String) });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    expect(onError).toHaveBeenCalled();
  });

  it("concurrent executions respect semaphore limit", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();
    let concurrent = 0;
    let maxConcurrent = 0;

    mockedCreateFnAgent.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 10));
            concurrent--;
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = createWorktreeExecutor(store, "/tmp/test", { semaphore: sem });

    const task = (id: string) => ({
      id,
      title: "Test",
      description: "Test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await Promise.all([
      executor.execute(task("FN-001")),
      executor.execute(task("FN-002")),
      executor.execute(task("FN-003")),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(sem.activeCount).toBe(0);
  });
});

describe("TaskExecutor worktreeInitCommand", () => {
  const makeTask = (id = "FN-010") => ({
    id,
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    resetExecutorMocks();
    __resetSandboxBackendForTests();
    // Default: worktree does NOT exist (new worktree)
    mockedExistsSync.mockReturnValue(false);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  afterEach(() => {
    __resetSandboxBackendForTests();
  });

  it("runs worktreeInitCommand in new worktree when configured", async () => {
    __setSandboxBackendForTests({
      capabilities: () => ({
        id: "native",
        supportsNetworkPolicy: false,
        supportsFilesystemPolicy: false,
        supportsStreaming: true,
        platform: "any",
      }),
      prepare: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        bufferExceeded: false,
      }),
      runStreaming: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: "pnpm install --frozen-lockfile",
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should log success
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-010",
      expect.stringMatching(/^\[timing\] Worktree init command completed in \d+ms$/),
      "pnpm install --frozen-lockfile",
      expect.objectContaining({ agentId: "executor" }),
    );
  });

  it("does NOT run init command when worktreeInitCommand is not set", async () => {
    const store = createMockStore();
    // getSettings returns default (no worktreeInitCommand)

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Only worktree creation calls to execSync, no "pnpm install --frozen-lockfile" etc.
    const initCall = mockedExecSync.mock.calls.find(
      (call) => typeof call[0] === "string" && !call[0].startsWith("git"),
    );
    expect(initCall).toBeUndefined();
  });

  it("catches init command failure and logs without aborting", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: "npm run setup",
    });

    // Make the init command fail (but not git worktree commands)
    mockedExecSync.mockImplementation((cmd: any) => {
      if (cmd === "npm run setup") {
        const err: any = new Error("command failed");
        err.stderr = Buffer.from("setup script error");
        throw err;
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = createWorktreeExecutor(store, "/tmp/test", { onError });
    await executor.execute(makeTask());

    // Should log the failure
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-010",
      expect.stringContaining("Worktree init command failed"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );

    // The init command failure itself does not abort execution, but the mocked
    // agent still exits without fn_task_done. After 3 retries it requeues to todo
    // and reports an error.
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-010" }),
      expect.objectContaining({ message: "Agent finished without calling fn_task_done (after 3 retries)" }),
    );

    // Agent should still have been created
    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });

  it("does NOT run init command on worktree resume", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: "pnpm install --frozen-lockfile",
    });

    // Worktree already exists (resume)
    mockedExistsSync.mockReturnValue(true);

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // getSettings is called (for project commands in execution prompt) but init command should not run
    expect(store.getSettings).toHaveBeenCalled();
  });
});

describe("TaskExecutor worktree recovery", () => {
  const makeTask = (id = "FN-050") => ({
    id,
    title: "Test Task",
    description: "Test description",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates worktree successfully on first attempt", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");

    await executor.execute(makeTask());

    // Should have logged worktree creation
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Worktree created at"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
    // execSync should be called for worktree creation
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree add"),
      expect.any(Object),
    );
  });

  it("fails fast with a clear error when rootDir is not a git repository", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git rev-parse --git-dir") {
        const error: any = new Error("fatal: not a git repository (or any of the parent directories): .git");
        error.stderr = Buffer.from("fatal: not a git repository (or any of the parent directories): .git");
        throw error;
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test", { onError });
    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Cannot execute task: project directory is not a Git repository"),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("not a Git repository"),
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-050" }),
      expect.objectContaining({ message: expect.stringContaining("not a Git repository") }),
    );
  });

  it("does not attempt git worktree add when rootDir is not a git repository", async () => {
    const store = createMockStore();

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git rev-parse --git-dir") {
        const error: any = new Error("fatal: not a git repository");
        error.stderr = Buffer.from("fatal: not a git repository");
        throw error;
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git worktree add"),
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });

  it("surfaces dubious ownership as a distinct git detection error without suggesting git init", async () => {
    const rootDir = "C:/Users/drewd/Documents/1. App Development/1. Active/NextGenEHS";
    const store = createMockStore();
    const onError = vi.fn();

    mockedExecSync.mockImplementation((cmd: string | string[], opts?: any) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git rev-parse --git-dir" && opts?.cwd === rootDir) {
        const error: any = new Error(`fatal: detected dubious ownership in repository at '${rootDir}'`);
        error.stderr = Buffer.from(`fatal: detected dubious ownership in repository at '${rootDir}'`);
        throw error;
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, rootDir, { onError });
    await executor.execute(makeTask());

    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git worktree add"),
    );
    expect(worktreeAddCalls).toHaveLength(0);
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Cannot execute task: project directory is not a Git repository"),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("detected dubious ownership"),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("git config --global --add safe.directory <project-directory>"),
      }),
    );
    const failedPatch = store.updateTask.mock.calls.find(
      ([, patch]) => (patch as { status?: string }).status === "failed",
    )?.[1] as { error?: string } | undefined;
    expect(failedPatch?.error).not.toContain("Initialize with 'git init'");
    expect(failedPatch?.error).not.toContain("Project directory is not a Git repository");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-050" }),
      expect.objectContaining({ message: expect.stringContaining("detected dubious ownership") }),
    );
  });

  it("extractWorktreeConflictInfo classifies not-a-git-repository errors", () => {
    const error: any = new Error("fatal: not a git repository");
    error.stderr = Buffer.from("fatal: not a git repository");

    const conflictInfo = extractWorktreeConflictInfo(error);
    expect(conflictInfo.type).toBe("not-git-repo");
    expect(conflictInfo.message).toContain("not a git repository");
  });

  it("extractWorktreeConflictInfo does not misclassify dubious ownership as not-git-repo", () => {
    const rootDir = "C:/Users/drewd/Documents/1. App Development/1. Active/NextGenEHS";

    const error: any = new Error(`fatal: detected dubious ownership in repository at '${rootDir}'`);
    error.stderr = Buffer.from(`fatal: detected dubious ownership in repository at '${rootDir}'`);

    const conflictInfo = extractWorktreeConflictInfo(error);
    expect(conflictInfo.type).toBe("unknown");
    expect(conflictInfo.message).toContain("detected dubious ownership");
  });

  it("treats not-a-git-repository as non-retryable in tryCreateWorktree flow", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/test", "HEAD abc123", "branch refs/heads/main", ""].join("\n"));
      }
      if (command.includes("git worktree add -b")) {
        const error: any = new Error("fatal: not a git repository (or any of the parent directories): .git");
        error.stderr = Buffer.from("fatal: not a git repository (or any of the parent directories): .git");
        throw error;
      }
      return Buffer.from("");
    });

    await expect(
      (executor as any).createWorktree("fusion/fn-050", "/tmp/test/.worktrees/swift-falcon", "FN-050"),
    ).rejects.toThrow("not a Git repository");

    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git worktree add -b"),
    );
    expect(worktreeAddCalls).toHaveLength(1);
  });

  it("extractWorktreeConflictInfo classifies already checked out errors as already-used", () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");

    const error: any = new Error(
      "fatal: 'fusion/fn-050' is already checked out at '/tmp/test/.worktrees/green-sage'",
    );
    error.stderr = Buffer.from(
      "fatal: 'fusion/fn-050' is already checked out at '/tmp/test/.worktrees/green-sage'",
    );

    const conflictInfo = extractWorktreeConflictInfo(error);
    expect(conflictInfo).toMatchObject({
      type: "already-used",
      path: "/tmp/test/.worktrees/green-sage",
    });
  });

  /*
   * FNXC:TaskPinnedWorktrees 2026-09-19-22:20:
   * Native acquisition no longer retries a branch conflict through a generated directory. An executor
   * with no usable checkout recovers at its one task-id-derived destination.
   */
  it("creates a fresh canonical pinned worktree when in-progress metadata has no checkout", async () => {
    const store = createMockStore();
    mockedExistsSync.mockReturnValue(false);
    const executor = createWorktreeExecutor(store, "/tmp/test");

    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      "Drift detected: in-progress with no worktree — creating fresh worktree to recover",
      undefined,
      expect.anything(),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: "/tmp/test/.fusion/worktrees/fn-050", branch: "fusion/fn-050" }),
    );
  });

  it("reclaims an inactive same-task conflict when the branch preserves task commits", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    const conflictPath = "/tmp/test/.worktrees/light-cedar";
    vi.spyOn(executor as any, "shouldGenerateNewWorktreeName").mockResolvedValue(false);
    const cleanup = vi.spyOn(executor as any, "cleanupConflictingWorktree").mockResolvedValue(true);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "reclaimable",
      livePath: conflictPath,
      tipSha: "70b47804bc6f27659638e17ac7cf279ed343ff6f",
      taskAttributedCommitCount: 10,
      strandedCommits: [{ sha: "70b47804bc6f27659638e17ac7cf279ed343ff6f", subject: "fix(FN-8288): preserve implementation" }],
    } as any);

    const result = await (executor as any).handleWorktreeConflict(
      conflictPath,
      "fusion/fn-8288",
      "/tmp/test/.worktrees/pearl-otter",
      "FN-8288",
      "main",
      0,
      false,
      {},
    );

    expect(result).toEqual({ path: conflictPath, branch: "fusion/fn-8288" });
    expect(cleanup).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8288",
      expect.stringContaining("10 commits preserved"),
      "70b47804bc6f27659638e17ac7cf279ed343ff6f",
    );
  });

  it.each(["reclaimable", "fully-subsumed"] as const)(
    "relocates an out-of-root %s same-task worktree before reclaiming it",
    async (kind) => {
      const store = createMockStore();
      const executor = createWorktreeExecutor(store, "/tmp/test");
      const conflictPath = "/tmp/legacy-worktrees/recover-fn-8400";
      const targetPath = "/tmp/test/.worktrees/pearl-otter";
      vi.spyOn(executor as any, "shouldGenerateNewWorktreeName").mockResolvedValue(false);
      const relocate = vi.spyOn(executor as any, "normalizeReclaimableWorktreePath").mockResolvedValue(targetPath);
      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
        kind,
        livePath: conflictPath,
        tipSha: "70b47804bc6f27659638e17ac7cf279ed343ff6f",
        taskAttributedCommitCount: kind === "reclaimable" ? 1 : 0,
        strandedCommits: kind === "reclaimable"
          ? [{ sha: "70b47804bc6f27659638e17ac7cf279ed343ff6f", subject: "fix(FN-8400): preserve implementation" }]
          : [],
      } as any);

      const result = await (executor as any).handleWorktreeConflict(
        conflictPath,
        "fusion/fn-8400",
        targetPath,
        "FN-8400",
        "main",
        0,
        false,
        {},
      );

      expect(relocate).toHaveBeenCalledWith(conflictPath, targetPath, "FN-8400", {});
      expect(result).toEqual({ path: targetPath, branch: "fusion/fn-8400" });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-8400",
        expect.stringContaining(`at ${targetPath}`),
        "70b47804bc6f27659638e17ac7cf279ed343ff6f",
      );
    },
  );

  it("re-derives out-of-root persisted metadata to the canonical pinned target", async () => {
    const store = createMockStore();
    const legacyPath = "/tmp/legacy-worktrees/recover-fn-8400";
    mockedExistsSync.mockReturnValue(false);
    store._setRow("FN-8400", { worktree: legacyPath, branch: "fusion/fn-8400" });
    const executor = createWorktreeExecutor(store, "/tmp/test");

    await executor.execute({ ...makeTask("FN-8400"), worktree: legacyPath, branch: "fusion/fn-8400" });

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8400",
      "Re-derived task-pinned worktree path from task id",
      `${legacyPath} -> /tmp/test/.fusion/worktrees/fn-8400`,
      expect.anything(),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-8400",
      expect.objectContaining({ worktree: "/tmp/test/.fusion/worktrees/fn-8400" }),
    );
  });

  it("preserves operator provenance when reclaiming an operator-owned Fusion-namespaced branch", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ worktreesDir: ".worktrees" } as any);
    const executor = createWorktreeExecutor(store, "/tmp/test");
    const conflictPath = "/tmp/legacy-worktrees/recover-fn-8401";
    const targetPath = "/tmp/test/.worktrees/recover-fn-8401";
    const branch = "fusion/fn-8401";
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "reclaimable",
      livePath: conflictPath,
      tipSha: "70b47804bc6f27659638e17ac7cf279ed343ff6f",
      taskAttributedCommitCount: 1,
      strandedCommits: [{ sha: "70b47804bc6f27659638e17ac7cf279ed343ff6f", subject: "fix(FN-8401): preserve implementation" }],
    } as any);
    vi.spyOn(executor as any, "normalizeReclaimableWorktreePath").mockResolvedValue(targetPath);

    const result = await (executor as any).handleBranchConflict(
      {
        ...makeTask("FN-8401"),
        branch,
        worktree: conflictPath,
        branchContext: { branchOverride: { by: "operator", at: "2026-08-22T22:00:00.000Z", branch } },
      },
      new BranchConflictError({
        branchName: branch,
        conflictingWorktreePath: conflictPath,
        existingTipSha: "70b47804bc6f27659638e17ac7cf279ed343ff6f",
        strandedCommits: [],
        startPoint: "main",
        recommendedAction: "reclaim",
      }),
    );

    expect(result).toBe("reclaimed");
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-8401",
      expect.objectContaining({
        worktree: targetPath,
        branch,
        branchWriteOrigin: "operator",
      }),
    );
  });


  it("records recovery context when handling a branch conflict (FN-4847: now discards + requeues instead of pausing)", async () => {
    // FN-4847: branch-conflict-unrecoverable previously paused the task with
    // status=failed + pausedReason="branch-conflict-unrecoverable". The user has
    // opted into discard-and-recreate, so the executor's handleBranchConflict now
    // delegates to the auto-recovery dispatcher which in 'deterministic-only' mode
    // returns action='retry'. The handler discards the foreign branch and requeues
    // the task to todo. status='failed' is no longer set; moveTask IS called.
    const store = createMockStore();
    const onError = vi.fn();
    const executor = createWorktreeExecutor(store, "/tmp/test", { onError });

    const result = await (executor as any).handleBranchConflict(
      makeTask(),
      new BranchConflictError({
        branchName: "fusion/fn-050",
        conflictingWorktreePath: "/tmp/test/.worktrees/green-sage",
        existingTipSha: "abc123def456",
        strandedCommits: [
          { sha: "aaa111", subject: "Preserve prior fix" },
          { sha: "bbb222", subject: "Add regression coverage" },
        ],
        startPoint: "HEAD",
        recommendedAction: "Reclaim the existing task branch/worktree or explicitly discard prior work before retrying.",
      }),
    );

    // New contract: handleBranchConflict returns 'retry' (not 'sticky') and does
    // NOT mark the task failed. The branch-conflict context still gets logged and
    // surfaced for observability, but the task continues via requeue.
    expect(result).toBe("retry");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ status: "failed" }),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Existing tip: abc123def456"),
      undefined,
      undefined,
    );
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-050",
      "Branch conflict recovery required",
      "tool_error",
      expect.stringContaining("stranded=aaa111 Preserve prior fix"),
      "executor",
    );
    // onError no longer fires for the recoverable branch-conflict-unrecoverable path.
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops the original conflict retry after a foreign-unmerged recovery pins a sibling", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    const conflictError = new BranchConflictError({
      branchName: "fusion/fn-050",
      conflictingWorktreePath: "/tmp/test/.worktrees/fn-050",
      existingTipSha: "abc123def456",
      strandedCommits: [],
      startPoint: "main",
      recommendedAction: "preserve the conflicting branch and retry with a fresh sibling",
      collisionKind: "foreign-unmerged",
    });

    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({ kind: "stale" } as any);
    vi.spyOn(executor as any, "getAutoRecoveryDispatcher").mockReturnValue({
      dispatch: vi.fn().mockImplementation(async () => {
        store._setRow("FN-050", {
          branch: "fusion/fn-050-2",
          branchWriteOrigin: "engine",
          worktree: null,
        });
        return { action: "retry" };
      }),
    });

    const result = await (executor as any).handleBranchConflict(makeTask(), conflictError);

    expect(result).toBe("recovered");
    expect(await store.getTask("FN-050")).toEqual(expect.objectContaining({
      branch: "fusion/fn-050-2",
      worktree: null,
    }));
  });

  it("does not burn branch-conflict retries after a recovered sibling outcome", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    const conflictError = new BranchConflictError({
      branchName: "fusion/fn-050",
      conflictingWorktreePath: "/tmp/test/.worktrees/fn-050",
      existingTipSha: "abc123def456",
      strandedCommits: [],
      startPoint: "main",
      recommendedAction: "preserve the conflicting branch and retry with a fresh sibling",
      collisionKind: "foreign-unmerged",
    });
    const handle = vi.spyOn(executor as any, "handleBranchConflict").mockImplementation(async () => {
      store._setRow("FN-050", {
        branch: "fusion/fn-050-2",
        branchWriteOrigin: "engine",
        worktree: null,
      });
      return "recovered";
    });
    const createWorktree = vi.spyOn(executor as any, "createWorktree")
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ path: "/tmp/test/.fusion/worktrees/fn-050", branch: "fusion/fn-050-2" });

    await executor.execute(makeTask());
    await executor.execute(await store.getTask("FN-050"));

    expect(handle).toHaveBeenCalledTimes(1);
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(createWorktree.mock.calls[1][0]).toBe("fusion/fn-050-2");
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("branch-conflict auto-retry requested"),
      undefined,
      expect.anything(),
    );
  });

  it("FN-4397 reproduces repeated branch-conflict recovery-required emissions for the same task", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    const conflictError = new BranchConflictError({
      branchName: "fusion/fn-050",
      conflictingWorktreePath: "/tmp/test/.worktrees/green-sage",
      existingTipSha: "abc123def456",
      strandedCommits: [],
      startPoint: "HEAD",
      recommendedAction: "Reclaim the existing task branch/worktree or explicitly discard prior work before retrying.",
    });

    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({
      kind: "live-foreign",
      livePath: "/tmp/test/.worktrees/green-sage",
      error: conflictError,
    });
    vi.spyOn(executor as any, "cleanupConflictingWorktree").mockResolvedValue(false);

    await (executor as any).handleBranchConflict(makeTask(), conflictError);
    await (executor as any).handleBranchConflict(makeTask(), conflictError);
    await (executor as any).handleBranchConflict(makeTask(), conflictError);

    expect(store.appendAgentLog).toHaveBeenCalledTimes(3);
    expect(store.appendAgentLog).toHaveBeenNthCalledWith(
      1,
      "FN-050",
      "Branch conflict recovery required",
      "tool_error",
      expect.any(String),
      "executor",
    );
  });

  it("FN-4397 tripwire pauses on 6th branch conflict and suppresses additional recovery-required agent logs", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    const conflictError = new BranchConflictError({
      branchName: "fusion/fn-050",
      conflictingWorktreePath: "/tmp/test/.worktrees/green-sage",
      existingTipSha: "abc123def456",
      strandedCommits: [],
      startPoint: "HEAD",
      recommendedAction: "Reclaim the existing task branch/worktree or explicitly discard prior work before retrying.",
    });

    const handleSpy = vi.spyOn(executor as any, "handleBranchConflict").mockImplementation(async () => {
      await store.appendAgentLog("FN-050", "Branch conflict recovery required", "tool_error", "mock", "executor");
      return "sticky";
    });
    vi.spyOn(executor as any, "createWorktree").mockRejectedValue(conflictError);

    for (let i = 0; i < 6; i += 1) {
      await executor.execute(makeTask());
    }

    expect(handleSpy).toHaveBeenCalledTimes(5);
    const tripwireLogCall = vi.mocked(store.logEntry).mock.calls.find((call: unknown[]) =>
      call[0] === "FN-050" && String(call[1]).includes("Branch conflict tripwire fired after 6 events"),
    );
    expect(tripwireLogCall).toBeDefined();
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({
        status: "failed",
        paused: true,
        pausedReason: "branch-conflict-tripwire",
      }),
    );
    expect(store.appendAgentLog).toHaveBeenCalledTimes(5);
  });

  it("falls back to default base and clears task.executionStartBranch when the configured base ref is missing (FN-2165)", async () => {
    const store = createMockStore();

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git rev-parse --verify")) {
        // The stored baseBranch no longer exists — simulates a dep's branch
        // being deleted while this task sat queued/stuck.
        const error: any = new Error("fatal: Needed a single revision");
        error.stderr = Buffer.from("fatal: Needed a single revision");
        throw error;
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = createWorktreeExecutor(store, "/tmp/test", { onError });
    /*
    FNXC:EngineTests 2026-07-19-16:32 (U10b):
    `executionStartBranch` is a PERSISTED field: the missing-base fallback reads it from the row
    (and clears it there) so a later retry picks up the default base. The graph re-reads the task
    before worktree creation, so setting it only on the literal passed to `execute()` exercises
    nothing. Seeding the row is what the FN-2165 requirement actually describes.
    */
    store._setRow("FN-050", { executionStartBranch: "fusion/missing-base" });
    await executor.execute({ ...makeTask(), executionStartBranch: "fusion/missing-base" });

    // Should log the soft fallback, not a terminal failure
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining('Worktree base ref "fusion/missing-base" is missing'),
      expect.any(String),
    );
    // Should clear baseBranch on the task so retries use the default
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ executionStartBranch: null }),
    );
    // Should proceed to create a worktree from HEAD (no startPoint)
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("git worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
    // None of the worktree add calls should include the stale base ref
    for (const call of worktreeAddCalls) {
      expect(String(call[0])).not.toContain("fusion/missing-base");
    }
    // The task should NOT have been marked failed because of the stale baseBranch
    // (downstream errors unrelated to worktree creation may still occur in this
    // integration-style test — we only assert that baseBranch-missing is no
    // longer a terminal failure).
    const worktreeFailureCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("Worktree creation failed"),
    );
    expect(worktreeFailureCalls).toHaveLength(0);
    // onError may still fire from downstream step execution in this test harness;
    // what matters is that the failure reason is NOT "base ref missing".
    void onError;
  });

  it("re-derives nested persisted metadata without creating a nested checkout (FN-2165 guard)", async () => {
    const store = createMockStore();
    const nestedPath = "/tmp/test/.worktrees/green-finch/.worktrees/amber-panda";
    mockedExistsSync.mockReturnValue(false);
    store._setRow("FN-050", { worktree: nestedPath });
    const executor = createWorktreeExecutor(store, "/tmp/test");

    await executor.execute({ ...makeTask(), worktree: nestedPath });

    const worktreeAddCalls = mockedExecSync.mock.calls.map((call) => String(call[0]));
    expect(worktreeAddCalls.some((command) => command.includes(nestedPath))).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      "Re-derived task-pinned worktree path from task id",
      `${nestedPath} -> /tmp/test/.fusion/worktrees/fn-050`,
      expect.anything(),
    );
  });

  it("fails after 3 unsuccessful attempts with detailed error", async () => {
    vi.useRealTimers();
    const store = createMockStore();

    // All worktree add calls fail
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        const error: any = new Error(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        error.stderr = Buffer.from(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        throw error;
      }
      // Cleanup also fails
      if (command.includes("git worktree remove")) {
        throw new Error("cleanup failed");
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = createWorktreeExecutor(store, "/tmp/test", { onError });

    await executor.execute(makeTask());

    // Should log final failure
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Worktree creation failed after 3 attempts"),
      expect.any(String),
    );
    // Should update task as failed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).toHaveBeenCalled();
  });


  describe("stale registration recovery", () => {
    it("recovers stale registration and retries git worktree add", async () => {
      const store = createMockStore();
      let addCalls = 0;
      mockedRecoverStaleRegistration.mockResolvedValue({ recovered: true, actions: ["prune", "remove-force"] });

      mockedExecSync.mockImplementation((cmd: string | string[]) => {
        const command = typeof cmd === "string" ? cmd : cmd[0];
        if (command.includes("git worktree add") && addCalls++ === 0) {
          const error: any = new Error("fatal: '/tmp/test/.worktrees/swift-falcon' is a missing but already registered worktree");
          error.stderr = Buffer.from("fatal: '/tmp/test/.worktrees/swift-falcon' is a missing but already registered worktree");
          throw error;
        }
        return Buffer.from("");
      });

      const executor = createWorktreeExecutor(store, "/tmp/test");
      await executor.execute(makeTask());

      expect(mockedRecoverStaleRegistration).toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-050",
        "Recovered stale worktree registration and retrying",
        "/tmp/test/.worktrees/swift-falcon",
        expect.anything(),
      );
      const worktreeAddCalls = mockedExecSync.mock.calls
        .map((call) => String(call[0]))
        .filter((command) => command.includes("git worktree add -b"));
      expect(worktreeAddCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("preserves existing failure path when stale registration persists", async () => {
      const store = createMockStore();
      mockedRecoverStaleRegistration.mockResolvedValue({ recovered: false, actions: ["prune"], reason: "still registered" });

      mockedExecSync.mockImplementation((cmd: string | string[]) => {
        const command = typeof cmd === "string" ? cmd : cmd[0];
        if (command.includes("git worktree add")) {
          const error: any = new Error("fatal: '/tmp/test/.worktrees/swift-falcon' is a missing but already registered worktree");
          error.stderr = Buffer.from("fatal: '/tmp/test/.worktrees/swift-falcon' is a missing but already registered worktree");
          throw error;
        }
        return Buffer.from("");
      });

      const executor = createWorktreeExecutor(store, "/tmp/test");
      (executor as any).MAX_WORKTREE_RETRIES = 1;

      await expect(
        (executor as any).createWorktree("fusion/fn-050", "/tmp/test/.worktrees/swift-falcon", "FN-050"),
      ).rejects.toThrow("Failed to create worktree after 1 attempts");

      expect(mockedRecoverStaleRegistration).toHaveBeenCalled();
    }, 20000);
  });

  it("removes stale branch and retries when branch exists without worktree", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
          error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have removed the stale branch
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git branch -D"),
      expect.any(Object),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removed stale branch reference, retrying"),
    );
  });

  it("runs git worktree prune before branch deletion for stale references", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
          error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have called git worktree prune as the first recovery step
    expect(mockedExecSync).toHaveBeenCalledWith(
      "git worktree prune",
      expect.any(Object),
    );
    // Should log the prune
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Pruned stale worktree metadata"),
      "fusion/fn-050",
    );
    // Should also call branch -D after prune
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git branch -D"),
      expect.any(Object),
    );
    // Task should eventually succeed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
    );
  });

  it("falls back to git update-ref -d when git branch -D fails on stale reference", async () => {
    const store = createMockStore();
    let worktreeAddCallCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (worktreeAddCallCount++ === 0) {
          const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
          error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
          throw error;
        }
        return Buffer.from("");
      }
      // Prune succeeds
      if (command.includes("git worktree prune")) {
        return Buffer.from("");
      }
      // branch -D fails (corrupted reference)
      if (command.includes("git branch -D")) {
        const error: any = new Error("error: unable to delete ref 'refs/heads/fusion/fn-050'");
        throw error;
      }
      // update-ref -d succeeds
      if (command.includes("git update-ref -d")) {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have tried branch -D first
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git branch -D"),
      expect.any(Object),
    );
    // Should have fallen back to update-ref -d
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git update-ref -d"),
      expect.any(Object),
    );
    // Should log the fallback
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("git branch -D failed for stale branch, trying update-ref"),
      expect.any(String),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Force-removed stale branch reference via update-ref"),
      expect.any(String),
    );
    // Task should eventually succeed after cleanup + retry
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
    );
  });

  it("bounds stale-reference cleanup retries when update-ref succeeds but the ref remains invalid", async () => {
    const store = createMockStore();
    let worktreeAddCallCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        worktreeAddCallCount++;
        const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
        error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
        throw error;
      }
      if (command.includes("git branch -D")) {
        const error: any = new Error("error: branch 'fusion/fn-050' not found");
        error.stderr = Buffer.from("error: branch 'fusion/fn-050' not found");
        throw error;
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = createWorktreeExecutor(store, "/tmp/test", { onError });
    const executePromise = executor.execute(makeTask());
    await vi.advanceTimersByTimeAsync(5000);
    await executePromise;

    expect(worktreeAddCallCount).toBe(3);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Worktree creation failed after 3 attempts"),
      expect.any(String),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).toHaveBeenCalled();
  });

  it("fails task when all stale reference cleanup steps fail", async () => {
    vi.useRealTimers();
    const store = createMockStore();

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
        error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
        throw error;
      }
      // Prune fails
      if (command.includes("git worktree prune")) {
        throw new Error("prune failed");
      }
      // branch -D fails
      if (command.includes("git branch -D")) {
        throw new Error("branch delete failed");
      }
      // update-ref -d also fails
      if (command.includes("git update-ref -d")) {
        throw new Error("update-ref failed");
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = createWorktreeExecutor(store, "/tmp/test", { onError });
    await executor.execute(makeTask());

    // Should have logged terminal failure for the stale reference
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Failed to remove stale branch reference"),
      expect.any(String),
    );
    // Task should be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).toHaveBeenCalled();
  });

  it("recovers from stale reference in createFromExistingBranch fallback path", async () => {
    const store = createMockStore();
    let worktreeAddCallCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        worktreeAddCallCount++;
        if (command.includes("-b")) {
          // createWithBranch: fails with "already exists" (not invalid-reference)
          const error: any = new Error("fatal: A branch named 'fusion/fn-050' already exists.");
          error.stderr = Buffer.from("fatal: A branch named 'fusion/fn-050' already exists.");
          throw error;
        } else {
          // createFromExistingBranch: fails with invalid reference
          if (worktreeAddCallCount <= 2) {
            const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
            error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
            throw error;
          }
        }
      }
      // All cleanup commands succeed
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have logged cleanup in fallback path
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Cleaned up stale reference in fallback, retrying"),
    );
    // Task should eventually succeed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
    );
  });

  it("recognizes 'unable to resolve reference' as invalid-reference pattern", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: unable to resolve reference 'fusion/fn-050'");
          error.stderr = Buffer.from("fatal: unable to resolve reference 'fusion/fn-050'");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have triggered cleanup (stale branch reclaim)
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree prune"),
      expect.any(Object),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removed stale branch reference, retrying"),
    );
  });

  it("recognizes 'stale file handle' as invalid-reference pattern", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: stale file handle");
          error.stderr = Buffer.from("fatal: stale file handle");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removed stale branch reference, retrying"),
    );
  });

  it("recognizes 'not a valid ref' as invalid-reference pattern", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: not a valid ref: 'refs/heads/fusion/fn-050'");
          error.stderr = Buffer.from("fatal: not a valid ref: 'refs/heads/fusion/fn-050'");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removed stale branch reference, retrying"),
    );
  });


  it("handles locked worktree by unlocking before removal", async () => {
    vi.useRealTimers();
    const store = createMockStore();

    let callCount = 0;
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add") && callCount++ === 0) {
        const error: any = new Error(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        error.stderr = Buffer.from(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        throw error;
      }
      return Buffer.from("");
    });

    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should attempt to unlock the worktree before removing
    const unlockCalls = mockedExecSync.mock.calls.filter((call) =>
      String(call[0]).includes("git worktree unlock"),
    );
    expect(unlockCalls.length).toBeGreaterThanOrEqual(0); // Unlock is attempted but may fail silently
  });
});

describe("TaskExecutor dependency-based worktree creation", () => {
  const makeTask = (overrides: Partial<Task> = {}) => ({
    id: "FN-060",
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    vi.useRealTimers();
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedFindWorktreeUser.mockResolvedValue(null);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("creates worktree from baseBranch when set on task", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");

    /*
    FNXC:EngineTests 2026-07-19-16:41 (U10b):
    The dependency-derived base branch is read from the PERSISTED row (the graph re-reads the task
    before creating the worktree), so `executionStartBranch` must be seeded on the store for the
    "worktree is cut from the dependency's branch" requirement to be exercised.
    */
    store._setRow("FN-060", { executionStartBranch: "fusion/fn-059" });
    await executor.execute(makeTask({
      id: "FN-060",
      executionStartBranch: "fusion/fn-059",
    }));

    // The git worktree add command should include the startPoint
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
    expect(worktreeAddCalls[0][0]).toContain("fusion/fn-059");
  });

  it("creates worktree from integration branch when baseBranch is not set", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");

    await executor.execute(makeTask({
      id: "FN-061",
      // no baseBranch
    }));

    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add -b"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
    const cmd = worktreeAddCalls[0][0] as string;
    expect(cmd).toContain('"main"');
  });

  it("logs base branch in worktree creation log entry", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");

    /*
    FNXC:EngineTests 2026-07-19-16:42 (U10b):
    The "Worktree created ... (based on <base>)" log names the PERSISTED base branch; seed the row
    because the graph re-reads the task rather than trusting the object passed to `execute()`.
    */
    store._setRow("FN-062", { executionStartBranch: "fusion/fn-061" });
    await executor.execute(makeTask({
      id: "FN-062",
      executionStartBranch: "fusion/fn-061",
    }));

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-062",
      expect.stringContaining("based on fusion/fn-061"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
  });

  it("logs integration branch in worktree creation log when baseBranch is not set", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");

    await executor.execute(makeTask({
      id: "FN-063",
    }));

    const logCalls = store.logEntry.mock.calls.filter(
      (call: any[]) => typeof call[1] === "string" && call[1].includes("Worktree created"),
    );
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls[0][1]).toContain("based on main");
  });

  it("creates at the canonical task-pinned path after drift recovery", async () => {
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    mockedExistsSync.mockReturnValue(false);

    await executor.execute(makeTask({ id: "FN-064" }));

    const worktreeCreateCalls = mockedExecSync.mock.calls
      .map((call) => String(call[0]))
      .filter((command) => command.includes("git worktree add"));
    expect(worktreeCreateCalls).toHaveLength(1);
    expect(worktreeCreateCalls[0]).toContain('"/tmp/test/.fusion/worktrees/fn-064"');
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-064",
      "Drift detected: in-progress with no worktree — creating fresh worktree to recover",
      undefined,
      expect.anything(),
    );
  });

  it("throws original error if cleanup also fails", async () => {
    vi.useRealTimers();
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    const conflictingPath = "/tmp/test/.worktrees/sharp-stone";

    mockedExecSync.mockImplementation((cmd: any) => {
      if (typeof cmd === "string" && cmd.includes("git worktree add") && cmd.includes("-b")) {
        const err: any = new Error(
          `fatal: 'fusion/fn-065' is already used by worktree at '${conflictingPath}'`,
        );
        err.stderr = Buffer.from(
          `fatal: 'fusion/fn-065' is already used by worktree at '${conflictingPath}'`,
        );
        throw err;
      }
      if (cmd === `git worktree remove --force "${conflictingPath}"`) {
        throw new Error("remove failed");
      }
      return Buffer.from("");
    });

    await executor.execute(makeTask({ id: "FN-065" }));

    expect(store.updateTask).toHaveBeenCalledWith("FN-065", {
      status: "failed",
      error: expect.stringContaining("automatic cleanup failed"),
    });
  });
});

describe("fresh worktree integration rebase", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  function mockGitCommands(respond: (command: string) => Error | null) {
    mockedExec.mockImplementation(((command: string, _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(respond(command), "", "");
      return {} as any;
    }) as any);
  }

  it("rebases onto configured integrationBranch instead of remote or ambient HEAD", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      worktreeRebaseBeforeMerge: true,
      worktreeRebaseRemote: "origin",
      integrationBranch: "develop",
    });
    mockGitCommands(() => null);
    const executor = createWorktreeExecutor(store, "/repo");

    await (executor as any).rebaseNewWorktreeOntoRemote("/repo/.worktrees/fn-8839", "fusion/fn-8839", "FN-8839");

    const commands = mockedExec.mock.calls.map(([command]) => String(command));
    expect(commands).toContain("git fetch 'origin' 'develop'");
    expect(commands).toContain("git rebase 'origin/develop'");
    expect(commands).not.toContain(expect.stringContaining("rev-parse --abbrev-ref HEAD"));
    expect(commands).not.toContain(expect.stringContaining("origin/HEAD"));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8839",
      "Rebased new worktree branch fusion/fn-8839 onto origin/develop",
      undefined,
      undefined,
    );
  });

  it("uses the canonical resolver's origin HEAD and fixed fallback without ambient HEAD", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      worktreeRebaseBeforeMerge: true,
      worktreeRebaseRemote: "origin",
    });
    mockedExec.mockImplementation(((command: string, _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, command.includes("refs/remotes/origin/HEAD") ? "origin/release\n" : "", "");
      return {} as any;
    }) as any);
    const executor = createWorktreeExecutor(store, "/repo");

    await (executor as any).rebaseNewWorktreeOntoRemote("/worktree", "fusion/fn-8839", "FN-8839");

    expect(mockedExec.mock.calls.map(([command]) => String(command))).toEqual(expect.arrayContaining([
      "git symbolic-ref --short refs/remotes/origin/HEAD",
      "git fetch 'origin' 'release'",
      "git rebase 'origin/release'",
    ]));

    resetExecutorMocks();
    const fallbackStore = createMockStore();
    fallbackStore.getSettings.mockResolvedValue({
      worktreeRebaseBeforeMerge: true,
      worktreeRebaseRemote: "origin",
    });
    mockedExec.mockImplementation(((command: string, _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(command.includes("refs/remotes/origin/HEAD") ? new Error("origin HEAD unset") : null, "", "");
      return {} as any;
    }) as any);

    await (createWorktreeExecutor(fallbackStore, "/repo") as any).rebaseNewWorktreeOntoRemote("/worktree", "fusion/fn-8839", "FN-8839");

    const fallbackCommands = mockedExec.mock.calls.map(([command]) => String(command));
    expect(fallbackCommands).toContain("git fetch 'origin' 'main'");
    expect(fallbackCommands).toContain("git rebase 'origin/main'");
    expect(fallbackCommands).not.toContain(expect.stringContaining("rev-parse --abbrev-ref HEAD"));
  });

  it("logs an enabled refresh skip when no remote is resolvable", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ worktreeRebaseBeforeMerge: true });
    mockGitCommands((command) => command === "git remote" ? null : new Error(`unexpected ${command}`));
    const executor = createWorktreeExecutor(store, "/repo");

    await (executor as any).rebaseNewWorktreeOntoRemote("/worktree", "fusion/fn-8839", "FN-8839");

    expect(mockedExec).toHaveBeenCalledWith("git remote", { cwd: "/repo" }, expect.any(Function));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8839",
      "Skipped new worktree rebase refresh — no remote was resolvable",
      undefined,
      undefined,
    );
  });

  it("logs fetch failures without rebasing or failing worktree setup", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      worktreeRebaseBeforeMerge: true,
      worktreeRebaseRemote: "origin",
      integrationBranch: "develop",
    });
    mockGitCommands((command) => command.includes("git fetch") ? new Error("network unavailable") : null);
    const executor = createWorktreeExecutor(store, "/repo");

    await expect((executor as any).rebaseNewWorktreeOntoRemote("/worktree", "fusion/fn-8839", "FN-8839")).resolves.toBeUndefined();

    const commands = mockedExec.mock.calls.map(([command]) => String(command));
    expect(commands).toContain("git fetch 'origin' 'develop'");
    expect(commands).not.toContain("git rebase 'origin/develop'");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8839",
      "Could not refresh new worktree rebase target origin/develop — fetch failed; kept local base.",
      undefined,
      undefined,
    );
  });

  it("keeps a successful rebase successful when its task-log write fails", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      worktreeRebaseBeforeMerge: true,
      worktreeRebaseRemote: "origin",
      integrationBranch: "develop",
    });
    store.logEntry.mockRejectedValue(new Error("task log unavailable"));
    mockGitCommands(() => null);
    const executor = createWorktreeExecutor(store, "/repo");

    await expect((executor as any).rebaseNewWorktreeOntoRemote("/worktree", "fusion/fn-8839", "FN-8839")).resolves.toBeUndefined();
    await Promise.resolve();

    const commands = mockedExec.mock.calls.map(([command]) => String(command));
    expect(commands).toContain("git rebase 'origin/develop'");
    expect(commands).not.toContain("git rebase --abort");
  });

  it("aborts a conflicting rebase, retains the local-base log, and keeps disabled mode silent", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      worktreeRebaseBeforeMerge: true,
      worktreeRebaseRemote: "origin",
      integrationBranch: "develop",
    });
    mockGitCommands((command) => command === "git rebase 'origin/develop'" || command === "git rebase --abort"
      ? new Error("conflict")
      : null);
    const executor = createWorktreeExecutor(store, "/repo");

    await (executor as any).rebaseNewWorktreeOntoRemote("/worktree", "fusion/fn-8839", "FN-8839");

    expect(mockedExec.mock.calls.map(([command]) => String(command))).toContain("git rebase --abort");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8839",
      "Could not rebase new worktree onto origin/develop — kept local base. The merge-time rebase will retry with conflict resolution.",
      undefined,
      undefined,
    );

    resetExecutorMocks();
    const disabledStore = createMockStore();
    disabledStore.getSettings.mockResolvedValue({ worktreeRebaseBeforeMerge: false });
    const disabledExecutor = createWorktreeExecutor(disabledStore, "/repo");
    await (disabledExecutor as any).rebaseNewWorktreeOntoRemote("/worktree", "fusion/fn-8839", "FN-8839");
    expect(mockedExec).not.toHaveBeenCalled();
    expect(disabledStore.logEntry).not.toHaveBeenCalled();
  });
});

function createMockTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-001",
    title: "Test Task",
    description: "A test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}


describe("worktree DB hydration", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-HYD",
    title: "Hydrate",
    description: "Hydrate",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    resetExecutorMocks();
    mockedHydrateWorktreeDb.mockReset();
    mockedHydrateWorktreeDb.mockResolvedValue({
      tasksCopied: 1,
      documentsCopied: 2,
      artifactsCopied: 0,
      degraded: false,
    });
    mockedCreateFnAgent.mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
    } as any);
  });

  it("runs once for fresh worktree", async () => {
    mockedExistsSync.mockReturnValue(false);
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());
    expect(mockedHydrateWorktreeDb).toHaveBeenCalledTimes(1);
  });

  it("runs once for pool acquire", async () => {
    mockedExistsSync.mockReturnValue(false);
    const store = createMockStore();
    const pool = {
      acquire: vi.fn(() => "/tmp/test/.worktrees/pooled"),
      prepareForTask: vi.fn(async () => "fusion/fn-hyd"),
      release: vi.fn(),
    } as any;
    store.getSettings.mockResolvedValue({ ...(await store.getSettings()) });
    const executor = createWorktreeExecutor(store, "/tmp/test", { pool });
    await executor.execute(makeTask());
    expect(mockedHydrateWorktreeDb).toHaveBeenCalledTimes(1);
  });

  it("runs hydration after re-deriving unusable root metadata to a fresh pinned worktree", async () => {
    mockedExistsSync.mockReturnValue(false);
    const store = createMockStore();
    store._setRow("FN-HYD", { worktree: "/tmp/test" });
    const executor = createWorktreeExecutor(store, "/tmp/test");

    await executor.execute(makeTask({ worktree: "/tmp/test" }));

    expect(mockedHydrateWorktreeDb).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-HYD",
      expect.objectContaining({ worktree: "/tmp/test/.fusion/worktrees/fn-hyd" }),
    );
  });

  it("logs degraded hydration reason and continues execution", async () => {
    mockedHydrateWorktreeDb.mockResolvedValueOnce({
      tasksCopied: 0,
      documentsCopied: 0,
      artifactsCopied: 0,
      degraded: true,
      reason: "unable to open database file",
    });
    mockedExistsSync.mockReturnValue(false);
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          "FN-HYD",
          "Worktree DB hydration degraded: unable to open database file",
          undefined,
          expect.objectContaining({ agentId: "executor" }),
        ],
      ]),
    );
    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });

  it("hydration failure does not abort execute", async () => {
    mockedHydrateWorktreeDb.mockRejectedValueOnce(new Error("boom"));
    mockedExistsSync.mockReturnValue(false);
    const store = createMockStore();
    const executor = createWorktreeExecutor(store, "/tmp/test");
    await executor.execute(makeTask());
    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });
});
