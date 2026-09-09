import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isCompleteColumnRole,
  isPreImplementationColumnRole,
  isReviewColumnRole,
  isWipColumnRole,
} from "../utils/columnRoles";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-00:10 (fleet — board surfaces):

THE BUG THIS CLOSES, and it is a real divergence rather than a rename.

`Column.tsx` and `ListView.tsx` answered every column-role question with

    workflowMode ? Boolean(columnFlags?.<trait>) : column === "<legacy id>"

`workflowMode` is `Boolean(boardWorkflows?.workflows.length)` — a BOARD-level boolean standing in for
a PER-COLUMN question. The two do not line up in one state, and it is a state that really occurs: the
board is in workflow mode, but THIS column has no resolved traits, because a mid-flight workflow edit
left a card in a column the workflow no longer declares.

There, the ternary took its first arm and evaluated an absent trait as false for every role. The
revert action, promote affordance, auto-merge toggle, Done-sort control, and bulk actions silently
disappeared, and nothing in the UI explained why.

The shared helpers ask per column: traits when resolved, the legacy id ONLY when the flags are truly
absent. That covers the pre-load window the old form handled with `workflowMode === false` AND the
undeclared-column case it got wrong.

This is a deliberate behaviour change and is pinned here so it stays deliberate.
*/

const COMPONENTS = ["Column.tsx", "ListView.tsx"] as const;

describe("board surfaces resolve column roles per column, not per board", () => {
  /*
  The divergence itself, stated as behaviour. `undefined` flags is the state the old form answered
  `false` for; every helper must instead degrade to its documented legacy id.
  */
  it("degrades to the legacy column id when a column has no resolved traits", () => {
    expect(isCompleteColumnRole(undefined, "done")).toBe(true);
    expect(isWipColumnRole(undefined, "in-progress")).toBe(true);
    expect(isReviewColumnRole(undefined, "in-review")).toBe(true);
    expect(isPreImplementationColumnRole(undefined, "todo")).toBe(true);
  });

  /* The paired negative: degrading must not turn into "every column has every role". */
  it("degrading does not grant roles to unrelated columns", () => {
    expect(isCompleteColumnRole(undefined, "archived")).toBe(false);
    expect(isWipColumnRole(undefined, "in-review")).toBe(false);
    expect(isReviewColumnRole(undefined, "in-progress")).toBe(false);
  });

  /* Resolved traits still win outright — the whole point of resolving them. */
  it("prefers resolved traits over the column id in both directions", () => {
    expect(isWipColumnRole({ countsTowardWip: true }, "building")).toBe(true);
    expect(isWipColumnRole({ countsTowardWip: false }, "in-progress")).toBe(false);
  });

  /*
  The ratchet. A reintroduced `workflowMode ? … : column === "…"` is the exact regression, and it
  reads as perfectly reasonable code — which is why it needs a guard rather than a comment.
  */
  it.each(COMPONENTS)("%s decides no column role from the board-level workflowMode flag", (file) => {
    const source = readFileSync(resolve(__dirname, "../components", file), "utf8");

    /* Comments explain the removal and legitimately contain the old shape; strip them first. */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    const boardLevelRoleTernaries = code.match(
      /workflowMode\s*\?[^;]*?column(?:Flags)?[^;]*?===\s*"(?:todo|triage|in-progress|in-review|done)"/g,
    );

    expect(
      boardLevelRoleTernaries,
      `${file}: a column ROLE must be resolved per column via the shared helpers, not gated on the board-level workflowMode`,
    ).toBeNull();
  });

  /*
  Completeness: the ratchet above is vacuous if the file stopped asking role questions altogether.
  This fails if a refactor drops the helpers rather than converting to them.
  */
  it.each(COMPONENTS)("%s actually uses the shared role helpers", (file) => {
    const source = readFileSync(resolve(__dirname, "../components", file), "utf8");

    expect(source).toMatch(/from "\.\.\/utils\/columnRoles"/);
    expect(source.match(/is[A-Za-z]+ColumnRole\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-02:20 (PR #2738 review — greptile P1):
  A PER-TASK role question must not be answered from the cross-workflow UNION.

  `columnFlagsById` in ListView is built from `listColumns`, which is a union across workflows keyed
  by column id — the file already documents this for `moveTargets`. The union was harmless while the
  Flags originally answered column-level questions. The row context menu and progress bar ask per-task
  questions, and two workflows reusing an id with different traits must not share semantics.

  Pinned at the seam that decides it, because the divergence only exists when the two maps disagree.
  */
  it("resolves a task's role from ITS workflow when two workflows reuse a column id", () => {
    const unionFlags = { complete: true };
    const ownWorkflowFlags = { complete: false, countsTowardWip: true };

    expect(isCompleteColumnRole(unionFlags, "wrapped")).toBe(true);
    expect(isCompleteColumnRole(ownWorkflowFlags, "wrapped")).toBe(false);
  });

  /* The ratchet: the per-task sites must not read the union map directly. */
  it("ListView.tsx resolves per-task roles through the per-task accessor", () => {
    const source = readFileSync(resolve(__dirname, "../components/ListView.tsx"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code, "the per-task accessor must exist").toMatch(/const getTaskColumnFlags\s*=/);

    /*
    Any per-TASK read of the id-keyed union is the regression — not just an inline one.

    The first version of this guard matched only `isXColumnRole(columnFlagsById.get(task.column)`,
    and mutation testing walked straight through it: assigning the union to a local
    (`const taskColumnFlags = columnFlagsById.get(task.column)`) and passing that reproduces the bug
    while the guard stays green. So the rule is about the LOOKUP, wherever its result goes.

    `getTaskColumnFlags` is the one legitimate site — it is the accessor that falls back to the union
    on purpose — so it is excised before matching rather than special-cased in the regex.
    */
    const accessorStart = code.indexOf("const getTaskColumnFlags");
    expect(accessorStart, "the per-task accessor must exist").toBeGreaterThan(-1);
    const accessorEnd = code.indexOf("[columnFlagsById, taskContextMenuColumnsByTaskId]", accessorStart);
    expect(accessorEnd, "expected the accessor's dependency list to bound it").toBeGreaterThan(accessorStart);
    const outsideAccessor = code.slice(0, accessorStart) + code.slice(accessorEnd);

    const unionReadsForATask = outsideAccessor.match(/columnFlagsById\.get\(\s*task\.column/g);
    expect(
      unionReadsForATask,
      "a per-task flag lookup must go through getTaskColumnFlags, not the cross-workflow union",
    ).toBeNull();

    /*
    ROUND THREE OF THE SAME DEFECT, so the rule is restated at the level that actually holds.

    Round one forbade `isXColumnRole(columnFlagsById.get(task.column))` — an inline read. Round two
    widened it to the LOOKUP wherever its result goes, after a local variable walked through it.
    Round three: thirteen call sites reached the union through the COLUMN-LEVEL callbacks
    (`isCompleteColumn(task.column)`), which contain no lookup of their own at the call site at all.

    The invariant is not about syntax. It is: a question asked ABOUT A TASK must be answered from
    that task's own workflow. So passing `task.column` to a predicate that takes a bare column id is
    the violation, regardless of how the union is reached.
    */
    const columnLevelPredicatesAskedPerTask = outsideAccessor.match(
      /\bis(?:Complete|Intake|Review|Wip)Column\(\s*task\.column\s*\)/g,
    );
    expect(
      columnLevelPredicatesAskedPerTask,
      "a per-task question must use the per-task predicate (for example isTaskCompleteColumn), "
        + "not the column-level one — the column-level pair reads the cross-workflow union",
    ).toBeNull();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-03:30 (PR #2738 review — greptile P1):
  The stranded-card case, pinned as source because it is a resolution-precedence rule.

  `getTaskColumnFlags` has three states and they are NOT two:
    1. the task's workflow declares the column   -> those flags
    2. the task's workflow is KNOWN but does not declare it -> undefined (legacy-id degrade)
    3. no per-task metadata at all               -> the union, an admitted approximation

  Collapsing 2 into 3 reinstates the bug one level down: a card stranded in a column its OWN workflow
  no longer declares — the exact card this change exists for — would take a neighbouring workflow's
  traits for the same id.
  */
  it("treats a known workflow that does not declare the column as ABSENT flags, not a union hit", () => {
    const source = readFileSync(resolve(__dirname, "../components/ListView.tsx"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(
      code,
      "the union may only answer when there is NO per-task metadata (state 3), never when the task's own workflow simply lacks the column (state 2)",
    ).toMatch(/fromOwnWorkflow\s*\?\?\s*\(\s*own\s*\?\s*undefined\s*:\s*columnFlagsById\.get\(\s*task\.column\s*\)\s*\)/);
  });

  /* And the behaviour that rule produces: absent flags degrade to the legacy id, per column. */
  it("absent flags degrade per column rather than granting a neighbour's role", () => {
    expect(isCompleteColumnRole(undefined, "wrapped")).toBe(false);
    expect(isCompleteColumnRole(undefined, "done")).toBe(true);
  });
});
