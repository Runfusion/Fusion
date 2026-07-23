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
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

/*
FNXC:EngineTests 2026-07-19-16:30 (U10b):
`moveTask` is now called by the workflow graph's merge boundary, which carries a metadata options
argument (`workflowMoveSource`/`workflowMoveMetadata`). `toHaveBeenCalledWith(id, column)` matches
argument lists EXACTLY, so the old two-argument form turned every negative "must not move to
todo" assertion into a tautology once the third argument appeared. Match on destination only, so
the requirement under test — WHICH column the task lands in, and that an engine pause never
routes it back to `todo` — is asserted against the graph's real call shape.
*/
function moveTaskCallsTo(store: { moveTask: { mock: { calls: unknown[][] } } }, id: string, column: string) {
  return store.moveTask.mock.calls.filter((call) => call[0] === id && call[1] === column);
}

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
      capturedCustomTools = [...capturedCustomTools, ...(opts.customTools || [])];
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
      id: "FN-001", title: "Test", description: "T", column: "in-progress" as const,
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    /*
    FNXC:EngineTests 2026-07-19-16:30 (U10b):
    The graph runs more than one agent session per task (the implementation session plus the
    completion-summary node), so a hardcoded "dispose called once" no longer states the
    requirement. The requirement is that each session is disposed exactly once on its own normal
    completion and that the `settings:updated` engine-pause listener adds NO dispose of its own —
    expressed as one dispose per created session.
    */
    expect(mockedCreateFnAgent.mock.calls.length).toBeGreaterThan(0);
    expect(disposeFn).toHaveBeenCalledTimes(mockedCreateFnAgent.mock.calls.length);
    // Task should complete normally and move to in-review, not todo
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-001",
      "in-review",
      expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
    );
    expect(moveTaskCallsTo(store, "FN-001", "todo")).toHaveLength(0);
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
      capturedCustomTools = [...capturedCustomTools, ...(opts.customTools || [])];
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
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ paused: false, pausedByAgentId: null, status: null }),
    );
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-001",
      "in-review",
      expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
    );
  });

  it("does NOT move tasks to todo when enginePaused transitions false→true", async () => {
    const store = createMockStore();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = [...capturedCustomTools, ...(opts.customTools || [])];
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
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-001",
      "in-review",
      expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
    );
    expect(moveTaskCallsTo(store, "FN-001", "todo")).toHaveLength(0);
  });

  it("takes no action when enginePaused stays false (false→false)", async () => {
    const store = createMockStore();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = [...capturedCustomTools, ...(opts.customTools || [])];
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
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-001",
      "in-review",
      expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
    );
    expect(moveTaskCallsTo(store, "FN-001", "todo")).toHaveLength(0);
  });

  it("takes no action when enginePaused stays true (true→true)", async () => {
    const store = createMockStore();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = [...capturedCustomTools, ...(opts.customTools || [])];
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
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-001",
      "in-review",
      expect.objectContaining({ workflowMoveSource: "workflow-graph" }),
    );
    expect(moveTaskCallsTo(store, "FN-001", "todo")).toHaveLength(0);
  });
});

// ── Code review verdict enforcement tests ────────────────────────────

/**
 * Helper: executes a task and captures the custom tools passed to createFnAgent.
 * Returns a map of tool name → tool execute function for direct testing.
 */
async function captureTools(
  settingsOverride?: Record<string, unknown>,
  taskOverride?: Record<string, unknown>,
): Promise<Record<string, (id: string, params: any) => Promise<any>>> {
  const { tools } = await captureToolsWithStore(settingsOverride, taskOverride);
  return tools;
}

async function captureToolsWithStore(
  settingsOverride?: Record<string, unknown>,
  taskOverride?: Record<string, unknown>,
): Promise<{
  tools: Record<string, (id: string, params: any) => Promise<any>>;
  store: ReturnType<typeof createMockStore>;
}> {
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
    { name: "Testing", status: "pending" as const },
    { name: "Docs", status: "pending" as const },
  ];
  store.getTask.mockImplementation(async () => ({
    id: "FN-TEST",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: stepStates.map((s) => ({ ...s })),
    currentStep: 1,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...taskOverride,
  }));
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
    capturedTools = [...capturedTools, ...(opts.customTools || [])];
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
  return { tools, store };
}

describe("Code review verdict enforcement - fn_task_update blocking", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("registers research runtime tools in customTools when researchView experimental flag is enabled", async () => {
    const tools = await captureTools({ experimentalFeatures: { researchView: true } });
    expect(tools.fn_research_run).toBeTypeOf("function");
    expect(tools.fn_research_list).toBeTypeOf("function");
    expect(tools.fn_research_get).toBeTypeOf("function");
    expect(tools.fn_research_cancel).toBeTypeOf("function");
    expect(tools.fn_research_retry).toBeTypeOf("function");
  });

  it("does not register research runtime tools when researchView experimental flag is disabled", async () => {
    const tools = await captureTools({ experimentalFeatures: { researchView: false } });
    expect(tools.fn_research_run).toBeUndefined();
    expect(tools.fn_research_list).toBeUndefined();
    expect(tools.fn_research_get).toBeUndefined();
    expect(tools.fn_research_cancel).toBeUndefined();
    expect(tools.fn_research_retry).toBeUndefined();
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

  it("EXECUTOR_SYSTEM_PROMPT contains code review and full-suite enforcement language", async () => {
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
    expect(capturedSystemPrompt).toContain("Do NOT run the full/workspace-wide test suite as your normal verification path");
    expect(capturedSystemPrompt).toContain("A full/workspace-wide run is allowed ONLY when the task or workflow explicitly requires it");
    expect(capturedSystemPrompt).toContain("allowFullSuite: true");
    expect(capturedSystemPrompt).toContain("Do not call `fn_workflow_select` to change the workflow of the task you are executing");
    expect(capturedSystemPrompt).toContain("The only exception is when the user explicitly requested a specific workflow for this task");
    expect(capturedSystemPrompt).toContain("You may still set the workflow on tasks you create via `fn_task_create` or `fn_delegate_task`");
  });

  // Note: The EXECUTOR_SYSTEM_PROMPT constant is tested indirectly via the buildExecutionPrompt test.
  // The direct test for EXECUTOR_SYSTEM_PROMPT is skipped because of module caching issues in vitest.
  // The buildExecutionPrompt test verifies the CRITICAL language is included in execution prompts.

});

// ── RETHINK verdict handling tests ───────────────────────────────────

// ── Plan RETHINK verdict handling tests ──────────────────────────────

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
      capturedTools = [...capturedTools, ...(opts.customTools || [])];
      return { session: mockSession } as any;
    });

    const task = {
      id: "FN-E2E",
      title: "E2E Test",
      description: "E2E pipeline test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [
        { name: "Preflight", status: "pending" as const },
        { name: "Implement", status: "pending" as const },
        { name: "Tests", status: "pending" as const },
      ],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockImplementation(async (id: string) => (id === task.id ? task : task));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(task);

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
      id: "FN-E2E",
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
        { name: "Implement", status: "pending" as const },
        { name: "Verify", status: "pending" as const },
      ],
    });
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) => ({
      steps: [
        { name: "Preflight", status: "in-progress" },
        { name: "Implement", status: step === 1 ? status : "pending" },
        { name: "Verify", status: "pending" as const },
      ],
    }));

    const { tools } = await captureE2ETools(store);
    const result = await tools.fn_task_update("u-warn", { step: 1, status: "in-progress" });

    expect(store.updateStep).toHaveBeenCalledWith("FN-E2E", 1, "in-progress");
    expect(result.content[0].text).toContain("Step 1 (Implement) → in-progress");
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
      capturedTools = [...capturedTools, ...(opts.customTools || [])];
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
      capturedTools = [...capturedTools, ...(opts.customTools || [])];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            /*
            FNXC:EngineTests 2026-07-19-16:35 (U10b):
            `fn_task_add_dep` is an IMPLEMENTATION-session tool. Under graph ownership this stub is
            reused for the graph's review/summary sessions too, whose tool sets do not include it —
            calling it unconditionally blew up the first non-implementation session and the task
            never reached the abort path under test. Act only when the session actually owns the
            tool; other sessions are no-ops.
            */
            const addDepTool = capturedTools.find((t: any) => t.name === "fn_task_add_dep");
            if (!addDepTool) return;
            // The agent calls fn_task_add_dep with confirm=true during execution
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

import { UsageLimitPauser } from "../errors/usage-limit-detector.js";
