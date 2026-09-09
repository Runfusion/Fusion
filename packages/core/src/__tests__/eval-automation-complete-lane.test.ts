/*
FNXC:WorkflowLifecycleColumns 2026-08-01-03:10:

THE INVARIANT: the scheduled eval batch selects the board's OWN complete lane.

THE QUERY, plus a redundant re-assertion beneath it — the pairing that makes this class deceptive:

    const doneTasks = (await store.listTasks({ column: "done" }))   // the live filter
      .filter((task) => task.column === "done" && …);              // the census counts THIS

`listTasks({ column })` filters in the STORE, so on a renamed board the read returned an empty array
and **every scheduled eval run completed having evaluated zero tasks** — a run that reports success
over nothing. Converting the `.filter` alone would have dropped a census count and changed nothing,
because the list was already empty when it ran.

The redundant clause is DELETED rather than converted. A second copy of the same rule is how a read
and its filter drift apart; the completion-timestamp window is the only thing it contributed beyond
the column, and that is kept.

REVERT PROOF, measured: restore `listTasks({ column: "done" })` and the renamed case selects nothing.
*/
import { describe, expect, it, vi } from "vitest";
import { resolveProjectColumnsForRoles, TERMINAL_ROLES } from "../project-lane-vocabulary.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

describe("the eval batch's complete-lane vocabulary", () => {
  it("includes a RENAMED complete lane and the legacy id", async () => {
    const store = { listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]) };

    const columns = await resolveProjectColumnsForRoles(store, ["complete"]);

    expect(columns.has("shipped")).toBe(true);
    // Unioned, so a board mid-rename still evaluates rows stored under the old id.
    expect(columns.has("done")).toBe(true);
  });

  it("does NOT include the wip lane — complete only, as the original filter was", async () => {
    // Evaluation remains scoped to completed work and excludes active WIP.
    const store = { listWorkflowDefinitions: vi.fn(async () => [{ ir: RENAMED_IR }]) };

    const columns = await resolveProjectColumnsForRoles(store, ["complete"]);

    expect(columns.has("building")).toBe(false);
    expect([...(await resolveProjectColumnsForRoles(store, TERMINAL_ROLES))].includes("archived")).toBe(false);
  });

  it("the eval batch reads through the resolver, not the literal", () => {
    /*
    Structural: `runScheduledEvalBatch` needs an eval store, an automation row and a live task store
    to drive end to end. What was missing is that the READ asks for the resolved lane at all — the
    behaviour of the resolver itself is covered in `project-lane-vocabulary.test.ts`.
    */
    const raw = readFileSync(new URL("../eval/eval-automation.ts", import.meta.url), "utf8");
    /*
    COMMENTS STRIPPED FIRST. My first version asserted against the raw source and failed on its own
    explanatory comment, which quotes the deleted clause verbatim — a ratchet matching prose rather
    than code is the exact flaw I have criticised in others' guards, and the census AST strips
    comments for the same reason.
    */
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(source).toContain('resolveProjectColumnsForRoles(params.store as never, ["complete"])');
    expect(source).not.toContain('listTasks({ column: "done" })');
    // The redundant re-assertion must stay deleted.
    expect(source).not.toContain('task.column === "done"');
  });
});

import { readFileSync } from "node:fs";
