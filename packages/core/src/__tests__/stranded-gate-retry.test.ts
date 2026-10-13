import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import type { WorkflowIr, WorkflowIrV2 } from "../workflows/workflow-ir-types.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { buildStrandedGateRetryPatch, classifyStrandedGateRetry } from "../tasks/stranded-gate-retry.js";

/*
FNXC:StrandedGateRetry 2026-10-13 (STAS-299):
The STAS-281 card: self-heal declared the Plan Review session dead and flipped its `pending` row to
`failed`, and the card — still in the hold lane, still carrying the approved plan and a full step
list — was refused by every retry surface because its failure was a step row, not a card status.
These tests pin the ONE classification every retry surface consumes, and the non-destructive patch
that classification produces. Parity between surfaces is the point, so the classification is proven
here once rather than per surface.
*/

const verdictlessPlanGateRow = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  phase: "pre-merge" as const,
  source: "optional-group" as const,
  status: "failed" as const,
  reviewKind: "plan" as const,
  startedAt: "2026-09-24T00:16:39.000Z",
  output: "Pending step result had no live session or lease; marked failed by self-healing (FN-8492).",
};

function strandedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "STAS-281",
    column: "todo",
    status: "failed",
    error: "1 workflow step result(s) … marked failed by self-healing (FN-8492)",
    approvedPlanFingerprint: "7a73aaff",
    steps: ["Draft the plan", "Await the plan-review verdict"],
    currentStep: 1,
    workflowStepResults: [verdictlessPlanGateRow],
    ...overrides,
  } as unknown as Task;
}

function classify(task: Task, ir: WorkflowIr = BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr) {
  return classifyStrandedGateRetry({ task, ir });
}

describe("classifyStrandedGateRetry", () => {
  it("names the STAS-281 shape: hold lane + approved plan + verdict-less failed required gate", () => {
    expect(classify(strandedTask())).toEqual({ kind: "stranded-gate", gateStepIds: ["plan-review"] });
  });

  it("names the pre-fix stranded card too, which carried no card status at all", () => {
    /* The whole reason the hatch must not key on the status alone: every card stranded BEFORE this
       fix is exactly this shape, and an operator must be able to rescue it today. */
    expect(classify(strandedTask({ status: undefined, error: undefined } as Partial<Task>)))
      .toEqual({ kind: "stranded-gate", gateStepIds: ["plan-review"] });
  });

  it("resolves the hold lane by trait role, not by the literal `todo`", () => {
    const renamed = {
      ...BUILTIN_CODING_WORKFLOW_IR,
      columns: (BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIrV2).columns.map((column) =>
        column.id === "todo" ? { ...column, id: "queue" } : column,
      ),
      nodes: (BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIrV2).nodes.map((node) =>
        "column" in node && node.column === "todo" ? { ...node, column: "queue" } : node,
      ),
    } as unknown as typeof BUILTIN_CODING_WORKFLOW_IR;

    expect(classify(strandedTask({ column: "queue" } as Partial<Task>), renamed as unknown as WorkflowIr))
      .toEqual({ kind: "stranded-gate", gateStepIds: ["plan-review"] });
  });

  it("admits the intake lane on the same terms — it is pre-execution too", () => {
    expect(classify(strandedTask({ column: "triage" } as Partial<Task>)))
      .toEqual({ kind: "stranded-gate", gateStepIds: ["plan-review"] });
  });

  it("refuses a card in a lane that already owns its recovery", () => {
    /* WIP/review/complete cards are owned by the execution, in-review and merge recovery lanes;
       re-queueing them from this hatch would fight those owners. */
    for (const column of ["in-progress", "in-review", "done"]) {
      expect(classify(strandedTask({ column } as Partial<Task>)), column)
        .toEqual({ kind: "not-stranded", reason: "lane-owns-its-own-recovery" });
    }
  });

  it("refuses an authored verdict — reviewer authority is the remediation lane, never a re-run", () => {
    const authored = strandedTask({
      workflowStepResults: [{ ...verdictlessPlanGateRow, verdict: "REVISE" as const }],
    } as Partial<Task>);
    expect(classify(authored)).toEqual({ kind: "not-stranded", reason: "no-verdict-less-required-gate" });
  });

  it("refuses a card whose plan was never approved (the genuine planning/replan shape)", () => {
    expect(classify(strandedTask({ approvedPlanFingerprint: undefined } as Partial<Task>)))
      .toEqual({ kind: "not-stranded", reason: "no-approved-plan" });
  });

  it("refuses statuses owned by another lane, so the destructive restart stays available", () => {
    for (const status of ["needs-replan", "awaiting-approval", "planning", "merging"]) {
      expect(classify(strandedTask({ status } as Partial<Task>)), status)
        .toEqual({ kind: "not-stranded", reason: "status-owned-by-another-lane" });
    }
  });

  it("refuses a card whose gate row is not required by its workflow", () => {
    const optedOut = strandedTask({ enabledWorkflowSteps: [] } as Partial<Task>);
    expect(classify(optedOut)).toEqual({ kind: "not-stranded", reason: "no-verdict-less-required-gate" });
  });

  it("refuses a workflow that declares no column model", () => {
    const legacyIr = { version: "v1", nodes: [], edges: [] } as unknown as WorkflowIr;
    expect(classify(strandedTask(), legacyIr)).toEqual({ kind: "not-stranded", reason: "legacy-board" });
  });
});

describe("buildStrandedGateRetryPatch", () => {
  it("re-queues without touching the plan the reviewer approved", () => {
    const task = strandedTask({
      worktreePath: "/repo/.worktrees/STAS-281",
      branch: "fusion/stas-281",
      workflowStepResults: [
        { ...verdictlessPlanGateRow, workflowStepId: "code-review", reviewKind: "code", status: "passed", verdict: "APPROVE" },
        verdictlessPlanGateRow,
      ],
    } as Partial<Task>);

    const patch = buildStrandedGateRetryPatch(task, ["plan-review"]);

    expect(patch.status).toBeNull();
    expect(patch.error).toBeNull();
    // Only the verdict-less gate row is discharged; a passed gate row is board history.
    expect(patch.workflowStepResults?.map((row) => row.workflowStepId)).toEqual(["code-review"]);
    // The preserved half is the point of the class: no re-plan, no re-spec, no lost checkout.
    expect(patch.steps).toBeUndefined();
    expect(patch.currentStep).toBeUndefined();
    expect(patch.approvedPlanFingerprint).toBeUndefined();
    expect(patch.column).toBeUndefined();
    expect(patch.worktreePath).toBeUndefined();
    expect(patch.branch).toBeUndefined();
    expect(patch.paused).toBeUndefined();
  });

  it("lifts the sticky parks the shipped manual-retry reset lifts", () => {
    const patch = buildStrandedGateRetryPatch(strandedTask(), ["plan-review"]);
    expect(patch.sourceMetadataPatch).toMatchObject({ planPremiseRejection: null });
    expect(patch.recoveryRetryCount).toBe(0);
    expect(patch.stuckKillCount).toBe(0);
  });

  it("leaves an unrelated failed gate row alone", () => {
    const authored = { ...verdictlessPlanGateRow, verdict: "REVISE" as const };
    const patch = buildStrandedGateRetryPatch(
      strandedTask({ workflowStepResults: [authored] } as Partial<Task>),
      ["plan-review"],
    );
    expect(patch.workflowStepResults?.map((row) => row.workflowStepId)).toEqual(["plan-review"]);
  });
});
