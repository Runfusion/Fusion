// -nocheck
/* eslint-disable -eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./executor-test-helpers.js";
import { AgentSemaphore } from "../concurrency/concurrency.js";
import { detectReviewHandoffIntent, determineRevisionResetStart } from "../executor.js";
import { TaskExecutor, buildExecutionPrompt } from "../executor.js";
import { createFnAgent } from "../pi.js";
import { reviewStep as mockedReviewStepFn } from "../execution/reviewer.js";
import { execSync } from "node:child_process";
import { findWorktreeUser, aiMergeTask } from "../merger.js";
import { WorktreePool } from "../worktree/worktree-pool.js";
import { generateWorktreeName, slugify } from "../worktree/worktree-names.js";
import type { Task, TaskDetail } from "@fusion/core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { StepSessionExecutor } from "../execution/step-session-executor.js";
import { executorLog } from "../logger.js";
import { withRateLimitRetry } from "../errors/rate-limit-retry.js";
import { MAX_RECOVERY_RETRIES } from "../healing/recovery-policy.js";
import { executingTaskLock } from "../agents/active-session-registry.js";
import { runVerificationCommand as mockedRunVerificationCommand } from "../execution/verification-utils.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedSessionManager,
  mockedGenerateWorktreeName,
  mockedFindWorktreeUser,
  mockedStepSessionExecutor,
  mockedWithRateLimitRetry,
  mockedExecSync,
  mockedExistsSync,
  mockExecuteAll,
  mockTerminateAllSessions,
  mockCleanup,
  mockSteerActiveSessions,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

describe("Workflow Steps Execution", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  /**
   * FNXC:EngineTests 2026-07-19-10:35 (U10b):
   * Review gates (Plan Review, Code Review, Completion summary) are workflow-graph nodes now, so a
   * single execute() opens several agent sessions and the implementation session is no longer the
   * first or the only one. Every assertion in this file that used to count `createFnAgent` calls was
   * really asserting how many times the IMPLEMENTATION session was (re)opened — its retry loop.
   * `fn_task_done` is handed only to the implementation session, so filtering on it keeps those
   * assertions measuring the retry contract instead of the graph's node count.
   */
  function implementationSessionCount(): number {
    return mockedCreateFnAgent.mock.calls.filter((call: any[]) =>
      ((call[0]?.customTools as any[]) || []).some((tool: any) => tool.name === "fn_task_done"),
    ).length;
  }

  /**
   * Create a mock agent that auto-triggers the fn_task_done tool when prompt is called.
   * This simulates a successful task execution where the agent calls fn_task_done().
   */
  /*
  FNXC:EngineTests 2026-07-19-11:25 (U10b):
  Scoped the captured tools to the session that owns them (was a shared outer variable that each
  new graph session clobbered) and dropped the `subscribe` stub so the shared harness supplies a
  verdict-shaped stream for review-node sessions. Without both, the graph's review sessions ran
  with the implementation session's tools / an empty stream and the run never reached the
  implementation node this helper exists to drive.
  */
  function createAgentWithTaskDone() {
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      const customTools: any[] = opts.customTools || [];
      const session = {
        prompt: vi.fn().mockImplementation(async () => {
          // Find and execute fn_task_done tool to set taskDone = true
          const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
          if (taskDoneTool) {
            await taskDoneTool.execute("tool-1", {});
          }
        }),
        dispose: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      };
      return { session };
    }) as any);
  }

  it("exposes artifact discovery and register tools even without an assigned agent", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-ART-1",
      title: "Artifact discovery",
      description: "Test artifact discovery tools",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" }],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockResolvedValue(task as any);

    /*
    FNXC:EngineTests 2026-07-19-10:20 (U10b):
    Under graph ownership every execute() runs the whole builtin:coding graph, so several agent
    sessions are created (plan review, implementation, code review, completion summary). The
    implementation session is no longer the last one, so overwriting `toolNames` per session
    measured whichever session happened to run last. The requirement is that the artifact tools
    are offered to the executor's session at all without an assigned agent — accumulate across
    sessions so the assertion keeps testing that, not session ordering.
    Leave `subscribe` to the shared harness default: it streams an APPROVE verdict for review
    sessions, keeping the graph's review nodes inert for a test about tool exposure.
    */
    let toolNames: string[] = [];
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      const customTools = opts.customTools || [];
      toolNames = [...toolNames, ...customTools.map((tool: any) => tool.name)];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute(task as any);

    /*
    FNXC:ArtifactRegistry 2026-07-12-07:00:
    FN-7790 (commits 9024f3a63 / a8eafbbb1: agent-created visual artifacts end-to-end) made fn_artifact_register available for ALL executor sessions, not just assigned-agent sessions, so artifact creation works even without an assigned author. The previous gate (register requires assigned agent) was intentionally removed. Update the assertion to reflect the new behavior.
    */
    expect(toolNames).toContain("fn_artifact_list");
    expect(toolNames).toContain("fn_artifact_view");
    expect(toolNames).toContain("fn_artifact_register");
  });

  it("requeues to todo after 3 retries when the agent exits without calling fn_task_done", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" }],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // FNXC:EngineTests 2026-07-19-10:35 (U10b): no `subscribe` override — the shared harness streams
    // an APPROVE verdict for graph review sessions, so Plan Review stays inert and the run reaches
    // the implementation node whose no-fn_task_done retry budget is what this test asserts.
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);

    const onComplete = vi.fn();
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // The implementation session should have been opened four times: initial + 3 retries.
    expect(implementationSessionCount()).toBe(4);

    /*
    FNXC:EngineTests 2026-06-18-07:22:
    FN-6610 confirmed the intended executor.ts no-fn_task_done exhaustion behavior: after three in-session retries, tasks with remaining requeue budget return to todo with progress preserved; only exhausted requeue budget parks them in review.
    Keep these expectations aligned with Executor.execute()'s MAX_TASK_DONE_REQUEUE_RETRIES branch rather than treating the first in-session exhaustion as terminal.
    */
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "queued",
      error: null,
      taskDoneRetryCount: 1,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Agent finished without calling fn_task_done (after 3 retries) — requeued to todo immediately (1/3)",
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-001" }),
      expect.objectContaining({ message: "Agent finished without calling fn_task_done (after 3 retries)" }),
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("marks task failed in-place once fn_task_done requeue budget is exhausted (FN-7229)", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" }],
      currentStep: 0,
      taskDoneRetryCount: 3,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" }],
      currentStep: 0,
      taskDoneRetryCount: 3,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(mockedCreateFnAgent.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "failed",
      error: "Agent finished without calling fn_task_done (after 3 retries)",
    });
    // FNXC:ExecutorMoveTask 2026-07-07-08:38: FN-7229 (984e36255d) stopped parking execution errors in review — an exhausted fn_task_done budget now marks the task failed in-place (executor.ts:11179) instead of moveTask→in-review. `in-review` is reserved for clean completion handoffs, so the task must NOT be moved there. (Line 236 already asserts status=failed.)
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-001" }),
      expect.objectContaining({ message: "Agent finished without calling fn_task_done (after 3 retries)" }),
    );
  });

  it("clears a stale assistant-continuation resume session and requeues without marking the task failed", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-ASSISTANT-STALE",
      title: "Stale assistant continuation",
      description: "Test stale assistant continuation recovery",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" as const }],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      sessionFile: "/tmp/stale-session.jsonl",
      worktree: "/tmp/test/.worktrees/fn-assistant-stale",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockResolvedValue(task as any);
    store.moveTask.mockImplementation(async () => {
      expect(executingTaskLock.has("FN-ASSISTANT-STALE")).toBe(false);
      expect((executor as any).activeWorktrees.has("FN-ASSISTANT-STALE")).toBe(false);
      return task as any;
    });

    /*
    FNXC:EngineTests 2026-07-19-10:40 (U10b):
    The stale-resume recovery this test pins belongs to the IMPLEMENTATION session — that is the
    only session resumed from `task.sessionFile`. Under graph ownership a review-node session is
    created first, so rejecting from every session made the run die at Plan Review instead. Reject
    only from the session that carries `fn_task_done`, and leave `subscribe` to the harness so the
    review node approves and the graph actually reaches the implementation node.
    */
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      const isImplementation = ((opts?.customTools as any[]) || []).some((tool: any) => tool.name === "fn_task_done");
      return {
        session: {
          prompt: isImplementation
            ? vi.fn().mockRejectedValue(new Error("Cannot continue from message role: assistant"))
            : vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      };
    }) as any);

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    const markGraphExecuteSelfRequeued = vi.spyOn(executor as any, "markGraphExecuteSelfRequeued");
    (executor as any).activeWorktrees.set("FN-ASSISTANT-STALE", new Set([task.worktree]));

    await executor.execute(task as any);

    expect(store.updateTask).toHaveBeenCalledWith("FN-ASSISTANT-STALE", {
      sessionFile: null,
      recoveryRetryCount: 1,
      nextRecoveryAt: expect.any(String),
    });
    expect(store.updateTask).toHaveBeenCalledWith("FN-ASSISTANT-STALE", {
      sessionFile: null,
      status: null,
      error: null,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-ASSISTANT-STALE", "todo", { preserveResumeState: true });
    expect(markGraphExecuteSelfRequeued).toHaveBeenCalledWith("FN-ASSISTANT-STALE");
    expect(executingTaskLock.has("FN-ASSISTANT-STALE")).toBe(false);
    expect((executor as any).activeWorktrees.has("FN-ASSISTANT-STALE")).toBe(false);
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("fails a repeated stale assistant-continuation after the fresh-session retry budget is exhausted", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-ASSISTANT-STALE-EXHAUSTED",
      title: "Repeated stale assistant continuation",
      description: "Test bounded stale assistant continuation recovery",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" as const }],
      currentStep: 0,
      recoveryRetryCount: MAX_RECOVERY_RETRIES,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      sessionFile: "/tmp/stale-session.jsonl",
      worktree: "/tmp/test/.worktrees/fn-assistant-stale-exhausted",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockResolvedValue(task as any);
    // FNXC:EngineTests 2026-07-19-10:40 (U10b): reject only from the implementation session (the one
    // resumed from `task.sessionFile`); the graph's review-node session must stay healthy so the run
    // reaches the implementation node whose exhausted recovery budget is under test.
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      const isImplementation = ((opts?.customTools as any[]) || []).some((tool: any) => tool.name === "fn_task_done");
      return {
        session: {
          prompt: isImplementation
            ? vi.fn().mockRejectedValue(new Error("Cannot continue from message role: assistant"))
            : vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      };
    }) as any);
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    await executor.execute(task as any);

    expect(store.updateTask).toHaveBeenCalledWith("FN-ASSISTANT-STALE-EXHAUSTED", {
      status: "failed",
      error: "Cannot continue from message role: assistant",
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-ASSISTANT-STALE-EXHAUSTED", "todo", expect.anything());
    expect(onError).toHaveBeenCalledOnce();
  });

  describe("FN-5436: pending-review skip on no-fn_task_done exit", () => {
    /*
    FNXC:EngineTests 2026-07-19-10:55 (U10b):
    DELETED here: "does not park in-review when code review REVISE requires more executor work".
    It drove a code-review REVISE through the in-session `fn_review_step` tool, and asserted that
    the resulting in-session verdict suppressed the pending-review park. U10 (R9) deleted that
    tool and, with it, the in-session verdict source — `detectPendingReviewBlock` no longer reads
    any code-review verdict map (its parameter is now `_codeReviewVerdicts`). Review verdicts are
    owned exclusively by workflow-graph nodes, so there is no graph equivalent of the behavior the
    test described; what remained of it duplicated "keeps existing retry loop when no pending
    review block is present" below, which still covers the un-blocked retry loop.
    */

    it("parks in-review when review request has no subsequent verdict", async () => {
      const store = createMockStore();
      const baseTask = {
        id: "FN-5436-B",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [{ name: "Implement", status: "in-progress" }],
        currentStep: 0,
        log: [{ action: "code review requested for Step 0 (Implement)", timestamp: new Date().toISOString() }],
        prompt: "# test\n## Steps\n### Step 1: Implement\n- [ ] implement",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.getTask.mockResolvedValue(baseTask as any);

      mockedCreateFnAgent.mockResolvedValue({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      } as any);

      const executor = new TaskExecutor(store, "/tmp/test", {});
      await executor.execute(baseTask as any);

      // FNXC:EngineTests 2026-07-19-10:55 (U10b): the pending-review block must skip the retry
      // session, so the implementation session is opened exactly once. Count implementation
      // sessions, not total graph sessions.
      expect(implementationSessionCount()).toBe(1);
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-B", {
        status: "failed",
        error: "executor-exit-while-review-pending",
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-5436-B",
        expect.stringContaining("blocked on pending review (review-request-without-verdict)"),
        undefined,
        expect.objectContaining({ agentId: "executor" }),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-5436-B", "in-review");
    });

    it("keeps existing retry loop when no pending review block is present", async () => {
      const store = createMockStore();
      const baseTask = {
        id: "FN-5436-C",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [{ name: "Implement", status: "in-progress" }],
        currentStep: 0,
        log: [{ action: "code review Step 0: APPROVE", timestamp: new Date().toISOString() }],
        prompt: "# test\n## Steps\n### Step 1: Implement\n- [ ] implement",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.getTask.mockResolvedValue(baseTask as any);

      mockedCreateFnAgent.mockResolvedValue({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      } as any);

      const executor = new TaskExecutor(store, "/tmp/test", {});
      await executor.execute(baseTask as any);

      // FNXC:EngineTests 2026-07-19-10:55 (U10b): no pending-review block means the full retry
      // budget runs — 4 implementation sessions (initial + 3 retries), independent of the graph's
      // own review-node sessions.
      expect(implementationSessionCount()).toBe(4);
      expect(store.updateTask).toHaveBeenCalledWith("FN-5436-C", {
        status: "queued",
        error: null,
        taskDoneRetryCount: 1,
      });
    });

    /*
    FNXC:EngineTests 2026-07-19-11:15 (U10b):
    Requirement (unchanged): an agent that exits WITHOUT calling fn_task_done but leaves every step
    terminal completes implicitly — no retry sessions are burned and the task reaches the review
    handoff. Only the way to arrive at that state changed. This test used to seed the step as
    already `done` and rely on the legacy runner never touching it; the graph's step-execute node
    now marks its target step `in-progress` (source: "graph") before the implementation pass, so
    "no in-progress step exists at session start" is unreachable under graph ownership. Drive the
    same end-state the way the graph reaches it: the session completes the step and exits silently.
    */
    it("allows implicit done to complete when the agent leaves every step terminal", async () => {
      const store = createMockStore();
      const baseTask = {
        id: "FN-5436-D",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [{ name: "Implement", status: "done" }],
        currentStep: 0,
        log: [],
        prompt: "# test\n## Steps\n### Step 1: Implement\n- [x] implement",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.getTask.mockResolvedValue(baseTask as any);

      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
        const isImplementation = ((opts?.customTools as any[]) || []).some((tool: any) => tool.name === "fn_task_done");
        return {
          session: {
            // Completes the step but never calls fn_task_done — the implicit-completion path.
            prompt: vi.fn().mockImplementation(async () => {
              if (isImplementation) await store.updateStep("FN-5436-D", 0, "done");
            }),
            dispose: vi.fn(),
            on: vi.fn(),
            sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
            state: {},
          },
        };
      }) as any);

      const onComplete = vi.fn();
      const onError = vi.fn();
      const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });
      await executor.execute(baseTask as any);

      // FNXC:EngineTests 2026-07-19-10:55 (U10b): implicit done is accepted without a retry, so the
      // implementation session runs exactly once; the graph's review/summary sessions are separate.
      expect(implementationSessionCount()).toBe(1);
      /*
      FNXC:EngineTests 2026-07-19-11:15 (U10b):
      The old proof that implicit done was ACCEPTED was the legacy completion path's retry-counter
      reset (`workflowStepRetries: undefined, taskDoneRetryCount: null`) plus the executor's own
      `onComplete`. Both belong to the non-graph fallback: a graph-driven run returns at the
      implementation-complete boundary (executor.ts `if (graphCompletion) { ... return; }`) before
      either runs, and the graph interpreter owns the rest of the lifecycle. Assert the implicit
      acceptance directly at its own log line instead — that is the requirement, and it is a
      stronger statement than the bookkeeping side effect that used to stand in for it.
      */
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-5436-D",
        "All steps complete — implicit fn_task_done (agent did not call tool explicitly)",
        undefined,
        expect.objectContaining({ agentId: "executor" }),
      );
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-D", {
        status: "failed",
        error: "executor-exit-while-review-pending",
      });
      // FNXC:EngineTests 2026-07-19-11:15 (U10b): the in-review handoff is now the graph's own
      // move off the implementation node, carrying workflow move provenance.
      expect(store.moveTask).toHaveBeenCalledWith(
        "FN-5436-D",
        "in-review",
        expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
      );
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it("handles tasks with no workflow steps", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    /*
    FNXC:EngineTests 2026-07-19-11:25 (U10b):
    An explicit fn_task_done still completes in one implementation session, and the task still
    lands in `in-review`. Two things changed shape, not substance: the graph opens its own review
    sessions alongside the implementation one (so count implementation sessions), and the in-review
    handoff is now the graph's move off the implementation node, carrying workflow move provenance.
    */
    expect(implementationSessionCount()).toBe(1);
    // Task should still move to in-review
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-001",
      "in-review",
      expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
    );
  });

  it("routes exhausted prompt-mode workflow hard failures back to remediation and reopens actionable steps", async () => {
    // This test was previously written as an end-to-end run through
    // executor.execute(...) with vi.useFakeTimers(), but that path hung
    // deterministically under the 15 s budget: createResolvedAgentSession's
    // workflow-step Promise.race used a frozen 360 s setTimeout, and the
    // rejection from the mock prompt never reached the catch block in time.
    // The behavior we actually need to lock down is:
    //   1. sendTaskBackForFix re-opens the actionable implementation step plus
    //      any trailing verification/delivery step, not just a trivial last step.
    //   2. The rerun bounce uses preserveResumeState so step progress and
    //      the worktree survive the in-progress → todo hop.
    //   3. PROMPT.md gains the Workflow Step Failure section with the
    //      step name and feedback so the next session sees the regression.
    // We exercise (1)–(3) by calling sendTaskBackForFix directly, which is
    // what the executor's full failure path invokes once retries are
    // exhausted (executor.ts:2113/2626/2787).
    // Ensure we're on real timers — earlier tests in this describe block
    // call vi.useFakeTimers() and rely on per-test cleanup; defending
    // against any leak guarantees scheduleWorkflowRerun's setTimeout(0)
    // bounce actually fires here.
    vi.useRealTimers();

    const store = createMockStore();
    // The full file-backed path was unavailable here: this test file mocks
    // node:fs at the module level, which breaks node:fs/promises.mkdtemp
    // under the vitest module resolver. Stub out the PROMPT.md mutation
    // (already covered by other tests' addTaskComment + injection unit
    // checks) and assert the behavior we actually care about — only the
    // last step is reopened, and the rerun bounce flags preserveResumeState.
    store.getFusionDir.mockReturnValue("/tmp/fn-2301-workflow/.fusion");

    const mutableTask = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      dependencies: [] as string[],
      steps: [
        { name: "Implementation", status: "done" as const },
        { name: "Documentation & Delivery", status: "done" as const },
      ],
      currentStep: 1,
      log: [] as any[],
      enabledWorkflowSteps: ["WS-001"],
      workflowStepRetries: 3,
      prompt: "# test\n## Steps\n### Step 0\n- [x] done\n### Step 1\n- [x] done",
      worktree: "/tmp/test/worktree",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockImplementation(async () => mutableTask);

    store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: string) => {
      if (mutableTask.steps[stepIndex]) {
        mutableTask.steps[stepIndex].status = status as any;
      }
      return {};
    });

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    // Stub injectWorkflowStepFailureInstructions: PROMPT.md write is verified
    // by separate tests; here we just need sendTaskBackForFix to proceed past
    // it without doing real fs I/O (which is unavailable under this file's
    // node:fs mock).
    const injectSpy = vi
      .spyOn(executor as unknown as { injectWorkflowStepFailureInstructions: (...a: unknown[]) => Promise<void> }, "injectWorkflowStepFailureInstructions")
      .mockResolvedValue(undefined);

    // Run the rerun bounce inline rather than via setTimeout(0). When this
    // suite runs with sibling tests, fake-timer leaks from earlier
    // describe blocks have made the original setTimeout-driven path
    // non-deterministic; calling performWorkflowRerunBounce directly is
    // exactly what the timer would have done after the next event-loop
    // tick and removes the timing dependency entirely.
    // Cast once to a named handle: these are private executor methods the
    // compiler cannot see; assign to a typed const rather than inlining the
    // cast into each member access.
    const executorInternals = executor as unknown as {
      scheduleWorkflowRerun: (taskId: string, worktreePath: string, successMessage: string) => void;
      performWorkflowRerunBounce: (taskId: string, worktreePath: string) => Promise<unknown>;
    };
    let bouncePromise: Promise<unknown> | undefined;
    const scheduleSpy = vi
      .spyOn(executorInternals, "scheduleWorkflowRerun")
      .mockImplementation((taskId, worktreePath) => {
        // Capture the bounce promise so the test can await it to completion
        // (see FNXC below) instead of flushing a fixed microtask count.
        bouncePromise = executorInternals.performWorkflowRerunBounce(taskId, worktreePath);
      });

    const stepName = "Frontend UX Design";
    const feedback = "Quality gate hard failure: spacing regression in dashboard cards";

    await (executor as unknown as {
      sendTaskBackForFix: (
        task: typeof mutableTask,
        worktreePath: string,
        failureFeedback: string,
        stepName: string,
        reason: string,
      ) => Promise<void>;
    }).sendTaskBackForFix(
      mutableTask,
      mutableTask.worktree,
      feedback,
      stepName,
      "Workflow step failed",
    );

    // (1) failure comment + the implementation-bearing step is re-opened with the trailing delivery step.
    // Before FN-7162, reopenLastStepForRevision returned only [1] here, so a
    // Code Review / Browser Verification REVISE could re-run Documentation &
    // Delivery against unchanged implementation work and loop until budget exhaustion.
    expect(store.addTaskComment).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Workflow step failed"),
      "agent",
    );
    const reopenedStepIndexes = store.updateStep.mock.calls
      .filter((call: any[]) => call[0] === "FN-001" && call[2] === "pending")
      .map((call: any[]) => call[1]);
    expect(reopenedStepIndexes).toEqual([0, 1]);

    // FNXC:ExecutorMoveTask 2026-07-07-08:38: Await the captured rerun-bounce promise instead of flushing a fixed number of microtasks. 3167dbc83 inserted clearTerminalStepFailuresForRetry (an extra awaited hop) between the todo and in-progress moves inside performWorkflowRerunBounce, so a fixed microtask count no longer deterministically drains the bounce to the final in-progress moveTask. Awaiting the promise is exact and survives future awaited hops; the bounce still performs the todo→in-progress hop (executor.ts:3650 then 3674).
    await bouncePromise;

    // (2) bounce uses preserveResumeState so step progress + worktree survive
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", expect.objectContaining({ preserveResumeState: true, preserveWorktree: true }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    expect(onError).not.toHaveBeenCalled();

    // (3) PROMPT.md injection was invoked with the failure context. The
    // actual file write is covered by other tests; here we just need to
    // confirm sendTaskBackForFix forwards the right step name and feedback.
    // Last arg is MAX_WORKFLOW_STEP_RETRIES (private const, currently 3) so
    // the injected PROMPT.md note shows "3/3 (0 remaining)".
    expect(injectSpy).toHaveBeenCalledWith(
      mutableTask,
      feedback,
      stepName,
      expect.any(Number),
    );

    // The scheduleWorkflowRerun stub above never registers the 15 s
    // watchdog timer, so there's nothing to clear here.
    scheduleSpy.mockRestore();
    injectSpy.mockRestore();
  });

  it("keeps post-verdict reopening bounded across all-done, mixed, and single-step states", async () => {
    const cases = [
      {
        id: "all-done-terminal",
        steps: [
          { name: "Implementation", status: "done" as const },
          { name: "Documentation & Delivery", status: "done" as const },
        ],
        expectedIndexes: [0, 1],
        expectedCurrent: 0,
      },
      {
        id: "mixed-terminal-pending",
        steps: [
          { name: "Implementation", status: "done" as const },
          { name: "Documentation & Delivery", status: "pending" as const },
        ],
        expectedIndexes: [0],
        expectedCurrent: 0,
      },
      {
        id: "single-step",
        steps: [{ name: "Implementation", status: "done" as const }],
        expectedIndexes: [0],
        expectedCurrent: 0,
      },
    ];

    for (const testCase of cases) {
      const store = createMockStore();
      const mutableTask = {
        id: `FN-7162-${testCase.id}`,
        title: "Test",
        description: "Test task",
        column: "in-progress" as const,
        dependencies: [] as string[],
        steps: testCase.steps.map((step) => ({ ...step })),
        currentStep: testCase.steps.length - 1,
        log: [] as any[],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: string) => {
        mutableTask.steps[stepIndex]!.status = status as any;
        return {};
      });

      const executor = new TaskExecutor(store, "/tmp/test");
      const reopened = await (executor as unknown as {
        reopenLastStepForRevision: (
          taskId: string,
          task: typeof mutableTask,
        ) => Promise<{ index: number; name: string; indexes: number[] } | null>;
      }).reopenLastStepForRevision(mutableTask.id, mutableTask);

      expect(reopened?.indexes).toEqual(testCase.expectedIndexes);
      expect(reopened?.index).toBe(testCase.expectedCurrent);
      expect(store.updateStep.mock.calls.map((call: any[]) => call[1])).toEqual(testCase.expectedIndexes);
      expect(store.updateTask).toHaveBeenCalledWith(mutableTask.id, { currentStep: testCase.expectedCurrent });
      expect(mutableTask.steps.some((step) => step.status === "pending")).toBe(true);
    }
  });

  it("reopens terminal verification and delivery suffix with the implementation step", async () => {
    const store = createMockStore();
    const mutableTask = {
      id: "FN-7162-SUFFIX",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      dependencies: [] as string[],
      steps: [
        { name: "Implementation", status: "done" as const },
        { name: "Testing & Verification", status: "done" as const },
        { name: "Documentation & Delivery", status: "done" as const },
      ],
      currentStep: 2,
      log: [] as any[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: string) => {
      mutableTask.steps[stepIndex]!.status = status as any;
      return {};
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    const reopened = await (executor as unknown as {
      reopenLastStepForRevision: (
        taskId: string,
        task: typeof mutableTask,
      ) => Promise<{ index: number; name: string; indexes: number[] } | null>;
    }).reopenLastStepForRevision(mutableTask.id, mutableTask);

    expect(reopened).toEqual({ index: 0, name: "Implementation", indexes: [0, 1, 2] });
    expect(store.updateStep.mock.calls.map((call: any[]) => call[1])).toEqual([0, 1, 2]);
    expect(store.updateTask).toHaveBeenCalledWith("FN-7162-SUFFIX", { currentStep: 0 });
  });

  // FNXC:WorkflowOptionalStepFix 2026-06-27-13:30:
  // Regression for the FN-7122 deadlock: a pre-merge optional-step REVISE
  // reopens the last plan step to `pending` and schedules a rerun bounce, but
  // a completion race can land the task in `in-review` BEFORE the setTimeout(0)
  // bounce fires. The bounce previously only handled `in-progress`/`todo` and
  // THREW on `in-review`, stranding the task in-review with a `pending` step:
  // the merge gate blocks forever and self-healing only re-runs the graph
  // (re-passing the advisory step) without re-launching the executor. The
  // invariant: performWorkflowRerunBounce must bounce an `in-review` task back
  // to in-progress exactly like an `in-progress` task, so the reopened step is
  // actually re-executed.
  it("bounces an in-review task back to in-progress (FN-7122 deadlock)", async () => {
    vi.useRealTimers();

    const store = createMockStore();
    const mutableTask = {
      id: "FN-7122",
      title: "Test",
      description: "Test task",
      // The completion race left the task in in-review while the optional-step
      // fix bounce was queued.
      column: "in-review" as const,
      dependencies: [] as string[],
      steps: [
        { name: "Step 0", status: "done" as const },
        // Last step reopened by reopenLastStepForRevision — this is the step
        // the merge gate blocks on until the executor re-runs.
        { name: "Documentation & Delivery", status: "pending" as const },
      ],
      currentStep: 1,
      log: [] as any[],
      worktree: "/tmp/test/worktree",
      executionStartedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockImplementation(async () => mutableTask);

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    const outcome = await (executor as unknown as {
      performWorkflowRerunBounce: (
        taskId: string,
        worktreePath: string,
        preserveResumeState?: boolean,
      ) => Promise<string>;
    }).performWorkflowRerunBounce("FN-7122", mutableTask.worktree, true);

    // The bounce succeeds instead of throwing "cannot bounce to in-progress".
    expect(outcome).toBe("bounced");
    // in-review → todo (preserving step progress + worktree) → in-progress, so
    // the reopened step is re-executed rather than left stranded.
    expect(store.moveTask).toHaveBeenCalledWith("FN-7122", "todo", {
      preserveResumeState: true,
      preserveWorktree: true,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-7122", "in-progress");
    expect(onError).not.toHaveBeenCalled();
  });

});

describe("Real-time steering injection", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  function makeSteeringTask(steeringComments: Array<{ id: string; text: string; createdAt: string; author: "user" | "agent" }> = []) {
    return {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function setLegacyActiveSession(executor: TaskExecutor, steerFn: ReturnType<typeof vi.fn>, seenSteeringIds = new Set<string>()) {
    const session = { steer: steerFn, dispose: vi.fn() };
    const state = { session, seenSteeringIds };
    (executor as any).activeSessions.set("FN-001", state);
    return { session, state };
  }

  it("initializes seenSteeringIds with existing comments at session start", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");
    const existingComment = {
      id: "1234567890-abc123",
      text: "Existing comment",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };
    setLegacyActiveSession(executor, steerFn, new Set([existingComment.id]));

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([existingComment]));

    expect(steerFn).not.toHaveBeenCalled();
  });

  it("injects new steering comments via session.steer() on task:updated", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");
    setLegacyActiveSession(executor, steerFn);
    const newComment = {
      id: "9876543210-def456",
      text: "Please use a different approach",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([newComment]));

    expect(steerFn).toHaveBeenCalledOnce();
    expect(steerFn.mock.calls[0][0]).toContain("📣 **New feedback**");
    expect(steerFn.mock.calls[0][0]).toContain("Please use a different approach");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Comment received mid-execution"),
      "by user"
    );
  });

  it("injects new steering comments via active StepSessionExecutor on task:updated", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const seenIds = new Set<string>();
    const updateSteeringComments = vi.fn();
    const steerActiveSessions = vi.fn().mockImplementation(async () => {
      expect(updateSteeringComments).toHaveBeenCalledWith([newComment]);
      expect(seenIds.has(newComment.id)).toBe(true);
      return 1;
    });
    const markSteeringCommentsDelivered = vi.fn();
    const newComment = {
      id: "step-session-comment",
      text: "Please adjust the active step",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };

    (executor as any).activeStepExecutors.set("FN-001", {
      steerActiveSessions,
      markSteeringCommentsDelivered,
      updateSteeringComments,
    });
    (executor as any).activeStepExecutorSeenSteeringIds.set("FN-001", seenIds);

    await (store as any)._triggerAsync("task:updated", {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [newComment],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(updateSteeringComments).toHaveBeenCalledOnce();
    expect(steerActiveSessions).toHaveBeenCalledOnce();
    expect(steerActiveSessions.mock.calls[0][0]).toContain("📣 **New feedback**");
    expect(steerActiveSessions.mock.calls[0][0]).toContain("Please adjust the active step");
    expect(markSteeringCommentsDelivered).toHaveBeenCalledWith([newComment.id]);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Comment received mid-execution"),
      "by user",
    );
  });

  it("queues step-session steering comments for the next prompt when no step session is active", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const newComment = {
      id: "step-session-queued-comment",
      text: "Please apply this in the next step prompt",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };
    const { StepSessionExecutor: ActualStepSessionExecutor } = await vi.importActual<typeof import("../execution/step-session-executor.js")>("../execution/step-session-executor.js");
    const stepExecutor = new ActualStepSessionExecutor({
      taskDetail: makeSteeringTask() as any,
      worktreePath: "/tmp/test",
      rootDir: "/tmp",
      settings: {} as any,
    });
    const markSteeringCommentsDelivered = vi.spyOn(stepExecutor, "markSteeringCommentsDelivered");

    (executor as any).activeStepExecutors.set("FN-001", stepExecutor);
    (executor as any).activeStepExecutorSeenSteeringIds.set("FN-001", new Set());

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([newComment]));

    expect(markSteeringCommentsDelivered).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Comment received mid-execution"),
      "by user",
    );

    const nextPromptTask = (stepExecutor as any).consumeTaskDetailForStepPrompt();
    expect(nextPromptTask.steeringComments).toEqual([newComment]);
    const laterPromptTask = (stepExecutor as any).consumeTaskDetailForStepPrompt();
    expect(laterPromptTask.steeringComments).toBeUndefined();
  });

  it("injects new steering comments via active workflow step session on task:updated", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const steer = vi.fn().mockResolvedValue(undefined);
    const newComment = {
      id: "workflow-step-comment",
      text: "Please adjust the workflow step",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };

    (executor as any).activeWorkflowStepSessions.set("FN-001", { steer });
    (executor as any).activeWorkflowStepSessionSeenSteeringIds.set("FN-001", new Set());

    await (store as any)._triggerAsync("task:updated", {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [newComment],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(steer).toHaveBeenCalledOnce();
    expect(steer.mock.calls[0][0]).toContain("📣 **New feedback**");
    expect(steer.mock.calls[0][0]).toContain("Please adjust the workflow step");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Comment received mid-execution"),
      "by user",
    );
  });

  it("marks new comments seen before injecting and logs once across simultaneous surfaces", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const newComment = {
      id: "shared-surface-comment",
      text: "Please reach every live surface once",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };
    const legacySeen = new Set<string>();
    const stepSeen = new Set<string>();
    const workflowSeen = new Set<string>();
    const legacySteer = vi.fn().mockImplementation(async () => {
      expect(legacySeen.has(newComment.id)).toBe(true);
    });
    const stepSteerActiveSessions = vi.fn().mockImplementation(async () => {
      expect(stepSeen.has(newComment.id)).toBe(true);
      return 1;
    });
    const workflowSteer = vi.fn().mockImplementation(async () => {
      expect(workflowSeen.has(newComment.id)).toBe(true);
    });
    const markSteeringCommentsDelivered = vi.fn();

    setLegacyActiveSession(executor, legacySteer, legacySeen);
    (executor as any).activeStepExecutors.set("FN-001", { steerActiveSessions: stepSteerActiveSessions, markSteeringCommentsDelivered });
    (executor as any).activeStepExecutorSeenSteeringIds.set("FN-001", stepSeen);
    (executor as any).activeWorkflowStepSessions.set("FN-001", { steer: workflowSteer });
    (executor as any).activeWorkflowStepSessionSeenSteeringIds.set("FN-001", workflowSeen);

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([newComment]));
    await (store as any)._triggerAsync("task:updated", makeSteeringTask([newComment]));

    expect(legacySteer).toHaveBeenCalledOnce();
    expect(stepSteerActiveSessions).toHaveBeenCalledOnce();
    expect(workflowSteer).toHaveBeenCalledOnce();
    expect(markSteeringCommentsDelivered).toHaveBeenCalledOnce();
    expect(markSteeringCommentsDelivered).toHaveBeenCalledWith([newComment.id]);
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Comment received mid-execution"),
      "by user",
    );
  });

  it("does not re-inject an already seen active StepSessionExecutor steering comment", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const steerActiveSessions = vi.fn().mockResolvedValue(undefined);
    const comment = {
      id: "step-session-seen-comment",
      text: "Already delivered",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };

    (executor as any).activeStepExecutors.set("FN-001", { steerActiveSessions });
    (executor as any).activeStepExecutorSeenSteeringIds.set("FN-001", new Set([comment.id]));

    await (store as any)._triggerAsync("task:updated", {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [comment],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(steerActiveSessions).not.toHaveBeenCalled();
  });

  it("does not re-inject already seen steering comments", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");
    const comment = {
      id: "1111111111-aaa111",
      text: "Original comment",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };
    setLegacyActiveSession(executor, steerFn, new Set([comment.id]));

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([comment]));

    expect(steerFn).not.toHaveBeenCalled();
  });

  it("marks comment as seen even if steer() throws", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockRejectedValue(new Error("Session disconnected"));
    const executor = new TaskExecutor(store, "/tmp/test");
    const comment = {
      id: "2222222222-bbb222",
      text: "Comment that fails",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };
    setLegacyActiveSession(executor, steerFn);

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([comment]));
    await (store as any)._triggerAsync("task:updated", makeSteeringTask([comment]));

    expect(steerFn).toHaveBeenCalledTimes(1);
  });

  it("does not inject or log when active surfaces receive empty or undefined steering comments", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const legacySteer = vi.fn().mockResolvedValue(undefined);
    const stepSteerActiveSessions = vi.fn().mockResolvedValue(1);
    const workflowSteer = vi.fn().mockResolvedValue(undefined);

    setLegacyActiveSession(executor, legacySteer);
    (executor as any).activeStepExecutors.set("FN-001", {
      steerActiveSessions: stepSteerActiveSessions,
      updateSteeringComments: vi.fn(),
    });
    (executor as any).activeStepExecutorSeenSteeringIds.set("FN-001", new Set());
    (executor as any).activeWorkflowStepSessions.set("FN-001", { steer: workflowSteer });
    (executor as any).activeWorkflowStepSessionSeenSteeringIds.set("FN-001", new Set());

    await (store as any)._triggerAsync("task:updated", { ...makeSteeringTask(), steeringComments: undefined });
    await (store as any)._triggerAsync("task:updated", makeSteeringTask([]));

    expect(legacySteer).not.toHaveBeenCalled();
    expect(stepSteerActiveSessions).not.toHaveBeenCalled();
    expect(workflowSteer).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Comment received mid-execution"),
      expect.anything(),
    );
  });

  it("does not inject steering comments for tasks without an active injection target", async () => {
    const store = createMockStore();
    new TaskExecutor(store, "/tmp/test");

    await (store as any)._triggerAsync("task:updated", {
      ...makeSteeringTask([{
        id: "3333333333-ccc333",
        text: "Should not be injected",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      }]),
      id: "FN-NOT-EXECUTING",
    });

    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-NOT-EXECUTING",
      expect.stringContaining("Comment received mid-execution"),
      expect.anything(),
    );
  });

  it("handles multiple new steering comments in a single task:updated", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");
    setLegacyActiveSession(executor, steerFn, new Set(["existing-comment"]));

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([
      {
        id: "existing-comment",
        text: "Original",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      },
      {
        id: "new-comment-1",
        text: "First new comment",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      },
      {
        id: "new-comment-2",
        text: "Second new comment",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      },
    ]));

    expect(steerFn).toHaveBeenCalledTimes(2);
  });

  it("keeps agent-authored steering on the legacy review-handoff path", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reviewHandoffPolicy: "comment-triggered" } as any);
    const steerFn = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");
    const { session, state } = setLegacyActiveSession(executor, steerFn);
    const executeReviewHandoff = vi.fn().mockResolvedValue(undefined);
    (executor as any).executeReviewHandoff = executeReviewHandoff;
    const agentComment = {
      id: "agent-handoff-comment",
      text: "Implementation is ready; requesting user review now.",
      createdAt: new Date().toISOString(),
      author: "agent" as const,
    };

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([agentComment]));

    expect(steerFn).toHaveBeenCalledOnce();
    expect(executeReviewHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-001" }),
      session,
      state,
    );
  });
});

// ── Loop recovery (compact-and-resume) integration tests ────────────

describe("TaskExecutor loop recovery", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  function createMockSessionForLoopRecovery(overrides?: { compactResult?: any }) {
    const defaultResult = {
      summary: "Compacted conversation",
      tokensBefore: 150000,
    };
    const compactRetVal = overrides && "compactResult" in overrides ? overrides.compactResult : defaultResult;
    const compact = vi.fn(async () => compactRetVal);
    const steer = vi.fn(async () => {});
    const abort = vi.fn(async () => {});

    return {
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
      abort,
      subscribe: vi.fn(),
      setThinkingLevel: vi.fn(),
      steer,
      compact,
      sessionFile: "/tmp/test-session.json",
      model: { provider: "mock", id: "mock-model", name: "Mock" },
      sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
      state: {},
    };
  }

  function setupExecutorWithActiveSession(mockSession: ReturnType<typeof createMockSessionForLoopRecovery>) {
    const store = createMockStore();
    (store.getSettings as any).mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    const executor = new TaskExecutor(store, "/tmp/test-root");

    // Directly inject an active session (avoids full execute() chain)
    (executor as any).activeSessions.set("FN-001", {
      session: mockSession,
      seenSteeringIds: new Set(),
    });

    return { store, executor, mockSession };
  }

  it("handleLoopDetected returns true and compacts session when active session exists", async () => {
    const mockSession = createMockSessionForLoopRecovery();
    const { store, executor } = setupExecutorWithActiveSession(mockSession);

    const result = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      ignoredStepUpdateCount: 0,
      shouldRequeue: true,
    });

    expect(result).toBe(true);
    expect(mockSession.compact).toHaveBeenCalled();
    expect(mockSession.steer).toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("compact-and-resume"),
    );
  });

  it("handleLoopDetected returns false when no active session", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test-root");

    // No session active (activeSessions is empty)
    const result = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      ignoredStepUpdateCount: 0,
      shouldRequeue: true,
    });

    expect(result).toBe(false);
  });

  it("handleLoopDetected returns false when attempt ceiling reached", async () => {
    const mockSession = createMockSessionForLoopRecovery();
    const { executor } = setupExecutorWithActiveSession(mockSession);

    // First call succeeds
    const result1 = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      ignoredStepUpdateCount: 0,
      shouldRequeue: true,
    });
    expect(result1).toBe(true);

    // Second call hits ceiling (max 1 attempt per execute() lifecycle)
    const result2 = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 200,
      ignoredStepUpdateCount: 0,
      shouldRequeue: true,
    });
    expect(result2).toBe(false);
  });

  it("handleLoopDetected returns false when compaction fails", async () => {
    const mockSession = createMockSessionForLoopRecovery({ compactResult: null });
    const { executor } = setupExecutorWithActiveSession(mockSession);

    const result = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      ignoredStepUpdateCount: 0,
      shouldRequeue: true,
    });

    expect(result).toBe(false);
  });

  it("handleLoopDetected returns false when compaction hangs", async () => {
    vi.useFakeTimers();
    const mockSession = createMockSessionForLoopRecovery({ compactResult: new Promise(() => {}) });
    const { store, executor } = setupExecutorWithActiveSession(mockSession);

    const resultPromise = executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      ignoredStepUpdateCount: 0,
      shouldRequeue: true,
    });

    await vi.advanceTimersByTimeAsync(60000);

    await expect(resultPromise).resolves.toBe(false);
    expect(mockSession.abort).toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Context compaction timed out"),
    );

    vi.useRealTimers();
  });
});

// ── Context limit error recovery tests ────────────────────────────────

// ── U2 RETHINK delegation characterization (plan 2026-06-04-001, KTD-2) ──
//
// The legacy in-session fn_review_step RETHINK case now DELEGATES to
// step-runner.ts's resetStepToBaseline. These tests pin that the observable
// side effects are byte-identical to the pre-extraction block: git reset to
// the agent-supplied baseline, session rewind via navigateTree, step→pending,
// and the RETHINK log entry — all reached through the real executor session.