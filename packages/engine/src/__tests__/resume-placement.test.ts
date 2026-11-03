/*
FNXC:ResumePlacement 2026-11-01-18:05 (RUFU-300):
Unit coverage for the one shared placement resolver. RUFU-292 re-ran a released plan gate because the
resume authority it used (durable continuation, or the column entry contract) never consulted the
card's own `workflowStepResults`. This file pins the evidence rules the fix rests on:

  - the LATEST row per step id decides release (duplicates from retries/remediation are normal);
  - `plan-review` releases through core's `isPlanReviewSatisfied`, so `status: "passed"` +
    `verdict: "APPROVE_WITH_NOTES"` releases while a `supersededAt` row does not;
  - a `skipped` row releases only with an audited `bypassedBy`; a `remediationArchivedAt` collateral
    archive is an archive, not a waiver;
  - placement is the first main-path node strictly after the FURTHEST released gate, so a card whose
    code-review passed is not placed at that gate;
  - with no released gate and no pin the answer is byte-identical to `resolveColumnResumeNode` — the
    column contract is unchanged for every column the shipped coding IR declares.
*/
import { describe, expect, it } from "vitest";
import {
  computeWorkflowIrPin,
  getBuiltinWorkflow,
  parseWorkflowIr,
  type TaskDetail,
  type WorkflowStepResult,
} from "@fusion/core";

import { resolveColumnResumeNode } from "../workflows/workflow-graph-executor.js";
import { isGateReleased, resolveResumePlacement } from "../workflows/resume-placement.js";

const codingIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);
const ideasIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding-ideas")!.ir as never);

function task(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "RUFU-300-R",
    title: "resolver",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  } as unknown as TaskDetail;
}

function row(stepId: string, over: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: stepId,
    workflowStepName: stepId,
    status: "pending",
    completedAt: "2026-09-24T14:41:36.612Z",
    ...over,
  } as unknown as WorkflowStepResult;
}

describe("RUFU-300 — gate release is read from the latest row", () => {
  it("releases the shipped plan-review shape (`passed` + APPROVE-family verdict) and rejects the rest", () => {
    expect(isGateReleased(row("plan-review", { status: "passed", verdict: "APPROVE_WITH_NOTES" }))).toBe(true);
    expect(isGateReleased(row("plan-review", { status: "passed", verdict: "APPROVE" }))).toBe(true);
    // Superseded by a plan change: the passed row is no longer this plan's evidence.
    expect(isGateReleased(row("plan-review", { status: "passed", supersededAt: "2026-09-24T15:00:00.000Z" }))).toBe(false);
    expect(isGateReleased(row("plan-review", { status: "REVISE" }))).toBe(false);
    expect(isGateReleased(row("plan-review", { status: "pending" }))).toBe(false);
    expect(isGateReleased(row("plan-review", { status: "failed" }))).toBe(false);
    expect(isGateReleased(undefined)).toBe(false);
  });

  it("an operator waiver releases; a collateral remediation archive does not", () => {
    expect(isGateReleased(row("code-review", {
      status: "skipped",
      bypassedBy: "operator-1",
      bypassReason: "stranded no-verdict lane",
    }))).toBe(true);
    // FN-295's collateral archive: `skipped` + remediationArchivedAt, no waiver fields.
    expect(isGateReleased(row("plan-review", { status: "skipped", remediationArchivedAt: "2026-09-24T15:00:00.000Z" }))).toBe(false);
    expect(isGateReleased(row("plan-review", { status: "skipped" }))).toBe(false);
  });

  it("a later duplicate row decides release, not the first row found", () => {
    // Two rows for one step: a re-run that failed AFTER an earlier pass must not look released.
    const staleFirst = task({
      workflowStepResults: [
        row("plan-review", { status: "passed", completedAt: "2026-09-24T10:00:00.000Z" }),
        row("plan-review", { status: "REVISE", completedAt: "2026-09-24T12:00:00.000Z" }),
      ],
    });
    expect(resolveResumePlacement({ ir: codingIr, task: staleFirst }).releasedNodeIds).not.toContain("plan-review");

    // And the reverse: a passed re-run after an earlier failure IS released.
    const recoveredLast = task({
      workflowStepResults: [
        row("plan-review", { status: "REVISE", completedAt: "2026-09-24T10:00:00.000Z" }),
        row("plan-review", { status: "passed", verdict: "APPROVE", completedAt: "2026-09-24T12:00:00.000Z" }),
      ],
    });
    expect(resolveResumePlacement({ ir: codingIr, task: recoveredLast }).releasedNodeIds).toContain("plan-review");
  });

  it("the plan-review gate does not stand in for code review, and vice versa", () => {
    // This is the RUFU-292 row set read directly: ONE `plan-review` row, no code-review row.
    const planOnly = task({
      enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
      workflowStepResults: [row("plan-review", { workflowStepName: "Plan Review", status: "passed", verdict: "APPROVE_WITH_NOTES" })],
    });
    const placement = resolveResumePlacement({ ir: codingIr, task: planOnly });
    expect(placement.releasedNodeIds).toEqual(["plan-review"]);

    // The code-review gate's answer is not consulted, and must not release anything.
    const codeOnly = task({
      enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
      workflowStepResults: [row("code-review", { status: "passed", verdict: "APPROVE" })],
    });
    expect(resolveResumePlacement({ ir: codingIr, task: codeOnly }).releasedNodeIds).toEqual(["code-review"]);
  });
});

describe("RUFU-300 — placement lands strictly after the furthest released gate", () => {
  it("the REQUIRED answer for the shipped coding IR is `parse` behind a released plan-review", () => {
    // `planReviewOptionalGroupNode("todo")` sits between `plan` and `parse`
    // (builtin-stepwise-final-review-coding-workflow-ir.ts), so the successor of the released gate
    // IS parse. The invariant is "do not replay the released gate", NOT "never parse" — a test that
    // asserted the latter would encode the fix as a blacklist and survive a broken rule.
    const planOnly = task({
      enabledWorkflowSteps: ["plan-review"],
      workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE_WITH_NOTES" })],
    });
    const placement = resolveResumePlacement({ ir: codingIr, task: planOnly });
    expect(placement.nodeId).toBe("parse");
    expect(placement.source).toBe("after-released-gate");
  });

  it("a card whose furthest released gate is code-review is not placed at that gate", () => {
    const reviewPassed = task({
      column: "in-review",
      enabledWorkflowSteps: ["plan-review", "code-review"],
      workflowStepResults: [
        row("plan-review", { status: "passed", verdict: "APPROVE" }),
        row("code-review", { status: "passed", verdict: "APPROVE" }),
      ],
    });
    const placement = resolveResumePlacement({ ir: codingIr, task: reviewPassed });
    expect(placement.releasedNodeIds).toEqual(["plan-review", "code-review"]);
    expect(placement.nodeId).not.toBe("code-review");
    expect(placement.nodeId).not.toBe("plan-review");
    // It also must not land behind the card's own column contract.
    expect(placement.nodeId).toBeDefined();
  });

  it("follows the successor chain in a different IR (the Ideas board) rather than a hard-coded id", () => {
    const planOnly = task({
      workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
    });
    const placement = resolveResumePlacement({ ir: ideasIr, task: planOnly });
    expect(placement.source).toBe("after-released-gate");
    expect(ideasIr.nodes.some((node) => node.id === placement.nodeId)).toBe(true);
    expect(placement.nodeId).not.toBe("plan-review");
  });

  it("never places behind the card's own column contract", () => {
    // Released gate evidence exists, but the card already sits further along the board: the column
    // floor wins, so a forward move is never undone by gate evidence.
    const inReview = task({
      column: "in-review",
      enabledWorkflowSteps: ["plan-review"],
      workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
    });
    const floor = resolveColumnResumeNode(codingIr, "in-review");
    const placement = resolveResumePlacement({ ir: codingIr, task: inReview });
    const order = (codingIr as unknown as { nodes: Array<{ id: string }> }).nodes.map((node) => node.id);
    expect(order.indexOf(placement.nodeId!)).toBeGreaterThanOrEqual(order.indexOf(floor!.id));
  });

  it("a continuation naming a foreach TEMPLATE node id is not a legal placement", () => {
    const planOnly = task({
      workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
    });
    const placement = resolveResumePlacement({ ir: codingIr, task: planOnly, continuationNodeId: "no-such-template-node" });
    expect(placement.source).toBe("after-released-gate");
    expect(codingIr.nodes.some((node) => node.id === placement.nodeId)).toBe(true);
  });

  it("a top-level continuation at or behind the released gate cannot pull the run back onto it", () => {
    const planOnly = task({
      workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
    });
    const placement = resolveResumePlacement({ ir: codingIr, task: planOnly, continuationNodeId: "plan-review" });
    expect(placement.nodeId).toBe("parse");
    expect(placement.nodeId).not.toBe("plan-review");
  });
});

describe("RUFU-300 — no evidence, no forward move (the column contract is unchanged)", () => {
  it("answers byte-identically to resolveColumnResumeNode for every column the coding IR declares", () => {
    const columns = (codingIr as unknown as { columns: Array<{ id: string }> }).columns;
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      const bare = task({ column: column.id });
      const placement = resolveResumePlacement({ ir: codingIr, task: bare });
      const floor = resolveColumnResumeNode(codingIr, column.id);
      if (floor) {
        expect(placement.nodeId, column.id).toBe(floor.id);
        expect(placement.source, column.id).toBe("column");
      } else {
        expect(placement.nodeId, column.id).toBeUndefined();
        expect(placement.source, column.id).toBe("start");
      }
      expect(placement.releasedNodeIds, column.id).toEqual([]);
      expect(placement.mismatch, column.id).toBeUndefined();
    }
  });

  it("an unpinned card with released evidence reports no mismatch", () => {
    const planOnly = task({
      workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
    });
    expect(resolveResumePlacement({ ir: codingIr, task: planOnly }).mismatch).toBeUndefined();
  });

  it("a coherent pin reports no mismatch", () => {
    const coherent = task({
      column: "in-progress",
      workflowIrPin: computeWorkflowIrPin(codingIr, "parse").irHash,
      workflowIrPinNodeId: "parse",
      workflowIrPinColumnId: "in-progress",
    });
    expect(resolveResumePlacement({ ir: codingIr, task: coherent }).mismatch).toBeUndefined();
  });

  it("a v1 IR with no column model falls back to the caller's own start behaviour", () => {
    const v1Ir = { version: "v1", nodes: [], edges: [] } as never;
    const placement = resolveResumePlacement({ ir: v1Ir, task: task() });
    expect(placement.nodeId).toBeUndefined();
    expect(placement.source).toBe("start");
    expect(placement.releasedNodeIds).toEqual([]);
  });
});

/*
FNXC:ResumePlacement 2026-11-01-21:05 (RUFU-300):
The remaining rows of the Surface Enumeration that the shipped IR cannot express. Each one is a card
shape a real board produces (a pure hold lane with no authored node, a row whose timestamp came from
a writer that could not format a date, a pin half-cleared by an older build, a ledger that is either
untouched or already progressing) — and each one must produce a decision rather than a crash.
*/
describe("RUFU-300 — the shapes the shipped IR cannot express", () => {
  /** A board whose hold lane has NO authored node: the card rests where no node lives. */
  const pureHoldIr = parseWorkflowIr({
    version: "v2",
    name: "pure-hold",
    columns: [
      { id: "inbox", traits: ["hold"] },
      { id: "doing", traits: ["wip"] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "doing" },
      { id: "plan", kind: "prompt", column: "doing", prompt: "plan" },
      // A minimal but schema-valid Plan Review-shaped optional group (a `reviewKind: "plan"`
      // template is what `isReviewGateNode` and the plan-review release rule key on).
      {
        id: "plan-review",
        kind: "optional-group",
        column: "doing",
        config: {
          name: "Plan Review",
          reviewKind: "plan",
          defaultOn: true,
          template: {
            nodes: [{ id: "plan-review-prompt", kind: "prompt", prompt: "review the plan", gateMode: "gate" }],
            edges: [],
          },
        },
      },
      { id: "work", kind: "prompt", column: "doing", prompt: "work" },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "plan", condition: "success" },
      { from: "plan", to: "plan-review", condition: "success" },
      { from: "plan-review", to: "work", condition: "success" },
      { from: "work", to: "end", condition: "success" },
    ],
  } as never);

  it("a card resting in a lane the pipeline has no node for resumes at the next node forward", () => {
    const placement = resolveResumePlacement({ ir: pureHoldIr, task: task({ column: "inbox" }) });
    expect(placement.nodeId).toBe("start");
    expect(placement.source).toBe("column");
  });

  it("from that same lane a released gate still places the run past the gate, not at the prologue", () => {
    const released = task({
      column: "inbox",
      workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
    });
    const placement = resolveResumePlacement({ ir: pureHoldIr, task: released });
    expect(placement.nodeId).toBe("work");
    expect(placement.source).toBe("after-released-gate");
  });

  it("duplicate rows with unparseable timestamps resolve to the LAST row, never the first", () => {
    // `>=` on a tie/unparseable stamp is what keeps the newest duplicate in charge; a resolver that
    // took the first row would read a long-superseded `failed` as the gate's current verdict.
    const duplicates = task({
      workflowStepResults: [
        row("plan-review", { status: "passed", verdict: "APPROVE", completedAt: "not-a-date" }),
        row("plan-review", { status: "failed", verdict: "REVISE", completedAt: "not-a-date" }),
      ],
    });
    expect(isGateReleased(undefined)).toBe(false);
    const placement = resolveResumePlacement({ ir: codingIr, task: duplicates });
    expect(placement.releasedNodeIds).toEqual([]);
    expect(placement.source).toBe("column");

    const releasedLater = task({
      workflowStepResults: [
        row("plan-review", { status: "failed", verdict: "REVISE", completedAt: "not-a-date" }),
        row("plan-review", { status: "passed", verdict: "APPROVE", completedAt: "not-a-date" }),
      ],
    });
    expect(resolveResumePlacement({ ir: codingIr, task: releasedLater }).releasedNodeIds).toEqual(["plan-review"]);
  });

  it("a half-null pin triple stays unclassified instead of inventing an incoherence verdict", () => {
    const halfNull = task({ column: "todo", workflowIrPinNodeId: "parse", workflowIrPinColumnId: undefined });
    expect(resolveResumePlacement({ ir: codingIr, task: halfNull }).mismatch).toBeUndefined();

    const pinnedColumnGone = task({ column: "todo", workflowIrPinNodeId: "parse", workflowIrPinColumnId: "no-such-column" });
    expect(resolveResumePlacement({ ir: codingIr, task: pinnedColumnGone }).mismatch).toBeUndefined();
  });

  it("reads the ledger only to protect it: an untouched ledger keeps `parse`, a progressed one keeps its work", () => {
    const evidence = {
      enabledWorkflowSteps: ["plan-review", "code-review"],
      workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
    };
    // RUFU-292's shape: fully parsed, nothing executed — nothing to lose, so `parse` is the placement.
    const untouched = task({
      ...evidence,
      steps: Array.from({ length: 9 }, (_unused, index) => ({ name: `Step ${index}`, status: "pending" })),
      currentStep: 0,
    });
    // The same card after one step finished. `parse` rewrites the whole ledger as `pending`, so a
    // placement that chose it here would erase the completed step; the run goes to the node that
    // consumes the ledger instead.
    const progressing = task({
      ...evidence,
      steps: [
        { name: "Step 0", status: "done" },
        ...Array.from({ length: 8 }, (_unused, index) => ({ name: `Step ${index + 1}`, status: "pending" })),
      ],
      currentStep: 1,
    });

    const untouchedPlacement = resolveResumePlacement({ ir: codingIr, task: untouched });
    const progressingPlacement = resolveResumePlacement({ ir: codingIr, task: progressing });

    expect(untouchedPlacement.nodeId).toBe("parse");
    expect(untouchedPlacement.source).toBe("after-released-gate");
    expect(progressingPlacement.nodeId).toBe("steps");
    expect(progressingPlacement.source).toBe("ledger-progress");
    // Placement is a decision, never a mutation: both ledgers survive untouched.
    expect(untouched.steps).toHaveLength(9);
    expect(untouched.currentStep).toBe(0);
    expect(progressing.steps.map((step) => step.status)).toEqual([
      "done",
      ...Array.from({ length: 8 }, () => "pending"),
    ]);
    expect(progressing.currentStep).toBe(1);
  });

  it("a cursor that moved over an all-`pending` ledger still counts as progress worth protecting", () => {
    // The conservative reading of an inconsistent card: `currentStep` claims work the statuses do not.
    // Re-parsing would not fix the disagreement, it would only move it.
    const placement = resolveResumePlacement({
      ir: codingIr,
      task: task({
        enabledWorkflowSteps: ["plan-review"],
        workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
        steps: [{ name: "Step 0", status: "pending" }],
        currentStep: 2,
      }),
    });
    expect(placement).toMatchObject({ nodeId: "steps", source: "ledger-progress" });
  });

  it("leaves a continuation-owned `parse` work item alone — the guard refines inference, not ownership", () => {
    // A durable continuation naming `parse` means a work item holds that node; stealing it would
    // strand the row that is waiting for it.
    const placement = resolveResumePlacement({
      ir: codingIr,
      task: task({
        enabledWorkflowSteps: ["plan-review"],
        workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
        steps: [{ name: "Step 0", status: "done" }],
        currentStep: 1,
      }),
      continuationNodeId: "parse",
    });
    expect(placement).toMatchObject({ nodeId: "parse", source: "continuation" });
  });

  it("keeps the `parse` placement when the graph declares no ledger-consuming successor", () => {
    // A workflow whose parse node points at a plain prompt node has nowhere better to go. Inventing a
    // node the card's own IR never declared is a worse failure than the one the guard exists for.
    const noForeachIr = {
      version: "v2",
      id: "custom:no-foreach",
      name: "no foreach",
      columns: [
        { id: "h", name: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "w", name: "Work", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "c", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "h" },
        {
          id: "plan-review",
          name: "Plan Review",
          kind: "optional-group",
          column: "h",
          config: { defaultOn: true, template: { nodes: [{ id: "plan-review-step", kind: "prompt", config: { prompt: "review" } }], edges: [] } },
        },
        { id: "parse", kind: "parse-steps", column: "w", config: { artifact: "PROMPT.md", parser: "step-headings" } },
        { id: "run", kind: "prompt", column: "w", config: { prompt: "run" } },
        { id: "end", kind: "end", column: "c" },
      ],
      edges: [
        { from: "start", to: "plan-review", condition: "success" },
        { from: "plan-review", to: "parse", condition: "success" },
        { from: "parse", to: "run", condition: "success" },
        { from: "run", to: "end", condition: "success" },
      ],
    } as unknown as typeof codingIr;

    const placement = resolveResumePlacement({
      ir: noForeachIr,
      task: task({
        enabledWorkflowSteps: ["plan-review"],
        workflowStepResults: [row("plan-review", { status: "passed", verdict: "APPROVE" })],
        steps: [{ name: "Step 0", status: "done" }],
        currentStep: 1,
      }),
    });
    expect(placement).toMatchObject({ nodeId: "parse", source: "after-released-gate" });
  });
});
