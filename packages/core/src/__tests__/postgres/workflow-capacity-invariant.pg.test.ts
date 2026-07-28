/*
FNXC:WorkflowCapacity 2026-07-27-20:10 (Phase A3 — workflow-owned lifecycle):
GROUND TRUTH for the in-transaction column-capacity invariant.

`workflow-capacity.ts` states the enforcement "runs INSIDE `moveTaskInternal`'s
transaction and is NEVER bypassable (not a guard — runs regardless of
bypassGuards/recoveryRehome/moveSource)". Phase A2 observed the opposite: with
`maxConcurrent: 1` and an occupied wip column, a second move into that column
was ACCEPTED. This suite establishes which is true, by test.

RESULT: the invariant does NOT hold for default-workflow tasks, for TWO
independent reasons, each proven separately below.

  R1. THE POOL-ID SENTINEL MISMATCH (the live defect).
      `moves.ts:319` resolves the pool for a task with no workflow selection as
          (await getTaskWorkflowSelectionAsync(id))?.workflowId ?? "builtin:coding"
      while the counter buckets rows with no selection under
          row.wid ?? DEFAULT_WORKFLOW_POOL_ID          // "__default-workflow__"
      (`countActiveInCapacitySlotAsyncImpl`). The two sentinels differ, so for a
      no-selection task the check asks for occupants of a pool that no occupant
      is ever bucketed into: the count comes back 0 and the limit can never bind.
      The SECOND enforcement point — the hold/release sweep at
      `hold-release.ts:116` — uses `?? DEFAULT_WORKFLOW_POOL_ID` and is correct,
      so the two points disagree about pool identity. That is precisely what the
      module docstring claims is impossible ("the two enforcement points can
      never disagree on what a limit *is*, only on the live count").

  R2. THE `useWorkflow` GATE (why the live path is unaffected either way).
      The whole in-txn capacity block sits inside
      `if (useWorkflow && workflowIr && fromColumn !== toColumn)` (moves.ts:921),
      and `useWorkflow` reads the raw `experimentalFeatures.workflowColumns` key
      that nothing in production sets. So on the LIVE path the check does not run
      at all — R1 is latent there and becomes reachable the moment the paths
      converge onto the flag-ON side.

The discriminating experiment is the third case: giving the tasks an EXPLICIT
`builtin:coding` selection makes both sentinels agree, and the rejection appears.
That is what distinguishes a sentinel bug from "capacity is simply not wired".

STATUS: these tests document TODAY'S behavior and fail if it changes. The two
that pin the defect are named `DEFECT:` and assert the wrong-but-current outcome
deliberately — flipping them to expect rejection is the fix's acceptance test.
Fixing is NOT done here: turning enforcement on changes scheduling for every
project (the graph column boundary parks on `capacity-exhausted`), so the blast
radius is reported for an operator decision first.
*/

import { afterEach, beforeEach, expect, it, beforeAll, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("in-transaction column capacity — ground truth (Phase A3)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_capacity_truth",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  Force the move path, then PROVE the flip took effect. Carried over from A2,
  where two silent forcing failures (project-scoped write of a global key, then
  a merge that never cleared the previous value) produced nine and seven
  tautological "passes" respectively. A both-paths suite without this probe
  reports what it assumed, not what happened.
  */
  async function setPath(path: "inline" | "hooks"): Promise<void> {
    const store = h.store();
    await store.updateGlobalSettings(
      path === "hooks"
        ? { experimentalFeatures: { workflowColumns: true } }
        : { experimentalFeatures: { workflowColumns: false } },
    );
    const probe = await store.createTask({ description: `path probe ${path}` });
    const err = await store
      .moveTask(probe.id, "not-a-column-any-workflow-declares")
      .then(() => null, (e: unknown) => e as Error);
    expect(err, `${path}: probe move should have been rejected`).toBeInstanceOf(Error);
    expect(err!.message, `${path} path not active`).toContain(
      path === "hooks" ? "Unknown column for this workflow" : "Valid targets:",
    );
    await store.deleteTask(probe.id);
  }

  /** Occupy the wip column with one card, then try to move a second in.
   *  Returns the rejection (or null when the move was accepted). */
  async function fillWipThenAdmitSecond(
    opts: { selectWorkflow?: string } = {},
  ): Promise<{ error: Error | null; secondColumn: string | undefined }> {
    const store = h.store();

    const holder = await store.createTask({ description: "capacity holder" });
    if (opts.selectWorkflow) await store.selectTaskWorkflow(holder.id, opts.selectWorkflow);
    await store.moveTask(holder.id, "todo");
    await store.moveTask(holder.id, "in-progress");

    const contender = await store.createTask({ description: "capacity contender" });
    if (opts.selectWorkflow) await store.selectTaskWorkflow(contender.id, opts.selectWorkflow);
    await store.moveTask(contender.id, "todo");
    const error = await store
      .moveTask(contender.id, "in-progress")
      .then(() => null, (e: unknown) => e as Error);

    return { error, secondColumn: (await store.getTask(contender.id))?.column };
  }

  it("FIXED (R2): the capacity check now runs on the PRODUCTION inline path too", async () => {
    /*
    FNXC:WorkflowCapacity 2026-07-28-10:20 (R2 fix):
    Was `DEFECT (R2, STILL LIVE)`, asserting that a second card entered a full wip
    column on the path every real project takes. Both reasons the invariant failed
    are now closed: R1 was the pool-id sentinel, R2 was this — the whole capacity
    block sat inside `if (useWorkflow && …)`, reading a settings key with no
    production writer.

    THIS IS THE USER-VISIBLE HALF of the change. Before it, a project with
    `maxConcurrent: N` could hold more than N cards in its wip column and nothing
    said so; now the move is refused with `capacity-exhausted`, which the graph
    column boundary parks on and the promote route surfaces. Flipping this
    expectation is the acceptance test for that behavior change.
    */
    const store = h.store();
    await store.updateSettings({ maxConcurrent: 1 });
    await setPath("inline");

    const { error, secondColumn } = await fillWipThenAdmitSecond();

    expect((error as unknown as { rejection?: { code?: string } })?.rejection?.code).toBe(
      "capacity-exhausted",
    );
    expect(secondColumn).toBe("todo"); // refused, stays put
  });

  it("FIXED (R1): flag-ON, a NO-SELECTION task is now REFUSED at the limit", async () => {
    /*
    FNXC:WorkflowCapacity 2026-07-28-19:05:
    Was `DEFECT (R1)`, asserting the wrong-but-current outcome. The pool-id
    sentinel is fixed: `moves.ts` and the counter now BOTH derive the pool through
    `resolveCapacityPoolId`, so a selection-less row is bucketed and asked about
    under the same key and the limit binds. Flipping this expectation is the
    acceptance test the original ratchet named.
    */
    const store = h.store();
    await store.updateSettings({ maxConcurrent: 1 });
    await setPath("hooks");

    const { error, secondColumn } = await fillWipThenAdmitSecond();

    expect(error).toBeInstanceOf(Error);
    expect((error as unknown as { rejection?: { code?: string } }).rejection?.code).toBe(
      "capacity-exhausted",
    );
    expect(secondColumn).toBe("todo"); // refused, stays put

  });

  it("DISCRIMINATOR: with an EXPLICIT builtin:coding selection the sentinels agree and the limit BINDS", async () => {
    /*
    This is what proves R1 is a sentinel mismatch rather than "capacity is not
    wired". Same settings, same columns, same limit — the ONLY change is that
    both tasks now carry a selection row, so `row.wid` is "builtin:coding" and
    matches what moves.ts asked for. The occupant is counted and the move is
    refused with the typed code the graph column boundary parks on.
    */
    const store = h.store();
    await store.updateSettings({ maxConcurrent: 1 });
    await setPath("hooks");

    const { error, secondColumn } = await fillWipThenAdmitSecond({ selectWorkflow: "builtin:coding" });

    expect(error).toBeInstanceOf(Error);
    expect((error as unknown as { rejection?: { code?: string } }).rejection?.code).toBe(
      "capacity-exhausted",
    );
    expect(secondColumn).toBe("todo"); // refused, stays put
  });

  /*
  THE INVARIANT RATCHET.

  The three cases above document today's behavior, so they stay green while the
  defect exists — which on its own would let the defect live forever unnoticed.
  This case states the invariant AS WRITTEN in `workflow-capacity.ts`
  ("enforcement ... is NEVER bypassable") and is marked `it.fails`, so:

      today  — the body fails (no rejection), therefore `it.fails` PASSES and CI
               stays green while honestly recording that the invariant is broken;
      fixed  — the body passes, `it.fails` FAILS, and whoever lands the sentinel
               fix is forced to delete the `.fails` marker and the two `DEFECT:`
               expectations above.

  That is the "test that fails today if the invariant is broken" the unit asks
  for, in the only shape that does not park a permanently-red test in CI. An
  invariant nobody can prove is an invariant nobody has; this is the proof
  obligation, written down.
  */
  it(
    "INVARIANT (HOLDS on the flag-ON path): a move into a full capacity column is refused, even with no workflow selection",
    async () => {
      const store = h.store();
      await store.updateSettings({ maxConcurrent: 1 });
      await setPath("hooks");

      const { error, secondColumn } = await fillWipThenAdmitSecond();

      expect(error).toBeInstanceOf(Error);
      expect((error as unknown as { rejection?: { code?: string } }).rejection?.code).toBe(
        "capacity-exhausted",
      );
      expect(secondColumn).toBe("todo");
    },
  );

  /*
  FNXC:WorkflowCapacity 2026-07-28-16:10 (PR #2499 review — greptile: split capacity state):
  THE SPLIT-SNAPSHOT RATCHET.

  The capacity gate derives TWO things from the task's workflow selection: the
  LIMIT (from the resolved IR) and the POOL KEY the occupancy count buckets on.
  Before this fix they came from two INDEPENDENT reads — the pool id from a
  pre-transaction `getTaskWorkflowSelectionAsync`, the IR from a second one inside
  `resolveTaskWorkflowIrForMove`. Neither was serialized with the count, which runs
  on the move's transaction handle. A selection change landing between them made
  the gate measure workflow A's (empty) pool against workflow B's finite limit and
  admit into a full column.

  That is the R1 sentinel defect in a new costume: gate and counter describing
  different pools, so a finite limit cannot bind. It matters precisely BECAUSE this
  PR is where capacity starts binding — a gate that leaks under concurrent
  selection change is a defect introduced exactly where operators begin relying on
  it.

  HOW THIS DISCRIMINATES, deterministically rather than by racing threads: the
  pre-transaction reader is stubbed to report a workflow that DIFFERS from the one
  actually persisted — which is what a concurrent selection change looks like from
  inside the move. The stubbed workflow's pool is empty; the persisted one's is
  full. Old code trusts the stub for both the pool key and the IR, so it measures
  an empty pool against a finite limit and admits. The fix reads the selection once
  through the transaction handle, so the PERSISTED value decides and the move is
  refused.

  FIRST ATTEMPT AT THIS TEST WAS WORTHLESS, and the revert-proof is the only reason
  that is known: it stubbed a per-CALL sequence to hand the two old reads different
  values, but the pre-transaction telemetry read silently consumed the first entry,
  so both capacity reads landed on the same value and the reverted code passed. The
  order-independent form below does not depend on how many times the reader is
  called — which is the property a ratchet needs, since call counts are exactly the
  kind of thing a later refactor changes without noticing.
  */
  it("RATCHET: a workflow-selection change mid-move cannot split the limit from the counting pool", async () => {
    const store = h.store();
    await store.updateSettings({ maxConcurrent: 1 });
    await setPath("inline");

    // Fill builtin:coding's wip pool to its limit of 1.
    const holder = await store.createTask({ description: "split-snapshot holder" });
    await store.selectTaskWorkflow(holder.id, "builtin:coding");
    await store.moveTask(holder.id, "todo");
    await store.moveTask(holder.id, "in-progress");

    const contender = await store.createTask({ description: "split-snapshot contender" });
    await store.selectTaskWorkflow(contender.id, "builtin:coding");
    await store.moveTask(contender.id, "todo");

    /*
    The stub diverges from what is PERSISTED: it reports builtin:coding-ideas (whose
    wip pool holds zero occupants and whose in-progress column still carries a
    finite maxConcurrent-backed limit), while the row says builtin:coding (pool
    full). Restored in `finally` so a failure cannot leak a patched store into the
    next test.
    */
    const realReader = store.getTaskWorkflowSelectionAsync.bind(store);
    let stubCalls = 0;
    (store as unknown as { getTaskWorkflowSelectionAsync: (taskId: string) => Promise<unknown> })
      .getTaskWorkflowSelectionAsync = async (taskId: string) => {
        if (taskId !== contender.id) return realReader(taskId);
        stubCalls++;
        return { workflowId: "builtin:coding-ideas", stepIds: [] };
      };

    let error: Error | null;
    try {
      error = await store
        .moveTask(contender.id, "in-progress")
        .then(() => null, (e: unknown) => e as Error);
    } finally {
      (store as unknown as { getTaskWorkflowSelectionAsync: unknown }).getTaskWorkflowSelectionAsync = realReader;
    }

    // The stub was actually exercised — otherwise this would pass for the wrong reason.
    expect(stubCalls, "the pre-transaction selection reader was never called").toBeGreaterThan(0);
    expect((error as unknown as { rejection?: { code?: string } })?.rejection?.code).toBe(
      "capacity-exhausted",
    );
    expect((await store.getTask(contender.id))?.column).toBe("todo");
  });
});
