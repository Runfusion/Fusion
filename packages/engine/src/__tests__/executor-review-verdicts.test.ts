// -nocheck
/* eslint-disable -eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./executor-test-helpers.js";
import { AgentSemaphore } from "../concurrency.js";
import { detectReviewHandoffIntent, determineRevisionResetStart } from "../executor.js";
import { TaskExecutor, buildExecutionPrompt } from "../executor.js";
import { createFnAgent } from "../pi.js";
import { reviewStep as mockedReviewStepFn } from "../reviewer.js";
import { execSync } from "node:child_process";
import { findWorktreeUser, aiMergeTask } from "../merger.js";
import { WorktreePool } from "../worktree-pool.js";
import { generateWorktreeName, slugify } from "../worktree-names.js";
import type { Task, TaskDetail } from "@fusion/core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { StepSessionExecutor } from "../step-session-executor.js";
import { executorLog } from "../logger.js";
import { withRateLimitRetry } from "../rate-limit-retry.js";
import { runVerificationCommand as mockedRunVerificationCommand } from "../verification-utils.js";
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
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

describe("TaskExecutor enginePaused soft pause (no agent termination)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("does NOT dispose active sessions when enginePaused transitions false→true", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            store._trigger("settings:updated", {
              settings: { enginePaused: true },
              previous: { enginePaused: false },
            });
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: disposeFn,
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // dispose called once during normal completion,
    // NOT by an engine pause listener
    expect(disposeFn).toHaveBeenCalledTimes(1);
    // Task should complete normally and move to in-review, not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
  });

  it("keeps fn_task_done on the normal completion path when enginePaused becomes true", async () => {
    const store = createMockStore();
    const mutableSettings = {
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
    };
    let capturedCustomTools: any[] = [];
    let taskDoneResult: any;

    store.getSettings.mockImplementation(async () => ({ ...mutableSettings }));

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            mutableSettings.enginePaused = true;
            store._trigger("settings:updated", {
              settings: { enginePaused: true },
              previous: { enginePaused: false },
            });
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              taskDoneResult = await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    const watchdogSpy = vi.spyOn(executor as any, "scheduleCompletedTaskWatchdog");

    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    expect(taskDoneResult.content[0].text).toBe(
      "Task marked complete with summary. All steps done. Moving to in-review.",
    );
    expect(watchdogSpy).toHaveBeenCalledWith("FN-001", "fn_task_done");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({ paused: false, status: null }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("does NOT move tasks to todo when enginePaused transitions false→true", async () => {
    const store = createMockStore();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            store._trigger("settings:updated", {
              settings: { enginePaused: true },
              previous: { enginePaused: false },
            });
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: vi.fn(),
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Task should complete normally (in-review), not be moved to todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
  });

  it("takes no action when enginePaused stays false (false→false)", async () => {
    const store = createMockStore();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            store._trigger("settings:updated", {
              settings: { enginePaused: false },
              previous: { enginePaused: false },
            });
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: vi.fn(),
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
  });

  it("takes no action when enginePaused stays true (true→true)", async () => {
    const store = createMockStore();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            store._trigger("settings:updated", {
              settings: { enginePaused: true },
              previous: { enginePaused: true },
            });
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: vi.fn(),
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
  });
});

// ── Code review verdict enforcement tests ────────────────────────────

/**
 * Helper: executes a task and captures the custom tools passed to createFnAgent.
 * Returns a map of tool name → tool execute function for direct testing.
 */
async function captureTools(settingsOverride?: Record<string, unknown>): Promise<Record<string, (id: string, params: any) => Promise<any>>> {
  const store = createMockStore();
  if (settingsOverride) {
    store.getSettings.mockResolvedValue({ ...(await store.getSettings()), ...settingsOverride });
  }
  // Simulate the real TaskStore: forward transitions persist, but in-progress
  // regressions on done/skipped steps are rejected so executor.ts can surface
  // the "already <status>" diagnostic.
  const stepStates: Array<{ name: string; status: string }> = [
    { name: "Preflight", status: "done" },
    { name: "Implement", status: "in-progress" },
    { name: "Testing", status: "pending" },
    { name: "Docs", status: "pending" },
  ];
  store.updateStep.mockImplementation(async (_taskId: string, stepIndex: number, status: string) => {
    const current = stepStates[stepIndex];
    const isRegression = status === "in-progress" && (current.status === "done" || current.status === "skipped");
    if (!isRegression) {
      current.status = status;
    }
    return { steps: stepStates.map((s) => ({ ...s })) };
  });
  mockedExistsSync.mockReturnValue(true);

  let capturedTools: any[] = [];
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    capturedTools = opts.customTools || [];
    return {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf-id"),
          branchWithSummary: vi.fn(),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
    } as any;
  });

  const executor = new TaskExecutor(store, "/tmp/test");
  await executor.execute({
    id: "FN-TEST",
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

  const tools: Record<string, any> = {};
  for (const t of capturedTools) {
    tools[t.name] = t.execute;
  }
  return tools;
}

describe("Code review verdict tracking", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("code review REVISE sets tracking state", async () => {
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Fix the bug",
      summary: "Needs fixes",
    });

    const tools = await captureTools();
    const result = await tools.fn_review_step("call1", {
      step: 0,
      type: "code",
      step_name: "Implement",
      baseline: "abc123",
    });

    expect(result.content[0].text).toContain("REVISE");
    expect(result.content[0].text).toContain("cannot be marked done");

    // Now fn_task_update(step=1, status="done") should be blocked
    const updateResult = await tools.fn_task_update("call2", { step: 1, status: "done" });
    expect(updateResult.content[0].text).toContain("Cannot mark Step 1 as done");
    expect(updateResult.content[0].text).toContain("REVISE");
  });

  it("code review APPROVE clears tracking state", async () => {
    // First: REVISE
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Fix the bug",
      summary: "Needs fixes",
    });

    const tools = await captureTools();
    await tools.fn_review_step("call1", {
      step: 0,
      type: "code",
      step_name: "Implement",
      baseline: "abc123",
    });

    // Verify it's blocked
    const blocked = await tools.fn_task_update("call2", { step: 1, status: "done" });
    expect(blocked.content[0].text).toContain("Cannot mark Step 1 as done");

    // Now: APPROVE
    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE",
      review: "Looks good",
      summary: "All good",
    });

    await tools.fn_review_step("call3", {
      step: 0,
      type: "code",
      step_name: "Implement",
      baseline: "def456",
    });

    // Now fn_task_update should succeed
    const updateResult = await tools.fn_task_update("call4", { step: 1, status: "done" });
    expect(updateResult.content[0].text).toContain("→ done");
  });

  it("plan review REVISE does NOT set tracking state", async () => {
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Reconsider approach",
      summary: "Plan issues",
    });

    const tools = await captureTools();
    const result = await tools.fn_review_step("call1", {
      step: 0,
      type: "plan",
      step_name: "Implement",
    });

    // Plan REVISE should use the non-enforced text format
    expect(result.content[0].text).toContain("REVISE");
    expect(result.content[0].text).not.toContain("cannot be marked done");

    // fn_task_update should still work (plan reviews are advisory)
    const updateResult = await tools.fn_task_update("call2", { step: 1, status: "done" });
    expect(updateResult.content[0].text).toContain("→ done");
  });
});

describe("Code review verdict enforcement - fn_task_update blocking", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("fn_task_update(status='done') is rejected when last code review was REVISE", async () => {
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Fix issues",
      summary: "Needs work",
    });

    const tools = await captureTools();
    await tools.fn_review_step("call1", {
      step: 0,
      type: "code",
      step_name: "Implement",
      baseline: "abc",
    });

    const result = await tools.fn_task_update("call2", { step: 1, status: "done" });
    expect(result.content[0].text).toContain("Cannot mark Step 1 as done");
    expect(result.content[0].text).toContain("fn_review_step");
  });

  it("fn_task_update succeeds after a subsequent APPROVE", async () => {
    const tools = await captureTools();

    // REVISE first
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Fix", summary: "Bad" });
    await tools.fn_review_step("c1", { step: 0, type: "code", step_name: "Impl", baseline: "a" });

    // Then APPROVE
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "OK", summary: "Good" });
    await tools.fn_review_step("c2", { step: 0, type: "code", step_name: "Impl", baseline: "b" });

    const result = await tools.fn_task_update("c3", { step: 1, status: "done" });
    expect(result.content[0].text).toContain("→ done");
  });

  it("fn_task_update succeeds when no code review was requested (review level 0)", async () => {
    const tools = await captureTools();

    // No fn_review_step calls at all
    const result = await tools.fn_task_update("c1", { step: 1, status: "done" });
    expect(result.content[0].text).toContain("→ done");
  });

  it("plan-only REVISE does NOT block advancement", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Rethink", summary: "Plan issue" });

    const tools = await captureTools();
    await tools.fn_review_step("c1", { step: 0, type: "plan", step_name: "Impl" });

    const result = await tools.fn_task_update("c2", { step: 1, status: "done" });
    expect(result.content[0].text).toContain("→ done");
  });

  it("multiple steps tracked independently (REVISE on step 1 doesn't block step 2)", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Fix", summary: "Bad" });

    const tools = await captureTools();
    await tools.fn_review_step("c1", { step: 0, type: "code", step_name: "Step1", baseline: "a" });

    // Step 1 is blocked
    const blocked = await tools.fn_task_update("c2", { step: 1, status: "done" });
    expect(blocked.content[0].text).toContain("Cannot mark Step 1 as done");

    // Step 2 is NOT blocked (no review for step 2)
    const allowed = await tools.fn_task_update("c3", { step: 2, status: "done" });
    expect(allowed.content[0].text).toContain("→ done");
  });

  it("registers research runtime tools in customTools when researchView experimental flag is enabled", async () => {
    const tools = await captureTools({ experimentalFeatures: { researchView: true } });
    expect(tools.fn_research_run).toBeTypeOf("function");
    expect(tools.fn_research_list).toBeTypeOf("function");
    expect(tools.fn_research_get).toBeTypeOf("function");
    expect(tools.fn_research_cancel).toBeTypeOf("function");
  });

  it("does not register research runtime tools when researchView experimental flag is disabled", async () => {
    const tools = await captureTools({ experimentalFeatures: { researchView: false } });
    expect(tools.fn_research_run).toBeUndefined();
    expect(tools.fn_research_list).toBeUndefined();
    expect(tools.fn_research_get).toBeUndefined();
    expect(tools.fn_research_cancel).toBeUndefined();
  });

  it("REVISE tool response text includes re-review instructions", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Bug found", summary: "Issues" });

    const tools = await captureTools();
    const result = await tools.fn_review_step("c1", { step: 0, type: "code", step_name: "Implement", baseline: "abc" });

    expect(result.content[0].text).toContain("cannot be marked done");
    expect(result.content[0].text).toContain("fn_review_step");
    expect(result.content[0].text).toContain('type="code"');
  });

  it("omits research prompt guidance when researchView experimental flag is disabled", async () => {
    let capturedSystemPrompt = "";
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt || "";
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn(), branchWithSummary: vi.fn() },
          navigateTree: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore();
    store.getSettings.mockResolvedValue({ ...(await store.getSettings()), experimentalFeatures: { researchView: false } });
    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-SYS-NO-RESEARCH",
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

    expect(capturedSystemPrompt).not.toContain("fn_research_run");
  });

  it("includes research prompt guidance when researchView experimental flag is enabled", async () => {
    let capturedSystemPrompt = "";
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt || "";
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn(), branchWithSummary: vi.fn() },
          navigateTree: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore();
    store.getSettings.mockResolvedValue({ ...(await store.getSettings()), experimentalFeatures: { researchView: true } });
    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-SYS-RESEARCH",
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

    expect(capturedSystemPrompt).toContain("fn_research_run");
  });

  it("EXECUTOR_SYSTEM_PROMPT contains code review enforcement language", async () => {
    // Capture the system prompt passed to createFnAgent
    let capturedSystemPrompt = "";
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt || "";
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn(), branchWithSummary: vi.fn() },
          navigateTree: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-SYS",
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

    // Verify enforcement language is present in system prompt
    expect(capturedSystemPrompt).toContain("enforced");
    expect(capturedSystemPrompt).toContain("will be rejected until the code review passes");
    expect(capturedSystemPrompt).toContain("REVISE (plan review)");
    expect(capturedSystemPrompt).toContain("advisory");
  });

  // Note: The EXECUTOR_SYSTEM_PROMPT constant is tested indirectly via the buildExecutionPrompt test.
  // The direct test for EXECUTOR_SYSTEM_PROMPT is skipped because of module caching issues in vitest.
  // The buildExecutionPrompt test verifies the CRITICAL language is included in execution prompts.

  it("fn_task_update with non-done status is not blocked by REVISE", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Fix", summary: "Bad" });

    const tools = await captureTools();
    // Target step 3 (Testing, currently pending) so the in-progress transition is
    // a valid forward move — the assertion below only verifies that a REVISE on
    // the same step does not produce the "Cannot mark … as done" block.
    await tools.fn_review_step("c1", { step: 2, type: "code", step_name: "Testing", baseline: "a" });

    const result = await tools.fn_task_update("c2", { step: 3, status: "in-progress" });
    expect(result.content[0].text).not.toContain("Cannot mark");
    expect(result.content[0].text).toContain("→ in-progress");
  });
});

// ── RETHINK verdict handling tests ───────────────────────────────────

describe("RETHINK verdict handling", () => {
  const makeTask = (id = "FN-040") => ({
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

  /** Return value for store.updateStep that satisfies the fn_task_update tool. */
  function makeStepResult(stepIndex: number, status: string) {
    const steps = Array.from({ length: Math.max(stepIndex + 1, 3) }, (_, i) => ({
      name: `Step ${i}`,
      status: i === stepIndex ? status : "pending",
    }));
    return { steps };
  }

  /**
   * Helper: run executor and capture custom tools from createFnAgent mock.
   * Returns the tools map keyed by tool name.
   */
  async function captureRethinkTools(store: any, options?: any) {
    let capturedTools: any[] = [];
    const mockSessionManager = {
      getLeafId: vi.fn().mockReturnValue("leaf-checkpoint-123"),
      branchWithSummary: vi.fn().mockReturnValue("new-branch-id"),
    };
    const mockNavigateTree = vi.fn().mockResolvedValue({ cancelled: false });
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      sessionManager: mockSessionManager,
      navigateTree: mockNavigateTree,
    };

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return { session: mockSession } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test", options);
    await executor.execute(makeTask());

    const toolMap = new Map<string, any>();
    for (const tool of capturedTools) {
      toolMap.set(tool.name, tool);
    }
    return { toolMap, mockSession, mockSessionManager, mockNavigateTree };
  }

  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("RETHINK verdict triggers git reset --hard to baseline SHA", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong approach, try something else",
      summary: "Rejected approach",
    });

    const { toolMap } = await captureRethinkTools(store);
    const reviewTool = toolMap.get("fn_review_step");

    // First call fn_task_update to set in-progress (captures checkpoint)
    const updateTool = toolMap.get("fn_task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    // Now call fn_review_step with a baseline
    const result = await reviewTool.execute("call-2", {
      step: 0,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123def",
    });

    // Verify git reset was called
    expect(mockedExecSync).toHaveBeenCalledWith(
      "git reset --hard abc123def",
      expect.objectContaining({ cwd: expect.stringContaining(".worktrees/") }),
    );
  });

  it("RETHINK verdict rewinds session to pre-step checkpoint", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Fundamentally wrong",
      summary: "Bad approach",
    });

    const { toolMap, mockNavigateTree } = await captureRethinkTools(store);

    // Capture checkpoint
    const updateTool = toolMap.get("fn_task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    // Trigger RETHINK
    await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    // Verify navigateTree was called with checkpoint and summarize: false
    expect(mockNavigateTree).toHaveBeenCalledWith("leaf-checkpoint-123", { summarize: false });
  });

  it("RETHINK verdict resets step status to pending", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Try again",
      summary: "Rejected",
    });

    const { toolMap } = await captureRethinkTools(store);

    const updateTool = toolMap.get("fn_task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    // updateStep should be called: once for in-progress, once for pending (reset)
    expect(store.updateStep).toHaveBeenCalledWith("FN-040", 0, "pending");
  });

  it("RETHINK re-prompt includes reviewer feedback", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Your approach uses polling when it should use events",
      summary: "Wrong architecture",
    });

    const { toolMap } = await captureRethinkTools(store);

    const updateTool = toolMap.get("fn_task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    const result = await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    const text = result.content[0].text;
    expect(text).toContain("RETHINK");
    expect(text).toContain("Your approach uses polling when it should use events");
    expect(text).toContain("Take a different approach");
    expect(text).toContain("Do NOT repeat the rejected strategy");
  });

  it("RETHINK without baseline SHA skips git reset but still rewinds conversation", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong approach",
      summary: "Rejected",
    });

    const { toolMap, mockNavigateTree } = await captureRethinkTools(store);

    const updateTool = toolMap.get("fn_task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    // Call fn_review_step WITHOUT baseline
    await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "code",
      step_name: "Test Step",
      // no baseline
    });

    // git reset should NOT be called (no baseline)
    const gitResetCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("git reset --hard"),
    );
    expect(gitResetCalls).toHaveLength(0);

    // But session rewind should still happen
    expect(mockNavigateTree).toHaveBeenCalledWith("leaf-checkpoint-123", { summarize: false });
  });

  it("RETHINK without session checkpoint falls back gracefully", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Bad approach",
      summary: "Rejected",
    });

    const { toolMap, mockNavigateTree } = await captureRethinkTools(store);

    // Do NOT call fn_task_update for step 2, so no checkpoint exists

    // Call fn_review_step for step 2 — should not crash
    const result = await toolMap.get("fn_review_step").execute("call-2", {
      step: 1,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    // navigateTree should NOT be called (no checkpoint)
    expect(mockNavigateTree).not.toHaveBeenCalled();

    // Should still return RETHINK feedback
    expect(result.content[0].text).toContain("RETHINK");
  });

  it("pre-step checkpoint is captured when fn_task_update sets status to in-progress", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { toolMap, mockSessionManager } = await captureRethinkTools(store);

    const updateTool = toolMap.get("fn_task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    // Verify getLeafId was called
    expect(mockSessionManager.getLeafId).toHaveBeenCalled();
  });

  it("uses step-1 checkpoint key when step 3 enters in-progress and step index 2 is reviewed", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );
    mockedReviewStep.mockResolvedValue({ verdict: "RETHINK", review: "Bad", summary: "Redo" });

    const { toolMap, mockNavigateTree } = await captureRethinkTools(store);
    await toolMap.get("fn_task_update").execute("call-1", { step: 3, status: "in-progress" });

    await toolMap.get("fn_review_step").execute("call-2", {
      step: 2,
      type: "code",
      step_name: "Testing",
      baseline: "abc123",
    });

    expect(mockNavigateTree).toHaveBeenCalled();
  });

  it("RETHINK falls back to branchWithSummary when navigateTree fails", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong approach",
      summary: "Rejected",
    });

    // Create tools but make navigateTree throw
    let capturedTools: any[] = [];
    const mockSessionManager = {
      getLeafId: vi.fn().mockReturnValue("leaf-checkpoint-456"),
      branchWithSummary: vi.fn().mockReturnValue("new-branch-id"),
    };
    const mockNavigateTree = vi.fn().mockRejectedValue(new Error("navigateTree not available"));
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      sessionManager: mockSessionManager,
      navigateTree: mockNavigateTree,
    };

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return { session: mockSession } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    const toolMap = new Map<string, any>();
    for (const tool of capturedTools) toolMap.set(tool.name, tool);

    // Capture checkpoint
    await toolMap.get("fn_task_update").execute("call-1", { step: 1, status: "in-progress" });

    // Trigger RETHINK
    await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    // navigateTree was called but failed → should fall back to branchWithSummary
    expect(mockNavigateTree).toHaveBeenCalled();
    expect(mockSessionManager.branchWithSummary).toHaveBeenCalledWith(
      "leaf-checkpoint-456",
      expect.stringContaining("RETHINK"),
    );
  });
});

// ── Plan RETHINK verdict handling tests ──────────────────────────────

describe("Plan RETHINK verdict handling", () => {
  const makeTask = (id = "FN-050") => ({
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

  function makeStepResult(stepIndex: number, status: string) {
    const steps = Array.from({ length: Math.max(stepIndex + 1, 3) }, (_, i) => ({
      name: `Step ${i}`,
      status: i === stepIndex ? status : "pending",
    }));
    return { steps };
  }

  async function capturePlanRethinkTools(store: any) {
    let capturedTools: any[] = [];
    const mockSessionManager = {
      getLeafId: vi.fn().mockReturnValue("plan-checkpoint-789"),
      branchWithSummary: vi.fn().mockReturnValue("new-branch-id"),
    };
    const mockNavigateTree = vi.fn().mockResolvedValue({ cancelled: false });
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      sessionManager: mockSessionManager,
      navigateTree: mockNavigateTree,
    };

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return { session: mockSession } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    const toolMap = new Map<string, any>();
    for (const tool of capturedTools) {
      toolMap.set(tool.name, tool);
    }
    return { toolMap, mockSession, mockSessionManager, mockNavigateTree };
  }

  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("plan RETHINK verdict rewinds session to pre-step checkpoint", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Plan is fundamentally flawed",
      summary: "Bad plan",
    });

    const { toolMap, mockNavigateTree } = await capturePlanRethinkTools(store);

    // Capture checkpoint by starting step
    await toolMap.get("fn_task_update").execute("call-1", { step: 1, status: "in-progress" });

    // Trigger plan RETHINK
    await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "plan",
      step_name: "Test Step",
    });

    // Session should be rewound to checkpoint
    expect(mockNavigateTree).toHaveBeenCalledWith("plan-checkpoint-789", { summarize: false });
  });

  it("plan RETHINK verdict does NOT trigger git reset", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong plan",
      summary: "Rejected",
    });

    const { toolMap } = await capturePlanRethinkTools(store);

    await toolMap.get("fn_task_update").execute("call-1", { step: 1, status: "in-progress" });

    // Even if baseline is passed, plan RETHINK should NOT git reset
    await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "plan",
      step_name: "Test Step",
      baseline: "some-sha-that-should-be-ignored",
    });

    // git reset should NOT be called for plan reviews
    const gitResetCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("git reset --hard"),
    );
    expect(gitResetCalls).toHaveLength(0);
  });

  it("plan RETHINK verdict resets step status to pending", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Try another plan",
      summary: "Rejected plan",
    });

    const { toolMap } = await capturePlanRethinkTools(store);

    await toolMap.get("fn_task_update").execute("call-1", { step: 1, status: "in-progress" });

    await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "plan",
      step_name: "Test Step",
    });

    // updateStep should be called with "pending" to reset the step
    expect(store.updateStep).toHaveBeenCalledWith("FN-050", 0, "pending");
  });

  it("plan RETHINK re-prompt includes reviewer feedback and plan-specific language", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "This plan overlooks critical edge cases in error handling",
      summary: "Insufficient plan",
    });

    const { toolMap } = await capturePlanRethinkTools(store);

    await toolMap.get("fn_task_update").execute("call-1", { step: 1, status: "in-progress" });

    const result = await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "plan",
      step_name: "Test Step",
    });

    const text = result.content[0].text;
    expect(text).toContain("RETHINK");
    expect(text).toContain("Your plan was rejected");
    expect(text).toContain("This plan overlooks critical edge cases in error handling");
    expect(text).toContain("Take a different approach to planning this step");
    expect(text).toContain("Do NOT repeat the rejected strategy");
  });

  it("plan RETHINK without session checkpoint falls back gracefully", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Bad plan",
      summary: "Rejected",
    });

    const { toolMap, mockNavigateTree } = await capturePlanRethinkTools(store);

    // Do NOT call fn_task_update for step 2, so no checkpoint exists

    // Call fn_review_step for step 2 — should not crash
    const result = await toolMap.get("fn_review_step").execute("call-2", {
      step: 1,
      type: "plan",
      step_name: "Test Step",
    });

    // navigateTree should NOT be called (no checkpoint)
    expect(mockNavigateTree).not.toHaveBeenCalled();

    // Should still return RETHINK feedback with plan-specific text
    expect(result.content[0].text).toContain("RETHINK");
    expect(result.content[0].text).toContain("Your plan was rejected");
  });

  it("plan RETHINK logs correctly without git reset info", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong plan",
      summary: "Plan rejected",
    });

    const { toolMap } = await capturePlanRethinkTools(store);

    await toolMap.get("fn_task_update").execute("call-1", { step: 1, status: "in-progress" });

    await toolMap.get("fn_review_step").execute("call-2", {
      step: 0,
      type: "plan",
      step_name: "Test Step",
    });

    // Verify log entry uses plan-specific message (no git reset reference)
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("plan rewound"),
      "Plan rejected",
    );
  });
});

// ── E2E review pipeline sequence tests ─────────────────────────────

describe("E2E review pipeline — multi-verdict sequence", () => {
  /**
   * Exercises the full review pipeline within a single task execution:
   *   plan review → APPROVE
   *   code review → REVISE (blocked)
   *   code review → APPROVE (unblocked)
   *   step done → success
   *
   * Verifies that verdicts compose correctly across the full lifecycle.
   */

  function makeStepResult(stepIndex: number, status: string) {
    const steps = Array.from({ length: 3 }, (_, i) => ({
      name: [`Preflight`, `Implement`, `Tests`][i],
      status: i === stepIndex ? status : i < stepIndex ? "done" : "pending",
    }));
    return { steps };
  }

  async function captureE2ETools(store: any) {
    let capturedTools: any[] = [];
    const mockSessionManager = {
      getLeafId: vi.fn().mockReturnValue("e2e-checkpoint"),
      branchWithSummary: vi.fn(),
    };
    const mockNavigateTree = vi.fn().mockResolvedValue({ cancelled: false });
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      sessionManager: mockSessionManager,
      navigateTree: mockNavigateTree,
    };

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return { session: mockSession } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-E2E",
      title: "E2E Test",
      description: "E2E pipeline test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const tools: Record<string, any> = {};
    for (const t of capturedTools) {
      tools[t.name] = t.execute;
    }
    return { tools, mockNavigateTree, mockSessionManager };
  }

  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("warns when fn_task_update marks a second step in-progress", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n### Step 1: Implement\n### Step 2: Verify",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: "pending" },
        { name: "Verify", status: "pending" },
      ],
    });
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) => ({
      steps: [
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: step === 1 ? status : "pending" },
        { name: "Verify", status: "pending" },
      ],
    }));

    const { tools } = await captureE2ETools(store);
    const result = await tools.fn_task_update("u-warn", { step: 2, status: "in-progress" });

    expect(executorLog.warn).toHaveBeenCalledTimes(1);
    expect(executorLog.warn).toHaveBeenCalledWith(
      "FN-E2E: fn_task_update marking step 2 in-progress while step 1 is already in-progress",
    );
    expect(store.updateStep).toHaveBeenCalledWith("FN-E2E", 1, "in-progress");
    expect(result.content[0].text).toContain("Step 2 (Implement) → in-progress");
  });

  it("full sequence: plan APPROVE → code REVISE (blocked) → code APPROVE (unblocked) → done", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { tools } = await captureE2ETools(store);

    // Step 1: Start the step
    await tools.fn_task_update("u1", { step: 1, status: "in-progress" });

    // Step 2: Plan review → APPROVE (advisory, no blocking)
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Good plan", summary: "Approved" });
    const planResult = await tools.fn_review_step("r1", {
      step: 0, type: "plan", step_name: "Implement",
    });
    expect(planResult.content[0].text).toBe("APPROVE");

    // Step 3: Code review → REVISE (should block advancement)
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE", review: "Missing error handling in fetchUser()", summary: "Needs fixes",
    });
    const reviseResult = await tools.fn_review_step("r2", {
      step: 0, type: "code", step_name: "Implement", baseline: "sha-1",
    });
    expect(reviseResult.content[0].text).toContain("cannot be marked done");

    // Step 4: Attempt to mark done — should be blocked
    const blockedResult = await tools.fn_task_update("u2", { step: 1, status: "done" });
    expect(blockedResult.content[0].text).toContain("Cannot mark Step 1 as done");

    // Step 5: Fix issues, re-submit code review → APPROVE
    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE", review: "Error handling added correctly", summary: "All good",
    });
    const approveResult = await tools.fn_review_step("r3", {
      step: 0, type: "code", step_name: "Implement", baseline: "sha-2",
    });
    expect(approveResult.content[0].text).toBe("APPROVE");

    // Step 6: Now marking done should succeed
    const doneResult = await tools.fn_task_update("u3", { step: 1, status: "done" });
    expect(doneResult.content[0].text).toContain("→ done");
  });

  it("full sequence: code RETHINK → git reset + session rewind → retry with APPROVE → done", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { tools, mockNavigateTree } = await captureE2ETools(store);

    // Step 1: Start the step (captures checkpoint)
    await tools.fn_task_update("u1", { step: 1, status: "in-progress" });

    // Step 2: Code review → RETHINK (rewind everything)
    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK", review: "Using polling instead of events is wrong", summary: "Bad approach",
    });
    const rethinkResult = await tools.fn_review_step("r1", {
      step: 0, type: "code", step_name: "Implement", baseline: "sha-bad",
    });

    // Verify RETHINK outcomes
    expect(rethinkResult.content[0].text).toContain("RETHINK");
    expect(rethinkResult.content[0].text).toContain("Do NOT repeat the rejected strategy");
    expect(mockedExecSync).toHaveBeenCalledWith(
      "git reset --hard sha-bad",
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(mockNavigateTree).toHaveBeenCalledWith("e2e-checkpoint", { summarize: false });
    expect(store.updateStep).toHaveBeenCalledWith("FN-E2E", 0, "pending");

    // Step 3: Restart the step (new approach)
    await tools.fn_task_update("u2", { step: 1, status: "in-progress" });

    // Step 4: Code review → APPROVE on second attempt
    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE", review: "Event-driven approach is correct", summary: "Approved",
    });
    const approveResult = await tools.fn_review_step("r2", {
      step: 0, type: "code", step_name: "Implement", baseline: "sha-good",
    });
    expect(approveResult.content[0].text).toBe("APPROVE");

    // Step 5: Mark done — should succeed (no REVISE blocking)
    const doneResult = await tools.fn_task_update("u3", { step: 1, status: "done" });
    expect(doneResult.content[0].text).toContain("→ done");
  });

  it("multi-step pipeline: step 1 APPROVE, step 2 REVISE, step 1 remains unaffected", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { tools } = await captureE2ETools(store);

    // Step 1: Complete with APPROVE
    await tools.fn_task_update("u1", { step: 1, status: "in-progress" });
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "OK", summary: "Good" });
    await tools.fn_review_step("r1", { step: 0, type: "code", step_name: "Implement", baseline: "sha-1" });
    const step1Done = await tools.fn_task_update("u2", { step: 1, status: "done" });
    expect(step1Done.content[0].text).toContain("→ done");

    // Step 2: Gets REVISE
    await tools.fn_task_update("u3", { step: 2, status: "in-progress" });
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Tests insufficient", summary: "Bad" });
    await tools.fn_review_step("r2", { step: 1, type: "code", step_name: "Tests", baseline: "sha-2" });

    // Step 2 blocked
    const step2Blocked = await tools.fn_task_update("u4", { step: 2, status: "done" });
    expect(step2Blocked.content[0].text).toContain("Cannot mark Step 2 as done");

    // Step 1 remains unaffected — if agent tries to re-update step 1, it still works
    // (step isolation: REVISE on step 2 does not affect step 1)
  });

  it("plan RETHINK followed by plan APPROVE allows code phase to proceed", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { tools, mockNavigateTree } = await captureE2ETools(store);

    // Start step
    await tools.fn_task_update("u1", { step: 1, status: "in-progress" });

    // Plan review → RETHINK
    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK", review: "Plan ignores edge cases", summary: "Bad plan",
    });
    const rethinkResult = await tools.fn_review_step("r1", {
      step: 0, type: "plan", step_name: "Implement",
    });
    expect(rethinkResult.content[0].text).toContain("Your plan was rejected");

    // Verify plan RETHINK does NOT trigger git reset
    const gitResetCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("git reset --hard"),
    );
    expect(gitResetCalls).toHaveLength(0);

    // Session was rewound
    expect(mockNavigateTree).toHaveBeenCalled();

    // Restart step with new plan
    await tools.fn_task_update("u2", { step: 1, status: "in-progress" });

    // Plan review → APPROVE
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Good plan", summary: "Approved" });
    await tools.fn_review_step("r2", { step: 0, type: "plan", step_name: "Implement" });

    // Code phase: APPROVE directly
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Clean code", summary: "Good" });
    await tools.fn_review_step("r3", { step: 0, type: "code", step_name: "Implement", baseline: "sha-1" });

    // Mark done — should succeed (plan reviews are advisory, code APPROVE clears the path)
    const doneResult = await tools.fn_task_update("u3", { step: 1, status: "done" });
    expect(doneResult.content[0].text).toContain("→ done");
  });
});

// ── fn_task_add_dep tool tests ──────────────────────────────────────────

describe("fn_task_add_dep tool", () => {
  /**
   * Helper: run executor with a customized mock store and capture custom tools.
   * The mock store's getTask is configured to:
   * - Return the executing task (KB-TEST) with configurable dependencies
   * - Return a target task (KB-OTHER) when requested
   * - Throw for unknown task IDs
   */
  async function captureAddDepTools(opts?: { existingDeps?: string[]; targetExists?: boolean }) {
    const existingDeps = opts?.existingDeps ?? [];
    const targetExists = opts?.targetExists ?? true;

    const store = createMockStore();
    store.getTask.mockImplementation(async (id: string) => {
      if (id === "FN-TEST") {
        return {
          id: "FN-TEST",
          title: "Test",
          description: "Test task",
          column: "in-progress",
          dependencies: existingDeps,
          steps: [],
          currentStep: 0,
          log: [],
          prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      if (id === "FN-OTHER" && targetExists) {
        return {
          id: "FN-OTHER",
          title: "Other task",
          description: "Another task",
          column: "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          prompt: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      throw new Error(`Task ${id} not found`);
    });

    store.updateStep.mockResolvedValue({
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ],
    });

    mockedExistsSync.mockReturnValue(true);

    let capturedTools: any[] = [];
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-id"),
            branchWithSummary: vi.fn(),
          },
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-TEST",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: existingDeps,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const tools: Record<string, any> = {};
    for (const t of capturedTools) {
      tools[t.name] = t.execute;
    }
    return { tools, store };
  }

  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("adds a valid dependency via store.updateTask when confirm=true", async () => {
    const { tools, store } = await captureAddDepTools();

    const result = await tools.fn_task_add_dep("call1", { task_id: "FN-OTHER", confirm: true });

    expect(result.content[0].text).toContain("Added dependency");
    expect(result.content[0].text).toContain("triage");
    expect(store.updateTask).toHaveBeenCalledWith("FN-TEST", {
      dependencies: ["FN-OTHER"],
    });
  });

  it("returns error for self-dependency", async () => {
    const { tools, store } = await captureAddDepTools();

    const result = await tools.fn_task_add_dep("call1", { task_id: "FN-TEST" });

    expect(result.content[0].text).toContain("Cannot add self-dependency");
    expect(result.content[0].text).toContain("FN-TEST cannot depend on itself");
    // store.updateTask should NOT have been called for dependency update
    // (it may be called for worktree path updates, so we check specifically for dependencies)
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("returns error for non-existent target task", async () => {
    const { tools, store } = await captureAddDepTools({ targetExists: false });

    const result = await tools.fn_task_add_dep("call1", { task_id: "FN-OTHER" });

    expect(result.content[0].text).toContain("FN-OTHER not found");
    expect(result.content[0].text).toContain("Cannot add dependency on a non-existent task");
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("returns informational message for duplicate dependency without duplicating", async () => {
    const { tools, store } = await captureAddDepTools({ existingDeps: ["FN-OTHER"] });

    const result = await tools.fn_task_add_dep("call1", { task_id: "FN-OTHER" });

    expect(result.content[0].text).toContain("already a dependency");
    expect(result.content[0].text).toContain("No changes made");
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("logs the dependency addition via store.logEntry when confirm=true", async () => {
    const { tools, store } = await captureAddDepTools();

    await tools.fn_task_add_dep("call1", { task_id: "FN-OTHER", confirm: true });

    expect(store.logEntry).toHaveBeenCalledWith("FN-TEST", "Added dependency on FN-OTHER — stopping execution for re-planning");
  });

  it("appends to existing dependencies without overwriting when confirm=true", async () => {
    const { tools, store } = await captureAddDepTools({ existingDeps: ["FN-001"] });

    const result = await tools.fn_task_add_dep("call1", { task_id: "FN-OTHER", confirm: true });

    expect(result.content[0].text).toContain("Added dependency");
    expect(store.updateTask).toHaveBeenCalledWith("FN-TEST", {
      dependencies: ["FN-001", "FN-OTHER"],
    });
  });

  it("is registered in customTools array", async () => {
    const { tools } = await captureAddDepTools();

    expect(tools.fn_task_add_dep).toBeDefined();
    expect(typeof tools.fn_task_add_dep).toBe("function");
  });

  it("returns warning without confirm=true and does NOT add dependency", async () => {
    const { tools, store } = await captureAddDepTools();

    const result = await tools.fn_task_add_dep("call1", { task_id: "FN-OTHER" });

    expect(result.content[0].text).toContain("stop execution and discard current work");
    expect(result.content[0].text).toContain("confirm=true");
    // Should NOT have updated dependencies
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
    // Should NOT have logged any dep addition
    const logCalls = store.logEntry.mock.calls.filter(
      (call: any[]) => typeof call[1] === "string" && call[1].includes("Added dependency"),
    );
    expect(logCalls).toHaveLength(0);
  });

  it("validation errors (self-dep, not-found, dedup) return immediately without requiring confirm", async () => {
    // Self-dep — no confirm needed
    const { tools: tools1 } = await captureAddDepTools();
    const selfResult = await tools1.fn_task_add_dep("call1", { task_id: "FN-TEST" });
    expect(selfResult.content[0].text).toContain("Cannot add self-dependency");

    // Not found — no confirm needed
    const { tools: tools2 } = await captureAddDepTools({ targetExists: false });
    const notFoundResult = await tools2.fn_task_add_dep("call1", { task_id: "FN-OTHER" });
    expect(notFoundResult.content[0].text).toContain("not found");

    // Dedup — no confirm needed
    const { tools: tools3 } = await captureAddDepTools({ existingDeps: ["FN-OTHER"] });
    const dedupResult = await tools3.fn_task_add_dep("call1", { task_id: "FN-OTHER" });
    expect(dedupResult.content[0].text).toContain("already a dependency");
  });

  it("with confirm=true triggers depAborted and disposes session", async () => {
    const store = createMockStore();
    store.getTask.mockImplementation(async (id: string) => {
      if (id === "FN-DEP") {
        return {
          id: "FN-DEP",
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
        };
      }
      if (id === "FN-TARGET") {
        return {
          id: "FN-TARGET",
          title: "Target",
          description: "Target task",
          column: "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          prompt: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      throw new Error(`Task ${id} not found`);
    });

    mockedExistsSync.mockReturnValue(true);

    const disposeFn = vi.fn();
    let capturedTools: any[] = [];

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // The agent calls fn_task_add_dep with confirm=true during execution
            const addDepTool = capturedTools.find((t: any) => t.name === "fn_task_add_dep");
            await addDepTool.execute("call1", { task_id: "FN-TARGET", confirm: true });
            // After dispose is called, session.prompt throws
            throw new Error("Session terminated");
          }),
          dispose: disposeFn,
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-id"),
            branchWithSummary: vi.fn(),
          },
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-DEP",
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

    // Worktree removal should have been attempted
    const worktreeRemoveCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(worktreeRemoveCalls.length).toBeGreaterThan(0);

    // Branch deletion should have been attempted
    const branchDeleteCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("branch -D") && (c[0] as string).includes("fusion/fn-dep"),
    );
    expect(branchDeleteCalls.length).toBeGreaterThan(0);

    // Task should be moved to triage
    expect(store.moveTask).toHaveBeenCalledWith("FN-DEP", "triage");

    // Worktree and status should be cleared
    expect(store.updateTask).toHaveBeenCalledWith("FN-DEP", { worktree: null, status: null });

    // Task should NOT be marked as failed
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-DEP", { status: "failed" });
  });
});

// ── Usage limit detection in executor ────────────────────────────────

import { UsageLimitPauser } from "../usage-limit-detector.js";

