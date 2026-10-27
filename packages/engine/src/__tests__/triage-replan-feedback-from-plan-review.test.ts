import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TriageProcessor } from "../triage.js";

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
    comments: (task as Partial<TaskDetail>).comments ?? [],
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

/**
 * FNXC:ReplanFeedback 2026-10-27-21:47:
 * The scheduler passes specifyTask() a `listTasks({ slim: true })` row, and the slim
 * serializer always returns `log: []`. The feedback lookup must therefore read the log
 * of the freshly loaded task, otherwise `spec/revise` feedback never reaches the planner.
 */
function slimRow(task: Task): Task {
  return { ...task, log: [] } as Task;
}

describe("triage replan feedback when the scheduler passes a slim task row", () => {
  let rootDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession();
  });

  afterEach(async () => {
    await cleanup(rootDir);
    rootDir = undefined;
  });

  async function capturePromptFor(task: Task, slim = true): Promise<string | undefined> {
    rootDir = await createRoot(task.id);
    await writeFile(
      join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md"),
      "# Existing plan\n\nKeep this body under surgical revision.\n",
      "utf-8",
    );
    const harness = createMutableStore(task);
    const processor = new TriageProcessor(harness.store, rootDir);
    let capturedPrompt: string | undefined;
    mockPromptWithFallback.mockImplementationOnce(async (_session: unknown, agentPrompt: string) => {
      capturedPrompt = agentPrompt;
      processor.markStuckAborted(task.id);
    });
    await processor.specifyTask(slim ? slimRow(harness.currentTask) : harness.currentTask);
    return capturedPrompt;
  }

  it("delivers spec/revise feedback that exists only in the stored task log", async () => {
    const revision = "SPEC-REVISE-MARKER: replace Step 2 with the exact requested wording.";
    const prompt = await capturePromptFor(createTask({
      id: "FN-REPLAN-SLIM-REVISE",
      log: [{ timestamp: "2026-10-27T19:06:31.000Z", action: "AI spec revision requested", outcome: revision }],
    }));

    expect(prompt).toBeDefined();
    expect(prompt).toContain(revision);
    expect(prompt).toContain("Existing Specification");
    expect(prompt).toContain("Keep this body under surgical revision");
  });

  it("prefers a newer spec/revise over an older user comment", async () => {
    const revision = "SPEC-REVISE-MARKER: newest revision must win.";
    const staleComment = "STALE-COMMENT-MARKER: superseded note from an earlier day.";
    const task = createTask({
      id: "FN-REPLAN-SLIM-PRECEDENCE",
      log: [{ timestamp: "2026-10-27T15:30:00.000Z", action: "AI spec revision requested", outcome: revision }],
    });
    (task as Partial<TaskDetail>).comments = [
      { id: "c1", text: staleComment, author: "user", createdAt: "2026-10-26T10:00:00.000Z" },
    ] as TaskDetail["comments"];
    const prompt = await capturePromptFor(task);

    expect(prompt).toBeDefined();
    const revisionFeedback = prompt?.split("## Revision Feedback", 2)[1];
    expect(revisionFeedback).toBeDefined();
    expect(revisionFeedback).toContain(revision);
    expect(revisionFeedback?.split("\n\n## ", 1)[0]).not.toContain(staleComment);
  });

  it("still excludes Plan Review revision previews from the log lookup", async () => {
    const reviseNotes = "PLAN-REVIEW-REVISE-MARKER: durable reviewer notes.";
    const prompt = await capturePromptFor(createTask({
      id: "FN-REPLAN-SLIM-PLAN-REVIEW",
      log: [{
        timestamp: "2026-10-27T12:00:00.000Z",
        action: "AI spec revision requested",
        outcome: "Revision source: plan-review/plan-review\nTRUNCATED-PREVIEW-MUST-NOT-WIN",
      }],
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "failed",
        verdict: "REVISE",
        notes: reviseNotes,
      }],
    }));

    expect(prompt).toContain(reviseNotes);
    expect(prompt).not.toContain("TRUNCATED-PREVIEW-MUST-NOT-WIN");
  });

  it.each([true, false])("uses durable review notes after an older explicit revision (slim=%s)", async (slim) => {
    const oldRevision = "OLD-EXPLICIT-MUST-NOT-WIN";
    const notes = "CURRENT-REVIEW-NOTES: fix the missing cancellation path.";
    const task = createTask({
      log: [
        { timestamp: "2026-10-27T11:00:00.000Z", action: "AI spec revision requested", outcome: oldRevision },
        { timestamp: "2026-10-27T12:00:00.000Z", action: "AI spec revision requested", outcome: "Revision source: plan-review/plan-review\nPREVIEW-MUST-NOT-LEAK" },
      ],
      workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "failed", verdict: "REVISE", notes }],
    });
    const prompt = await capturePromptFor(task, slim);
    expect(prompt).toContain(notes);
    expect(prompt).not.toContain(oldRevision);
    expect(prompt).not.toContain("PREVIEW-MUST-NOT-LEAK");
    expect(prompt).toContain("Existing Specification");
    expect(prompt).toContain("Keep this body under surgical revision");
  });

  it.each([true, false])("uses durable review notes before an older user comment (slim=%s)", async (slim) => {
    const notes = "CURRENT-REVIEW-NOTES: add the lifecycle audit.";
    const oldComment = "OLD-USER-COMMENT-MUST-NOT-WIN";
    const task = createTask({
      log: [{ timestamp: "2026-10-27T12:00:00.000Z", action: "AI spec revision requested", outcome: "Plan Review requested a planning revision before execution.\nPREVIEW-MUST-NOT-LEAK" }],
      workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "failed", verdict: "REVISE", output: notes }],
    });
    (task as Partial<TaskDetail>).comments = [{ id: "old", text: oldComment, author: "user", createdAt: "2026-10-26T10:00:00.000Z" }] as TaskDetail["comments"];
    const prompt = await capturePromptFor(task, slim);
    expect(prompt).toContain(notes);
    expect(prompt).not.toContain("PREVIEW-MUST-NOT-LEAK");
    const feedback = prompt?.split("## Revision Feedback", 2)[1]?.split("\n\n## ", 1)[0];
    expect(feedback).toBeDefined();
    expect(feedback).not.toContain(oldComment);
  });

  it.each([true, false])("preserves an explicit revision after the review marker (slim=%s)", async (slim) => {
    const revision = "LATEST-EXPLICIT-REVISION: use the requested replacement.";
    const oldReview = "OLDER-REVIEW-MUST-NOT-WIN";
    const prompt = await capturePromptFor(createTask({
      log: [
        { timestamp: "2026-10-27T12:00:00.000Z", action: "AI spec revision requested", outcome: "Revision source: plan-review/plan-review\nPREVIEW-MUST-NOT-LEAK" },
        { timestamp: "2026-10-27T13:00:00.000Z", action: "AI spec revision requested", outcome: revision },
      ],
      workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "failed", verdict: "REVISE", notes: oldReview }],
    }), slim);
    expect(prompt).toContain(revision);
    expect(prompt).not.toContain(oldReview);
    expect(prompt).not.toContain("PREVIEW-MUST-NOT-LEAK");
  });


  it.each([true, false])("does not revive an old comment when a review marker has no durable feedback (slim=%s)", async (slim) => {
    const task = createTask({
      log: [{ timestamp: "2026-10-27T12:00:00.000Z", action: "AI spec revision requested", outcome: "Revision source: plan-review/plan-review\nPREVIEW-MUST-NOT-LEAK" }],
      workflowStepResults: [],
    });
    (task as Partial<TaskDetail>).comments = [{ id: "old", text: "OLD-USER-COMMENT-MUST-NOT-WIN", author: "user", createdAt: "2026-10-26T10:00:00.000Z" }] as TaskDetail["comments"];
    const prompt = await capturePromptFor(task, slim);
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain("PREVIEW-MUST-NOT-LEAK");
    expect(prompt).not.toContain("## Revision Feedback");
  });

});
