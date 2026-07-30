/*
FNXC:WorkflowLifecycleColumns 2026-08-01-13:10 (restore lands a card back on its OWN board — the fix):

`resolveUnarchiveTargetColumnImpl` decides where a restored card lands, and its comments record THREE
defects fixed on those few lines: a `?? "done"` that invented an undeclared column, an `isColumn`
legacy-enum gate that rejected every renamed id, and the same gate one function over that dropped a
renamed board's stored history on read. All three were reasoned from source, none had a live test, and
the path stayed broken — because the value they argue over never arrived.

    archive-lifecycle-2.ts   const preArchiveColumn = task.preArchiveColumn ?? "todo";

`preArchiveColumn` HAS NO DATABASE COLUMN. It exists on the `Task` type and in the archive snapshot,
and nowhere else — so the in-place restore cannot carry it, `store.getTask(id)` reads a live row that
never had it, and the literal decided every destination. On the default board `todo` is declared, so
restores landed in the queue and looked right; on a renamed board `todo` is declared nowhere, the
resolver took its "no usable history" branch, and a card archived mid-implementation came back marked
FINISHED.

TWO HALVES, and the first alone does nothing — established by shipping it first and watching the
destination stay wrong:
  capture   `taskToArchiveEntryImpl` records `task.column` into the snapshot, which is the last place
            the original column is still in hand (the entry's own `column` is set to `"archived"`).
  read      `unarchiveTaskImpl` reads the SNAPSHOT it already loaded, not the restored row.

WHAT THE ROLES DECIDE, from the resolver's own branches — and the review case is subtler than it looks:
  archived from a WIP or REVIEW lane   -> the board's HOLD lane; unfinished work returns to the queue
  archived from any other declared     -> that same column; its history is usable as-is
  archived from `archived`, or from a  -> the board's COMPLETE lane
  column the board no longer declares

`.review` is derived from the `mergeOrchestration` flag, NOT from `human-review` (a distinction that
cost me a wrong expectation here). This fixture's review column declares `human-review` and
`merge-blocker` only, so it is not a `.review` lane to the resolver — it is simply a declared column
with usable history, and a card archived from it restores THERE. That is the correct answer, and the
case below asserts it with the reasoning attached so the next reader does not "fix" it to hold.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import type { TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("unarchive destination resolves the card's own board", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_unarchive_target",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** Archive a real card from `fromColumn` on a real stored workflow, then restore it. Returns the
   *  column the restore actually wrote to the row. */
  async function archiveThenUnarchive(
    store: TaskStore,
    v: Vocabulary,
    key: string,
    fromColumn: string,
  ): Promise<string | undefined> {
    const created = await store.createWorkflowDefinition({
      name: `Unarchive ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    const task = await store.createTask({ description: `unarchive probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, (created as { id: string }).id, []);
    store.taskCache.delete(task.id);

    await store.moveTask(task.id, fromColumn as never, { recoveryRehome: true } as never);
    await store.archiveTask(task.id, { cleanup: false });
    await store.unarchiveTask(task.id);

    store.taskCache.delete(task.id);
    return (await store.getTask(task.id))?.column;
  }

  it("CONTROL — on the DEFAULT board a restore lands in the queue, and looks correct", async () => {
    /* Unchanged by the fix, and that is the point: the literal happened to be this board's hold lane,
       which is why the defect was invisible here for so long. */
    const store = h.store();

    expect(await archiveThenUnarchive(store, DEFAULT_VOCAB, "wf-default-wip", DEFAULT_VOCAB.wip))
      .toBe(DEFAULT_VOCAB.hold);
  });

  it("a RENAMED board's card archived from WIP returns to ITS queue", async () => {
    /*
    The card was mid-implementation, so it goes back to the queue — but the queue is `backlog`, not
    `todo`. A legacy-enum gate anywhere upstream sends it to the complete lane or to an id this board
    does not declare, and `unarchiveTaskImpl` writes that destination straight to the row without
    `moveTask`'s validation, so nothing downstream would catch it.
    */
    const store = h.store();

    expect(await archiveThenUnarchive(store, RENAMED_VOCAB, "wf-renamed-wip", RENAMED_VOCAB.wip))
      .toBe(RENAMED_VOCAB.hold);
  });

  it("one archived from a human-review lane returns to that lane", async () => {
    /* The review lane is grouped with WIP by the resolver — unfinished work returns to the queue.
       Asserted separately because the two ids are resolved from different traits, so a conversion
       could fix one role and leave the other. */
    const store = h.store();

    /* Its OWN lane, not hold — see the header: this column declares `human-review` but no merge
       orchestration, so it is a declared column with usable history rather than a `.review` lane. */
    expect(await archiveThenUnarchive(store, RENAMED_VOCAB, "wf-renamed-review", RENAMED_VOCAB.review))
      .toBe(RENAMED_VOCAB.review);
  });

  it("one archived from the HOLD lane returns there", async () => {
    /*
    The differential that stops the two cases above passing for a trivial reason. If the resolver
    simply returned the hold lane for everything, all three would be green — this one distinguishes
    "resolved the role" from "always answers hold". A card archived from the hold lane has usable
    history, so it goes back to exactly that column.
    */
    const store = h.store();

    expect(await archiveThenUnarchive(store, RENAMED_VOCAB, "wf-renamed-hold", RENAMED_VOCAB.hold))
      .toBe(RENAMED_VOCAB.hold);
  });

  it("a card archived from COMPLETE stays finished", async () => {
    /* Finished work keeps its history too, and its id must be the board's own `shipped` — the case a
       `?? "done"` fallback would silently answer with the legacy id. */
    const store = h.store();

    expect(await archiveThenUnarchive(store, RENAMED_VOCAB, "wf-renamed-complete", RENAMED_VOCAB.complete))
      .toBe(RENAMED_VOCAB.complete);
  });
});
