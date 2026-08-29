/*
FNXC:PostgresCutover 2026-07-31-15:55 (regression — the startup sweep deadlocked on itself):

`recoverStaleTransitionPendingImpl` runs its whole per-task body inside `store.withTaskLock(id, ...)`.
On the PostgreSQL arm it then read the task with `store.getTask(id)` — and `getTaskImpl` opens with
`store.withTaskLock(id, ...)` too. The per-task lock is NON-REENTRANT, an invariant this codebase
states in prose in two other files ("nesting inside withTaskLock would deadlock since the lock is
non-reentrant" in `branch-and-pr-entities.ts`; "because the per-task lock is non-reentrant" in
`workflow-ops.ts`). So the sweep waited forever on a lock its own frame was holding.

SQLite never had it: that arm reads through `readTaskFromDb`, a lock-free row read. The backend port
swapped only the PostgreSQL arm to `getTask`, so the deadlock is PostgreSQL-only — which is every
production install. The fix restores a lock-free read (`readTaskRow`) on that arm.

WHY IT SURVIVED: the branch is entered only when a stale marker names a plugin hook the trait
registry still knows (`hasSurvivingPluginHook`). Three nearby cases all miss it —
  no marker at all             -> the row is not scanned
  marker with only the default -> `hasSurvivingPluginHook` is false; marker is just cleared
  marker naming an UNKNOWN hook-> reconciled away as degraded, so nothing survives to re-run
— and those are the cases the existing tests cover. Only a marker naming a REGISTERED plugin hook
reaches the read, which is precisely the state a crash mid-hook leaves behind. All four are asserted
below so the next change cannot re-narrow the path and call it covered.

FOUND BY BISECTION, not by reading. An earlier attempt to drive this recovery reported that "the
sweep never returns", which was wrong in a way worth recording: the sweep returns fine in three of
the four cases, and generalising the one hang to the whole function is what hid the actual trigger
for several sessions. The bisection is the four cases below.

EVERY CASE IS TIMEBOXED. A deadlock regression manifests as a hang, and a hung test is reported as a
suite-level timeout that names no case — useless for locating the fault. Racing each call against an
explicit deadline turns it into a normal assertion failure that names the case and the condition.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable. Throwaway per-file
database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import {
  getTraitRegistry,
  makeTransitionPending,
  registerTraitHookImpl,
  type TaskStore,
} from "@fusion/core";

import { recoverStaleTransitionPendingImpl } from "../../../core/src/task-store/lifecycle-ops.js";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";
import { writeTransitionPendingAsync } from "../../../core/src/task-store/async/async-transition-pending.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

/** Generous next to a sweep over one row, tight next to a deadlock. Not a flake knob: the fixed code
 *  completes in milliseconds and the broken code never completes at all, so there is no value in
 *  between for this to be tuned to. */
const DEADLINE_MS = 8_000;

const REGISTERED_TRAIT = "plugin:transition-pending-regression";

/** Set by the registered hook when the runner actually invokes it. */
const firedFor: string[] = [];

async function sweepWithin(store: TaskStore): Promise<{ scanned: number; recovered: number; degradedHooks: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      recoverStaleTransitionPendingImpl(store),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`recoverStaleTransitionPendingImpl did not settle within ${DEADLINE_MS}ms — deadlock`)),
          DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

pgDescribe("stale transition-pending recovery does not deadlock on the per-task lock", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_transition_deadlock",
  });

  beforeAll(async () => {
    await h.beforeAll();
    /* A real plugin trait with a real hook, so `knownHookIds` contains it and a marker naming it
       counts as SURVIVING. Registered through the production registry — nothing here is a stand-in. */
    getTraitRegistry().register({
      id: REGISTERED_TRAIT,
      name: "transition pending regression probe",
      flags: {},
      hooks: { onEnter: { id: `${REGISTERED_TRAIT}:onEnter` } },
    } as never);
    /* THREE arguments — `(traitId, hookKind, impl)`. Registering with a composed `"<trait>:onEnter"`
       id and no kind silently registers nothing: the runner then resolves the hook to a no-op, so the
       suite reads as "the hook never fired" and invites the conclusion that the recovery is broken.
       Cost me a wrong diagnosis before the signature was checked. */
    registerTraitHookImpl(
      REGISTERED_TRAIT,
      "onEnter" as never,
      (async (ctx: { task?: { id?: string } }) => { firedFor.push(ctx?.task?.id ?? "unknown"); }) as never,
    );
  });
  afterAll(h.afterAll);
  beforeEach(async () => { firedFor.length = 0; await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A card carrying a stale transition-pending marker with the given hook ids. */
  async function markedCard(store: TaskStore, hookIds: string[], description: string): Promise<string> {
    const task = await store.createTask({ description });
    await writeTransitionPendingAsync(
      store.asyncLayer!.db,
      task.id,
      makeTransitionPending("todo", hookIds, Date.now() - 10 * 60_000),
    );
    return task.id;
  }

  it("REGRESSION — a marker naming a REGISTERED plugin hook settles instead of hanging", async () => {
    /*
    The deadlock case, and the only one of the four that reaches the in-lock task read. Before the
    fix this never returned; the assertion below was never reached and the suite died on a timeout
    that named no case.
    */
    const store = h.store();
    await markedCard(store, [`${REGISTERED_TRAIT}:onEnter`, "default-workflow:postCommit"], "registered hook");

    const result = await sweepWithin(store);

    expect(result.scanned).toBe(1);
    expect(result.recovered).toBe(1);
  });

  it("a marker naming an UNKNOWN plugin hook is reconciled as degraded", async () => {
    /* Never reached the read — the unknown hook is reconciled away, so nothing survives to re-run.
       Pinned so the fix cannot be "fixed" by narrowing the surviving-hook test instead. */
    const store = h.store();
    await markedCard(store, ["plugin:not-installed:onEnter", "default-workflow:postCommit"], "unknown hook");

    const result = await sweepWithin(store);

    expect(result.recovered).toBe(1);
    expect(result.degradedHooks).toBe(1);
  });

  it("a marker with only the default hook is cleared without a re-run", async () => {
    const store = h.store();
    await markedCard(store, ["default-workflow:postCommit"], "default only");

    const result = await sweepWithin(store);

    expect(result.recovered).toBe(1);
    expect(result.degradedHooks).toBe(0);
  });

  it("REGRESSION — the interrupted hook is re-run for a task on a CUSTOM workflow", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-18:55 (PR #2809 review — greptile P1):
    THE SECOND DEFECT ON THIS LINE, and it only became reachable once the deadlock above was fixed.
    The recovery resolved the task's IR with `resolveTaskWorkflowIrSync`, which hands back the DEFAULT
    workflow for every task under PostgreSQL. The hook runner derives its pending set from the
    columns of the IR it is given, so a task on a RENAMED board matched no plugin trait: the
    interrupted hook was never re-run and the sweep reported success having done nothing.

    Observed state, not a spy on the resolver: the hook itself records the task id it ran for. The
    board is renamed so the default IR cannot supply the column by accident — the `building` column
    carrying the plugin trait exists on this workflow and on no other.
    */
    const store = h.store();
    const ir = lifecycleIr(RENAMED_VOCAB, "custom:transition-pending") as unknown as {
      columns: { id: string; traits: unknown[] }[];
    };
    ir.columns = ir.columns.map((column) => column.id === RENAMED_VOCAB.wip
      ? { ...column, traits: [...column.traits, { trait: REGISTERED_TRAIT }] }
      : column);
    const created = await store.createWorkflowDefinition({
      name: "Transition pending custom board",
      kind: "workflow",
      ir,
    } as never);

    const task = await store.createTask({ description: "custom board, interrupted hook" });
    await store.writeTaskWorkflowSelection(task.id, (created as { id: string }).id, []);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, RENAMED_VOCAB.wip as never, { recoveryRehome: true } as never);
    await writeTransitionPendingAsync(
      store.asyncLayer!.db,
      task.id,
      makeTransitionPending(RENAMED_VOCAB.wip, [`${REGISTERED_TRAIT}:onEnter`, "default-workflow:postCommit"], Date.now() - 10 * 60_000),
    );

    const result = await sweepWithin(store);

    expect(result.recovered).toBe(1);
    expect(firedFor).toContain(task.id);
  });

  it("a store with no markers scans nothing", async () => {
    /* The vacuity guard: without it, a change that stopped listing marked rows would leave every
       case above green while the recovery did nothing at all. */
    const store = h.store();
    await store.createTask({ description: "no marker" });

    expect(await sweepWithin(store)).toEqual({ scanned: 0, recovered: 0, degradedHooks: 0 });
  });
});
