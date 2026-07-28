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
  it("enters the planning prologue only for a card still in the planning lane", () => {
    // Intake: nothing is behind it, so the run starts at the graph's own start node.
    expect(resolveColumnResumeNode(codingIr, "triage")?.id).toBe("start");
    // Planning lane: the specification phase is exactly what this card still needs.
    expect(resolveColumnResumeNode(codingIr, "todo")?.id).toBe("plan");
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
    // The base IR names its planning seam `planning`; the contract is about columns, not ids.
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
FNXC:MergedPlanningColumn 2026-07-28-11:20 (U11):
The entry contract under the MERGED planning column — one column carrying `intake` + `hold`, which
is what U11 leaves behind once `triage` is deleted and `todo` becomes "Planning".

This is the interaction the earlier, reverted attempt at this merge got wrong, so it is pinned
BEFORE the IR changes. `resolveColumnResumeNode` walks forward from `start` and returns the first
node whose column index is `>= ` the card's. Collapsing two pre-implementation columns into one
changes those indices for EVERY node, so the two positions that matter are:

  - the merged column itself must still enter the specification phase (not skip past it), and
  - a card past it must STILL never re-enter a planning node — the backward drag that aborts a live
    session via `abort-on-exit` and stranded cards last time.

Differential against the split shape: the same graph under both vocabularies must produce the same
ROLE-level answer. The merged shape legitimately returns `start` rather than `plan` for a planning
card — `start` is the first node in that column once the columns collapse — which is equivalent only
because `start` is a passthrough with a single success edge into the specification node. That
equivalence is asserted, not assumed.
*/
describe("workflow graph entry contract — merged intake+hold planning column (U11)", () => {
  const SPLIT_COLUMNS = [
    { id: "triage", name: "Planning", traits: [{ trait: "intake" }] },
    { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }] },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", name: "In review", traits: [{ trait: "merge-blocker" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ];

  const MERGED_COLUMNS = [
    {
      id: "todo",
      name: "Planning",
      traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
    },
    { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", name: "In review", traits: [{ trait: "merge-blocker" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ];

  /** Same node graph under both vocabularies; only `start`'s column differs. */
  function shapedIr(columns: unknown[], startColumn: string): WorkflowIr {
    return {
      version: "v2",
      id: "wf-shape",
      name: "shape",
      columns,
      nodes: [
        { id: "start", kind: "start", column: startColumn },
        { id: "plan", kind: "prompt", column: "todo" },
        { id: "plan-review", kind: "optional-group", column: "todo" },
        { id: "plan-replan", kind: "prompt", column: "todo" },
        { id: "parse", kind: "prompt", column: "in-progress" },
        { id: "review", kind: "prompt", column: "in-review" },
        { id: "merge-gate", kind: "merge-gate", column: "in-review" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "plan", condition: "success" },
        { from: "plan", to: "plan-review", condition: "success" },
        { from: "plan-review", to: "parse", condition: "success" },
        { from: "plan-review", to: "plan-replan", condition: "failure" },
        { from: "plan-replan", to: "plan-review", condition: "success", kind: "rework" },
        { from: "parse", to: "review", condition: "success" },
        { from: "review", to: "merge-gate", condition: "success" },
        { from: "merge-gate", to: "end", condition: "success" },
      ],
    } as unknown as WorkflowIr;
  }

  const splitIr = shapedIr(SPLIT_COLUMNS, "triage");
  const mergedIr = shapedIr(MERGED_COLUMNS, "todo");

  it("enters the specification phase for a card in the merged planning column", () => {
    const resumed = resolveColumnResumeNode(mergedIr, "todo");

    // `start` is a passthrough; what matters is that the card is NOT dropped past specification.
    expect(resumed?.id).toBe("start");
    expect(resumed?.column).toBe("todo");
    // The failure this guards: entering at `parse` would put an unspecified card into
    // implementation with no plan.
    expect(resumed?.id).not.toBe("parse");
  });

  it("reaches the specification node from the merged column's entry point in one hop", () => {
    /*
    The merged shape answers `start` where the split shape answers `plan`. That is equivalent ONLY
    because `start` leads to the specification node by a single unconditional success edge. Assert
    that rather than trusting it — if a node is ever inserted between them, the two shapes stop
    being equivalent and this fails.
    */
    const entry = resolveColumnResumeNode(mergedIr, "todo")!;
    const successors = mergedIr.edges.filter((edge) => edge.from === entry.id && edge.condition === "success");

    expect(successors).toHaveLength(1);
    expect(successors[0]!.to).toBe(resolveColumnResumeNode(splitIr, "todo")?.id);
  });

  it("NEVER re-plans a card past the merged column — the drag that aborts a live session", () => {
    const resumed = resolveColumnResumeNode(mergedIr, "in-progress");

    expect(resumed?.id).toBe("parse");
    expect(resumed?.column).toBe("in-progress");
    expect(["start", "plan", "plan-review", "plan-replan"]).not.toContain(resumed?.id);
  });

  it("re-enters a review-column card at the first review node under the merged shape", () => {
    const resumed = resolveColumnResumeNode(mergedIr, "in-review");

    expect(resumed?.id).toBe("review");
    // Entering at the merge region instead would silently skip review.
    expect(resumed?.id).not.toBe("merge-gate");
  });

  it("produces the same role-level answer as the split shape at every position past planning", () => {
    for (const column of ["in-progress", "in-review", "done"]) {
      expect(resolveColumnResumeNode(mergedIr, column)?.id).toBe(resolveColumnResumeNode(splitIr, column)?.id);
    }
  });

  it("still resumes a card stranded in the DELETED triage column without dropping it", () => {
    /*
    R7 / migration case: rows persisted in `triage` outlive the column. `resolveColumnResumeNode`
    returns undefined for a column the IR does not declare, and the executor's caller falls back to
    the start node — so the card re-enters at the top of the pipeline rather than being stranded.
    Pinned because "undefined" here is only safe while that fallback exists.
    */
    expect(resolveColumnResumeNode(mergedIr, "triage")).toBeUndefined();
    expect(mergedIr.nodes.find((node) => node.kind === "start")?.id).toBe("start");
  });
});
