/*
FNXC:WorkflowLifecycleColumns 2026-07-31-11:30 (E2E evidence — PR #3051's scheduler conversion is INERT):

ESCALATION, not a characterization. PR #3051 ("scheduler.ts 12 -> 2 lifecycle-column guards") converted
the ten `task:moved` / `task:updated` handler arms by widening `resolveTaskParkedColumnsSync` from
`{hold,intake}` to the full role set and replacing the literals with `parked.review` /
`parked.complete` / `parked.archived` / `parked.wip`. The census fell by ten. The behaviour did not
change at all, on any board.

FNXC:WorkflowLifecycleColumns 2026-08-01-05:01:
FN-8656 deletes that scheduler helper and removes every scheduler call site. This file remains the
live PostgreSQL proof that the sync resolver itself is inert, but it no longer claims a scheduler arm
consumes its result; the scheduler's await-safe arms now resolve asynchronously and its prologue uses
emitter lanes.

The reason is one line inside that helper:

    const l = resolveLifecycleColumns(store.resolveTaskWorkflowIrSync(taskId));

`resolveTaskWorkflowIrSync` resolves through the sync workflow SELECTION reader, which under
PostgreSQL — the shipped backend — answers `undefined` for EVERY task. The resolver then takes its
`!workflowId` branch and returns the DEFAULT builtin IR. Note the shape precisely, because the obvious
reading is wrong and this file corrected itself on it: the helper does NOT get `undefined` back and
fall through to `?? legacy.review`. It gets a REAL IR that resolves REAL traits — the default board's
— so `l.review` is `"in-review"` for every card on every board and the `?? legacy` arms beside it are
dead code that never runs. Each converted arm is byte-identical in outcome to the literal it replaced,
and it looks resolved at every level except the one that decides the answer.

This is already established at the store level
(`core/.../postgres/sync-workflow-ir-is-always-default.pg.test.ts`) and for the hold/intake half of
this very helper (`workflow-scheduler-parked-columns-live-e2e.pg.test.ts`, PR #2789). What had no
executable evidence is the claim #3051 actually makes — that the NEWLY added roles fixed something.
Its own note states the fix as fact:

    "so on a renamed board PR monitoring never started or stopped, failure bookkeeping never
     recorded, and terminal cleanup never ran"

Those failures are real. This file shows the conversion does not fix them. Note also that the older
FNXC block still standing directly above the handler contradicts the code beneath it: it says the ten
arms CANNOT be converted this way and names `resolveTaskParkedColumnsSync` as the hazard-avoidance
device, not the fix.

WHY IT IS WORTH ITS OWN FILE. A conversion that changes nothing is worse than an unconverted literal,
because the literal is COUNTED and this is not. Ten guards left the backlog, the file reads as
converted at every level except running it, and the next reader has no reason to look again. That is
the inert-conversion class this program exists to catch, and it has now landed on main.

WHAT IS DRIVEN, AND WHAT IS NOT — stated plainly rather than dressed up.

DRIVEN, against a real PostgreSQL store and a really persisted renamed workflow: the single line every
converted arm rests on. For a card bound to a renamed board, `store.resolveTaskWorkflowIrSync(id)`
returns `undefined`, and the lifecycle columns the helper derives from it are the DEFAULT board's
ids — `in-review`, `in-progress`, `done` — none of which that board contains. Since each arm is
exactly `to === parked.<role>`, an arm that compares against a column the board does not have cannot
fire, and the pre-conversion literal compared against the same string.

NOT DRIVEN: the `parked.review` arm's own side effect. Its only effect is clearing four
dispatch-oscillation fields, and those do not round-trip through `updateTask` on this store
(measured: writing `dispatchStormCount: 3` reads back `undefined`), so there is no persisted
observable to assert on. Rather than substitute a spy and call it end-to-end, the behavioural half is
left to the sibling file `workflow-scheduler-parked-columns-live-e2e.pg.test.ts`, which drives the
SAME helper on the hold role through to persisted state (a dependent that is never unblocked). The
mechanism is one line shared by every role; this file proves that line is inert for the roles #3051
added, and the sibling proves what an inert answer costs.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import { resolveWorkflowIrForTask, type TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { resolveLifecycleColumns } from "../../../core/src/workflows/workflow-lifecycle-traits.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("sync workflow-role resolution remains inert without scheduler consumers", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_sched_syncrole",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A real persisted workflow and a card bound to it, resting in that board's REVIEW column. */
  async function cardOnBoard(store: TaskStore, v: Vocabulary, key: string): Promise<string> {
    const created = await store.createWorkflowDefinition({
      name: `SyncRole ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`, { mergeOrchestration: true }),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `sync-role probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, v.review as never, { recoveryRehome: true } as never);
    store.taskCache.delete(task.id);
    return task.id;
  }

  /** Exactly what `resolveTaskParkedColumnsSync` computes, on the same sync path it uses. */
  function syncRoles(store: TaskStore, taskId: string) {
    return resolveLifecycleColumns(store.resolveTaskWorkflowIrSync(taskId));
  }

  it("FIXTURE — the renamed board really is stored, and the card really is in its review column", async () => {
    /* First, because the refutation below is a claim about a board that must actually exist. If the
       selection had not persisted, every assertion under it would pass for the wrong reason. */
    const store = h.store();
    const taskId = await cardOnBoard(store, RENAMED_VOCAB, "wf-renamed-fixture");

    expect((await store.getTask(taskId))?.column).toBe(RENAMED_VOCAB.review);
    expect(RENAMED_VOCAB.review).not.toBe("in-review");
  });

  it("CONTROL — on the DEFAULT board the sync answer is right, which is why this hid", async () => {
    /* The helper's constant answer IS this board's vocabulary, so every converted arm compares
       against the correct id here — by coincidence, not by resolution. Every default-board test of
       the scheduler therefore passes either way, which is exactly how ten inert conversions read as
       a fix. */
    const store = h.store();
    const taskId = await cardOnBoard(store, DEFAULT_VOCAB, "wf-default-syncrole");

    const roles = syncRoles(store, taskId);
    expect(roles?.review).toBe(DEFAULT_VOCAB.review);
    expect(roles?.wip).toBe(DEFAULT_VOCAB.wip);
    expect(roles?.complete).toBe(DEFAULT_VOCAB.complete);
  });

  it("REFUTATION — on a RENAMED board the sync path still answers with the DEFAULT ids", async () => {
    /*
    The decisive fact. The card is bound to a stored workflow whose review lane is `checking`
    (carrying `human-review`, `merge-blocker` and `merge`), and it is sitting in that column. The
    sync selection read still answers `undefined`, so the roles resolve to the DEFAULT board.

    Every arm #3051 converted is `to === parked.<role>`, so on this board each one compares the card
    against a column the board does not contain — precisely what the literal it replaced did. The
    conversion removed ten guards from the census and changed no behaviour.
    */
    const store = h.store();
    const taskId = await cardOnBoard(store, RENAMED_VOCAB, "wf-renamed-syncrole");

    /* The sync path DOES return an IR — that is the trap. It is simply not this card's IR, so the
       fail-soft `?? legacy` arms never engage and the helper answers with full confidence. */
    const syncIr = store.resolveTaskWorkflowIrSync(taskId);
    expect(syncIr).toBeDefined();

    const roles = syncRoles(store, taskId);
    expect(roles?.review).toBe("in-review");
    expect(roles?.wip).toBe("in-progress");
    expect(roles?.complete).toBe("done");

    /* ...none of which this board declares. */
    expect(roles?.review).not.toBe(RENAMED_VOCAB.review);
    expect(roles?.wip).not.toBe(RENAMED_VOCAB.wip);
    expect(roles?.complete).not.toBe(RENAMED_VOCAB.complete);

    /* And the async resolver — the one an await-tolerant call site would use — gets it right, which
       attributes the failure to the SYNC path and nothing else. */
    const asyncIr = await resolveWorkflowIrForTask(store, taskId);
    expect(resolveLifecycleColumns(asyncIr)?.review).toBe(RENAMED_VOCAB.review);
  });
});
