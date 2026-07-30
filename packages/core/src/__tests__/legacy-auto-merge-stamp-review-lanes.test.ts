/*
FNXC:WorkflowLifecycleColumns 2026-07-31-13:00:

THE INVARIANT: the legacy auto-merge stamp backfill reads from the board's OWN review lanes.

THE QUERY WAS THE DEFECT, not the predicate. `isLegacyAutoMergeStampCandidate` gained an optional
resolved `reviewColumns` and no caller passed it — but wiring that parameter alone would have changed
NOTHING, because the read above it asked `listTasks({ column: "in-review" })`. On a renamed board that
query returns zero rows, so the backfill iterated an empty list and reported success over nothing.
The predicate was never reached.

That makes three unwired parameters in this sweep whose CALLER held the larger defect
(`blocker-fanout` emitted no warning at all; the analytics routes reported a silent zero; this one
queried a column that does not exist). An optional parameter nobody fills is worth reading as a
symptom of an unexamined caller, not as a cosmetic gap.

ONE RESOLUTION, THREE USES. `resolveLegacyStampReviewColumns` is exported so the candidate query and
both re-checks share a single answer. My first draft derived the re-check set from the candidates'
own columns, which is subtly wrong: a row that moved between two VALID review lanes would have been
rejected because no candidate happened to sit in the second. Deriving the same fact twice is how a
read and its re-check disagree.

REVERT PROOF, measured: restore `listTasks({ column: "in-review" })` and the renamed-board case
returns no candidates.
*/
import { describe, expect, it, vi } from "vitest";
import { listLegacyAutoMergeStampCandidatesImpl, resolveLegacyStampReviewColumns } from "../task-store/task-store-helpers.js";
import type { TaskStore } from "../store.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "waiting", name: "Waiting", traits: [{ trait: "human-review" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function harness(tasksByColumn: Record<string, Array<Record<string, unknown>>>, definitions: unknown[]) {
  const queried: string[] = [];
  const store = {
    listWorkflowDefinitions: vi.fn(async () => definitions),
    listTasks: vi.fn(async ({ column }: { column: string }) => {
      queried.push(column);
      return tasksByColumn[column] ?? [];
    }),
    isLegacyAutoMergeStampCandidate: (task: { column: string; autoMerge?: boolean; autoMergeProvenance?: string }, reviewColumns?: ReadonlySet<string>) =>
      (reviewColumns ? reviewColumns.has(task.column) : task.column === "in-review")
      && task.autoMerge === true && task.autoMergeProvenance !== "user",
  } as unknown as TaskStore;
  return { store, queried };
}

const stampable = (id: string, column: string) => ({ id, column, autoMerge: true });

describe("the legacy stamp backfill reads the board's own review lanes", () => {
  it("finds candidates in a RENAMED merge lane", async () => {
    // Pre-fix: the query asked for "in-review", got nothing, and the backfill reported success.
    const { store } = harness({ signoff: [stampable("FN-1", "signoff")] }, [{ ir: RENAMED_IR }]);

    const candidates = await listLegacyAutoMergeStampCandidatesImpl(store);

    expect(candidates.map((c) => c.id)).toEqual(["FN-1"]);
  });

  it("also covers a human-review-only lane — the union, not one id", async () => {
    const { store } = harness({ waiting: [stampable("FN-2", "waiting")] }, [{ ir: RENAMED_IR }]);

    const candidates = await listLegacyAutoMergeStampCandidatesImpl(store);

    expect(candidates.map((c) => c.id)).toEqual(["FN-2"]);
  });

  it("still queries the legacy id, for a board mid-rename", async () => {
    // Rows stored under the old id must not be skipped while a rename is in flight.
    const { store, queried } = harness({ "in-review": [stampable("FN-3", "in-review")] }, [{ ir: RENAMED_IR }]);

    const candidates = await listLegacyAutoMergeStampCandidatesImpl(store);

    expect(queried).toContain("in-review");
    expect(candidates.map((c) => c.id)).toEqual(["FN-3"]);
  });

  it("does not return a card outside the review lanes", async () => {
    // The predicate must still filter — widening the query is not widening the answer.
    const { store } = harness({ signoff: [], backlog: [stampable("FN-4", "backlog")] }, [{ ir: RENAMED_IR }]);

    const candidates = await listLegacyAutoMergeStampCandidatesImpl(store);

    expect(candidates).toEqual([]);
  });

  it("falls back to the legacy id alone when definitions cannot be read", async () => {
    const store = {
      listWorkflowDefinitions: vi.fn(async () => { throw new Error("unreadable"); }),
      listTasks: vi.fn(async ({ column }: { column: string }) => (column === "in-review" ? [stampable("FN-5", "in-review")] : [])),
      isLegacyAutoMergeStampCandidate: (t: { column: string; autoMerge?: boolean }) => t.column === "in-review" && t.autoMerge === true,
    } as unknown as TaskStore;

    expect(await resolveLegacyStampReviewColumns(store)).toEqual(new Set(["in-review"]));
    expect((await listLegacyAutoMergeStampCandidatesImpl(store)).map((c) => c.id)).toEqual(["FN-5"]);
  });
});
