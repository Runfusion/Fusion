import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPlanReviewSatisfied, isTaskAwaitingPlanning } from "@fusion/core";
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TriageProcessor } from "../triage.js";
import {
  EXCLUDED_REVISION_LOG_PREVIEW,
  producePlanReviewRevisedState,
  PLAN_REVIEW_NOTES,
  PLAN_REVIEW_OUTPUT,
  REJECTED_PLAN_DRAFT,
} from "./_plan-review-outcome-states.js";

/*
 * Bug A (part 1): when re-planning and no explicit user/AI-comment feedback exists,
 * the planner prompt must be seeded from the most recent Plan Review REVISE output
 * stored in workflowStepResults — otherwise the planner re-plans with
 * `feedback: undefined` and regenerates the same rejected plan.
 *
 * FNXC:PlanReviewReplan 2026-07-15-11:15:
 * Also seed the rejected PROMPT.md body so buildSpecificationPrompt uses surgical
 * revision mode (Existing Specification + Revision Feedback) instead of a full
 * rewrite from title/description — the main non-convergence failure mode.
 */

const { mockCreateResolvedAgentSession, mockPromptWithFallback } = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  mockPromptWithFallback: vi.fn(),
}));

vi.mock("../agents/agent-session-helpers.js", () => ({
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

  it("seeds the planner prompt from the latest durable Plan Review REVISE notes when no comment feedback exists", async () => {
    const reviseOutput = "PLAN-REVIEW-REVISE-MARKER: the plan omits the required migration step and must add it.";
    const rejectedDraft = "# Existing rejected plan\n\n## Mission\nDo not lose this body during replan.\n";
    const task = createTask({
      id: "FN-REPLAN-FEEDBACK-WSR",
      // The activity log is only a bounded operator preview. The full durable
      // remediation contract comes from workflowStepResults.
      log: [{
        timestamp: "2026-07-13T00:00:20.000Z",
        action: "AI spec revision requested",
        outcome: "Revision source: plan-review/plan-review\nTRUNCATED-PREVIEW-MUST-NOT-WIN",
      }],
      workflowStepResults: [
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          phase: "pre-merge",
          status: "failed",
          verdict: "REVISE",
          output: "Reviewer prose may be incomplete.",
          notes: reviseOutput,
        },
      ],
    });
    rootDir = await createRoot(task.id);
    await writeFile(join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), rejectedDraft, "utf-8");
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
    expect(capturedPrompt).not.toContain("TRUNCATED-PREVIEW-MUST-NOT-WIN");
    // Surgical revision: rejected PROMPT body + feedback, not a fresh respec from title alone.
    expect(capturedPrompt).toContain("Revise this task");
    expect(capturedPrompt).toContain("Existing Specification");
    expect(capturedPrompt).toContain("Do not lose this body during replan");
    expect(capturedPrompt).toContain("Converge — do not rewrite from scratch");
    expect(capturedPrompt).toContain("PLAN-REVIEW-REVISE-MARKER");
    expect(capturedPrompt).not.toContain("Re-specify this task");
  });

  it.each([
    { label: "notes with a rejected draft", feedbackField: "notes" as const, expectedFeedback: PLAN_REVIEW_NOTES, writeDraft: true },
    { label: "output fallback with a rejected draft", feedbackField: "output" as const, expectedFeedback: PLAN_REVIEW_OUTPUT, writeDraft: true },
    { label: "notes without a rejected draft", feedbackField: "notes" as const, expectedFeedback: PLAN_REVIEW_NOTES, writeDraft: false },
  ])("continues the real REVISE output chain from $label", async ({ feedbackField, expectedFeedback, writeDraft }) => {
    const produced = await producePlanReviewRevisedState({
      id: `FN-299-${feedbackField}-${writeDraft ? "DRAFT" : "NO-DRAFT"}`,
      feedbackField,
    });
    const revised = produced.task;
    if (!writeDraft) revised.prompt = undefined;
    expect(produced.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "needs-replan", error: null }),
    ]));
    expect(produced.logs.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      "AI spec revision requested",
      expect.stringContaining("Plan Review requested a plan revision"),
    ]));
    rootDir = await createRoot(revised.id);
    if (writeDraft) {
      await writeFile(join(rootDir, ".fusion", "tasks", revised.id, "PROMPT.md"), REJECTED_PLAN_DRAFT, "utf-8");
    }
    const harness = createMutableStore(revised);
    const processor = new TriageProcessor(harness.store, rootDir);
    let capturedPrompt: string | undefined;
    mockPromptWithFallback.mockImplementationOnce(async (_session: unknown, agentPrompt: string) => {
      capturedPrompt = agentPrompt;
      processor.markStuckAborted(revised.id);
    });

    expect(isTaskAwaitingPlanning(revised, REJECTED_PLAN_DRAFT)).toBe(true);
    expect(isTaskAwaitingPlanning({ ...revised, status: null }, REJECTED_PLAN_DRAFT)).toBe(false);
    const executionQueueArmed = !revised.status
      && !revised.paused
      && !revised.userPaused
      && (Boolean(revised.approvedPlanFingerprint)
        || revised.workflowStepResults?.some(isPlanReviewSatisfied) === true);
    expect(executionQueueArmed).toBe(false);

    await processor.specifyTask(harness.currentTask);

    expect(capturedPrompt).toContain(expectedFeedback);
    expect(capturedPrompt).not.toContain(EXCLUDED_REVISION_LOG_PREVIEW);
    if (writeDraft) {
      expect(capturedPrompt).toContain("## Cumulative Revision Decision Ledger");
      expect(capturedPrompt).toContain("### PR1");
      expect(capturedPrompt).toContain("## Revision Instructions");
      expect(capturedPrompt).toContain("## Existing Specification");
      expect(capturedPrompt).toContain("Preserve this rejected draft while revising it surgically.");
    } else {
      expect(capturedPrompt).toContain("Re-specify this task");
      expect(capturedPrompt).not.toContain("## Existing Specification");
    }
  });

  it("prefers an explicit AI spec revision comment over the workflowStepResults fallback", async () => {
    const reviseOutput = "PLAN-REVIEW-REVISE-MARKER: stale fallback that must not win.";
    const explicitFeedback = "EXPLICIT-COMMENT-FEEDBACK: address the auth edge case first.";
    const rejectedDraft = "# Rejected plan body\n\nKeep this under surgical revision.\n";
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
          priorAttempts: [{
            workflowStepId: "plan-review",
            workflowStepName: "Plan Review",
            phase: "pre-merge",
            status: "failed",
            verdict: "REVISE",
            notes: "PRIOR-PLAN-REVIEW-FEEDBACK: preserve the lifecycle-writer audit.",
          }],
        },
      ],
    });
    rootDir = await createRoot(task.id);
    await writeFile(join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md"), rejectedDraft, "utf-8");
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
    expect(capturedPrompt).toContain("Cumulative Revision Decision Ledger");
    expect(capturedPrompt).toContain("### PR1");
    expect(capturedPrompt).toContain("PRIOR-PLAN-REVIEW-FEEDBACK");
    const ledger = capturedPrompt?.split("## Cumulative Revision Decision Ledger\n", 2)[1]
      ?.split("\n\nRevise the specification above", 1)[0];
    expect(ledger).toBeDefined();
    expect(ledger).not.toContain("EXPLICIT-COMMENT-FEEDBACK");
    expect(capturedPrompt).toContain("Existing Specification");
    expect(capturedPrompt).toContain("Keep this under surgical revision");
  });
});
