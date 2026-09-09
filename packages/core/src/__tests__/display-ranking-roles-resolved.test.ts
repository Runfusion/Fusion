/*
FNXC:WorkflowLifecycleColumns 2026-07-31-02:00 (batch-core feed: task-priority.ts 3 → 0, assigned-task-ranking.ts 2 → 0):

THE INVARIANT: display ordering and assigned-work ranking ask core's column-ROLE helpers, never the
column's name.

Both files are converted onto `column-roles.ts` rather than onto another optional set. That module
already owns the legacy-id degraded mode, so passing `undefined` flags reproduces the previous
behaviour exactly — there is no bespoke fallback in either file left to get wrong. Where the earlier
conversions in this batch had to invent a documented default, these two inherit one that is already
tested, which is the shape the remaining files should prefer wherever a role helper fits.

WHY THESE SURVIVED. Every failure here is WRONG ORDER or a MISCOUNT, never an error:

  - the hold lane loses priority ordering, so urgent work stops floating to the top of the backlog;
  - the complete lane loses recency ordering, so the newest completions are not at the top of Done;
  - the review lane stops floating actively-merging cards, so the card an operator is waiting on
    sits wherever priority puts it;
  - Wake Delta counts a SHIPPED card as open assigned work, so a coordinator is asked to unblock or
    reassign tasks that already landed.

Nobody files a bug titled "the Done column is sorted slightly wrong", which is how three of these sat
in one function.

REVERT PROOF, measured: restore the four literals and 4 of the 8 cases fail — the complete-lane
recency case, the review-lane merge-float case, and both Wake Delta terminal cases.

STATED PLAINLY BECAUSE IT MATTERS: the RENAMED-HOLD case does NOT fail on revert, and I could not
construct one that does. A renamed hold lane falls through to the generic comparator, which also
priority-sorts first, so the hold branch and the fallback agree on every input I could build. That
conversion is therefore a CONSISTENCY fix — the three branches now ask the same kind of question —
not a behaviour fix, and this file does not pin it. The case is kept because it documents the
intended routing, but it is not evidence.

The legacy-board cases pass either way; they are the degraded mode, not coverage of the change.
*/
import { describe, expect, it } from "vitest";
import { sortTasksForDisplayColumn } from "../tasks/task-priority.js";
import { rankAssignedTasksForWakeDelta } from "../agents/assigned-task-ranking.js";
import type { ColumnRoleTraitFlags } from "../column-roles.js";

const HOLD_FLAGS = { hold: true } as unknown as ColumnRoleTraitFlags;
const COMPLETE_FLAGS = { complete: true } as unknown as ColumnRoleTraitFlags;
const REVIEW_FLAGS = { mergeBlocker: true } as unknown as ColumnRoleTraitFlags;

const at = (iso: string) => ({ columnMovedAt: iso, updatedAt: iso, createdAt: iso });

describe("sortTasksForDisplayColumn resolves the column's role", () => {
  it("priority-sorts a RENAMED hold lane", () => {
    // Pre-fix: `backlog` !== "todo", so urgent work did not float to the top of the backlog.
    const tasks = [
      { id: "FN-1", priority: "low", ...at("2026-01-01T00:00:00Z") },
      { id: "FN-2", priority: "urgent", ...at("2026-01-02T00:00:00Z") },
    ] as never[];

    expect(sortTasksForDisplayColumn(tasks, "backlog", { columnFlags: HOLD_FLAGS }).map((t: { id: string }) => t.id))
      .toEqual(["FN-2", "FN-1"]);
  });

  it("recency-sorts a RENAMED complete lane, newest first", () => {
    const tasks = [
      { id: "FN-OLD", priority: "urgent", ...at("2026-01-01T00:00:00Z") },
      { id: "FN-NEW", priority: "low", ...at("2026-02-01T00:00:00Z") },
    ] as never[];

    // Priority would put FN-OLD first; the complete lane orders by recency instead.
    expect(sortTasksForDisplayColumn(tasks, "shipped", { columnFlags: COMPLETE_FLAGS }).map((t: { id: string }) => t.id))
      .toEqual(["FN-NEW", "FN-OLD"]);
  });

  it("floats an actively-merging card in a RENAMED review lane", () => {
    const tasks = [
      { id: "FN-IDLE", priority: "urgent", status: null, ...at("2026-01-01T00:00:00Z") },
      { id: "FN-MERGING", priority: "low", status: "merging", ...at("2026-01-01T00:00:00Z") },
    ] as never[];

    // Priority alone would rank FN-IDLE first; merge-active wins in the review lane.
    expect(sortTasksForDisplayColumn(tasks, "signoff", { columnFlags: REVIEW_FLAGS }).map((t: { id: string }) => t.id))
      .toEqual(["FN-MERGING", "FN-IDLE"]);
  });

  it("keeps the legacy ids when no flags are supplied", () => {
    const tasks = [
      { id: "FN-1", priority: "low", ...at("2026-01-01T00:00:00Z") },
      { id: "FN-2", priority: "urgent", ...at("2026-01-02T00:00:00Z") },
    ] as never[];

    expect(sortTasksForDisplayColumn(tasks, "todo").map((t: { id: string }) => t.id)).toEqual(["FN-2", "FN-1"]);
  });
});

describe("rankAssignedTasksForWakeDelta excludes each card's own terminal columns", () => {
  const assigned = (id: string, column: string) => ({ id, column, title: `${id} title`, dependencies: [] });

  it("excludes a card in a RENAMED complete lane from open assigned work", () => {
    // Pre-fix: `shipped` is not `done`, so a coordinator was asked to unblock shipped work.
    const result = rankAssignedTasksForWakeDelta(
      [assigned("FN-OPEN", "building"), assigned("FN-DONE", "shipped")] as never[],
      { agentId: "AG-1", flagsByColumnId: new Map([["shipped", COMPLETE_FLAGS]]) },
    );

    expect(result.totalOpen).toBe(1);
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-OPEN"]);
  });

  it("keeps the legacy ids for a column absent from the flag map", () => {
    // The degraded mode owned by column-roles.ts: no flags → legacy ids, byte-identical to before.
    const result = rankAssignedTasksForWakeDelta(
      [assigned("FN-OPEN", "todo"), assigned("FN-DONE", "done")] as never[],
      { agentId: "AG-1" },
    );

    expect(result.totalOpen).toBe(1);
    expect(result.ranked.map((r) => r.task.id)).toEqual(["FN-OPEN"]);
  });

  it("still counts a card in a non-terminal renamed column as open", () => {
    const result = rankAssignedTasksForWakeDelta(
      [assigned("FN-OPEN", "signoff")] as never[],
      { agentId: "AG-1", flagsByColumnId: new Map([["signoff", REVIEW_FLAGS]]) },
    );

    expect(result.totalOpen).toBe(1);
  });
});
