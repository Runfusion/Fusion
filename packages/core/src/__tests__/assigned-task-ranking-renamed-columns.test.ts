/*
FNXC:WorkflowLifecycleColumns 2026-07-29-13:20 (U11 conversion — assigned-task ranking):

`tierForTask` ranks an agent's assigned work for the Wake Delta inventory, and it
identified the two actionable tiers by literal id: `in-progress` -> `in_progress`,
`todo` -> `ready_todo` / `partial_blocked`.

The file's own comment already documents the consequence for custom workflows —
"Only treating default `todo`/`in-progress` as titled hid assigned work as a bare
count" — and then fixes it only halfway: unrecognised columns fall to the `other`
tier so they stay VISIBLE, but a renamed hold column loses `ready_todo` entirely.

That is the failure this converts: a card that is genuinely ready to start is
ranked at the lowest tier, below every in-progress card, so an agent reading its
Wake Delta sees ready work buried under work already underway. Nothing errors and
nothing disappears — the ordering is just wrong, which is why it survived.

`partial_blocked` matters too: it is the ONLY tier that distinguishes "ready" from
"waiting on a dependency" for hold-column cards, and it is unreachable for a
renamed workflow.

Written against the literal implementation and observed FAILING first.
*/
import { describe, expect, it } from "vitest";

import { rankAssignedTasksForWakeDelta } from "../assigned-task-ranking.js";

type Ranked = ReturnType<typeof rankAssignedTasksForWakeDelta>;

function task(over: Record<string, unknown> = {}) {
  return {
    id: "FN-1",
    title: "t",
    column: "drafting",
    paused: false,
    deletedAt: null,
    dependencies: [],
    ...over,
  } as never;
}

const RENAMED = { hold: "drafting", wip: "building" };

function tiersOf(result: Ranked): string[] {
  return result.ranked.map((line) => line.tier);
}

describe("assigned-task ranking under a renamed column vocabulary", () => {
  it("ranks a card in the RENAMED hold column as ready_todo", () => {
    const result = rankAssignedTasksForWakeDelta([task()], { agentId: "a1", roles: RENAMED });
    expect(tiersOf(result)).toEqual(["ready_todo"]);
  });

  it("ranks a dependency-carrying hold card as partial_blocked, not ready", () => {
    /* The tier that distinguishes "ready" from "waiting", and the one a renamed
       workflow could not reach at all. */
    const result = rankAssignedTasksForWakeDelta(
      [task({ dependencies: ["FN-DEP"] })],
      { agentId: "a1", roles: RENAMED },
    );
    expect(tiersOf(result)).toEqual(["partial_blocked"]);
  });

  it("ranks a card in the RENAMED wip column as in_progress", () => {
    const result = rankAssignedTasksForWakeDelta(
      [task({ column: "building" })],
      { agentId: "a1", roles: RENAMED },
    );
    expect(tiersOf(result)).toEqual(["in_progress"]);
  });

  it("orders ready hold work ABOVE nothing-but-other work", () => {
    /*
    The observable symptom. Without the conversion the hold card falls to `other`
    and sorts below in-progress, so an agent sees ready work buried.
    */
    const result = rankAssignedTasksForWakeDelta(
      [task({ id: "FN-OTHER", column: "reviewing" }), task({ id: "FN-READY" })],
      { agentId: "a1", roles: RENAMED },
    );
    const ids = result.ranked.map((l) => l.task.id);
    expect(ids.indexOf("FN-READY")).toBeLessThan(ids.indexOf("FN-OTHER"));
  });

  it("keeps every other tier rule intact under the renamed vocabulary", () => {
    /* The conversion must change which id means "hold"/"wip", not which cards are
       actionable at all. */
    const paused = rankAssignedTasksForWakeDelta([task({ paused: true })], { agentId: "a1", roles: RENAMED });
    expect(paused.ranked).toEqual([]);
    expect(paused.notActionableCount).toBe(1);

    const unknown = rankAssignedTasksForWakeDelta([task({ column: "reviewing" })], { agentId: "a1", roles: RENAMED });
    expect(tiersOf(unknown)).toEqual(["other"]);
  });

  it("defaults to the legacy ids when no roles are supplied", () => {
    /* Byte-identical for every caller that cannot resolve a workflow. */
    const legacy = rankAssignedTasksForWakeDelta([task({ column: "todo" })], { agentId: "a1" });
    expect(tiersOf(legacy)).toEqual(["ready_todo"]);

    const renamedWithoutRoles = rankAssignedTasksForWakeDelta([task({ column: "drafting" })], { agentId: "a1" });
    expect(tiersOf(renamedWithoutRoles)).toEqual(["other"]);
  });
});
