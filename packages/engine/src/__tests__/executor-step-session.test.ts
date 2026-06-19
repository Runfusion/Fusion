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
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
  mockSteerActiveSessions,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

describe("Workflow Steps Execution", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  /**
   * Create a mock agent that auto-triggers the fn_task_done tool when prompt is called.
   * This simulates a successful task execution where the agent calls fn_task_done().
   */
  function createAgentWithTaskDone() {
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      const session = {
        prompt: vi.fn().mockImplementation(async () => {
          // Find and execute fn_task_done tool to set taskDone = true
          const taskDoneTool = capturedCustomTools.find((t: any) => t.name === "fn_task_done");
          if (taskDoneTool) {
            await taskDoneTool.execute("tool-1", {});
          }
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      };
      return { session };
    }) as any);
  }

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

    // Should have been called four times: initial + 3 retries
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);

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

  it("moves task to in-review once fn_task_done requeue budget is exhausted", async () => {
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
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-001" }),
      expect.objectContaining({ message: "Agent finished without calling fn_task_done (after 3 retries)" }),
    );
  });

  describe("FN-5436: pending-review skip on no-fn_task_done exit", () => {
    it("does not park in-review when code review REVISE requires more executor work", async () => {
      const store = createMockStore();
      const baseTask = {
        id: "FN-5436-A",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [{ name: "Implement", status: "in-progress" }],
        currentStep: 0,
        log: [],
        prompt: "# test\n## Steps\n### Step 1: Implement\n- [ ] implement",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.getTask.mockResolvedValue(baseTask as any);

      mockedReviewStep.mockResolvedValue({
        verdict: "REVISE",
        review: "needs changes",
        summary: "needs changes",
      });

      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
        const tools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const reviewTool = tools.find((t: any) => t.name === "fn_review_step");
              if (reviewTool) {
                await reviewTool.execute("tool-review", { step: 0, type: "code", step_name: "Implement" });
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

      const onError = vi.fn();
      const executor = new TaskExecutor(store, "/tmp/test", { onError });

      await executor.execute(baseTask as any);

      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);
      expect(store.updateTask).toHaveBeenCalledWith("FN-5436-A", expect.objectContaining({
        status: "queued",
        error: null,
        taskDoneRetryCount: 1,
      }));
      expect(store.moveTask).toHaveBeenCalledWith("FN-5436-A", "todo", { preserveProgress: true });
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-5436-A", "in-review");
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-A", {
        status: "failed",
        error: "executor-exit-while-review-pending",
      });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ id: "FN-5436-A" }),
        expect.objectContaining({ message: "Agent finished without calling fn_task_done (after 3 retries)" }),
      );
    });

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
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      } as any);

      const executor = new TaskExecutor(store, "/tmp/test", {});
      await executor.execute(baseTask as any);

      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
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
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      } as any);

      const executor = new TaskExecutor(store, "/tmp/test", {});
      await executor.execute(baseTask as any);

      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);
      expect(store.updateTask).toHaveBeenCalledWith("FN-5436-C", {
        status: "queued",
        error: null,
        taskDoneRetryCount: 1,
      });
    });

    it("allows implicit done to complete when no in-progress step exists", async () => {
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

      const onComplete = vi.fn();
      const onError = vi.fn();
      const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });
      await executor.execute(baseTask as any);

      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-5436-D", { workflowStepRetries: undefined, taskDoneRetryCount: null });
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-5436-D", {
        status: "failed",
        error: "executor-exit-while-review-pending",
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-5436-D", "in-review");
      expect(onComplete).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it("runs workflow steps after main task execution", async () => {
    const store = createMockStore();

    // Task has workflow steps enabled
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Docs Review",
      description: "Check documentation",
      prompt: "Review all docs and verify they are complete.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // First call: main agent with fn_task_done, subsequent calls: simple mocks for workflow step agents
    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        // Main execution — find and trigger fn_task_done
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        // Workflow step agent (no custom tools, uses readonly tools)
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // createFnAgent called twice: main agent + workflow step agent
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Second call should be the workflow step with readonly tools
    const secondCall = mockedCreateFnAgent.mock.calls[1];
    expect(secondCall[0].tools).toBe("readonly");
    expect(secondCall[0].systemPrompt).toContain("Docs Review");
    expect(secondCall[0].systemPrompt).toContain("Review all docs and verify they are complete.");
    const withoutWorkflowStep = (env: Record<string, string | undefined>) => {
      const { FUSION_WORKFLOW_STEP: _workflowStep, ...stableEnv } = env;
      return stableEnv;
    };
    expect(secondCall[0].taskEnv.FUSION_WORKFLOW_STEP).toBe("1");
    expect(withoutWorkflowStep(secondCall[0].taskEnv)).toEqual(withoutWorkflowStep(mockedCreateFnAgent.mock.calls[0][0].taskEnv));

    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("executes plugin-prefixed workflow steps", async () => {
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
      enabledWorkflowSteps: ["plugin:agent-browser:workflow-check"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "plugin:agent-browser:workflow-check",
      name: "Plugin Workflow Check",
      description: "Plugin contributed step",
      prompt: "Run plugin check",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
              if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
            }),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
            state: {},
          },
        };
      }

      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["plugin:agent-browser:workflow-check"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.setPluginWorkflowStepTemplates).toHaveBeenCalledWith([]);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "[pre-merge] Starting plugin workflow step: Plugin Workflow Check (plugin:agent-browser:workflow-check)",
    );
  });

  it("runs browser verification workflow steps with coding tools", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Browser task",
      description: "Verify browser behavior",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      templateId: "browser-verification",
      name: "Browser Verification",
      description: "Verify with browser automation",
      mode: "prompt",
      toolMode: "coding",
      prompt: "Use browser automation to verify the app.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      }

      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Browser task",
      description: "Verify browser behavior",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    const secondCall = mockedCreateFnAgent.mock.calls[1];
    expect(secondCall[0].tools).toBe("coding");
  });

  it("runs QA workflow steps with coding tools", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "QA task",
      description: "Verify tests pass",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      templateId: "qa-check",
      name: "QA Check",
      description: "Run tests and verify they pass",
      mode: "prompt",
      toolMode: "coding",
      prompt: "Run the test suite and report results.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      }

      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "QA task",
      description: "Verify tests pass",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    const secondCall = mockedCreateFnAgent.mock.calls[1];
    expect(secondCall[0].tools).toBe("coding");
  });

  it("skips workflow steps with no prompt", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Empty Step",
      description: "No prompt",
      prompt: "",
      enabled: true,
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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should only call createFnAgent once (main execution), skip workflow step
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

    // Should log that it was skipped
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("has no prompt"),
    );

    // Task should still move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
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

    // Only main agent call
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    // Task should still move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("uses workflow step model override when both provider and modelId are set", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Security Audit",
      description: "Check security",
      prompt: "Scan for vulnerabilities.",
      enabled: true,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        // Main execution agent
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        // Workflow step agent
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // createFnAgent called twice: main agent + workflow step agent
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Second call should use the workflow step's model override
    const secondCall = mockedCreateFnAgent.mock.calls[1];
    expect(secondCall[0].defaultProvider).toBe("anthropic");
    expect(secondCall[0].defaultModelId).toBe("claude-sonnet-4-5");

    // Log should indicate the override
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("workflow step override"),
    );
  });

  it("uses global defaults when workflow step has no model override", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Workflow step without model override
    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Docs Review",
      description: "Check documentation",
      prompt: "Review all docs.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Second call should use settings defaults (no override indicator)
    const secondCall = mockedCreateFnAgent.mock.calls[1];
    // defaults come from the mock store's getSettings
    expect(secondCall[0].defaultProvider).toBeUndefined();
    expect(secondCall[0].defaultModelId).toBeUndefined();

    // Log should NOT indicate override
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("workflow step override"),
    );
  });

  it("auto-skips built-in Frontend UX Design when diff scope has no frontend files", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" as const }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["frontend-ux-design"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue({
      id: "frontend-ux-design",
      name: "Frontend UX Design",
      description: "UI review",
      prompt: "Review UI",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      if (typeof cmd === "string" && cmd.includes("git merge-base HEAD origin/main")) {
        return Buffer.from("abc123\n");
      }
      if (typeof cmd === "string" && cmd.includes("git diff --name-only abc123..HEAD")) {
        return Buffer.from("packages/engine/src/foo.ts\n");
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test", {});
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue(["packages/engine/src/foo.ts"]);
    const executeStepSpy = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task, "/tmp/test", {});

    expect(result).toEqual({ allPassed: true });
    expect(executeStepSpy).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "frontend-ux-design",
            status: "skipped",
            output: expect.stringContaining("No frontend/UI files in diff scope"),
          }),
        ]),
      }),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "[pre-merge] Auto-skipped Frontend UX Design — no frontend/UI files in diff scope",
    );
    const logged = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
    expect(logged.some((line: string) => line.includes("Completion handoff deferred"))).toBe(false);
  });

  it("runs built-in Frontend UX Design normally when UI files are in scope", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" as const }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["frontend-ux-design"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue({
      id: "frontend-ux-design",
      name: "Frontend UX Design",
      description: "UI review",
      prompt: "Review UI",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      if (typeof cmd === "string" && cmd.includes("git merge-base HEAD origin/main")) {
        return Buffer.from("abc123\n");
      }
      if (typeof cmd === "string" && cmd.includes("git diff --name-only abc123..HEAD")) {
        return Buffer.from("packages/dashboard/app/components/Foo.tsx\n");
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test", {});
    const executeStepSpy = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "approved" });

    const result = await (executor as any).runWorkflowSteps(task, "/tmp/test", {});

    expect(result).toEqual({ allPassed: true });
    expect(executeStepSpy).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({ workflowStepId: "frontend-ux-design", status: "passed" }),
        ]),
      }),
    );
    const logged = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
    expect(logged.some((line: string) => line.includes("Auto-skipped Frontend UX Design"))).toBe(false);
  });

  it("avoids paused defer for built-in Frontend UX Design when no UI files are in scope", async () => {
    const store = createMockStore();
    const pausedTask = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" as const }],
      currentStep: 0,
      paused: true,
      log: [],
      enabledWorkflowSteps: ["frontend-ux-design"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(pausedTask as any);
    store.getWorkflowStep.mockResolvedValue({
      id: "frontend-ux-design",
      name: "Frontend UX Design",
      description: "UI review",
      prompt: "Review UI",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      if (typeof cmd === "string" && cmd.includes("git merge-base HEAD origin/main")) {
        return Buffer.from("abc123\n");
      }
      if (typeof cmd === "string" && cmd.includes("git diff --name-only abc123..HEAD")) {
        return Buffer.from("packages/engine/src/foo.ts\n");
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test", {});
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue(["packages/engine/src/foo.ts"]);
    const executeStepSpy = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(pausedTask, "/tmp/test", {});

    expect(result).toEqual({ allPassed: true });
    expect(executeStepSpy).not.toHaveBeenCalled();
    const logged = store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
    expect(logged.some((line: string) => line.includes("Auto-skipped Frontend UX Design — no frontend/UI files in diff scope"))).toBe(true);
    expect(logged.some((line: string) => line.includes("Completion handoff deferred — task paused (before workflow step 'Frontend UX Design')"))).toBe(false);
  });

  it("does not auto-skip custom step id even when named Frontend UX Design", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" as const }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["ws-custom-1"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(task as any);
    store.getWorkflowStep.mockResolvedValue({
      id: "ws-custom-1",
      name: "Frontend UX Design",
      description: "Custom UI review",
      prompt: "Review UI",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const executor = new TaskExecutor(store, "/tmp/test", {});
    const executeStepSpy = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

    const result = await (executor as any).runWorkflowSteps(task, "/tmp/test", {});

    expect(result).toEqual({ allPassed: true });
    expect(executeStepSpy).toHaveBeenCalledTimes(1);
  });

  it("executes script-mode workflow step successfully", async () => {
    const store = createMockStore();
    process.env.FN3968_SCRIPT_ENV = "workflow-script-env";

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: { test: `node -e "if (process.env.FN3968_SCRIPT_ENV !== 'workflow-script-env') process.exit(42)"` },
    });

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Run Tests",
      description: "Execute test suite",
      mode: "script",
      prompt: "",
      scriptName: "test",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Main agent with fn_task_done
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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should only call createFnAgent once (main execution — no agent for script mode)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

    // Should log script execution
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("executing script 'test'"),
    );

    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");

    // Should record a passed result
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "WS-001",
            workflowStepName: "Run Tests",
            status: "passed",
            output: "Script 'test' completed successfully",
          }),
        ]),
      }),
    );
    delete process.env.FN3968_SCRIPT_ENV;
  });

  it("executes plugin script-mode workflow step successfully", async () => {
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: { test: "echo 'all tests passed'" },
    });

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["plugin:agent-browser:script-check"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "plugin:agent-browser:script-check",
      name: "Plugin Script Check",
      description: "Execute plugin script",
      mode: "script",
      prompt: "",
      scriptName: "test",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      if (typeof cmd === "string" && cmd.includes("echo")) return Buffer.from("all tests passed\n");
      return Buffer.from("");
    });

    createAgentWithTaskDone();
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["plugin:agent-browser:script-check"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "plugin:agent-browser:script-check",
            status: "passed",
          }),
        ]),
      }),
    );
  });

  it("executes mixed db and plugin workflow steps in sequence", async () => {
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
      enabledWorkflowSteps: ["WS-001", "plugin:agent-browser:workflow-check"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockImplementation(async (id: string) => id === "WS-001"
      ? {
        id: "WS-001", name: "DB Step", description: "DB", prompt: "Run DB step", enabled: true,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      : {
        id: "plugin:agent-browser:workflow-check", name: "Plugin Step", description: "Plugin", prompt: "Run plugin step", enabled: true,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        return { session: { prompt: vi.fn().mockImplementation(async () => {
          const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
          if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
        }), dispose: vi.fn(), subscribe: vi.fn(), on: vi.fn(), sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") }, state: {} } };
      }
      return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), subscribe: vi.fn(), on: vi.fn(), state: {} } };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute({
      id: "FN-001", title: "Test", description: "Test task", column: "in-progress", dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }], currentStep: 0, log: [],
      enabledWorkflowSteps: ["WS-001", "plugin:agent-browser:workflow-check"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    expect(store.getWorkflowStep).toHaveBeenNthCalledWith(1, "WS-001");
    expect(store.getWorkflowStep).toHaveBeenNthCalledWith(2, "plugin:agent-browser:workflow-check");
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(3);
  });

  it("skips missing plugin workflow step IDs with warning log", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001", title: "Test", description: "Test task", column: "in-progress", dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }], currentStep: 0, log: [],
      enabledWorkflowSteps: ["plugin:missing:step"], prompt: "# test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    store.getWorkflowStep.mockResolvedValue(undefined);
    createAgentWithTaskDone();

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute({
      id: "FN-001", title: "Test", description: "Test task", column: "in-progress", dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }], currentStep: 0, log: [], enabledWorkflowSteps: ["plugin:missing:step"],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "[pre-merge] Workflow step plugin:missing:step not found — skipping");
  });

  it("sends task back to in-progress when script-mode workflow step fails with exhausted retries", async () => {
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: { lint: "pnpm lint" },
    });

    // Mutable task object to track step changes
    const mutableTask = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      dependencies: [] as string[],
      steps: [{ name: "Preflight", status: "pending" as const }],
      currentStep: 0,
      log: [] as any[],
      enabledWorkflowSteps: ["WS-001"],
      workflowStepRetries: 3, // Exhaust retries so task fails immediately
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockResolvedValue(mutableTask);

    // Make updateStep track changes in the mutable task
    store.updateStep.mockImplementation(async (taskId: string, stepIndex: number, status: string) => {
      if (mutableTask.steps[stepIndex]) {
        mutableTask.steps[stepIndex].status = status as any;
      }
      return {};
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Lint Check",
      description: "Run linter",
      mode: "script",
      prompt: "",
      scriptName: "lint",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Mock execSync to throw for the lint command
    const scriptErr = new Error("Command failed: pnpm lint");
    (scriptErr as any).status = 1;
    (scriptErr as any).stderr = Buffer.from("syntax error on line 42\n");
    (scriptErr as any).stdout = Buffer.from("");
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      if (typeof cmd === "string" && cmd.includes("lint")) {
        throw scriptErr;
      }
      return Buffer.from("");
    });

    // Use createAgentWithTaskDone to properly set up the agent mock
    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });

    // Use fake timers to control the setTimeout in sendTaskBackForFix
    vi.useFakeTimers();

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      workflowStepRetries: 3, // Exhaust retries so task fails immediately
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should record a failed result with exit code and stderr
    // (This may not be the first call, so check if any call has workflowStepResults)
    const updateTaskCalls = store.updateTask.mock.calls;
    const hasWorkflowStepFailure = updateTaskCalls.some(
      (call: any[]) =>
        call[0] === "FN-001" &&
        call[1]?.workflowStepResults?.some(
          (r: any) =>
            r.workflowStepId === "WS-001" &&
            r.workflowStepName === "Lint Check" &&
            r.status === "failed" &&
            r.output?.includes("Exit code: 1")
        )
    );
    expect(hasWorkflowStepFailure).toBe(true);

    // Task should be cleared and reset for retry (not failed + in-review)
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: null, error: null, sessionFile: null, workflowStepRetries: 0 }),
    );

    // Should add a comment with failure feedback
    // This will fail if sendTaskBackForFix is not called
    expect(store.addTaskComment).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Workflow step failed"),
      "agent",
    );

    // Should reset all steps to pending
    // Check that updateStep was called with "pending" for step 0
    // (There may be multiple calls - first from fn_task_done marking it done, second from sendTaskBackForFix resetting it)
    const updateStepCalls = store.updateStep.mock.calls;
    const hasResetToPending = updateStepCalls.some(
      (call: any[]) => call[0] === "FN-001" && call[1] === 0 && call[2] === "pending"
    );
    expect(hasResetToPending).toBe(true);

    // Advance timers to trigger the setTimeout that moves task to todo then in-progress
    vi.advanceTimersByTime(0);
    // Run any pending microtasks (the async code in setTimeout)
    await vi.runAllTimersAsync();

    // Task should move to todo then in-progress (not in-review). The hop to
    // todo must flag preserveResumeState so the workflow-rerun bounce keeps
    // the worktree and accumulated step progress through the transient
    // todo state on its way back to in-progress.
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveResumeState: true, preserveWorktree: true });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress");

    // onComplete should NOT be called (task is being retried, not completed)
    expect(onComplete).not.toHaveBeenCalled();

    // onError should NOT be called (task is being retried, not permanently failed)
    expect(onError).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("sends task back to in-progress when script is missing from settings.scripts", async () => {
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: { other: "echo other" },
    });

    // Mutable task object to track step changes
    const mutableTask = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      dependencies: [] as string[],
      steps: [{ name: "Preflight", status: "pending" as const }],
      currentStep: 0,
      log: [] as any[],
      enabledWorkflowSteps: ["WS-001"],
      workflowStepRetries: 3, // Exhaust retries so task fails immediately
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockResolvedValue(mutableTask);

    // Make updateStep track changes in the mutable task
    store.updateStep.mockImplementation(async (taskId: string, stepIndex: number, status: string) => {
      if (mutableTask.steps[stepIndex]) {
        mutableTask.steps[stepIndex].status = status as any;
      }
      return {};
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Missing Script",
      description: "Uses nonexistent script",
      mode: "script",
      prompt: "",
      scriptName: "nonexistent",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Use createAgentWithTaskDone to properly set up the agent mock
    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });

    // Use fake timers to control the setTimeout in sendTaskBackForFix
    vi.useFakeTimers();

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      workflowStepRetries: 3, // Exhaust retries so task fails immediately
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should log that the script was not found
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("not found in project settings"),
    );

    // Should record a failed result
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "WS-001",
            status: "failed",
            output: expect.stringContaining("not found in project settings"),
          }),
        ]),
      }),
    );

    // Task should be cleared and reset for retry (not failed + in-review)
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: null, error: null, sessionFile: null, workflowStepRetries: 0 }),
    );

    // Should add a comment with failure feedback
    expect(store.addTaskComment).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Workflow step failed"),
      "agent",
    );

    // Should reset all steps to pending
    // Check that updateStep was called with "pending" for step 0
    // (There may be multiple calls - first from fn_task_done marking it done, second from sendTaskBackForFix resetting it)
    const updateStepCalls = store.updateStep.mock.calls;
    const hasResetToPending = updateStepCalls.some(
      (call: any[]) => call[0] === "FN-001" && call[1] === 0 && call[2] === "pending"
    );
    expect(hasResetToPending).toBe(true);

    // Advance timers to trigger the setTimeout that moves task to todo then in-progress
    vi.advanceTimersByTime(0);
    // Run any pending microtasks (the async code in setTimeout)
    await vi.runAllTimersAsync();

    // Task should move to todo then in-progress (not in-review). The hop to
    // todo must flag preserveResumeState so the workflow-rerun bounce keeps
    // the worktree and accumulated step progress through the transient
    // todo state on its way back to in-progress.
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveResumeState: true, preserveWorktree: true });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress");

    // onComplete should NOT be called (task is being retried, not completed)
    expect(onComplete).not.toHaveBeenCalled();

    // onError should NOT be called (task is being retried, not permanently failed)
    expect(onError).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("routes exhausted prompt-mode workflow hard failures back to remediation and only reopens the last step", async () => {
    // This test was previously written as an end-to-end run through
    // executor.execute(...) with vi.useFakeTimers(), but that path hung
    // deterministically under the 15 s budget: createResolvedAgentSession's
    // workflow-step Promise.race used a frozen 360 s setTimeout, and the
    // rejection from the mock prompt never reached the catch block in time.
    // The behavior we actually need to lock down is:
    //   1. sendTaskBackForFix re-opens only the last completed step
    //      (reopenLastStepForRevision) — earlier done steps stay done.
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
        { name: "Step 0", status: "done" as const },
        { name: "Step 1", status: "done" as const },
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
    const scheduleSpy = vi
      .spyOn(executor as unknown as {
        scheduleWorkflowRerun: (
          taskId: string,
          worktreePath: string,
          successMessage: string,
        ) => void;
      }, "scheduleWorkflowRerun")
      .mockImplementation((taskId, worktreePath) => {
        void (executor as unknown as {
          performWorkflowRerunBounce: (taskId: string, worktreePath: string) => Promise<unknown>;
        }).performWorkflowRerunBounce(taskId, worktreePath);
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

    // (1) failure comment + only the last step re-opened
    expect(store.addTaskComment).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Workflow step failed"),
      "agent",
    );
    const reopenedStepIndexes = store.updateStep.mock.calls
      .filter((call: any[]) => call[0] === "FN-001" && call[2] === "pending")
      .map((call: any[]) => call[1]);
    expect(reopenedStepIndexes).toContain(1);
    expect(reopenedStepIndexes).not.toContain(0);

    // performWorkflowRerunBounce was invoked synchronously by the spy
    // above; flush microtasks so its awaited store calls settle before
    // we assert.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // (2) bounce uses preserveResumeState so step progress + worktree survive
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveResumeState: true, preserveWorktree: true });
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

  it("skips script-mode step when scriptName is missing", async () => {
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: {},
    });

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "No Script",
      description: "Script step without scriptName",
      mode: "script",
      prompt: "",
      scriptName: undefined,
      enabled: true,
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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should only call createFnAgent once (main execution)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

    // Should log that it was skipped
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("no scriptName"),
    );

    // Task should move to in-review (skipped step doesn't block)
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("treats legacy steps without mode as prompt-mode", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Legacy step without mode field
    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Legacy Review",
      description: "Old step without mode",
      prompt: "Review the code changes.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any); // mode field intentionally omitted

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // createFnAgent called twice: main agent + workflow step agent (prompt mode)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Second call should use prompt mode (readonly tools, agent-based)
    const secondCall = mockedCreateFnAgent.mock.calls[1];
    expect(secondCall[0].tools).toBe("readonly");
    expect(secondCall[0].systemPrompt).toContain("Legacy Review");

    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  // ── Workflow Step Phase Filtering ────────────────────────────────────

  it("skips post-merge workflow steps during executor pre-merge execution", async () => {
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
      enabledWorkflowSteps: ["WS-001", "WS-002"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockImplementation(async (id: string) => {
      if (id === "WS-001") {
        return {
          id: "WS-001",
          name: "Pre-merge Check",
          description: "Before merge",
          prompt: "Run pre-merge checks",
          phase: "pre-merge",
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      if (id === "WS-002") {
        return {
          id: "WS-002",
          name: "Post-merge Notify",
          description: "After merge",
          prompt: "Send notifications",
          phase: "post-merge",
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      return undefined;
    });

    // Main agent calls fn_task_done, then a workflow step agent for pre-merge only
    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001", "WS-002"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // createFnAgent called twice: main agent + 1 pre-merge step (post-merge skipped)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Verify the workflow step results only contain pre-merge
    const updateCalls = store.updateTask.mock.calls;
    const resultsCall = updateCalls.find((c: any) =>
      c[1]?.workflowStepResults?.length > 0
    );
    expect(resultsCall).toBeDefined();
    const results = resultsCall![1].workflowStepResults;
    expect(results).toHaveLength(1);
    expect(results[0].workflowStepId).toBe("WS-001");
    expect(results[0].phase).toBe("pre-merge");
  });

  it("normalizes legacy workflow steps without phase as pre-merge", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Legacy step without phase field
    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Legacy Check",
      description: "No phase field",
      prompt: "Run checks",
      // phase is undefined — should be treated as pre-merge
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Legacy step should have been executed (treated as pre-merge)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Verify result has phase: "pre-merge"
    const updateCalls = store.updateTask.mock.calls;
    const resultsCall = updateCalls.find((c: any) =>
      c[1]?.workflowStepResults?.some((r: any) => r.workflowStepId === "WS-001")
    );
    expect(resultsCall).toBeDefined();
    const results = resultsCall![1].workflowStepResults;
    expect(results[0].phase).toBe("pre-merge");
  });

  it("only runs post-merge steps when all are post-merge (skips all in executor)", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Post-merge Notify",
      description: "After merge",
      prompt: "Send notifications",
      phase: "post-merge",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createAgentWithTaskDone();

    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Only main agent called (no workflow step agent since all are post-merge)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);

    // Task should still move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  // ── Workflow Step Revision Request ──────────────────────────────────

  it("workflow step agent returns revisionRequested when output starts with REQUEST REVISION", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Security Audit",
      description: "Check for vulnerabilities",
      gateMode: "gate",
      prompt: "Scan for security issues.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.parseFileScopeFromPrompt.mockResolvedValue(["src/auth.ts"]);

    // First call: main agent with fn_task_done
    // Second call: workflow step agent that returns REQUEST REVISION
    let callIdx = 0;
    let subscribeHandler: any;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        // Main execution
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        // Workflow step agent that requests revision
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            // Call the subscribe handler to simulate agent outputting REQUEST REVISION
            if (subscribeHandler) {
              subscribeHandler({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "REQUEST REVISION\n\nFix the SQL injection vulnerability in src/auth.ts" },
              });
            }
          }),
          dispose: vi.fn(),
          subscribe: vi.fn((handler: any) => {
            subscribeHandler = handler;
          }),
          state: {},
        };
        return { session };
      }
    }) as any);

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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Both agents should be called
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Log should show revision was requested
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("requested revision"),
      expect.stringContaining("SQL injection"),
      expect.objectContaining({ agentId: "executor" }),
    );
    expect(store.createTask).not.toHaveBeenCalled();

    // Workflow step result should be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "WS-001",
            status: "failed",
            output: expect.stringContaining("SQL injection"),
          }),
        ]),
      }),
    );

    // Task should NOT be marked as failed (revision requested, not hard failure)
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed", error: "Workflow step failed" }),
    );
  });

  it("treats prompt advisory workflow revision requests as non-blocking findings", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Frontend UX Design",
      description: "Polish pass",
      gateMode: "advisory",
      mode: "prompt",
      prompt: "Review polish quality.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.parseFileScopeFromPrompt.mockResolvedValue(["src/auth.ts"]);

    let callIdx = 0;
    let subscribeHandler: any;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      }

      const session = {
        prompt: vi.fn().mockImplementation(async () => {
          subscribeHandler?.({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "REQUEST REVISION\n\nPolish note: tighten auth error copy." },
          });
        }),
        dispose: vi.fn(),
        subscribe: vi.fn((handler: any) => {
          subscribeHandler = handler;
        }),
        state: {},
      };
      return { session };
    }) as any);

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
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "WS-001",
            status: "advisory_failure",
            notes: expect.stringContaining("Polish note"),
          }),
        ]),
      }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Advisory workflow step failed"),
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed", error: "Workflow step failed" }),
    );
    expect(onComplete).toHaveBeenCalled();
  });

  it("forks out-of-scope workflow revision feedback into a follow-up task and leaves the original task untouched", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## File Scope\n- `packages/engine/src/executor.ts`\n## Steps\n### Step 0: Implement\n- [x] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Security Audit",
      description: "Check for vulnerabilities",
      gateMode: "gate",
      prompt: "Scan for security issues.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    let subscribeHandler: any;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
              if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
            }),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
            state: {},
          },
        };
      }

      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            subscribeHandler?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "REQUEST REVISION\n\nFix `packages/core/src/types.ts` before merge." },
            });
          }),
          dispose: vi.fn(),
          subscribe: vi.fn((handler: any) => {
            subscribeHandler = handler;
          }),
          state: {},
        },
      };
    }) as any);

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining("workflow follow-up"),
      dependencies: ["FN-001"],
      source: expect.objectContaining({
        sourceType: "workflow_step",
        sourceParentTaskId: "FN-001",
      }),
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({ status: null, sessionFile: null }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(onComplete).toHaveBeenCalled();
  });

  it("splits mixed workflow revision feedback between the original task and a follow-up task", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## File Scope\n- `packages/engine/src/executor.ts`\n## Steps\n### Step 0: Implement\n- [x] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Security Audit",
      description: "Check for vulnerabilities",
      gateMode: "gate",
      prompt: "Scan for security issues.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    let subscribeHandler: any;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
              if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
            }),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
            state: {},
          },
        };
      }

      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            subscribeHandler?.({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "REQUEST REVISION\n\nTighten `packages/engine/src/executor.ts`.\n\nAdd the setting in `packages/core/src/settings-schema.ts`.",
              },
            });
          }),
          dispose: vi.fn(),
          subscribe: vi.fn((handler: any) => {
            subscribeHandler = handler;
          }),
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.createTask).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("split feedback"),
      expect.stringContaining("packages/engine/src/executor.ts"),
      expect.objectContaining({ agentId: "executor" }),
    );
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({ status: null, sessionFile: null }));
  });

  it("preserves legacy append-and-rerun behavior when workflow revision forking is disabled", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      workflowRevisionForkOnScopeMismatch: false,
      worktreeInitCommand: undefined,
    });

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## File Scope\n- `packages/engine/src/executor.ts`\n## Steps\n### Step 0: Implement\n- [x] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.parseFileScopeFromPrompt.mockResolvedValue(["packages/engine/src/executor.ts"]);
    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Security Audit",
      description: "Check for vulnerabilities",
      gateMode: "gate",
      prompt: "Scan for security issues.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    let subscribeHandler: any;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
              if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
            }),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
            state: {},
          },
        };
      }

      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            subscribeHandler?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "REQUEST REVISION\n\nFix `packages/core/src/types.ts` before merge." },
            });
          }),
          dispose: vi.fn(),
          subscribe: vi.fn((handler: any) => {
            subscribeHandler = handler;
          }),
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Implement", status: "done" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.createTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({ status: null, sessionFile: null }));
  });

  it("passing workflow step moves task to in-review normally", async () => {
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
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "QA Check",
      description: "Run tests",
      prompt: "Run the test suite.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        let stepSubscribeHandler: any;
        // Workflow step agent that passes with the structured verdict required by the workflow-step parser.
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              stepSubscribeHandler?.({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: '{"verdict":"APPROVE","notes":""}' },
              });
            }),
            dispose: vi.fn(),
            subscribe: vi.fn((handler: any) => { stepSubscribeHandler = handler; }),
            state: {},
          },
        };
      }
    }) as any);

    const onComplete = vi.fn();
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Both agents called
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);

    // Log should show workflow step passed
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Workflow step completed"),
    );

    // Task should move to in-review (not revision loop)
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");

    // onComplete should be called
    expect(onComplete).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("parks a task pause during a prompt-mode workflow step instead of routing through failure recovery", async () => {
    const store = createMockStore();
    const mutableTask = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress" as const,
      paused: false,
      dependencies: [] as string[],
      steps: [{ name: "Preflight", status: "pending" as const }],
      currentStep: 0,
      log: [] as any[],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockImplementation(async () => mutableTask as any);
    store.updateTask.mockImplementation(async (_taskId: string, patch: Record<string, unknown>) => {
      Object.assign(mutableTask, patch);
      return { ...mutableTask };
    });
    store.moveTask.mockImplementation(async (_taskId: string, column: string) => {
      mutableTask.column = column as typeof mutableTask.column;
      return { ...mutableTask };
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "QA Check",
      description: "Run tests",
      mode: "prompt",
      prompt: "Run the test suite.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const workflowAbort = vi.fn().mockResolvedValue(undefined);
    const workflowDispose = vi.fn();
    let callIdx = 0;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = customTools.find((tool: any) => tool.name === "fn_task_done");
              if (taskDoneTool) {
                await taskDoneTool.execute("tool-1", {});
              }
            }),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
            state: {},
          },
        };
      }

      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            mutableTask.paused = true;
            store._trigger("task:updated", { ...mutableTask });
            throw new Error("workflow step aborted by pause");
          }),
          abort: workflowAbort,
          dispose: workflowDispose,
          subscribe: vi.fn(),
          on: vi.fn(),
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({ ...mutableTask });

    expect(workflowDispose).toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveResumeState: true });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.addTaskComment).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Execution paused during pre-merge workflow step — moved to todo",
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
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
    const steerActiveSessions = vi.fn().mockResolvedValue(1);
    const markSteeringCommentsDelivered = vi.fn();
    const newComment = {
      id: "step-session-comment",
      text: "Please adjust the active step",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };

    (executor as any).activeStepExecutors.set("FN-001", { steerActiveSessions, markSteeringCommentsDelivered });
    (executor as any).activeStepExecutorSeenSteeringIds.set("FN-001", new Set());

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
    const steerActiveSessions = vi.fn().mockResolvedValue(0);
    const updateSteeringComments = vi.fn();
    const markSteeringCommentsDelivered = vi.fn();
    const newComment = {
      id: "step-session-queued-comment",
      text: "Please apply this in the next step prompt",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };

    (executor as any).activeStepExecutors.set("FN-001", {
      steerActiveSessions,
      updateSteeringComments,
      markSteeringCommentsDelivered,
    });
    (executor as any).activeStepExecutorSeenSteeringIds.set("FN-001", new Set());

    await (store as any)._triggerAsync("task:updated", makeSteeringTask([newComment]));

    expect(steerActiveSessions).toHaveBeenCalledOnce();
    expect(updateSteeringComments).toHaveBeenCalledWith([newComment]);
    expect(markSteeringCommentsDelivered).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Comment received mid-execution"),
      "by user",
    );
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
describe("U2: fn_review_step RETHINK delegates to resetStepToBaseline (characterization)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  function runRethinkScenario(reviewType: "code" | "plan", navigateTree: any) {
    const store = createMockStore();
    const baseTask = {
      id: "FN-RT-1",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Implement", status: "in-progress" }],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 1: Implement\n- [ ] implement",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockResolvedValue(baseTask as any);
    // updateStep returns the task with the step persisted in-progress so the
    // executor's checkpoint-capture path (executor.ts ~6517) populates the
    // stepCheckpoints map that RETHINK rewinds to.
    store.updateStep.mockResolvedValue({
      ...baseTask,
      steps: [{ name: "Implement", status: "in-progress" }],
    } as any);

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "wrong approach",
      summary: "rejected approach",
    } as any);

    let reviewToolError: unknown;
    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      const tools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // First, flip the step to in-progress via fn_task_update so the
            // checkpoint map is populated (mirrors the real session lifecycle).
            const updateTool = tools.find((t: any) => t.name === "fn_task_update");
            if (updateTool) {
              try {
                await updateTool.execute("tool-update", { step: 0, status: "in-progress" });
              } catch { /* tool param shape varies; ignore */ }
            }
            const reviewTool = tools.find((t: any) => t.name === "fn_review_step");
            if (reviewTool) {
              try {
                await reviewTool.execute("tool-review", {
                  step: 0,
                  type: reviewType,
                  step_name: "Implement",
                  baseline: reviewType === "code" ? "agentBaselineSHA" : undefined,
                });
              } catch (e) {
                reviewToolError = e;
              }
            }
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          navigateTree,
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-pre-step"),
            branchWithSummary: vi.fn(),
          },
          state: {},
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});
    return { store, baseTask, executor, getReviewToolError: () => reviewToolError };
  }

  it("code RETHINK: git reset to baseline, navigateTree rewind, step→pending, RETHINK log", async () => {
    const navigateTree = vi.fn().mockResolvedValue(undefined);
    const { store, baseTask, executor } = runRethinkScenario("code", navigateTree);

    await executor.execute(baseTask as any);

    // git reset --hard <baseline> issued in the worktree (via the mocked exec).
    const resetIssued = mockedExecSync.mock.calls.some(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("git reset --hard agentBaselineSHA"),
    );
    expect(resetIssued).toBe(true);
    // Session rewound to the captured pre-step checkpoint.
    expect(navigateTree).toHaveBeenCalledWith("leaf-pre-step", { summarize: false });
    // Step reset to pending through the projection sink.
    expect(store.updateStep).toHaveBeenCalledWith("FN-RT-1", 0, "pending");
    // RETHINK log entry (code-review variant references the git reset).
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-RT-1",
      expect.stringContaining("git reset to agentBaselineSHA"),
      "rejected approach",
    );
  });

  it("plan RETHINK: no git reset, navigateTree rewind, step→pending, plan-rewound log", async () => {
    const navigateTree = vi.fn().mockResolvedValue(undefined);
    const { store, baseTask, executor } = runRethinkScenario("plan", navigateTree);

    await executor.execute(baseTask as any);

    const resetIssued = mockedExecSync.mock.calls.some(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("git reset --hard"),
    );
    expect(resetIssued).toBe(false);
    expect(navigateTree).toHaveBeenCalledWith("leaf-pre-step", { summarize: false });
    expect(store.updateStep).toHaveBeenCalledWith("FN-RT-1", 0, "pending");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-RT-1",
      expect.stringContaining("Step 0 plan rewound"),
      "rejected approach",
    );
  });
});
