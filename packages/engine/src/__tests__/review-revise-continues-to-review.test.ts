import "./executor-test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR,
  STEP_LEDGER_REFUSAL_MARKER_PREFIX,
  type Task,
  type TaskDetail,
  type TaskStep,
  type WorkflowIrNode,
} from "@fusion/core";
import { runTaskStep, type RunSingleStep } from "../execution/step-runner.js";
import { runForeach } from "../workflows/workflow-graph-foreach.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  type ForeachActiveContext,
  type WorkflowLegacySeams,
} from "../workflows/workflow-node-handlers.js";
import {
  resolveColumnResumeNode,
  WorkflowGraphExecutor,
  type WorkflowNodeResult,
} from "../workflows/workflow-graph-executor.js";
import { createWorkflowColumnBoundary } from "../workflows/workflow-column-boundary.js";
import {
  appendNamedReviewFix,
  appendTrailingReplay,
  createReviewResumeFixture,
  makeCompletedReviewTask,
  makeRealProjectionStepDeps,
  type ReviewResumeFixture,
} from "./review-revise-resumes-fix-step.test.js";

const IR = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR;

function stepsForeach(): WorkflowIrNode {
  const node = IR.nodes.find((candidate) => candidate.id === "steps" && candidate.kind === "foreach");
  if (!node) throw new Error("builtin:coding-ideas-v2 must contain its steps foreach");
  return node;
}

function implementationColumn(): string {
  const column = stepsForeach().column;
  if (!column) throw new Error("steps foreach must declare an implementation column");
  return column;
}

function reviewColumn(): string {
  const column = IR.nodes.find((node) => node.id === "code-review")?.column;
  if (!column) throw new Error("code-review must declare a review column");
  return column;
}

function shouldTraverseEdge(
  edge: { condition?: string },
  source: WorkflowNodeResult,
): boolean {
  if (!edge.condition) return source.outcome === "success";
  if (edge.condition === "success") return source.outcome === "success";
  if (edge.condition.startsWith("outcome:")) return source.value === edge.condition.slice("outcome:".length);
  return source.outcome === "failure";
}

async function runImplementationRegion(
  fixture: ReviewResumeFixture,
  runStep: RunSingleStep,
) {
  const context: Record<string, unknown> = {};
  return runForeach(stepsForeach(), {
    task: fixture.read() as TaskDetail,
    runId: `${fixture.read().id}:foreach`,
    steps: fixture.read().steps,
    getLiveSteps: () => fixture.read().steps,
    context,
    runTemplateNode: async (node, _signal, contextOverride) => {
      const nodeContext = contextOverride ?? context;
      if (node.id === "step-execute") {
        const active = nodeContext[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        const result = await runTaskStep(
          makeRealProjectionStepDeps(fixture, runStep),
          fixture.read(),
          active.stepIndex,
          { projectionSource: "graph", markDoneOnSuccess: active.deferDoneToReview !== true },
        );
        return {
          outcome: result.outcome,
          value: result.outcome === "success" ? "step-done" : "step-failed",
        };
      }
      return { outcome: "success" };
    },
    shouldTraverseEdge,
  });
}

function graphSeams(
  fixture: ReviewResumeFixture,
  runStep: RunSingleStep,
  enteredNodeIds: string[],
): WorkflowLegacySeams {
  const record = (id: string) => async (): Promise<WorkflowNodeResult> => {
    enteredNodeIds.push(id);
    return { outcome: "success" };
  };
  return {
    planning: record("planning"),
    execute: record("execute"),
    review: record("review"),
    merge: record("merge"),
    schedule: record("schedule"),
    stepExecute: async (_task, context) => {
      const active = context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
      enteredNodeIds.push(active.instanceId);
      const result = await runTaskStep(
        makeRealProjectionStepDeps(fixture, runStep),
        fixture.read(),
        active.stepIndex,
        { projectionSource: "graph", markDoneOnSuccess: active.deferDoneToReview !== true },
      );
      active.baselineSha = result.baselineSha;
      active.checkpointId = result.checkpointId;
      return {
        outcome: result.outcome,
        value: result.outcome === "success" ? "step-done" : "step-failed",
        contextPatch: { [FOREACH_ACTIVE_CONTEXT_KEY]: active },
      };
    },
  };
}

interface MoveRecord {
  toColumn: string;
  fromColumn: string;
  nodeId: string;
}

async function runGraphFromImplementation(options: {
  fixture: ReviewResumeFixture;
  graphTask?: Task;
  getTaskSteps?: () => TaskStep[];
  runStep: RunSingleStep;
}) {
  const task = options.graphTask ?? options.fixture.read();
  task.column = implementationColumn();
  const moves: MoveRecord[] = [];
  const enteredNodeIds: string[] = [];
  const boundary = createWorkflowColumnBoundary({
    taskId: task.id,
    workflowId: IR.name,
    ir: IR,
    initialColumn: implementationColumn(),
    moveTask: async (toColumn, context) => {
      moves.push({ toColumn, ...context });
    },
  });
  const executor = new WorkflowGraphExecutor({
    seams: graphSeams(options.fixture, options.runStep, enteredNodeIds),
    runCustomNode: async (node) => {
      enteredNodeIds.push(node.id);
      return { outcome: "success" };
    },
    getTaskSteps: () => options.getTaskSteps?.() ?? options.fixture.read().steps,
    parseStepsDeps: {
      readArtifact: async () => (options.getTaskSteps?.() ?? options.fixture.read().steps)
        .map((step, index) => `### Step ${index}: ${step.name}`)
        .join("\n"),
      writeSteps: async () => undefined,
    },
    columnBoundary: boundary,
    runId: `${task.id}:continuation`,
  });

  const result = await executor.run(
    task as TaskDetail,
    { experimentalFeatures: { workflowGraphExecutor: true, graphNativePostMerge: false } } as never,
    IR,
  );
  return { result, moves, enteredNodeIds };
}

function historicalWedgeTask(): Task {
  const fixIndex = 3;
  const task = makeCompletedReviewTask({
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "done" },
      { name: "Testing & Verification", status: "done" },
      { name: "Fix: Dated Live timestamps are truncated", status: "pending" },
    ],
    currentStep: fixIndex,
  });
  const inner = `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} in-progress for step ${fixIndex} (Fix: Dated Live timestamps are truncated) — implementation ended at "Task marked done by agent" and no new implementation session has started`;
  task.log = [
    ...(task.log ?? []),
    { timestamp: "2026-09-01T01:31:14.181Z", action: inner },
    {
      timestamp: "2026-09-01T01:31:14.182Z",
      action: `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} in-progress for step ${fixIndex} (Fix: Dated Live timestamps are truncated) — implementation ended at "${inner}" and no new implementation session has started`,
    },
  ];
  return task;
}

describe("review REVISE continues through implementation back into review", () => {
  it.each([
    ["named remediation", appendNamedReviewFix],
    ["trailing replay", appendTrailingReplay],
  ] as const)("resumes the real foreach at only the pending %s work", async (_case, appendWork) => {
    const fixture = createReviewResumeFixture(makeCompletedReviewTask());
    const fixIndex = await appendWork(fixture);
    const pendingIndexes = fixture.read().steps
      .map((step, index) => step.status === "pending" ? index : -1)
      .filter((index) => index >= 0);
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });

    const result = await runImplementationRegion(fixture, runStep);

    expect(result).toMatchObject({ outcome: "success" });
    expect(runStep.mock.calls.map(([index]) => index)).toEqual(pendingIndexes);
    expect(pendingIndexes).toContain(fixIndex);
    expect(pendingIndexes.every((index) => fixture.read().steps[index]?.status === "done")).toBe(true);
    expect(fixture.read().steps.slice(0, fixIndex).every((step) => step.status === "done")).toBe(true);
  });

  it("runs Code Review's named remediation hand-off and continues back to review", async () => {
    const fixture = createReviewResumeFixture(makeCompletedReviewTask());
    const fixIndex = await appendNamedReviewFix(fixture);
    const pendingIndexes = fixture.read().steps
      .map((step, index) => step.status === "pending" ? index : -1)
      .filter((index) => index >= 0);
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });
    const resumeNode = resolveColumnResumeNode(IR, implementationColumn());

    expect(resumeNode?.column).toBe(implementationColumn());
    expect(pendingIndexes).toContain(fixIndex);
    const { result, moves, enteredNodeIds } = await runGraphFromImplementation({ fixture, runStep });

    expect(result.visitedNodeIds).toContain("code-review");
    expect(enteredNodeIds).toContain("code-review-step");
    expect(runStep.mock.calls.map(([index]) => index)).toEqual(pendingIndexes);
    expect(pendingIndexes.every((index) => fixture.read().steps[index]?.status === "done")).toBe(true);
    expect(moves.filter((move) => move.toColumn === reviewColumn())).toEqual([
      { fromColumn: implementationColumn(), toColumn: reviewColumn(), nodeId: "code-review" },
    ]);
  });

  it("resumes an already-wedged card and continues to Code Review's column", async () => {
    const fixture = createReviewResumeFixture(historicalWedgeTask());
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });
    const resumeNode = resolveColumnResumeNode(IR, implementationColumn());

    expect(resumeNode?.column).toBe(implementationColumn());
    const { result, moves, enteredNodeIds } = await runGraphFromImplementation({ fixture, runStep });

    expect(result.visitedNodeIds).toContain("code-review");
    expect(enteredNodeIds).toContain("code-review-step");
    expect(runStep.mock.calls.map(([index]) => index)).toEqual([3]);
    expect(moves.filter((move) => move.toColumn === reviewColumn())).toEqual([
      { fromColumn: implementationColumn(), toColumn: reviewColumn(), nodeId: "code-review" },
    ]);
  });

  it("does not carry a genuinely refused stale start into review", async () => {
    const fixture = createReviewResumeFixture(makeCompletedReviewTask({
      steps: [{ name: "Already completed", status: "done" }],
      currentStep: 1,
    }));
    const graphTask = fixture.read();
    graphTask.steps = [{ name: "Stale pending snapshot", status: "pending" }];
    graphTask.currentStep = 0;
    const runStep = vi.fn<RunSingleStep>().mockResolvedValue({ success: true });

    const { result, moves } = await runGraphFromImplementation({
      fixture,
      graphTask,
      getTaskSteps: () => graphTask.steps,
      runStep,
    });

    expect(result.visitedNodeIds).not.toContain("code-review");
    expect(moves.filter((move) => move.toColumn === reviewColumn())).toEqual([]);
    expect(runStep).not.toHaveBeenCalled();
  });
});
