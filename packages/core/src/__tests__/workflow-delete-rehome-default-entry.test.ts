/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
DELETING A WORKFLOW RE-HOMED ITS CARDS INTO `triage`, A COLUMN THE DEFAULT BOARD DOES NOT HAVE.

`deleteWorkflow` clears each occupant's selection so they fall back to the built-in default, then
re-homes them to "the default workflow's entry column" — its own comment's words. It read that entry
column from `BUILTIN_CODING_WORKFLOW_IR`, which is `builtin:legacy-coding`, not the catalog default.

Post-U11 the two differ by exactly the column this reads:

    default  todo, in-progress, in-review, done, archived
    legacy   triage, todo, in-progress, in-review, done, archived

so the entry column was `triage` instead of `todo`.

WHY IT GOT PAST THE GUARD THAT EXISTS FOR THIS. `moveTask` rejects a target the workflow does not
declare — except under `recoveryRehome` with a LEGACY id, the #1411 escape hatch that stops a
custom-workflow card becoming unrescuable. `triage` is a legacy id, so the rehome slipped through and
left the card in a lane its new workflow has no node for.

Third door into the same drift: #3178 fixed the TUI board, and `builtin-workflows.ts` records the
move-path resolvers as already fixed. This asserts the two IRs' entry columns are actually different,
so the test fails if someone "simplifies" the fix back to the legacy constant — and would go quiet, as
it should, if the two IRs ever converge again.
*/
import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, resolveDefaultWorkflowIr } from "../index.js";
import { resolveEntryColumnId } from "../workflow-reconciliation.js";

describe("the workflow-delete rehome target comes from the DEFAULT workflow", () => {
  it("the default workflow's entry column is `todo`", () => {
    expect(resolveEntryColumnId(resolveDefaultWorkflowIr())).toBe("todo");
  });

  /*
  The legacy IR's entry column is what the delete path used to read. Pinned so the difference is a
  fact in the suite rather than a claim in a comment — this is the whole reason the bug existed.
  */
  it("the LEGACY workflow's entry column is `triage`, which the default board does not declare", () => {
    expect(resolveEntryColumnId(BUILTIN_CODING_WORKFLOW_IR)).toBe("triage");

    const defaultColumns = (resolveDefaultWorkflowIr() as unknown as { columns: { id: string }[] })
      .columns.map((column) => column.id);
    expect(defaultColumns).not.toContain("triage");
  });

  /*
  ANTI-VACUITY. The two cases above would keep passing if the delete path still read the legacy
  constant — they describe the IRs, not the call site. This pins that the call site no longer
  imports it.
  */
  it("the delete path no longer reads the legacy IR", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const source = readFileSync(
      join(resolve(__dirname, "../.."), "src/task-store/workflow-ops.ts"),
      "utf8",
    );
    expect(source).toContain("resolveEntryColumnId(resolveDefaultWorkflowIr())");
    expect(source).not.toContain("resolveEntryColumnId(BUILTIN_CODING_WORKFLOW_IR)");
  });
});
