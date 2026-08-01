import { describe, expect, it } from "vitest";
import { workflowDeclaresColumnModel, workflowHasColumn, workflowPlansInColumn } from "../workflow-transitions.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "../builtin-stepwise-final-review-coding-workflow-ir.js";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "../builtin-coding-ideas-workflow-ir.js";
import { BUILTIN_WORKFLOWS } from "../builtin-workflows.js";
import { parseWorkflowIr } from "../workflow-ir.js";
import type { WorkflowIr } from "../workflow-ir.js";

/** Builtin IRs are authored either as objects or as JSON strings. */
function irOf(workflow: { ir: unknown }): WorkflowIr {
  return (typeof workflow.ir === "string" ? parseWorkflowIr(workflow.ir) : workflow.ir) as WorkflowIr;
}

/*
FNXC:WorkflowRetry 2026-07-29-20:55 (triage census):
`workflowPlansInColumn` replaces `!workflowHasColumn(ir, "triage")` as the answer to "does this card
sit where its workflow plans?" — the input to the manual Retry route's DESTRUCTIVE specification
branch (stamp needs-replan, delete PROMPT.md).

The first test is the measurement that condemned the old proxy, taken across all 12 shipped
workflows. It is not merely dead: 7 builtins still declare a `triage` column while NONE plans there,
so for 5 of them the proxy actively DENIED the retry a card in their planning column needed.
*/
describe("workflowPlansInColumn", () => {
  /*
  THE MEASUREMENT THAT CONDEMNS THE OLD PROXY, across every shipped workflow rather than the two
  that motivated it. Two facts, both asserted below:

    1. NO builtin places a planning node in `triage` — planning happens in `todo` wherever it
       happens at all. So "the workflow has a triage column" says nothing about where it plans.
    2. 7 of 12 builtins still DECLARE a `triage` column. The proxy is therefore not merely dead,
       it is inverted for those: `!workflowHasColumn(ir, "triage")` is FALSE, so a card in `todo`
       was denied specification retry by workflows that do all their planning in `todo`.

  If a future workflow ever does plan in `triage`, fact 1 goes red here — deliberately, because that
  is the one shape that would make the old proxy meaningful again.
  */
  it("MEASUREMENT: no builtin plans in `triage`, yet 7 still declare that column", () => {
    const declaringTriage = BUILTIN_WORKFLOWS.filter((w) => workflowHasColumn(irOf(w), "triage"));
    const planningInTriage = BUILTIN_WORKFLOWS.filter((w) => workflowPlansInColumn(irOf(w), "triage"));

    expect(planningInTriage.map((w) => w.id)).toEqual([]);
    expect(declaringTriage.map((w) => w.id)).toEqual([
      "builtin:legacy-coding",
      "builtin:quick-fix",
      "builtin:review-heavy",
      "builtin:compound-engineering",
      "builtin:design",
      "builtin:pr-workflow",
      "builtin:lead-generation",
    ]);
  });

  /*
  The live consequence of fact 2: these five workflows declare `triage` AND plan in `todo`, so the
  old proxy denied specification retry to a planning/needs-replan card sitting in their planning
  column — the manual Retry route answered 400 "not in a retryable state" and the operator had no
  button. `workflowPlansInColumn` gives every one of them the right answer.
  */
  it("gives specification retry to workflows that declare triage but plan in todo", () => {
    const declaresTriageAndPlansInTodo = BUILTIN_WORKFLOWS
      .filter((w) => workflowHasColumn(irOf(w), "triage") && workflowPlansInColumn(irOf(w), "todo"))
      .map((w) => w.id);

    expect(declaresTriageAndPlansInTodo).toEqual([
      "builtin:legacy-coding",
      "builtin:quick-fix",
      "builtin:review-heavy",
      "builtin:compound-engineering",
      "builtin:design",
    ]);
  });

  it("reports no planning column for workflows that have no plan nodes at all", () => {
    // marketing / pr-workflow / lead-generation never plan, so no column of theirs may be
    // classified as a planning column — a spec-deleting retry there would be pure damage.
    for (const id of ["builtin:marketing", "builtin:pr-workflow", "builtin:lead-generation"]) {
      const workflow = BUILTIN_WORKFLOWS.find((w) => w.id === id);
      expect(workflow, id).toBeDefined();
      for (const column of ["todo", "triage", "in-progress", "in-review"]) {
        expect(workflowPlansInColumn(irOf(workflow!), column), `${id}/${column}`).toBe(false);
      }
    }
  });

  it("reports the column that actually hosts the plan nodes for both builtins", () => {
    for (const ir of [BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR, BUILTIN_CODING_IDEAS_WORKFLOW_IR]) {
      expect(workflowPlansInColumn(ir, "todo")).toBe(true);
      // Cards parked elsewhere are not "where planning happens", so a retry there must not be
      // treated as a re-plan.
      expect(workflowPlansInColumn(ir, "in-progress")).toBe(false);
      expect(workflowPlansInColumn(ir, "in-review")).toBe(false);
      expect(workflowPlansInColumn(ir, "done")).toBe(false);
    }
    // Ideas' manual intake column is NOT its planning column — planning runs after promotion.
    expect(workflowPlansInColumn(BUILTIN_CODING_IDEAS_WORKFLOW_IR, "ideas")).toBe(false);
  });

  /*
  THE CASE THE OLD PROXY GOT WRONG. A workflow with no `triage` column that plans in its own intake
  column: the old predicate said `!hasColumn("triage")` -> true for a card in `todo`, so a failed
  card parked in `todo` was given a specification retry — needs-replan plus PROMPT.md deleted —
  even though `todo` hosts no plan node at all.
  */
  it("refuses a column that hosts no plan node, even when the workflow has no triage column", () => {
    const plansInIntake = {
      version: "v2",
      id: "custom:plans-in-intake",
      name: "Plans In Intake",
      columns: [
        { id: "inbox", traits: ["intake"] },
        { id: "todo", traits: ["hold"] },
        { id: "in-progress", traits: ["wip"] },
      ],
      nodes: [
        { id: "plan", kind: "prompt", column: "inbox", config: {} },
        { id: "plan-review", kind: "prompt", column: "inbox", config: {} },
      ],
      edges: [],
    } as unknown as WorkflowIr;

    expect(workflowHasColumn(plansInIntake, "triage")).toBe(false);
    // Old proxy: !hasColumn("triage") === true -> spec retry in todo. Wrong.
    expect(workflowPlansInColumn(plansInIntake, "todo")).toBe(false);
    expect(workflowPlansInColumn(plansInIntake, "inbox")).toBe(true);
  });

  it("keeps legacy behaviour for a workflow that plans in triage", () => {
    const legacy = {
      version: "v2",
      id: "custom:legacy-triage",
      name: "Legacy",
      columns: [
        { id: "triage", traits: ["intake"] },
        { id: "todo", traits: ["hold"] },
      ],
      nodes: [{ id: "plan", kind: "prompt", column: "triage", config: {} }],
      edges: [],
    } as unknown as WorkflowIr;

    // A card in `todo` under a triage-planning workflow got generic retry before and must still.
    expect(workflowPlansInColumn(legacy, "todo")).toBe(false);
    expect(workflowPlansInColumn(legacy, "triage")).toBe(true);
  });

  /*
  GREPTILE #2621: a custom workflow whose planning node has a bespoke id was reported as having NO
  planning column, so Manual Retry preserved a stale specification instead of replanning. Recognise
  the SEMANTIC markers the builtins carry — `config.seam` and `config.workflowAction` — so an id
  outside the known list is still classified when the workflow reuses a builtin planning seam.
  */
  it("recognises a planning node by config.seam, whatever its id", () => {
    const ir = {
      version: "v2",
      id: "custom:seam-marker",
      name: "Seam",
      columns: [{ id: "specify", traits: [{ trait: "intake" }] }, { id: "todo", traits: [{ trait: "hold" }] }],
      nodes: [{ id: "write-the-spec", kind: "prompt", column: "specify", config: { seam: "planning", name: "Spec" } }],
      edges: [],
    } as unknown as WorkflowIr;

    expect(workflowPlansInColumn(ir, "specify")).toBe(true);
    expect(workflowPlansInColumn(ir, "todo")).toBe(false);
  });

  it("recognises a planning node by config.workflowAction, whatever its id", () => {
    const ir = {
      version: "v2",
      id: "custom:action-marker",
      name: "Action",
      columns: [{ id: "backlog", traits: [{ trait: "intake" }] }],
      nodes: [{ id: "redo-it", kind: "prompt", column: "backlog", config: { workflowAction: "plan-replan" } }],
      edges: [],
    } as unknown as WorkflowIr;

    expect(workflowPlansInColumn(ir, "backlog")).toBe(true);
  });

  it("does not classify a non-planning seam as planning", () => {
    // `startsWith("plan")` on workflowAction must not swallow unrelated actions, and an
    // implementation/review seam is not a planning seam.
    const ir = {
      version: "v2",
      id: "custom:other-seams",
      name: "Other",
      columns: [{ id: "todo", traits: [{ trait: "hold" }] }],
      nodes: [
        { id: "build", kind: "prompt", column: "todo", config: { seam: "implementation" } },
        { id: "check", kind: "prompt", column: "todo", config: { workflowAction: "code-review" } },
        // greptile #2621: a `plan`-PREFIXED action that is not planning. A startsWith("plan") test
        // classified this column as planning, and the caller's planning branch DELETES PROMPT.md —
        // so the loose match cost a specification. Must be an exact set.
        { id: "run-it", kind: "prompt", column: "todo", config: { workflowAction: "plan-execute" } },
        { id: "fixup", kind: "prompt", column: "todo", config: { workflowAction: "pre-merge-remediation" } },
      ],
      edges: [],
    } as unknown as WorkflowIr;

    expect(workflowPlansInColumn(ir, "todo")).toBe(false);
  });

  /*
  GREPTILE #2621: callers gating a DESTRUCTIVE action must be able to tell "not a planning column"
  from "this IR cannot answer the question". A v1 IR is the second, and reading it as the first made
  Manual Retry answer 400 for a v1 planning card that the old predicate admitted.
  */
  it("distinguishes an unanswerable IR from a negative answer", () => {
    expect(workflowDeclaresColumnModel({ version: 1 } as unknown as WorkflowIr)).toBe(false);
    expect(workflowDeclaresColumnModel({} as unknown as WorkflowIr)).toBe(false);
    // Columns but no nodes: placement is still unanswerable.
    expect(workflowDeclaresColumnModel({
      version: "v2", columns: [{ id: "todo", traits: [] }],
    } as unknown as WorkflowIr)).toBe(false);
    expect(workflowDeclaresColumnModel(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR)).toBe(true);
    expect(workflowDeclaresColumnModel(BUILTIN_CODING_IDEAS_WORKFLOW_IR)).toBe(true);
  });

  it("returns false rather than throwing for a v1 IR with no nodes array", () => {
    // Callers use this to gate a destructive branch; an un-nodeed IR must fail CLOSED.
    expect(workflowPlansInColumn({ version: 1 } as unknown as WorkflowIr, "todo")).toBe(false);
    expect(workflowPlansInColumn({} as unknown as WorkflowIr, "todo")).toBe(false);
  });
});
