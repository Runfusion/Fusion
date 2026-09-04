import "./executor-test-helpers.js";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { Task, TaskStep, TaskStore } from "@fusion/core";
import { STEP_LEDGER_REFUSAL_MARKER_PREFIX, STEP_LEDGER_REOPEN_MARKER_PREFIX } from "@fusion/core";
import { startStepImpl, updateStepImpl } from "../../../core/src/task-store/merge-queue-ops.js";
import { appendRemediationStepsImpl } from "../../../core/src/task-store/remediation-step-ops.js";
import { appendReviewRemediationSteps } from "../executor/append-review-remediation-steps.js";
import { reopenLastStepForRevision } from "../executor/reopen-last-step-for-revision.js";
import { runTaskStep, type RunSingleStep, type RunTaskStepDeps } from "../execution/step-runner.js";

const COMPLETION_MARKER = "Task marked done by agent";

const REVISE_INFO = {
  nodeId: "code-review",
  stepName: "Code Review",
  phase: "pre-merge" as const,
  status: "failed" as const,
  verdict: "REVISE",
  reviewKind: "code" as const,
  feedback: "The implementation still truncates narrow-layout timestamps.",
  findings: [{
    id: "narrow-timestamp",
    title: "Dated Live timestamps are truncated instead of wrapping on narrow viewports",
    body: "Allow the full precise timestamp to remain visible at the mobile breakpoint.",
    filePath: "packages/dashboard/app/components/TaskChatTab.css",
    line: 42,
    severity: "major" as const,
    resolution: "open" as const,
  }],
};

export function makeCompletedReviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-277",
    title: "Resume review remediation",
    description: "Run appended review Fix steps after completion.",
    priority: "normal",
    column: "in-progress",
    status: null,
    error: null,
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      { name: "Testing & Verification", status: "done" },
    ],
    currentStep: 3,
    prompt: [
      "# Task FN-277",
      "",
      "## File Scope",
      "- `packages/dashboard/app/components/TaskChatTab.css`",
    ].join("\n"),
    worktree: "/virtual/fn-277",
    modifiedFiles: ["packages/dashboard/app/components/TaskChatTab.css"],
    log: [
      { timestamp: "2026-09-01T01:29:39.372Z", action: "Step 2 (Testing & Verification) → done" },
      { timestamp: "2026-09-01T01:29:45.302Z", action: COMPLETION_MARKER },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T01:29:45.302Z",
    ...overrides,
  } as Task;
}

export interface ReviewResumeFixture {
  store: TaskStore;
  read(): Task;
}

/** In-memory TaskStore shape shared by the step and graph regressions. */
export function createReviewResumeFixture(initial: Task): ReviewResumeFixture {
  let live = structuredClone(initial);
  const store = {
    isWatching: false,
    taskCache: new Map(),
    taskDir: () => "/virtual/fn-277",
    readTaskJson: async () => structuredClone(live),
    parseStepsFromPrompt: async () => structuredClone(live.steps),
    atomicWriteTaskJson: async (_dir: string, next: Task) => {
      live = structuredClone(next);
    },
    withTaskLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    emit: () => true,
    getSettingsFast: async () => ({ proactiveTaskChatEnabled: false }),
    appendAgentLog: async () => undefined,
    getTask: async () => structuredClone(live),
    updateTask: async (_id: string, patch: Partial<Task>) => {
      live = { ...live, ...structuredClone(patch) } as Task;
      return structuredClone(live);
    },
    updateTaskAtomic: async (
      _id: string,
      compute: (current: Task) => Partial<Task> | null,
    ) => {
      const patch = compute(structuredClone(live));
      if (patch) live = { ...live, ...structuredClone(patch) } as Task;
      return structuredClone(live);
    },
    appendRemediationSteps: async (
      id: string,
      steps: readonly TaskStep[],
      options: { wave?: number } = {},
    ) => appendRemediationStepsImpl(store as unknown as TaskStore, id, steps, options),
    logEntry: async (_id: string, action: string, outcome?: string) => {
      live.log = [
        ...(live.log ?? []),
        { timestamp: new Date().toISOString(), action, ...(outcome ? { outcome } : {}) },
      ];
    },
    addTaskComment: async () => undefined,
  } as unknown as TaskStore;
  return { store, read: () => structuredClone(live) };
}

export function makeRealProjectionStepDeps(
  fixture: ReviewResumeFixture,
  runStep: RunSingleStep,
): RunTaskStepDeps {
  return {
    store: {
      startStep: (id, index, options) => startStepImpl(fixture.store, id, index, options),
      updateStep: (id, index, status, options) => updateStepImpl(fixture.store, id, index, status, options),
      logEntry: (id, action, outcome) => fixture.store.logEntry(id, action, outcome),
    },
    worktreePath: "/virtual/fn-277",
    runStep,
    gitRevParse: async () => "sha",
    captureCheckpointId: () => undefined,
  };
}

export async function appendNamedReviewFix(fixture: ReviewResumeFixture): Promise<number> {
  const task = fixture.read();
  const outcome = await appendReviewRemediationSteps({
    store: fixture.store,
    readTaskArtifact: async () => fixture.read().prompt ?? "",
    sendTaskBackForFix: async () => undefined,
  }, task, REVISE_INFO as never, {
    attemptClaim: {
      revisionKey: "code-review",
      stepName: "Code Review",
      status: "failed",
      maxRevisions: "unbounded",
    },
  });
  expect(outcome).toBe("appended");
  const index = fixture.read().steps.findIndex((step) => step.status === "pending" && /^Fix:/i.test(step.name));
  if (index < 0) throw new Error("Expected named review remediation to append a pending Fix step");
  return index;
}

export async function appendTrailingReplay(fixture: ReviewResumeFixture): Promise<number> {
  const replay = await reopenLastStepForRevision(fixture.store, fixture.read().id, fixture.read());
  if (!replay) throw new Error("Expected trailing replay occurrence");
  return replay.index;
}

function actions(fixture: ReviewResumeFixture): string[] {
  return (fixture.read().log ?? []).map((entry) => entry.action);
}

async function expectSuccessfulFixRun(
  fixture: ReviewResumeFixture,
  stepIndex: number,
  runStep: Mock<RunSingleStep>,
  options: { preserveExistingRefusals?: boolean } = {},
): Promise<void> {
  const refusalNeedle = `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} in-progress for step ${stepIndex}`;
  const refusalCountBefore = actions(fixture).filter((action) => action.includes(refusalNeedle)).length;
  const result = await runTaskStep(
    makeRealProjectionStepDeps(fixture, runStep),
    fixture.read(),
    stepIndex,
    { projectionSource: "graph" },
  );

  expect(result).toMatchObject({ outcome: "success", baselineSha: "sha" });
  expect(runStep).toHaveBeenCalledTimes(1);
  expect(runStep).toHaveBeenCalledWith(stepIndex);
  expect(fixture.read().steps[stepIndex]?.status).toBe("done");
  expect(actions(fixture)).toContainEqual(expect.stringMatching(new RegExp(`^${STEP_LEDGER_REOPEN_MARKER_PREFIX}`)));
  const refusalCountAfter = actions(fixture).filter((action) => action.includes(refusalNeedle)).length;
  expect(refusalCountAfter).toBe(options.preserveExistingRefusals ? refusalCountBefore : 0);
  expect(actions(fixture)).not.toContainEqual(expect.stringContaining(`[integrity-warning] graph-source updateStep suppressed: step ${stepIndex}`));
}

describe("review REVISE resumes the real graph step driver", () => {
  it("starts and completes a named Fix step after completion", async () => {
    const fixture = createReviewResumeFixture(makeCompletedReviewTask());
    const stepIndex = await appendNamedReviewFix(fixture);
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });

    await expectSuccessfulFixRun(fixture, stepIndex, runStep);
  });

  it("starts and completes an unclassified gate's trailing replay after completion", async () => {
    const fixture = createReviewResumeFixture(makeCompletedReviewTask());
    const stepIndex = await appendTrailingReplay(fixture);
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });

    await expectSuccessfulFixRun(fixture, stepIndex, runStep);
  });

  it("recovers a historical wedge whose refusal narration nests the completion marker", async () => {
    const fixIndex = 3;
    const inner = `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} in-progress for step ${fixIndex} (Fix: narrow timestamps) — implementation ended at "${COMPLETION_MARKER}" and no new implementation session has started`;
    const outer = `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} in-progress for step ${fixIndex} (Fix: narrow timestamps) — implementation ended at "${inner}" and no new implementation session has started`;
    const task = makeCompletedReviewTask({
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implementation", status: "done" },
        { name: "Testing & Verification", status: "done" },
        { name: "Fix: narrow timestamps", status: "pending" },
      ],
      currentStep: fixIndex,
    });
    task.log = [
      ...(task.log ?? []),
      { timestamp: "2026-09-01T01:31:14.181Z", action: inner },
      { timestamp: "2026-09-01T01:31:14.182Z", action: outer },
    ];
    const fixture = createReviewResumeFixture(task);
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });

    await expectSuccessfulFixRun(fixture, fixIndex, runStep, { preserveExistingRefusals: true });
  });

  it("does not silently complete a stale in-progress projection after completion", async () => {
    const fixture = createReviewResumeFixture(makeCompletedReviewTask({
      steps: [{ name: "Fix: stale projection", status: "in-progress" }],
      currentStep: 0,
    }));
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });

    await runTaskStep(
      makeRealProjectionStepDeps(fixture, runStep),
      fixture.read(),
      0,
      { projectionSource: "graph" },
    );

    expect(runStep).toHaveBeenCalledWith(0);
    expect(fixture.read().steps[0]?.status).toBe("in-progress");
    expect(actions(fixture)).toContainEqual(expect.stringContaining(`${STEP_LEDGER_REFUSAL_MARKER_PREFIX} done for step 0`));
    expect(actions(fixture)).toContainEqual(expect.stringContaining("[integrity-warning] graph-source updateStep suppressed"));
  });

  it("does not execute a step already recorded done", async () => {
    const fixture = createReviewResumeFixture(makeCompletedReviewTask({
      steps: [{ name: "Already complete", status: "done" }],
      currentStep: 1,
    }));
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });

    const result = await runTaskStep(
      makeRealProjectionStepDeps(fixture, runStep),
      fixture.read(),
      0,
      { projectionSource: "graph" },
    );

    expect(result).toEqual({ outcome: "failure" });
    expect(runStep).not.toHaveBeenCalled();
    expect(actions(fixture)).toContainEqual(expect.stringContaining("Ignored done→in-progress regression"));
  });
});
