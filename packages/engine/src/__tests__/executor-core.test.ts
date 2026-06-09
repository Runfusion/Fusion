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
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

describe("detectReviewHandoffIntent", () => {
  it("returns true for 'send it back to me'", () => {
    expect(detectReviewHandoffIntent("Please send it back to me for review")).toBe(true);
  });

  it("returns true for 'hand off to user'", () => {
    expect(detectReviewHandoffIntent("I need to hand off to user")).toBe(true);
  });

  it("returns true for 'needs human review'", () => {
    expect(detectReviewHandoffIntent("This needs human review")).toBe(true);
  });

  it("returns true for 'assign to user'", () => {
    expect(detectReviewHandoffIntent("Please assign to user")).toBe(true);
  });

  it("returns true for 'return to user'", () => {
    expect(detectReviewHandoffIntent("Return to user for final approval")).toBe(true);
  });

  it("returns true for 'user review needed'", () => {
    expect(detectReviewHandoffIntent("User review needed")).toBe(true);
  });

  it("returns true for 'requesting user review'", () => {
    expect(detectReviewHandoffIntent("I am requesting user review")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectReviewHandoffIntent("SEND IT BACK TO ME")).toBe(true);
    expect(detectReviewHandoffIntent("Send It Back To Me")).toBe(true);
  });

  it("returns false for regular comments without handoff intent", () => {
    expect(detectReviewHandoffIntent("Good progress on the implementation")).toBe(false);
    expect(detectReviewHandoffIntent("Please add more tests")).toBe(false);
    expect(detectReviewHandoffIntent("The code looks great")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(detectReviewHandoffIntent("")).toBe(false);
  });
});

describe("buildExecutionPrompt", () => {
  it("includes worktree boundary guidance in the execution prompt", () => {
    const task: any = {
      id: "FN-TEST",
      title: "Test task",
      dependencies: [],
      prompt: "# Test task\n## Steps\n- Step 1",
      steps: [],
      currentStep: 0,
      attachments: [],
    };

    const prompt = buildExecutionPrompt(task, "/project");

    expect(prompt).toContain("## Worktree Boundaries");
    expect(prompt).toContain("isolated git worktree");
    expect(prompt).toContain("All code changes must be made inside the current worktree directory");
  });

  it("mentions project memory exception in worktree boundary guidance", () => {
    const task: any = {
      id: "FN-TEST",
      title: "Test task",
      dependencies: [],
      prompt: "# Test task\n## Steps\n- Step 1",
      steps: [],
      currentStep: 0,
      attachments: [],
    };

    const prompt = buildExecutionPrompt(task, "/project");

    expect(prompt).toContain(".fusion/memory/");
    expect(prompt).toContain("memory");
    expect(prompt).toContain("durable");
  });

  it("mentions task attachments exception in worktree boundary guidance", () => {
    const task: any = {
      id: "FN-TEST",
      title: "Test task",
      dependencies: [],
      prompt: "# Test task\n## Steps\n- Step 1",
      steps: [],
      currentStep: 0,
      attachments: [],
    };

    const prompt = buildExecutionPrompt(task, "/project");

    expect(prompt).toContain("attachments");
    expect(prompt).toContain("context");
  });

  it("includes worktree boundary guidance regardless of review level", () => {
    const task: any = {
      id: "FN-TEST",
      title: "Test task",
      dependencies: [],
      prompt: "# Test task\n## Review Level: 0\n## Steps\n- Step 1",
      steps: [],
      currentStep: 0,
      attachments: [],
    };

    const prompt = buildExecutionPrompt(task, "/project");

    expect(prompt).toContain("## Worktree Boundaries");
  });
});

describe("TaskExecutor review addressing transitions", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("moves queued addressing records to in-progress", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-001",
      column: "in-progress",
      status: null,
      reviewState: {
        source: "pull-request",
        items: [],
        addressing: [{ itemId: "ri-1", status: "queued", selectedAt: new Date().toISOString() }],
      },
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await (executor as any).transitionReviewAddressing("FN-001", ["queued"], "in-progress");

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      reviewState: expect.objectContaining({
        addressing: [expect.objectContaining({ status: "in-progress", startedAt: expect.any(String) })],
      }),
    });
  });

  it("marks in-progress addressing records as failed", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-001",
      column: "in-review",
      status: "failed",
      reviewState: {
        source: "reviewer-agent",
        items: [],
        addressing: [{ itemId: "ri-1", status: "in-progress", selectedAt: new Date().toISOString() }],
      },
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await (executor as any).transitionReviewAddressing("FN-001", ["in-progress"], "failed");

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      reviewState: expect.objectContaining({
        addressing: [expect.objectContaining({ status: "failed", completedAt: expect.any(String) })],
      }),
    });
  });
});

describe("TaskExecutor action gate context", () => {
  it("pauses task and agent for approval and marks completion", async () => {
    const store = createMockStore();
    store.pauseTask = vi.fn().mockResolvedValue(undefined);
    store.logEntry = vi.fn().mockResolvedValue(undefined);
    const agentStore = {
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    } as any;

    const executor = new TaskExecutor(store as any, "/tmp/project", { agentStore });
    (executor as any).currentRunContexts.set("FN-1", { runId: "run-1", agentId: "executor" });

    const context = (executor as any).buildActionGateContext("FN-1", { id: "agent-1", name: "Agent One", permissionPolicy: undefined });

    await context.pauseForApproval({
      approvalRequestId: "apr-1",
      decision: {
        disposition: "require-approval",
        category: "command_execution",
        toolName: "bash",
        operation: "git commit",
        summary: "bash: git commit",
        resourceType: "git",
        approvalDedupeKey: "dedupe-1",
        metadata: {},
      },
    });

    expect(store.pauseTask).toHaveBeenCalledWith(
      "FN-1",
      true,
      expect.objectContaining({ runId: "run-1" }),
      { pausedByAgentId: "agent-1" },
    );
    expect(agentStore.updateAgentState).toHaveBeenCalledWith("agent-1", "paused");
    expect(agentStore.updateAgent).toHaveBeenCalledWith("agent-1", { pauseReason: "awaiting-approval" });

  });
});

// ── Skill Selection Regression Tests (FN-1514) ──────────────────────────

describe("TaskExecutor skillSelection regression (FN-1511)", () => {
  const projectRoot = "/tmp/test-project";

  beforeEach(() => {
    resetExecutorMocks();
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf-id"),
          branchWithSummary: vi.fn(),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
    } as any);
  });

  /**
   * Helper: execute a task and capture createFnAgent call arguments.
   */
  async function captureCreateFnAgentArgs(options?: {
    assignedAgentId?: string;
    assignedAgentSkills?: string[];
    settings?: Record<string, unknown>;
  }) {
    const { assignedAgentId, assignedAgentSkills } = options || {};

    const mockAgentStore = {
      getAgent: vi.fn().mockImplementation(async (id: string) => {
        if (id === assignedAgentId) {
          return {
            id,
            name: "Test Agent",
            role: "executor",
            state: "idle",
            metadata: { skills: assignedAgentSkills || [] },
          };
        }
        return null;
      }),
    };

    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-SKILL",
      title: "Skill Test",
      description: "Test skill selection",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      assignedAgentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let capturedArgs: any = null;
    mockedCreateFnAgent.mockImplementationOnce(async (opts: any) => {
      capturedArgs = opts;
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

    const executor = new TaskExecutor(store, projectRoot, { agentStore: mockAgentStore as any });
    await executor.execute({
      id: "FN-SKILL",
      title: "Skill Test",
      description: "Test skill selection",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      assignedAgentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return capturedArgs;
  }

  describe("single-session mode (runStepsInNewSessions: false)", () => {
    it("passes skillSelection to createFnAgent when assigned agent has skills", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage", "executor"],
      });

      expect(args).not.toBeNull();
      expect(args).toHaveProperty("skillSelection");
      // The agent's skills are passed directly; filtering happens at skill resolver level
      expect(args.skillSelection).toMatchObject({
        projectRootDir: projectRoot,
        requestedSkillNames: expect.arrayContaining(["triage", "executor"]),
        sessionPurpose: "executor",
      });
    });

    it("normalizes whitespace in requestedSkillNames", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["  triage  ", " executor ", "reviewer"],
      });

      expect(args).not.toBeNull();
      expect(args.skillSelection).toMatchObject({
        projectRootDir: projectRoot,
        requestedSkillNames: expect.arrayContaining(["triage", "executor", "reviewer"]),
      });
    });

    it("deduplicates requestedSkillNames while preserving first occurrence", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage", "executor", "triage", "reviewer", "executor"],
      });

      expect(args).not.toBeNull();
      // Should contain triage, executor, reviewer in that order (first occurrence)
      expect(args.skillSelection).toMatchObject({
        projectRootDir: projectRoot,
        requestedSkillNames: ["triage", "executor", "reviewer"],
      });
    });

    it("uses role fallback skillSelection when assigned agent has no skills", async () => {
      const args = await captureCreateFnAgentArgs({
        assignedAgentId: "agent-001",
        assignedAgentSkills: [],
      });

      expect(args).not.toBeNull();
      expect(args.skillSelection).toMatchObject({
        projectRootDir: projectRoot,
        requestedSkillNames: expect.arrayContaining(["fusion"]),
        sessionPurpose: "executor",
      });
    });

    it("uses role fallback skillSelection when no assigned agent", async () => {
      const args = await captureCreateFnAgentArgs({});

      expect(args).not.toBeNull();
      expect(args.skillSelection).toMatchObject({
        projectRootDir: projectRoot,
        requestedSkillNames: expect.arrayContaining(["fusion"]),
        sessionPurpose: "executor",
      });
    });
  });

  describe("step-session mode (runStepsInNewSessions: true)", () => {
    // Ownership: executor tests verify skillSelection is wired into StepSessionExecutor
    // constructor args. step-session-executor tests own downstream forwarding to createFnAgent.

    async function captureStepSessionCtorOptions(options?: {
      assignedAgentId?: string;
      assignedAgentSkills?: string[];
    }) {
      const { assignedAgentId, assignedAgentSkills } = options || {};

      const mockAgentStore = {
        getAgent: vi.fn().mockImplementation(async (id: string) => {
          if (id === assignedAgentId) {
            return {
              id,
              name: "Test Agent",
              role: "executor",
              state: "idle",
              metadata: { skills: assignedAgentSkills || [] },
            };
          }
          return null;
        }),
      };

      const store = createMockStore();
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        runStepsInNewSessions: true,
      });
      store.getTask.mockResolvedValue({
        id: "FN-SKILL-SS",
        title: "Skill Test Step-Session",
        description: "Test skill selection in step-session mode",
        column: "in-progress",
        dependencies: [],
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
        currentStep: 0,
        log: [],
        assignedAgentId,
        prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check\n### Step 1: Implement\n- [ ] code",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        baseCommitSha: "abc123",
        enabledWorkflowSteps: [],
      });

      const executor = new TaskExecutor(store, projectRoot, { agentStore: mockAgentStore as any });
      await executor.execute({
        id: "FN-SKILL-SS",
        title: "Skill Test Step-Session",
        description: "Test skill selection in step-session mode",
        column: "in-progress",
        dependencies: [],
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
        currentStep: 0,
        log: [],
        assignedAgentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      expect(mockedStepSessionExecutor).toHaveBeenCalled();
      return mockedStepSessionExecutor.mock.calls[mockedStepSessionExecutor.mock.calls.length - 1][0];
    }

    it("passes skillSelection to StepSessionExecutor when assigned agent has skills", async () => {
      const ctorOptions = await captureStepSessionCtorOptions({
        assignedAgentId: "agent-001",
        assignedAgentSkills: ["triage", "executor"],
      });

      expect(ctorOptions).toHaveProperty("skillSelection");
      expect(ctorOptions.skillSelection).toMatchObject({
        projectRootDir: projectRoot,
        requestedSkillNames: expect.arrayContaining(["triage", "executor"]),
        sessionPurpose: "executor",
      });
    });

    it("uses role fallback skillSelection when assigned agent has no skills", async () => {
      const ctorOptions = await captureStepSessionCtorOptions({
        assignedAgentId: "agent-001",
        assignedAgentSkills: [],
      });

      // No explicit agent skills → executor falls back to built-in fusion skill context
      expect(ctorOptions.skillSelection).toMatchObject({
        projectRootDir: projectRoot,
        requestedSkillNames: expect.arrayContaining(["fusion"]),
        sessionPurpose: "executor",
      });
    });

    it("uses role fallback skillSelection when no assigned agent", async () => {
      const ctorOptions = await captureStepSessionCtorOptions({});

      // No assigned agent → executor falls back to built-in fusion skill context
      expect(ctorOptions.skillSelection).toMatchObject({
        projectRootDir: projectRoot,
        requestedSkillNames: expect.arrayContaining(["fusion"]),
        sessionPurpose: "executor",
      });
    });
  });
});

// ── Agent Messaging Tool Tests ────────────────────────────────────────

describe("TaskExecutor messaging tools", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf-id"),
          branchWithSummary: vi.fn(),
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
    } as any);
  });

  /**
   * Helper: execute a task and capture the customTools array passed to createFnAgent.
   */
  async function captureCustomTools(options?: {
    messageStore?: unknown;
    agentStore?: unknown;
    assignedAgentId?: string;
    executionMode?: "standard" | "fast";
  }): Promise<any[]> {
    const { messageStore, agentStore, assignedAgentId, executionMode } = options || {};
    let captured: any[] = [];

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      captured = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-id"),
            branchWithSummary: vi.fn(),
            navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
          },
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
      } as any;
    });

    const store = createMockStore();
    // Override getTask to return the correct assignedAgentId and executionMode
    store.getTask.mockImplementation(async (id: string) => ({
      id,
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      assignedAgentId,
      executionMode,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const taskExecutor = new TaskExecutor(store, "/tmp/test", {
      messageStore: messageStore as any,
      agentStore: agentStore as any,
    });

    await taskExecutor.execute({
      id: "FN-MSG",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      assignedAgentId,
      executionMode,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return captured;
  }

  it("includes fn_send_message when messageStore and assignedAgentId are available", async () => {
    const mockMessageStore = {
      sendMessage: vi.fn().mockReturnValue({ id: "msg-001" }),
    };
    const tools = await captureCustomTools({
      messageStore: mockMessageStore,
      assignedAgentId: "agent-001",
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("fn_send_message");
  });

  it("includes fn_read_messages when messageStore and assignedAgentId are available", async () => {
    const mockMessageStore = {
      sendMessage: vi.fn().mockReturnValue({ id: "msg-001" }),
      getInbox: vi.fn().mockReturnValue([]),
    };
    const tools = await captureCustomTools({
      messageStore: mockMessageStore,
      assignedAgentId: "agent-001",
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("fn_read_messages");
  });

  it("excludes fn_read_messages when messageStore is not provided", async () => {
    const tools = await captureCustomTools({
      assignedAgentId: "agent-001",
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("fn_read_messages");
  });

  it("excludes fn_read_messages when assignedAgentId is not provided", async () => {
    const mockMessageStore = {
      sendMessage: vi.fn().mockReturnValue({ id: "msg-001" }),
      getInbox: vi.fn().mockReturnValue([]),
    };
    const tools = await captureCustomTools({
      messageStore: mockMessageStore,
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("fn_read_messages");
  });

  it("excludes messaging tools when messageStore is not provided", async () => {
    const tools = await captureCustomTools({
      assignedAgentId: "agent-001",
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("fn_send_message");
    expect(toolNames).not.toContain("fn_read_messages");
  });

  it("includes fn_list_agents and fn_delegate_task when agentStore is available", async () => {
    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
      getAgent: vi.fn().mockResolvedValue(null),
    };
    const tools = await captureCustomTools({
      agentStore: mockAgentStore,
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("fn_list_agents");
    expect(toolNames).toContain("fn_delegate_task");
  });

  it("excludes delegation tools when agentStore is not provided", async () => {
    const tools = await captureCustomTools({});

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("fn_list_agents");
    expect(toolNames).not.toContain("fn_delegate_task");
  });

  describe("fast mode", () => {
    beforeEach(() => {
      resetExecutorMocks();
      mockedExistsSync.mockReturnValue(true);
    });

    it("excludes fn_review_step tool when executionMode is 'fast'", async () => {
      const tools = await captureCustomTools({
        executionMode: "fast",
      });

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).not.toContain("fn_review_step");
    });

    it("includes fn_task_update and fn_task_done tools in fast mode", async () => {
      const tools = await captureCustomTools({
        executionMode: "fast",
      });

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("fn_task_update");
      expect(toolNames).toContain("fn_task_done");
    });

    it("includes fn_review_step tool when executionMode is 'standard'", async () => {
      const tools = await captureCustomTools({
        executionMode: "standard",
      });

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("fn_review_step");
    });

    it("includes fn_review_step tool when executionMode is undefined (defaults to standard)", async () => {
      const tools = await captureCustomTools({});

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain("fn_review_step");
    });

    it("logs executor model usage when execution starts", async () => {
      const store = createMockStore();
      store.getTask.mockResolvedValue({
        id: "FN-001",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        executionMode: "fast",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      mockedCreateFnAgent.mockResolvedValue({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        },
      } as any);

      const executor = new TaskExecutor(store, "/tmp/test");
      await executor.execute({
        id: "FN-001",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        executionMode: "fast",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Verify logEntry was called (indicates executor is running)
      expect(store.logEntry).toHaveBeenCalled();
    });
  });

  describe("Fast mode completion path", () => {
    beforeEach(() => {
      resetExecutorMocks();
      mockedExistsSync.mockReturnValue(false);
    });

    it("skips workflow steps in fast mode when task completes", async () => {
      const store = createMockStore();

      // Task with workflow steps enabled AND fast mode
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
        executionMode: "fast",
        prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Mock workflow step exists
      store.getWorkflowStep.mockResolvedValue({
        id: "WS-001",
        name: "Docs Review",
        description: "Check documentation",
        prompt: "Review docs.",
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Mock agent with fn_task_done
      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
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
        executionMode: "fast",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Verify task moved to in-review
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");

      // Verify onComplete was called
      expect(onComplete).toHaveBeenCalled();

      // Verify workflow step was NOT called (fast mode skips workflow steps)
      // The agent should only be called once (main execution), not twice (main + workflow)
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    });

    it("still runs workflow steps in standard mode when task completes", async () => {
      const store = createMockStore();

      // Task with workflow steps enabled in standard mode
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
        executionMode: "standard",
        prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Mock workflow step exists
      store.getWorkflowStep.mockResolvedValue({
        id: "WS-001",
        name: "Docs Review",
        description: "Check documentation",
        prompt: "Review docs.",
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Track agent calls
      let callIdx = 0;
      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
        callIdx++;
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            if (callIdx === 1) {
              // Main execution — find and trigger fn_task_done
              const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
              if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
            } else {
              // Workflow step — no fn_task_done needed
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

      const executor = new TaskExecutor(store, "/tmp/test");

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
        executionMode: "standard",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Verify task moved to in-review
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");

      // Verify workflow step WAS called (standard mode runs workflow steps)
      // Agent should be called twice: main execution + workflow step
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    });

    it("still enforces fn_task_done requirement in fast mode", async () => {
      const store = createMockStore();

      // Task in fast mode
      store.getTask.mockResolvedValue({
        id: "FN-001",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [{ name: "Preflight", status: "pending" }],
        currentStep: 0,
        log: [],
        executionMode: "fast",
        prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Mock agent that exits WITHOUT calling fn_task_done
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
        steps: [{ name: "Preflight", status: "pending" }],
        currentStep: 0,
        log: [],
        executionMode: "fast",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Fast mode should still enforce fn_task_done requirement.
      // While retry budget remains, failures requeue instead of becoming terminal.
      expect(onError).toHaveBeenCalled();
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({
          status: "queued",
          error: null,
          taskDoneRetryCount: 1,
        }),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    });

    it("still checks completion blockers in fast mode", async () => {
      const store = createMockStore();

      // Task in fast mode with no workflow steps
      store.getTask.mockResolvedValue({
        id: "FN-001",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        executionMode: "fast",
        prompt: "# test\n## Steps\n",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Mock agent with fn_task_done
      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
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
      }) as any);

      const onComplete = vi.fn();
      const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

      await executor.execute({
        id: "FN-001",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        executionMode: "fast",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Verify task completed normally even without workflow steps
      // Completion blockers (test/build/typecheck) are checked via getTaskCompletionBlocker
      // which is called before finalizing
      expect(onComplete).toHaveBeenCalled();
    });
  });
});

describe("determineRevisionResetStart", () => {
  const steps = [
    { name: "Preflight" },
    { name: "Reposition the agent badge in TaskCard.tsx" },
    { name: "Restyle `.card-agent-badge` and add `.card-agent-row` in styles.css" },
    { name: "Update tests" },
    { name: "Testing & Verification" },
    { name: "Documentation & Delivery" },
  ];

  it("skips Preflight when feedback targets a later step", () => {
    // Feedback is phrased to hit step 2's "restyle" without also mentioning
    // step 1's distinctive tokens (reposition / badge / taskcard / agent).
    const feedback = "The card styling needs more contrast — restyle the class tokens.";
    expect(determineRevisionResetStart(steps, feedback)).toBe(2);
  });

  it("matches earliest step when multiple step names are mentioned", () => {
    const feedback = "The reposition logic is off, and the restyle tokens also need a second pass.";
    expect(determineRevisionResetStart(steps, feedback)).toBe(1);
  });

  it("falls back to first non-Preflight step when feedback matches nothing", () => {
    const feedback = "Please improve overall polish and typography hierarchy.";
    expect(determineRevisionResetStart(steps, feedback)).toBe(1);
  });

  it("never resets a Preflight step even if feedback somehow mentions preflight", () => {
    const feedback = "Preflight context looks wrong; restyle the row as well.";
    // Step 0 is Preflight → skipped. Earliest remaining match is step 2 (restyle).
    expect(determineRevisionResetStart(steps, feedback)).toBe(2);
  });

  it("is case-insensitive across both feedback and step names", () => {
    const feedback = "RESTYLE the component, please.";
    expect(determineRevisionResetStart(steps, feedback)).toBe(2);
  });

  it("returns 0 when there is no Preflight and no match", () => {
    const noPreflight = [{ name: "Apply Fix" }, { name: "Testing & Verification" }];
    expect(determineRevisionResetStart(noPreflight, "please improve polish")).toBe(0);
  });

  it("returns steps.length for an empty step list (nothing to reset)", () => {
    expect(determineRevisionResetStart([], "anything")).toBe(0);
  });

  it("returns steps.length when only a Preflight step exists (nothing to reset)", () => {
    expect(determineRevisionResetStart([{ name: "Preflight" }], "anything")).toBe(1);
  });

  it("ignores short tokens like 'test' to avoid matching 'Update tests' for generic feedback", () => {
    // "test" is 4 chars — below the 5+ char threshold — so generic feedback
    // mentioning "test" alone should not target the "Update tests" step.
    const feedback = "Please test this by clicking.";
    expect(determineRevisionResetStart(steps, feedback)).toBe(1);
  });
});

describe("Executor verification gate (FN-3345)", () => {
  const mockedVerification = vi.mocked(mockedRunVerificationCommand);

  beforeEach(() => {
    resetExecutorMocks();
    mockExecuteAll.mockResolvedValue([]);
    mockTerminateAllSessions.mockResolvedValue(undefined);
    mockCleanup.mockResolvedValue(undefined);
    mockedVerification.mockReset();
  });

  /** Helper to create a step-session store with default settings */
  function createVerificationStore(settingsOverrides: Record<string, unknown> = {}) {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      runStepsInNewSessions: true,
      maxParallelSteps: 2,
      ...settingsOverrides,
    });
    store.getTask.mockResolvedValue({
      id: "FN-3345",
      title: "Verification gate test task",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check\n### Step 1: Implement\n- [ ] code",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseCommitSha: "abc123",
      enabledWorkflowSteps: [],
    });
    return store;
  }

  /** Helper to create a task for step-session mode */
  function createVerificationTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "FN-3345",
      title: "Verification gate test task",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("no testCommand/buildCommand configured → gate skipped → task moves to in-review", async () => {
    const store = createVerificationStore({});
    mockExecuteAll.mockResolvedValue([
      { stepIndex: 0, success: true, retries: 0 },
      { stepIndex: 1, success: true, retries: 0 },
    ]);

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute(createVerificationTask());

    // Verification command should NOT have been called
    expect(mockedVerification).not.toHaveBeenCalled();
    // Task should move to in-review normally
    expect(store.moveTask).toHaveBeenCalledWith("FN-3345", "in-review");
  });

  it("testCommand configured, verification passes → task moves to in-review", async () => {
    const store = createVerificationStore({ testCommand: "pnpm test" });
    mockExecuteAll.mockResolvedValue([
      { stepIndex: 0, success: true, retries: 0 },
      { stepIndex: 1, success: true, retries: 0 },
    ]);
    mockedVerification.mockResolvedValue({
      command: "pnpm test",
      exitCode: 0,
      stdout: "all passed",
      stderr: "",
      success: true,
    });

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute(createVerificationTask());

    // Verification command should have been called
    expect(mockedVerification).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".worktrees"),
      "FN-3345",
      "pnpm test",
      "test",
      undefined,
      expect.anything(),
      "executor",
      expect.any(Object),
    );
    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-3345", "in-review");
  });

  it("verification fails, fix agent succeeds on first attempt → task moves to in-review", async () => {
    const store = createVerificationStore({
      testCommand: "pnpm test",
      verificationFixRetries: 3,
    });
    mockExecuteAll.mockResolvedValue([
      { stepIndex: 0, success: true, retries: 0 },
      { stepIndex: 1, success: true, retries: 0 },
    ]);

    // First verification fails, then re-verification passes after fix
    mockedVerification
      .mockResolvedValueOnce({
        command: "pnpm test",
        exitCode: 1,
        stdout: "",
        stderr: "1 test failed",
        success: false,
      })
      // Re-verification after fix passes
      .mockResolvedValue({
        command: "pnpm test",
        exitCode: 0,
        stdout: "all passed",
        stderr: "",
        success: true,
      });

    // Mock the fix agent session
    mockedCreateFnAgent.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-fix-1") },
        state: {},
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute(createVerificationTask());

    // First call: initial verification (fails)
    // Second call: re-verification after fix (passes)
    expect(mockedVerification).toHaveBeenCalledTimes(2);
    // Fix agent should have been created
    expect(mockedCreateFnAgent).toHaveBeenCalled();
    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-3345", "in-review");
  });

  it("verification fails, fix agent fails all attempts → task sent back to in-progress", async () => {
    const store = createVerificationStore({
      testCommand: "pnpm test",
      verificationFixRetries: 2, // 2 fix attempts
    });
    mockExecuteAll.mockResolvedValue([
      { stepIndex: 0, success: true, retries: 0 },
      { stepIndex: 1, success: true, retries: 0 },
    ]);

    // All verification calls fail
    mockedVerification.mockResolvedValue({
      command: "pnpm test",
      exitCode: 1,
      stdout: "",
      stderr: "1 test failed",
      success: false,
    });

    // Mock the fix agent session (2 attempts)
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-fix") },
        state: {},
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute(createVerificationTask());

    // Fix agent should have been called twice (2 attempts)
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    // Task should NOT move to in-review
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-3345", "in-review");
    // Task should have been sent back for merge remediation with active merge status
    expect(store.addTaskComment).toHaveBeenCalledWith(
      "FN-3345",
      expect.stringContaining("Deterministic verification failed"),
      "agent",
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-3345",
      expect.objectContaining({ status: "merging-fix" }),
    );
  });

  it("test fails then fix succeeds → re-verification runs both test AND build", async () => {
    const store = createVerificationStore({
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
      verificationFixRetries: 3,
    });
    mockExecuteAll.mockResolvedValue([
      { stepIndex: 0, success: true, retries: 0 },
      { stepIndex: 1, success: true, retries: 0 },
    ]);

    // Initial verification: test fails (build is never reached because test fails first)
    // Re-verification after fix: both test and build pass
    mockedVerification
      .mockResolvedValueOnce({
        command: "pnpm test",
        exitCode: 1,
        stdout: "",
        stderr: "1 test failed",
        success: false,
      })
      // Re-verification: test passes
      .mockResolvedValueOnce({
        command: "pnpm test",
        exitCode: 0,
        stdout: "all passed",
        stderr: "",
        success: true,
      })
      // Re-verification: build passes
      .mockResolvedValueOnce({
        command: "pnpm build",
        exitCode: 0,
        stdout: "build ok",
        stderr: "",
        success: true,
      });

    // Mock the fix agent session
    mockedCreateFnAgent.mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-fix-1") },
        state: {},
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute(createVerificationTask());

    // Verification should have been called 3 times:
    // 1. Initial test (fails)
    // 2. Re-verification test (passes)
    // 3. Re-verification build (passes)
    expect(mockedVerification).toHaveBeenCalledTimes(3);
    // Second call should be test
    expect(mockedVerification).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining(".worktrees"),
      "FN-3345",
      "pnpm test",
      "test",
      undefined,
      expect.anything(),
      "executor",
      expect.any(Object),
    );
    // Third call should be build
    expect(mockedVerification).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.stringContaining(".worktrees"),
      "FN-3345",
      "pnpm build",
      "build",
      undefined,
      expect.anything(),
      "executor",
      expect.any(Object),
    );
    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-3345", "in-review");
  });

  it("fast mode → verification gate is skipped", async () => {
    const store = createVerificationStore({
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
    });
    mockExecuteAll.mockResolvedValue([
      { stepIndex: 0, success: true, retries: 0 },
      { stepIndex: 1, success: true, retries: 0 },
    ]);

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute(createVerificationTask({ executionMode: "fast" }));

    // Verification command should NOT have been called (fast mode)
    expect(mockedVerification).not.toHaveBeenCalled();
    // Task should move to in-review normally
    expect(store.moveTask).toHaveBeenCalledWith("FN-3345", "in-review");
  });

  it("verificationFixRetries is 0 → task sent back immediately without fix attempt", async () => {
    const store = createVerificationStore({
      testCommand: "pnpm test",
      verificationFixRetries: 0,
    });
    mockExecuteAll.mockResolvedValue([
      { stepIndex: 0, success: true, retries: 0 },
      { stepIndex: 1, success: true, retries: 0 },
    ]);

    // Verification fails
    mockedVerification.mockResolvedValue({
      command: "pnpm test",
      exitCode: 1,
      stdout: "",
      stderr: "1 test failed",
      success: false,
    });

    const executor = new TaskExecutor(store, "/tmp/test", {});
    await executor.execute(createVerificationTask());

    // Fix agent should NOT have been created (0 retries)
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    // Task should NOT move to in-review
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-3345", "in-review");
    // Task should have been sent back for merge remediation with active merge status
    expect(store.addTaskComment).toHaveBeenCalledWith(
      "FN-3345",
      expect.stringContaining("Deterministic verification failed"),
      "agent",
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-3345",
      expect.objectContaining({ status: "merging-fix" }),
    );
  });
});

// ---------------------------------------------------------------------------
// allowParallelExecution gate
// ---------------------------------------------------------------------------

describe("allowParallelExecution heartbeat gate", () => {
  const TASK_BASE: Omit<Task, "id"> = {
    title: "Gated task",
    description: "Test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function makeAgentStore(opts: {
    ephemeral: boolean;
    allowParallelExecution?: boolean;
    hasActiveRun: boolean;
  }) {
    const agent = {
      id: "agent-perm-1",
      name: "Permanent Agent",
      role: "executor",
      state: "running",
      metadata: opts.ephemeral ? { agentKind: "task-worker" } : {},
      runtimeConfig: opts.allowParallelExecution !== undefined
        ? { allowParallelExecution: opts.allowParallelExecution }
        : {},
    };
    return {
      getAgent: vi.fn().mockResolvedValue(agent),
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(
        opts.hasActiveRun ? { id: "run-1", status: "active" } : null,
      ),
    };
  }

  beforeEach(() => {
    resetExecutorMocks();
  });

  it.each([
    {
      label: "permanent agent, allowParallelExecution=false, active heartbeat run → skipped",
      ephemeral: false,
      allowParallelExecution: false as boolean | undefined,
      hasActiveRun: true,
      expectExecute: false,
    },
    {
      label: "permanent agent, allowParallelExecution=true, active heartbeat run → proceeds",
      ephemeral: false,
      allowParallelExecution: true as boolean | undefined,
      hasActiveRun: true,
      expectExecute: true,
    },
    {
      label: "permanent agent, allowParallelExecution=false, no heartbeat run → proceeds",
      ephemeral: false,
      allowParallelExecution: false as boolean | undefined,
      hasActiveRun: false,
      expectExecute: true,
    },
    {
      label: "ephemeral agent, allowParallelExecution=false, active heartbeat run → proceeds (flag ignored)",
      ephemeral: true,
      allowParallelExecution: false as boolean | undefined,
      hasActiveRun: true,
      expectExecute: true,
    },
  ])("$label", async ({ ephemeral, allowParallelExecution, hasActiveRun, expectExecute }) => {
    const agentStore = makeAgentStore({ ephemeral, allowParallelExecution, hasActiveRun });
    const store = createMockStore();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { agentStore: agentStore as any });

    await executor.execute({
      ...TASK_BASE,
      id: "FN-GATE-1",
      assignedAgentId: "agent-perm-1",
    });

    if (expectExecute) {
      expect(mockedCreateFnAgent).toHaveBeenCalled();
    } else {
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    }
  });

  it("builds permanent-agent gating context for durable assigned agents", () => {
    const agentStore = makeAgentStore({ ephemeral: false, allowParallelExecution: true, hasActiveRun: false });
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore: agentStore as any });

    const context = (executor as any).buildPermanentAgentGatingContext("FN-GATE-2", {
      id: "agent-perm-1",
      name: "Perm Agent",
      type: "normal",
      permissionPolicy: {
        presetId: "approval-required",
        rules: {
          git_write: "require-approval",
          file_write_delete: "require-approval",
          command_execution: "require-approval",
          network_api: "require-approval",
          task_agent_mutation: "require-approval",
        },
      },
    });

    expect(context?.permissionPolicy?.presetId).toBe("approval-required");
    expect(context?.taskId).toBe("FN-GATE-2");
    expect(typeof context?.createApprovalRequest).toBe("function");
    expect(typeof context?.findPendingApprovalRequest).toBe("function");
  });

  it("omits permanent-agent gating context when no agent is assigned", async () => {
    const agentStore = makeAgentStore({ ephemeral: false, allowParallelExecution: true, hasActiveRun: false });
    const store = createMockStore();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { agentStore: agentStore as any });

    await executor.execute({
      ...TASK_BASE,
      id: "FN-GATE-3",
      assignedAgentId: undefined,
    });

    const hasPermanentGating = mockedCreateFnAgent.mock.calls
      .map((call) => call[0] as { permanentAgentGating?: unknown })
      .some((args) => args.permanentAgentGating !== undefined);
    expect(hasPermanentGating).toBe(false);
  });
});
