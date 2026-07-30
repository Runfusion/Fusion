/*
FNXC:WorkflowLifecycleColumns 2026-08-01-05:50 (E2E evidence — restore lands every custom-board card in DONE):

The one lifecycle role with no live coverage, in the function with the worst track record in this
program — and driving it end to end shows why the track record did not improve.

`resolveUnarchiveTargetColumnImpl` decides where a restored card lands, and its own comments record
THREE separate defects fixed on these few lines: a `?? "done"` that invented an undeclared column, an
`isColumn` legacy-enum gate that rejected every renamed id, and the same gate one function over that
dropped a renamed board's stored history on read. All three were reasoned from source. None had a
live-store test.

WITH ONE, THE PATH IS STILL BROKEN, and the cause is upstream of everything those fixes touched:

    archive-lifecycle-2.ts:441   const preArchiveColumn = task.preArchiveColumn ?? "todo";

`preArchiveColumn` IS NEVER WRITTEN. Across `packages/core` every occurrence READS it or copies it
through — into the archive entry, back out of it, through serialization — and nothing ever sets it
from `task.column` when a card is archived. Measured on both boards:

    default: after archive column=archived preArchiveColumn=undefined  -> resolver target=todo
    renamed: after archive column=archived preArchiveColumn=undefined  -> resolver target=shipped

So the fallback fires for every restore that has ever happened, and the two boards diverge because of
what `"todo"` means to each:

  DEFAULT BOARD   `todo` is a declared column, so the resolver returns it. Every restore lands in the
                  queue. That is right for a card archived mid-implementation and wrong for one
                  archived from `done` — but it LOOKS right, which is why this survived.
  RENAMED BOARD   `todo` is declared nowhere, so the resolver takes its "no usable history" branch and
                  returns the COMPLETE lane. Archive a card mid-implementation, restore it, and it
                  comes back marked FINISHED.

That is the operator-visible defect, and it explains the track record: the three earlier fixes were
correcting how the resolver interprets a value that never arrives.

THE CASES BELOW ARE CHARACTERIZATION. They assert today's wrong-but-real behaviour so the defect is
executable rather than argued, and they are written to flip: the fix is to persist the card's column
when archiving, at which point every renamed expectation becomes the lane the card was actually in.
See the PR body — that fix also changes DEFAULT-board placement for cards archived from `done`, which
is why it is proposed rather than smuggled in here.

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
    /* Correct for this card by coincidence: the hardcoded `"todo"` fallback happens to be the default
       board's hold lane. That coincidence is what has hidden the missing write. */
    const store = h.store();

    expect(await archiveThenUnarchive(store, DEFAULT_VOCAB, "wf-default-wip", DEFAULT_VOCAB.wip))
      .toBe(DEFAULT_VOCAB.hold);
  });

  it("CHARACTERIZATION — a RENAMED board's card archived from WIP comes back marked FINISHED", async () => {
    /*
    The card was mid-implementation, so it goes back to the queue — but the queue is `backlog`, not
    `todo`. A legacy-enum gate anywhere upstream sends it to the complete lane or to an id this board
    does not declare, and `unarchiveTaskImpl` writes that destination straight to the row without
    `moveTask`'s validation, so nothing downstream would catch it.
    */
    const store = h.store();

    /* Expected: `hold` — the queue it should return to. Actual: the COMPLETE lane. */
    expect(await archiveThenUnarchive(store, RENAMED_VOCAB, "wf-renamed-wip", RENAMED_VOCAB.wip))
      .toBe(RENAMED_VOCAB.complete);
  });

  it("CHARACTERIZATION — one archived from REVIEW does too", async () => {
    /* The review lane is grouped with WIP by the resolver — unfinished work returns to the queue.
       Asserted separately because the two ids are resolved from different traits, so a conversion
       could fix one role and leave the other. */
    const store = h.store();

    expect(await archiveThenUnarchive(store, RENAMED_VOCAB, "wf-renamed-review", RENAMED_VOCAB.review))
      .toBe(RENAMED_VOCAB.complete);
  });

  it("CHARACTERIZATION — and so does one archived from the HOLD lane it should return to", async () => {
    /*
    The differential that stops the two cases above passing for a trivial reason. If the resolver
    simply returned the hold lane for everything, all three would be green — this one distinguishes
    "resolved the role" from "always answers hold". A card archived from the hold lane has usable
    history, so it goes back to exactly that column.
    */
    const store = h.store();

    expect(await archiveThenUnarchive(store, RENAMED_VOCAB, "wf-renamed-hold", RENAMED_VOCAB.hold))
      .toBe(RENAMED_VOCAB.complete);
  });

  it("a card archived from COMPLETE lands in the complete lane — the only one that is right, and only by accident", async () => {
    /* Finished work keeps its history too, and its id must be the board's own `shipped` — the case a
       `?? "done"` fallback would silently answer with the legacy id. */
    const store = h.store();

    expect(await archiveThenUnarchive(store, RENAMED_VOCAB, "wf-renamed-complete", RENAMED_VOCAB.complete))
      .toBe(RENAMED_VOCAB.complete);
  });
});
