/*
FNXC:WorkflowLifecycleColumns 2026-07-30-19:20 (E2E evidence — the scheduler's SYNC parked-column read):

`scheduler.ts`'s `resolveTaskParkedColumnsSync` resolves a task's hold/intake columns through
`store.resolveTaskWorkflowIrSync`. Under PostgreSQL that reader is a cutover stub that answers
`undefined` for EVERY task (`core/.../postgres/sync-workflow-ir-is-always-default.pg.test.ts`), so
the resolver always takes its `!workflowId` branch and hands back the DEFAULT lifecycle IR — which
resolves to `{ hold: "todo", intake: "triage" }` on every board, renamed or not. The conversion is
INERT: byte-identical in outcome to the literals it replaced.

NOTE THE EXACT MECHANISM, because the obvious reading is wrong. It is NOT the fail-soft:

    { hold: lifecycle?.hold ?? "todo", intake: lifecycle?.intake ?? "triage" }

`lifecycle` is not nullish. A REAL default IR comes back and resolves real traits, so `lifecycle.hold`
is `"todo"` and both `??` arms are unreachable in production. Established by mutation, not by reading:
rewriting the two fallback literals to the renamed vocabulary changed NEITHER arm below (dead branch),
while forcing the returned object to the renamed pair flipped BOTH. That is the sharpest form of this
whole defect class — the site resolves an IR and reads a trait off it, so it looks converted at every
level except the one that decides the answer.

WHY THIS FILE EXISTS AND WHAT IT CONTRADICTS. `scheduler-renamed-hold-events.test.ts` asserts the
opposite outcome and passes, because its mock store supplies

    resolveTaskWorkflowIrSync: vi.fn(() => renamedIr())

— an answer the real store provably never gives. So the scheduler's renamed-board behaviour is
currently attested only by a fixture that disagrees with production. That unit test is not wrong
about the SCHEDULER (given a working resolver the handlers do resolve the renamed lane); it is wrong
about the RESOLVER. This suite pins the live outcome so the gap is executable rather than argued.

THE ARM THAT IS NOT LATENCY. Four handler groups read these columns. Three fail as latency — a wake
that does not fire costs up to one poll interval, which is why the whole class hid for so long. The
`task:deleted` dependency reconciliation is different: it both QUERIES `listTasks({ column: hold })`
and re-checks `dependent.column === deletedParked.hold` before clearing `blockedBy`. On a renamed
board both tests are against `"todo"`, a column that board does not contain, so a dependent resting
in the renamed hold column is never found and never unblocked. It waits on a blocker that is already
gone — persisted, operator-visible, and unbounded in time.

OBSERVED STATE, NOT SPIES. Each arm asserts the dependent's PERSISTED `blockedBy` after a REAL
soft-delete on a REAL store. No call assertions: a wake is a call, but this failure is a row.

THE SETTLE WINDOW IS SELF-VALIDATING. The handler's work is fire-and-forget (`void (async () => …)()`),
so the observation needs a bounded wait, and a bounded wait proving a NEGATIVE is normally worthless
— it cannot distinguish "never happens" from "not yet". The default-vocabulary arm is the control:
it runs the same window against the same store and DOES unblock. A window long enough for the
control is long enough for the renamed arm, so the negative is a real difference and not a race.
That is also why the two arms share one helper and one settle constant rather than being tuned
apart. If this ever flakes, the control fails first and says so — the fix is the quarantine ledger,
never a larger number here.

REGRESSION, NOT CHARACTERIZATION. The renamed expectation now pins the corrected outcome: the
asynchronous resolver finds dependents in the workflow's real hold column, so the renamed and default
boards both clear `blockedBy` in the same settle window.

FNXC:WorkflowResolvedColumns 2026-08-01-05:01:
FN-8656 applies the same async fallback to the await-safe `task:moved` arms. Its synchronous prologue
still consumes emitter lanes over legacy defaults, preserving event ordering; this file continues to
pin the live-store dependency invariant for lane-less or forwarded payloads.

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

import { Scheduler } from "../scheduler.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

/** Bounded wait for the handler's fire-and-forget reconciliation. Validated by the control arm. */
const SETTLE_MS = 2_000;
const POLL_MS = 25;

pgDescribe("scheduler parked-column resolution against a live store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_sched_parked",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /**
   * Persist a real workflow definition, a blocker, and a dependent parked in that workflow's HOLD
   * column, then soft-delete the blocker with a live Scheduler attached.
   *
   * Returns the dependent's persisted `blockedBy` once it settles (or once the window expires).
   *
   * `createWorkflowDefinition` allocates its OWN id and ignores one passed in, so both tasks bind to
   * the id the STORE returned — binding to the requested id silently resolves the default builtin
   * IR, which is a renamed-workflow fixture that tests nothing.
   */
  async function unblockOutcome(store: TaskStore, v: Vocabulary, key: string): Promise<string | null> {
    const created = await store.createWorkflowDefinition({
      name: `Parked ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    const workflowId = (created as { id: string }).id;

    const blocker = await store.createTask({ description: `blocker ${key}` });
    const dependent = await store.createTask({ description: `dependent ${key}` });
    for (const id of [blocker.id, dependent.id]) {
      await store.writeTaskWorkflowSelection(id, workflowId, []);
      store.taskCache.delete(id);
    }

    /* `moveTask`, not `updateTask({ column })` — `column` is not part of the update payload, so the
       latter typechecks as an unknown key and leaves both cards in their created column, which
       makes both arms of this suite vacuous.

       `recoveryRehome` because a card is CREATED in `todo` regardless of its workflow's own start
       column, so on the renamed board the first move is `todo -> building`, which the IR's
       transition guard correctly refuses (`Valid targets: backlog`). This is fixture placement, not
       the subject: the flag skips only the allowed-transition check, and every arm uses it, so the
       two boards are still placed identically. */
    await store.moveTask(blocker.id, v.wip as never, { recoveryRehome: true } as never);

    /* ORDER MATTERS, and getting it backwards silently voids the control arm. Writing the blocked
       state AFTER placing the card re-homes it to the INTAKE column (observed: `todo -> triage` on
       the default board), and the reconciliation re-checks `dependent.column === hold` before
       clearing `blockedBy` — so the control fails for a fixture reason that looks exactly like the
       defect under test. Block first, then place. */
    await store.updateTask(dependent.id, {
      dependencies: [blocker.id],
      blockedBy: blocker.id,
      status: "queued",
    });
    await store.moveTask(dependent.id, v.hold as never, { recoveryRehome: true } as never);
    store.taskCache.delete(dependent.id);
    expect((await store.getTask(dependent.id))?.column).toBe(v.hold);

    /* A real Scheduler over the real store. Its handlers register in the constructor, so no start()
       — and deliberately no poll loop, which would introduce a second, non-event path to the same
       reconciliation and make the arm below ambiguous about WHICH path unblocked the card. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const scheduler = new Scheduler(store, {} as never);
    void scheduler;

    /* `removeDependencyReferences` is required: `deleteTask` refuses a blocker that a live task
       still lists, and the dependent listing it is the whole subject here. */
    await store.deleteTask(blocker.id, { removeDependencyReferences: false, allowResurrection: false });

    const deadline = Date.now() + SETTLE_MS;
    let observed: string | null = blocker.id;
    while (Date.now() < deadline) {
      store.taskCache.delete(dependent.id);
      const row = await store.getTask(dependent.id);
      observed = row?.blockedBy ?? null;
      if (observed === null) return null;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return observed;
  }

  it("CONTROL — a dependent in the DEFAULT hold column is unblocked when its blocker is deleted", async () => {
    /* Proves the path works and the settle window is adequate. Without this the renamed arm below
       could be passing on a window that is simply too short. */
    const store = h.store();

    expect(await unblockOutcome(store, DEFAULT_VOCAB, "wf-default-parked")).toBeNull();
  });

  it("REGRESSION — a dependent in a RENAMED hold column IS unblocked when its blocker is deleted", async () => {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-06:35 (fleet — the flip this test was written to catch):
    This was a CHARACTERIZATION of the inert sync read: `resolveTaskParkedColumnsSync` answered
    `{ hold: "todo" }` for a board whose hold column is `backlog`, so the reconciliation queried a
    column that does not exist, found no dependents, and left `blockedBy` pointing at a deleted task.

    Its author wrote "expected to flip to `null` the moment the resolver is fixed — and that flip is
    the whole point of writing it down." The `task:deleted` handler now resolves asynchronously, so it
    has flipped, and the assertion is inverted to hold the fix rather than deleted.

    It now asserts the SAME thing as the CONTROL above, which is the point: the renamed board and the
    default board must behave identically. The control still earns its place — if the settle window
    were too short, both would return null and this would pass vacuously.
    */
    const store = h.store();

    expect(await unblockOutcome(store, RENAMED_VOCAB, "wf-renamed-parked")).toBeNull();
  });
});
