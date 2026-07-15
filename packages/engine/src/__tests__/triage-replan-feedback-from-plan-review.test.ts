import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TriageProcessor } from "../triage.js";

/*
 * Bug A (part 1): when re-planning and no explicit user/AI-comment feedback exists,
 * the planner prompt must be seeded from the most recent Plan Review REVISE output
 * stored in workflowStepResults — otherwise the planner re-plans with
 * `feedback: undefined` and regenerates the same rejected plan.
 */

const { mockCreateResolvedAgentSession, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../agent-session-helpers.js", () => ({
  createResolvedAgentSession: mockCreateResolvedAgentSession,
  extractRuntimeHint: vi.fn(),
  resolvePlanningSessionModel: vi.fn().mockReturnValue({ provider: "mock", modelId: "mock-model" }),
  resolveExecutorThinkingLevel: vi.fn(() => undefined),
  resolveExecutorFallbackThinkingLevel: vi.fn(() => undefined),
  resolvePlanningThinkingLevel: vi.fn(() => undefined),
  resolvePlanningFallbackThinkingLevel: vi.fn(() => undefined),
  resolveValidatorThinkingLevel: vi.fn(() => undefined),
  resolveValidatorFallbackThinkingLevel: vi.fn(() => undefined),
  resolveMergerThinkingLevel: vi.fn(() => undefined),
  resolveMergerFallbackThinkingLevel: vi.fn(() => undefined),
  resolveImplicitPlanningFallbackModel: vi.fn(() => ({ provider: undefined, modelId: undefined })),
}));

vi.mock("../pi.js", () => {
  class ModelFallbackExhaustedError extends Error {}
  return {
    describeModel: vi.fn().mockReturnValue("mock-model"),
    promptWithFallback: mockPromptWithFallback,
    formatModelMarkerDetails: vi.fn((model: string) => model),
    ModelFallbackExhaustedError,
  };
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-REPLAN-FEEDBACK",
    title: "Replan feedback source",
    description: "Re-plan a task that only has Plan Review REVISE feedback",
    column: "triage",
    status: "needs-replan",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function toDetail(task: Task): TaskDetail {
  return {
    ...task,
    attachments: [],
    comments: [],
    log: task.log ?? [],
  } as TaskDetail;
}

function createMutableStore(initialTask: Task, settings: Partial<Settings> = {}) {
  let currentTask: Task = { ...initialTask, log: [...(initialTask.log ?? [])] };
  const store = {
    getTask: vi.fn(async () => toDetail(currentTask)),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      pollIntervalMs: 60_000,
      maxConcurrent: 1,
      maxWorktrees: 1,
      autoMerge: true,
      groupOverlappingFiles: false,
      maxStuckKills: 6,
      requirePlanApproval: false,
      ...settings,
    } as Settings),
    getTaskDocument: vi.fn(async () => null),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => {
      currentTask = { ...currentTask, ...updates, updatedAt: "2026-07-13T00:01:00.000Z" } as Task;
      return currentTask;
    }),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      currentTask = { ...currentTask, column, status: null } as Task;
      return currentTask;
    }),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => {
      currentTask = {
        ...currentTask,
        log: [...(currentTask.log ?? []), { timestamp: new Date().toISOString(), action, outcome }],
      } as Task;
    }),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;

  return {
    store,
    get currentTask() {
      return currentTask;
    },
  };
}

async function createRoot(taskId: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-triage-replan-feedback-"));
  const taskDir = join(rootDir, ".fusion", "tasks", taskId);
  await mkdir(taskDir, { recursive: true });
  return rootDir;
}

function mockSession() {
  mockCreateResolvedAgentSession.mockResolvedValue({
    session: {
      state: {},
      sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      navigateTree: vi.fn(),
    },
  });
}

async function cleanup(rootDir: string | undefined) {
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe("triage replan feedback falls back to Plan Review REVISE output", () => {
  let rootDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession();
  });

  afterEach(async () => {
    await cleanup(rootDir);
    rootDir = undefined;
  });

  it("seeds the planner prompt from the latest plan-review REVISE output when no comment feedback exists", async () => {
    const reviseOutput = "PLAN-REVIEW-REVISE-MARKER: the plan omits the required migration step and must add it.";
    const task = createTask({
      id: "FN-REPLAN-FEEDBACK-WSR",
      // No user comments and no "AI spec revision requested" log entry — the only
      // available feedback is the Plan Review REVISE result in workflowStepResults.
      log: [],
      workflowStepResults: [
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          phase: "pre-merge",
          status: "failed",
          verdict: "REVISE",
          output: reviseOutput,
          notes: "Needs a migration step.",
        },
      ],
    });
    rootDir = await createRoot(task.id);
    const harness = createMutableStore(task);
    const processor = new TriageProcessor(harness.store, rootDir);

    let capturedPrompt: string | undefined;
    mockPromptWithFallback.mockImplementationOnce(async (_session: unknown, agentPrompt: string) => {
      capturedPrompt = agentPrompt;
      // Short-circuit the rest of planning; we only assert the prompt was seeded.
      processor.markStuckAborted(task.id);
    });

    await processor.specifyTask(harness.currentTask);

    expect(mockPromptWithFallback).toHaveBeenCalled();
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toContain(reviseOutput);
  });

  it("prefers an explicit AI spec revision comment over the workflowStepResults fallback", async () => {
    const reviseOutput = "PLAN-REVIEW-REVISE-MARKER: stale fallback that must not win.";
    const explicitFeedback = "EXPLICIT-COMMENT-FEEDBACK: address the auth edge case first.";
    const task = createTask({
      id: "FN-REPLAN-FEEDBACK-PRECEDENCE",
      log: [
        {
          timestamp: "2026-07-13T00:00:30.000Z",
          action: "AI spec revision requested",
          outcome: explicitFeedback,
        },
      ],
      workflowStepResults: [
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          phase: "pre-merge",
          status: "failed",
          verdict: "REVISE",
          output: reviseOutput,
        },
      ],
    });
    rootDir = await createRoot(task.id);
    const harness = createMutableStore(task);
    const processor = new TriageProcessor(harness.store, rootDir);

    let capturedPrompt: string | undefined;
    mockPromptWithFallback.mockImplementationOnce(async (_session: unknown, agentPrompt: string) => {
      capturedPrompt = agentPrompt;
      processor.markStuckAborted(task.id);
    });

    await processor.specifyTask(harness.currentTask);

    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toContain(explicitFeedback);
    expect(capturedPrompt).not.toContain(reviseOutput);
  });
});
