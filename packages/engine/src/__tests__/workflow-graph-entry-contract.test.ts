import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR,
  getBuiltinWorkflow,
  parseWorkflowIr,
  type WorkflowIr,
} from "@fusion/core";
import { resolveColumnResumeNode, WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import type { WorkflowRuntimePrimitives } from "../runtime-primitives.js";
import type { TaskDetail, TaskStep } from "@fusion/core";

/*
FNXC:WorkflowGraphEntry 2026-07-26-17:10:
THE GRAPH ENTRY CONTRACT. A run with no durable continuation resumes at the card's OWN column instead
of replaying the pipeline from `start`. Before this, every continuation-less run (self-healing graph
re-entry, a fresh dispatch, an operator drag into a processing column) re-entered at the first node of
the FIRST column and dragged the card backward through columns it had already left — aborting its live
session via `abort-on-exit`, and stranding it in any pre-wip column with no releaser. That backward
drag is the reason planning nodes had to live in the implementation column.

These assert the INVARIANT across every lifecycle position a card can hold, not just the plan-in-place
case that motivated it: behind (resume forward), at, and past each column, on the real built-in IRs.
*/

const codingIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);

describe("workflow graph entry contract — resume at the card's own column", () => {
  /*
  FNXC:MergedPlanningColumn 2026-07-28-17:40 (U11):
  EXPECTATION CHANGED BY THE MERGE, recorded rather than relaxed. This asserted two entry points
  because the default workflow had two pre-implementation columns; it now has one, so `triage`
  resolves to undefined (a column the IR does not declare cannot be placed relative to any node)
  and the single planning column enters at `start`.

  The `undefined` half is NOT the whole story and is deliberately not left as the only assertion:
  a card still stored in the removed `triage` column is rescued by `run()`'s start-node fallback,
  and that rescue is asserted by driving the executor in the stranded-card suite at the bottom of
  this file — verified to go red when the fallback is deleted. Asserting undefined here alone
  would be compatible with those cards stranding.
  */
  it("enters the planning prologue for a card in the merged planning lane", () => {
    const entry = resolveColumnResumeNode(codingIr, "todo");
    expect(entry?.column).toBe("todo");
    expect(entry?.id).toBe("start");

    // …and `start` reaches the specification node in one unconditional hop, which is what makes
    // entering there equivalent to entering at the specification node itself.
    const successors = codingIr.edges.filter(
      (edge) => edge.from === entry!.id
        && (edge.condition === undefined || edge.condition === "success")
        && edge.kind !== "rework",
    );
    expect(successors).toHaveLength(1);
    expect(successors[0]!.to).toBe("plan");
  });

  it("never re-plans a card that already reached implementation", () => {
    const resumed = resolveColumnResumeNode(codingIr, "in-progress");
    expect(resumed?.id).toBe("parse");
    expect(resumed?.column).toBe("in-progress");
    // The regression this exists to prevent: resuming at a planning node would move the card
    // backward out of the wip column and abort its session.
    expect(["plan", "plan-review", "plan-replan"]).not.toContain(resumed?.id);
  });

  it("re-enters a review-column card at the FIRST review node so no gate is skipped", () => {
    const resumed = resolveColumnResumeNode(codingIr, "in-review");
    expect(resumed?.column).toBe("in-review");
    // Entering at the merge region instead would silently skip Code Review.
    expect(resumed?.id).toBe("browser-verification");
  });

  it("resolves the same way for the other built-in coding IRs", () => {
    expect(resolveColumnResumeNode(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR, "in-progress")?.id).toBe("parse");
    /*
    FNXC:MergedPlanningColumn 2026-07-28-17:10 (U11):
    BUILTIN_CODING_WORKFLOW_IR is `builtin:legacy-coding`, NOT the default workflow — the catalog
    maps `builtin:coding` to the stepwise-final-review IR. Legacy coding deliberately keeps the
    six-column split shape (its purpose is being the old pipeline; R11 commits to legacy shapes
    continuing to work), so it still answers `planning` here. The merged-column assertions live
    with the DEFAULT lineage below.
    */
    expect(resolveColumnResumeNode(BUILTIN_CODING_WORKFLOW_IR, "todo")?.id).toBe("planning");
    expect(resolveColumnResumeNode(BUILTIN_CODING_WORKFLOW_IR, "in-progress")?.id).toBe("execute");
  });

  it("skips forward when the card rests in a column the pipeline has no node for", () => {
    const ir = parseWorkflowIr({
      version: "v2",
      name: "gap-column",
      columns: [
        { id: "intake", name: "Intake", traits: [{ trait: "intake" }] },
        // No node declares `staging` — a card parked here must resume at the next node forward.
        { id: "staging", name: "Staging", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "work", name: "Work", traits: [{ trait: "wip" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "intake" },
        { id: "build", kind: "prompt", column: "work" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "build", condition: "success" },
        { from: "build", to: "end", condition: "success" },
      ],
    } as WorkflowIr);
    expect(resolveColumnResumeNode(ir, "staging")?.id).toBe("build");
  });

  it("never resumes at a remediation node reached only by a failure or rework edge", () => {
    // `plan-replan` sits in the planning lane and is reachable only from a plan-review FAILURE,
    // so a planning-lane card must still resume at `plan` — remediation is not an entry point.
    expect(resolveColumnResumeNode(codingIr, "todo")?.id).not.toBe("plan-replan");
    // Same shape in the implementation column, where the code-review remediation node lives.
    expect(resolveColumnResumeNode(codingIr, "in-progress")?.id).not.toBe("code-review-remediation");
  });

  it("falls back to the start node for an unknown column or a v1 IR", () => {
    expect(resolveColumnResumeNode(codingIr, "not-a-column")).toBeUndefined();
    expect(resolveColumnResumeNode(codingIr, undefined)).toBeUndefined();
    expect(resolveColumnResumeNode({ version: "v1", name: "legacy", nodes: [], edges: [] } as never, "todo"))
      .toBeUndefined();
  });
});

/*
FNXC:WorkflowGraphEntry 2026-07-27-06:10 (PR #2462 review):
The resolver tests above prove the DECISION; this one proves the executor actually asks. A run that
reached `run()` and ignored the resolver — or that reintroduced the backward `columnBoundary` move —
would satisfy every assertion above and still strand the card, which is exactly the regression the
entry contract exists to prevent. Assert on the real traversal, not on the helper.
*/
describe("workflow graph entry contract — the executor honors it", () => {
  const promptWithOneStep = "# Task\n\n## Steps\n\n### Step 0: Implement\n- [ ] do it\n";

  function silentPrimitives(calls: string[]): WorkflowRuntimePrimitives {
    const ok = { outcome: "success" as const };
    return {
      prepareWorktree: async () => ({ outcome: "success", data: { worktreePath: "/memory/worktree" } }),
      readArtifact: async (_c, _t, key) => (key === "PROMPT.md" ? promptWithOneStep : undefined),
      writeArtifact: async (_c, _t, key) => ({ outcome: "success", data: { key } }),
      runPlanningSession: async () => {
        calls.push("planning-session");
        return { outcome: "success", data: { approved: true, artifactKeys: ["PROMPT.md"] } };
      },
      runCodingSession: async () => ({ outcome: "success", data: { taskDone: true, modifiedFiles: [] } }),
      runTaskStep: async () => ({ outcome: "success", baselineSha: "b", checkpointId: "c" }),
      resetTaskStep: async () => ({ ok: true }),
      runReview: async () => ({ outcome: "success", data: { verdict: "APPROVE" } }),
      runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
      updateSteps: async (_c, target: TaskDetail, steps: TaskStep[]) => {
        target.steps = steps;
        return { outcome: "success", data: { count: steps.length } };
      },
      transitionTask: async () => ok,
      requestMerge: async () => ({ outcome: "success", value: "merged", data: { status: "merged" } }),
      abortRun: async () => ok,
      audit: () => undefined,
    } as unknown as WorkflowRuntimePrimitives;
  }

  it("resumes an in-progress card at `parse` and never re-enters a planning node", async () => {
    const calls: string[] = [];
    const task = {
      id: "FN-ENTRY",
      title: "Entry contract",
      description: "",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: promptWithOneStep,
      workflowStepResults: [],
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    } as unknown as TaskDetail;

    const executor = new WorkflowGraphExecutor({
      primitives: silentPrimitives(calls),
      parseStepsDeps: {
        readArtifact: async (_target, key) => (key === "PROMPT.md" ? promptWithOneStep : undefined),
        writeSteps: async (target: TaskDetail, steps: TaskStep[]) => {
          target.steps = steps;
        },
      },
    } as never);

    // No continuation node id — the "replay from start" path the contract governs.
    const result = await executor.run(task, { experimentalFeatures: {} } as never, codingIr);

    expect(result.visitedNodeIds[0]).toBe("parse");
    for (const planningNode of ["start", "plan", "plan-review", "plan-replan"]) {
      expect(result.visitedNodeIds, `must not re-enter ${planningNode}`).not.toContain(planningNode);
    }
    // The planning primitive is the loudest possible proof: a re-planned card would call it.
    expect(calls).not.toContain("planning-session");
  });
});

/*
FNXC:MergedPlanningColumn 2026-07-28-14:05 (U11, PR #2503 review — greptile + coderabbit):

The entry contract under the MERGED planning column — one column carrying `intake` + `hold`,
which is what U11 leaves behind once `triage` is deleted and `todo` becomes "Planning".

REWRITTEN after review. The first cut of this block did two things wrong, and both are the
difference between proving something and appearing to:

1. It asserted against a hand-written synthetic graph. A toy graph proves the RESOLVER's
   arithmetic, not that the operator's board survives — production planning/review topology could
   drift away from the shape under test and nothing here would notice. `mergeTodoIntoPlanning`
   below is instead the literal U11 edit expressed as a transformation, applied to the REAL
   production IR, so these assertions track production topology by construction.

2. It asserted that `resolveColumnResumeNode` returns `undefined` for a card stranded in the
   deleted `triage` column, and that a start node exists. Both can hold while cards strand: the
   thing that actually rescues such a card is the `?? ir.nodes.find(kind === "start")` fallback in
   `run()`, and neither assertion touches it. Deleting that fallback left the old test GREEN. The
   stranded case now drives `executor.run()` and asserts the card really traverses — and going red
   when the fallback is removed is verified, not assumed.
*/
describe("workflow graph entry contract — merged intake+hold planning column (U11)", () => {
  /*
  FNXC:MergedPlanningColumn 2026-07-28-17:30 (U11):
  This block previously TRANSFORMED the production IR to preview the merged shape before it
  landed. It has landed: `builtin:coding` (the stepwise-final-review lineage) now declares one
  pre-implementation column. So the transformation is deleted and these assert the real thing.

  The transform helper is not kept "just in case" — it would now be a no-op that quietly asserts
  nothing, which is worse than no test. `builtin:legacy-coding` still carries the split shape and
  is asserted separately above, so the split vocabulary has not lost coverage.
  */
  const mergedCodingIr = codingIr;

  it("declares ONE pre-implementation column carrying both intake and hold", () => {
    // The shape U11 exists to produce, asserted on the real default workflow.
    expect(mergedCodingIr.columns.map((column) => column.id)).not.toContain("triage");
    expect(mergedCodingIr.nodes.every((node) => node.column !== "triage")).toBe(true);

    const planning = mergedCodingIr.columns.find((column) => column.id === "todo")!;
    expect(planning.name).toBe("Planning");
    const traits = (planning.traits ?? []).map((trait) => (trait as { trait: string }).trait);
    expect(traits).toContain("intake");
    expect(traits).toContain("hold");

    // Exactly one column carries each pre-implementation role — a second intake or hold column
    // would reintroduce the two-stage shape under different ids.
    const withTrait = (name: string) => mergedCodingIr.columns.filter(
      (column) => (column.traits ?? []).some((trait) => (trait as { trait: string }).trait === name),
    );
    expect(withTrait("intake")).toHaveLength(1);
    expect(withTrait("hold")).toHaveLength(1);
    expect(withTrait("intake")[0]!.id).toBe(withTrait("hold")[0]!.id);
  });

  it("enters the specification phase for a card in the merged planning column", () => {
    const resumed = resolveColumnResumeNode(mergedCodingIr, "todo");

    expect(resumed?.column).toBe("todo");
    // The failure this guards: entering at an implementation node would put an unspecified card
    // into implementation with no plan.
    expect(resumed?.id).not.toBe("parse");
  });

  it("reaches the production specification node from the merged entry point in one hop", () => {
    /*
    The merged shape answers `start` where the split shape answers the planning node, because
    `start` becomes the first node in that column once the columns collapse. That is equivalent
    ONLY because `start` reaches the specification node by a single unconditional success edge.
    Asserted against the PRODUCTION graph, so inserting a node between them fails here rather than
    silently admitting an unspecified card into implementation.
    */
    const entry = resolveColumnResumeNode(mergedCodingIr, "todo")!;
    const splitAnswer = resolveColumnResumeNode(codingIr, "todo")!;

    if (entry.id === splitAnswer.id) return; // no collapse happened; nothing to bridge.

    const successors = mergedCodingIr.edges.filter(
      (edge) => edge.from === entry.id && (edge.condition === undefined || edge.condition === "success") && edge.kind !== "rework",
    );
    expect(successors).toHaveLength(1);
    expect(successors[0]!.to).toBe(splitAnswer.id);
  });

  it("NEVER re-plans a card past the merged column — the drag that aborts a live session", () => {
    const resumed = resolveColumnResumeNode(mergedCodingIr, "in-progress");

    expect(resumed?.id).toBe("parse");
    expect(resumed?.column).toBe("in-progress");
    expect(["start", "plan", "planning", "plan-review", "plan-replan"]).not.toContain(resumed?.id);
  });

  it("re-enters a review-column card at the production first review node, not the merge region", () => {
    const resumed = resolveColumnResumeNode(mergedCodingIr, "in-review");

    /*
    ABSOLUTE, not merely equal-to-production. A differential assertion alone is tautological here:
    if the production review lane were reordered, both sides of the comparison would move together
    and the test would stay green while the merged board silently skipped a gate. The literal is
    the same one the production block above pins, so a real topology change fails in both places.
    */
    expect(resumed?.id).toBe("browser-verification");
    expect(resumed?.column).toBe("in-review");
    // …and it still agrees with production, which is the property the merge must preserve.
    expect(resumed?.id).toBe(resolveColumnResumeNode(codingIr, "in-review")?.id);
  });

  it("produces the same answer as the production IR at every position past planning", () => {
    // Absolutes first, so production drift cannot move both sides of the differential in step.
    expect(resolveColumnResumeNode(mergedCodingIr, "in-progress")?.id).toBe("parse");
    expect(resolveColumnResumeNode(mergedCodingIr, "in-review")?.id).toBe("browser-verification");

    for (const column of ["in-progress", "in-review", "done"]) {
      expect(resolveColumnResumeNode(mergedCodingIr, column)?.id)
        .toBe(resolveColumnResumeNode(codingIr, column)?.id);
    }
  });
});

/*
FNXC:MergedPlanningColumn 2026-07-28-14:20 (U11, PR #2503 review — coderabbit):
The stranded-card case, driven through `executor.run()` rather than through the resolver.

Rows persisted in `triage` outlive the column U11 deletes. `resolveColumnResumeNode` returns
undefined for a column the IR does not declare, and the ONLY thing that then rescues the card is
`run()`'s `?? ir.nodes.find(kind === "start")` fallback. Asserting "the resolver returns undefined"
and "a start node exists" is compatible with the card stranding, which is why this drives the real
traversal and asserts the card moves.

Verified red: deleting the `?? ir.nodes.find(...)` fallback makes `run()` throw
`WorkflowIrError: Workflow IR missing start node` and this test fails.
*/
describe("workflow graph entry contract — a card stranded in a deleted column still runs (U11)", () => {
  const promptWithOneStep = "# Task\n\n## Steps\n\n### Step 0: Implement\n- [ ] do it\n";

  function silentPrimitives(): WorkflowRuntimePrimitives {
    const ok = { outcome: "success" as const };
    return {
      prepareWorktree: async () => ({ outcome: "success", data: { worktreePath: "/memory/worktree" } }),
      readArtifact: async (_c: unknown, _t: unknown, key: string) => (key === "PROMPT.md" ? promptWithOneStep : undefined),
      writeArtifact: async (_c: unknown, _t: unknown, key: string) => ({ outcome: "success", data: { key } }),
      runPlanningSession: async () => ({ outcome: "success", data: { approved: true, artifactKeys: ["PROMPT.md"] } }),
      runCodingSession: async () => ({ outcome: "success", data: { taskDone: true, modifiedFiles: [] } }),
      runTaskStep: async () => ({ outcome: "success", baselineSha: "b", checkpointId: "c" }),
      resetTaskStep: async () => ({ ok: true }),
      runReview: async () => ({ outcome: "success", data: { verdict: "APPROVE" } }),
      runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
      updateSteps: async (_c: unknown, target: TaskDetail, steps: TaskStep[]) => {
        target.steps = steps;
        return { outcome: "success", data: { count: steps.length } };
      },
      transitionTask: async () => ok,
      requestMerge: async () => ({ outcome: "success", value: "merged", data: { status: "merged" } }),
      abortRun: async () => ok,
      audit: () => undefined,
    } as unknown as WorkflowRuntimePrimitives;
  }

  /** Production is already merged, so this is the real default IR — no transform needed. */
  function mergedIrWithoutTriage(): WorkflowIr {
    return codingIr;
  }

  it("runs a card still stored in the DELETED triage column instead of stranding it", async () => {
    const task = {
      id: "FN-STRANDED",
      title: "Left behind in a deleted column",
      description: "",
      // The migration case: the row outlived the column its workflow declared.
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: promptWithOneStep,
      workflowStepResults: [],
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    } as unknown as TaskDetail;

    const executor = new WorkflowGraphExecutor({
      primitives: silentPrimitives(),
      parseStepsDeps: {
        readArtifact: async (_target: unknown, key: string) => (key === "PROMPT.md" ? promptWithOneStep : undefined),
        writeSteps: async (target: TaskDetail, steps: TaskStep[]) => {
          target.steps = steps;
        },
      },
    } as never);

    const merged = mergedIrWithoutTriage();
    expect(merged.columns.map((column) => column.id)).not.toContain("triage");

    // No continuation node id — the "replay from start" path the fallback governs.
    const result = await executor.run(task, { experimentalFeatures: {} } as never, merged);

    // The card must actually traverse. An empty trace IS the stranding this guards.
    expect(result.visitedNodeIds.length).toBeGreaterThan(0);
    // …and it re-enters at the top of the pipeline, which is the only safe answer for a column
    // the workflow no longer declares: it cannot be placed relative to any node.
    expect(result.visitedNodeIds[0]).toBe(merged.nodes.find((node) => node.kind === "start")?.id);
  });
});
