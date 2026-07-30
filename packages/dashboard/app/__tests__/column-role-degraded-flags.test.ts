import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isArchivedColumnRole,
  isCompleteColumnRole,
  isPreImplementationColumnRole,
  isReviewColumnRole,
  isWipColumnRole,
} from "../utils/columnRoles";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-00:10 (fleet — board surfaces):

THE BUG THIS CLOSES, and it is a real divergence rather than a rename.

`Column.tsx` and `ListView.tsx` answered every column-role question with

    workflowMode ? Boolean(columnFlags?.<trait>) : column === "<legacy id>"

`workflowMode` is `Boolean(boardWorkflows?.workflows.length)` — a BOARD-level boolean standing in for
a PER-COLUMN question. The two do not line up in one state, and it is a state that really occurs: the
board is in workflow mode, but THIS column has no resolved traits, because a mid-flight workflow edit
left a card in a column the workflow no longer declares.

There, the ternary took its FIRST arm and evaluated `Boolean(undefined?.archived)` — false. Not
"fall back to the legacy id": false for EVERY role at once. So for that column the archive action,
the revert action, the promote affordance, the auto-merge toggle, the Done-sort control and all bulk
actions silently disappeared, and nothing in the UI explained why.

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
    expect(isArchivedColumnRole(undefined, "archived")).toBe(true);
    expect(isCompleteColumnRole(undefined, "done")).toBe(true);
    expect(isWipColumnRole(undefined, "in-progress")).toBe(true);
    expect(isReviewColumnRole(undefined, "in-review")).toBe(true);
    expect(isPreImplementationColumnRole(undefined, "todo")).toBe(true);
  });

  /* The paired negative: degrading must not turn into "every column has every role". */
  it("degrading does not grant roles to unrelated columns", () => {
    expect(isArchivedColumnRole(undefined, "done")).toBe(false);
    expect(isCompleteColumnRole(undefined, "archived")).toBe(false);
    expect(isWipColumnRole(undefined, "in-review")).toBe(false);
    expect(isReviewColumnRole(undefined, "in-progress")).toBe(false);
  });

  /* Resolved traits still win outright — the whole point of resolving them. */
  it("prefers resolved traits over the column id in both directions", () => {
    expect(isArchivedColumnRole({ archived: true }, "shipped")).toBe(true);
    expect(isArchivedColumnRole({ archived: false }, "archived")).toBe(false);
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
      /workflowMode\s*\?[^;]*?column(?:Flags)?[^;]*?===\s*"(?:todo|triage|in-progress|in-review|done|archived)"/g,
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
  FNXC:WorkflowResolvedColumns 2026-07-31-02:20 (PR #2738 review — greptile P1):
  A PER-TASK role question must not be answered from the cross-workflow UNION.

  `columnFlagsById` in ListView is built from `listColumns`, which is a union across workflows keyed
  by column id — the file already documents this for `moveTargets`. The union was harmless while the
  flags answered COLUMN-level questions (is this whole list section the archive?). Converting the row
  context menu and progress bar made them per-TASK questions, and there two workflows reusing an id
  with different traits serve one workflow's semantics to the other's card: Archive and Revert appear
  or vanish, and the progress bar shows or hides, for reasons belonging to a neighbouring workflow.

  Pinned at the seam that decides it, because the divergence only exists when the two maps disagree.
  */
  it("resolves a task's role from ITS workflow when two workflows reuse a column id", () => {
    const unionFlags = { complete: true, archived: false };
    const ownWorkflowFlags = { complete: false, archived: true };

    /* The union says "complete" (so: offer Archive); the task's own workflow says "archived"
       (so: do not offer Archive, offer Revert). They must not agree by construction. */
    expect(isCompleteColumnRole(unionFlags, "wrapped")).toBe(true);
    expect(isCompleteColumnRole(ownWorkflowFlags, "wrapped")).toBe(false);
    expect(isArchivedColumnRole(ownWorkflowFlags, "wrapped")).toBe(true);
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
  });
});
