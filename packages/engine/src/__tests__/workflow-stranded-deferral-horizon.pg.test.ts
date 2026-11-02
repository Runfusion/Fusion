/*
FNXC:StrandedContinuationDeferralHorizon 2026-11-02-12:27 (RUFU-299):
This file is the real-store proof for the two promises RUFU-299 makes about a deferred stranded
continuation, because neither is checkable through a mock:

1. `deferred_since` is a durable COLUMN that survives the round trip. A fake that echoes the patch it was
   handed would confirm an unwired migration, a mapper that drops the field, or a transition `updateSet` that
   forgets it exactly as happily as it confirms the fix — and all three defects are invisible to the unit lane,
   because the sweep there reads back the object the same process wrote.
2. The deferral ladder is BOUNDED and OBSERVABLE. `listDueWorkflowWorkItems` is the one predicate that decides
   which row any dispatcher ever sees, so "the card came back" has to be asserted against the real predicate
   over real rows, not against a fake's `retryAfter <= now` reimplementation.

Why a PostgreSQL lane and not only the fake harness: the symptom IS the due-gate
(`retry_after IS NULL OR retry_after <= now`), and the fix crosses the persistence boundary — new column, new
migration, registered explicitly, ceiling advanced. The engine fake harness stays where the per-pass
write/emit budget is asserted cheaply; this file asserts the state.

ASSERTION RULE, inherited from `workflow-stranded-column-live-e2e.pg.test.ts`: every claim is asserted on
OBSERVED PERSISTED STATE — a fresh read through the store — never on "a function was called".

TIME IS ARRANGED, NOT WAITED FOR. A transition stamps `updated_at` with the wall clock, so a test that wants a
row to LOOK seven hours old must set `updated_at` after its last write, in the same arrangement step. Getting
that order wrong does not fail loudly: every row reads `too-fresh`, the classifier answers `none`, the sweep
writes nothing, and the test passes for entirely the wrong reason. Every helper below therefore ends by
arranging `updated_at`.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is unaffected.
Throwaway per-file database; never port 4040; no temp-root walk.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@fusion/core";
import type { TaskStore, WorkflowWorkItem } from "@fusion/core";
import { ACTIVE_WORKFLOW_WORK_ITEM_STATES } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  DEPENDENCY_HOLD_REASON_PREFIX,
  RECLAIM_DEFERRAL_HORIZON_MS,
} from "../workflows/stranded-continuation-reclaim.js";

pgDescribe("RUFU-299 stranded-deferral horizon against a live store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rufu_299_horizon",
    projectId: "fusion-rufu-299-horizon",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const BLOCKER = "RUFU-196";
  const HOLD_REASON = `${DEPENDENCY_HOLD_REASON_PREFIX}${BLOCKER}`;
  const TOP_RUNG = 6 * HOUR;

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
  const dueIds = (rows: WorkflowWorkItem[]) => rows.map((row) => row.id);
  const activeStates = () => [...ACTIVE_WORKFLOW_WORK_ITEM_STATES];

  /*
  The auditor wrapper wraps every payload in an envelope it owns — `phase`, plus `source` and `taskLineageId`
  when the caller's context carries them (RUFU-314 named exactly this as the reason a documented closed set
  and a stored row can disagree). The assertions below strip the envelope and compare the PAYLOAD, so the
  documented key set stays checkable without pretending the envelope is not there.
  */
  const AUDITOR_ENVELOPE_KEYS = new Set(["phase", "source", "taskLineageId"]);
  const payloadKeys = (metadata: Record<string, unknown>) =>
    Object.keys(metadata).filter((key) => !AUDITOR_ENVELOPE_KEYS.has(key)).sort();

  /** Arrange the row's whole temporal shape in one step, last, so no later write can refresh `updated_at`. */
  async function arrange(
    workItemId: string,
    state: { updatedAt: string; retryAfter: string | null; deferredSince: string | null },
  ): Promise<void> {
    await h.adminSql()`
      UPDATE project.workflow_work_items
         SET updated_at = ${state.updatedAt}, retry_after = ${state.retryAfter}, deferred_since = ${state.deferredSince}
       WHERE id = ${workItemId}
    `;
  }

  /**
   * A `held` dependency wait whose blocker the task row still proves, so every pass routes it to the
   * deferral ladder rather than re-queuing it as a stale hold.
   */
  async function seedHeldDependencyWait(store: TaskStore): Promise<{ taskId: string; itemId: string }> {
    const task = await h.createTestTask();
    await store.updateTask(task.id, { blockedBy: BLOCKER });
    const item = await store.upsertWorkflowWorkItem({
      runId: `run-${task.id}`,
      taskId: task.id,
      nodeId: "plan-review",
      kind: "task",
      state: "held",
      blockedReason: HOLD_REASON,
      retryAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return { taskId: task.id, itemId: item.id };
  }

  async function readRow(store: TaskStore, id: string): Promise<WorkflowWorkItem | null> {
    return store.getWorkflowWorkItem(id);
  }

  async function runSweep(store: TaskStore): Promise<void> {
    const manager = await makeSweeper(store);
    await manager.reconcileStrandedWorkflowContinuations();
  }

  /*
  A sweep's noise memos are process-local state on the `SelfHealingManager`, and production holds ONE manager
  across the whole maintenance batch. A helper that built a fresh manager per call would therefore test a
  process that restarts between every pass — the memo bound would be unobservable and the assertion would be
  about nothing. Any test that reasons about "announced once" must reuse one sweeper.
  */
  async function makeSweeper(store: TaskStore): Promise<{ reconcileStrandedWorkflowContinuations(): Promise<void> }> {
    const { SelfHealingManager } = await import("../self-healing.js");
    return new SelfHealingManager(store, { rootDir: "/repo" });
  }

  /** Every stranded-reclaim audit row persisted for this project, oldest first. */
  async function auditRows(type: string): Promise<Array<Record<string, unknown>>> {
    const rows = await h.adminSql()<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM project.run_audit_events
       WHERE mutation_type = ${type}
       ORDER BY "timestamp"
    `;
    return rows.map((row) => row.metadata ?? {});
  }

  describe("deferred_since persistence round trip", () => {
    it("writes the episode anchor through a transition patch and reads it back through both row shapes", async () => {
      const store = h.store();
      const { itemId } = await seedHeldDependencyWait(store);

      // The column defaults NULL: a row nobody ever deferred must REPORT that, not invent an episode.
      expect((await readRow(store, itemId))?.deferredSince).toBeNull();

      const anchor = ago(40 * 60_000);
      const written = await store.transitionWorkflowWorkItem(itemId, "held", {
        expectedState: "held",
        retryAfter: ahead(30 * 60_000),
        deferredSince: anchor,
      });
      expect(written.deferredSince).toBe(anchor);

      // Read shape #1: the by-id reader the sweep and every human surface share.
      expect((await readRow(store, itemId))?.deferredSince).toBe(anchor);

      // Read shape #2: the due-gated listing. A future `retryAfter` must hide the row (the mechanism under
      // test), and the anchor has to ride the SAME row shape once it is due again.
      expect(dueIds(await store.listDueWorkflowWorkItems({ states: activeStates() }))).not.toContain(itemId);
      const listed = (await store.listDueWorkflowWorkItems({ now: ago(-HOUR), states: activeStates() }))
        .find((row) => row.id === itemId);
      expect(listed, "a row whose retryAfter expired is due again").toBeDefined();
      expect(listed?.deferredSince).toBe(anchor);

      // An omitted patch field PRESERVES the anchor — the episode must not restart on the second shift.
      const preserved = await store.transitionWorkflowWorkItem(itemId, "held", {
        expectedState: "held",
        retryAfter: ahead(2 * HOUR),
      });
      expect(preserved.deferredSince).toBe(anchor);

      // An explicit null clears it (the reveal CAS), which is what bounds a reveal to one per episode.
      const cleared = await store.transitionWorkflowWorkItem(itemId, "held", {
        expectedState: "held",
        retryAfter: null,
        deferredSince: null,
      });
      expect(cleared.deferredSince).toBeNull();
    });

    it("leaves the anchor untouched when a compare-and-set loses, so no episode is anchored to a lost deferral", async () => {
      const store = h.store();
      const { itemId } = await seedHeldDependencyWait(store);
      // The row moved out from under the snapshot-driven caller, so the whole guarded UPDATE — anchor
      // included — must not land. This is why the anchor rides the same write as `retryAfter`.
      const lost = await store.transitionWorkflowWorkItem(itemId, "runnable", {
        expectedState: "running",
        retryAfter: ahead(HOUR),
        deferredSince: ago(0),
      });
      expect(lost.state).toBe("held");
      expect(lost.retryAfter).toBeNull();
      expect(lost.deferredSince).toBeNull();
    });

    it("defaults the column to NULL for a row inserted before any deferral exists", async () => {
      const store = h.store();
      const { itemId } = await seedHeldDependencyWait(store);
      const raw = await h.adminSql()<{ deferred_since: string | null }[]>`
        SELECT deferred_since FROM project.workflow_work_items WHERE id = ${itemId}
      `;
      expect(raw[0]?.deferred_since).toBeNull();
    });
  });

  /*
  FNXC:StrandedContinuationDeferralHorizon 2026-11-02-12:27 (RUFU-299) — SYMPTOM VERIFICATION.

  Original symptom (audit RUFU-296, P1#2): a sustained hold is deferred by writing `retryAfter`, and
  `retry_after IS NULL OR retry_after <= now` is the store-WIDE due gate. Once the ladder saturates at its top
  rung the card sits in the future almost all the time — invisible to the dispatcher, to this sweep, and to
  every other due-gated reader, with no deadline, no owner and no notice.

  Exact reproduction, run below as two acts: a real sweep pass defers a real aged hold, and the row then
  disappears from `listDueWorkflowWorkItems`. Before this change nothing brings it back except the expiry of
  that one rung, which the next pass pushes out again, forever.

  Assertion that it is gone: once the durable anchor is past `RECLAIM_DEFERRAL_HORIZON_MS`, the next pass that
  can see the row CLEARS the deferral — `retryAfter` and the anchor both go NULL and the row reappears in the
  real due listing.

  The bound this leaves is honest and is asserted as such: the horizon can only be measured on a pass that can
  see the row, so the worst-case hiding is the horizon plus one top rung, never the horizon alone.
  */
  describe("deferral horizon (bounded + observable)", () => {
    it("defers a hold out of sight, then brings it back once the episode passes the horizon", async () => {
      const store = h.store();
      const { itemId } = await seedHeldDependencyWait(store);

      // ACT 1 — the symptom, reproduced against a real store: an aged hold with no episode clock is deferred,
      // and the deferral is what removes it from the due listing.
      await arrange(itemId, { updatedAt: ago(30 * 60_000), retryAfter: null, deferredSince: null });
      await runSweep(store);

      const deferred = await readRow(store, itemId);
      expect(deferred?.retryAfter, "the first pass defers rather than reclaiming").not.toBeNull();
      expect(deferred?.deferredSince, "and the deferral starts an episode").not.toBeNull();
      expect(Date.parse(deferred!.retryAfter!)).toBeGreaterThan(Date.now());
      expect(dueIds(await store.listDueWorkflowWorkItems({ states: activeStates() })))
        .not.toContain(itemId);

      // ACT 2 — time passes. Eight days later the row is due again, still carrying the anchor act 1 wrote:
      // the sweep preserves an existing anchor rather than sliding it forward, and that preservation is what
      // lets any later pass reach the bound at all.
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: ago(8 * DAY) });
      expect(dueIds(await store.listDueWorkflowWorkItems({ states: activeStates() })))
        .toContain(itemId);

      await runSweep(store);

      const revealed = await readRow(store, itemId);
      expect(revealed?.retryAfter, "the horizon refuses the deferral").toBeNull();
      expect(revealed?.deferredSince, "and clears the anchor that made it true").toBeNull();
      expect(revealed?.state, "without reclaiming the wait itself").toBe("held");
      expect(revealed?.blockedReason, "and without erasing the reason the wait exists").toBe(HOLD_REASON);
      expect(dueIds(await store.listDueWorkflowWorkItems({ states: activeStates() })))
        .toContain(itemId);
    });

    it("leaves the ladder intact inside the horizon and does NOT slide the anchor forward", async () => {
      /*
      The horizon is a bound, not a disable. A row anchored one day ago keeps its ladder, and its anchor must
      not move with it — an episode clock that slides forward on every shift can never reach its own bound,
      which is exactly why the anchor is a separate column and not a reading of `retryAfter`.
      */
      const store = h.store();
      const { itemId } = await seedHeldDependencyWait(store);
      const anchor = ago(DAY);
      // Already at the top rung (retryAfter - updatedAt = 6 h), i.e. the pass a wedge would live in forever.
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: anchor });

      await runSweep(store);

      const after = await readRow(store, itemId);
      expect(after?.retryAfter, "the ladder still advances inside the horizon").not.toBeNull();
      expect(Date.parse(after!.retryAfter!)).toBeGreaterThan(Date.now());
      expect(after?.deferredSince, "and the episode clock does not slide forward with it").toBe(anchor);
      expect(after?.state).toBe("held");
    });

    it("records the saturated ladder and the reveal as queryable rows carrying ids/counts/outcomes only", async () => {
      const store = h.store();
      const { taskId, itemId } = await seedHeldDependencyWait(store);

      // A saturated hold anchored one day in: the deferral is re-applied and the saturation is recorded once.
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: ago(DAY) });
      await runSweep(store);
      const sustained = await auditRows("workflowWorkItem:reconcile-stranded-defer-sustained");
      expect(sustained, "the wedge is greppable, not reconstructable only from the absence of anything else")
        .toHaveLength(1);
      expect(payloadKeys(sustained[0]!)).toEqual([
        "deferralAgeMs", "deferredSince", "kind", "nodeId", "priorState", "reason", "rungMs", "stalenessMs",
        "taskId", "workItemId",
      ]);
      expect(sustained[0]!.workItemId).toBe(itemId);
      expect(sustained[0]!.reason).toBe("dependency-hold");
      expect(Number(sustained[0]!.deferralAgeMs), "the wedge carries a real, non-zero episode age")
        .toBeGreaterThan(0);
      expect(Number(sustained[0]!.rungMs)).toBe(TOP_RUNG);

      // The same row eight days in: the reveal is recorded, and its payload is the same closed ids/counts set
      // minus the rung it no longer carries. `reason` is a fixed classifier code, never prose or an error.
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: ago(8 * DAY) });
      await runSweep(store);
      const revealed = await auditRows("workflowWorkItem:reconcile-stranded-revealed");
      expect(revealed).toHaveLength(1);
      expect(payloadKeys(revealed[0]!)).toEqual([
        "deferralAgeMs", "kind", "nodeId", "priorState", "reason", "stalenessMs", "taskId", "workItemId",
      ]);
      expect(revealed[0]!.taskId).toBe(taskId);
      expect(revealed[0]!.workItemId).toBe(itemId);
      expect(revealed[0]!.reason).toBe("dependency-hold");
      expect(Number(revealed[0]!.deferralAgeMs)).toBeGreaterThanOrEqual(RECLAIM_DEFERRAL_HORIZON_MS);
    });

    it("announces the episode on the card exactly once per state change, read through the History projection", async () => {
      /*
      The two `[recovery]` lines are the operator's on-card evidence, and both are bounded to ONE per episode:
      the saturated line by the sweep's episode memo, the reveal line by the anchor it clears. RUFU-263 is the
      reason for the bound — one card carried 782 identical `[recovery]` lines while the card itself never
      moved. Asserted against the real `task_log_entries` side table (RUFU-312), the lane the History tab
      reads, not the legacy `tasks.log` jsonb — a jsonb count would prove nothing about what an operator sees.
      */
      const store = h.store();
      const sweep = await makeSweeper(store);
      const { taskId, itemId } = await seedHeldDependencyWait(store);
      const history = async () => (await h.adminSql()<{ m: string }[]>`
        SELECT action AS m FROM project.task_log_entries WHERE task_id = ${taskId} ORDER BY seq
      `).map((row) => row.m);
      expect(await history(), "a freshly seeded wait has announced nothing").toEqual([]);

      // A plain (non-saturated) first deferral announces nothing: the ladder is still the explanation.
      await arrange(itemId, { updatedAt: ago(30 * 60_000), retryAfter: null, deferredSince: null });
      await sweep.reconcileStrandedWorkflowContinuations();
      expect(await history(), "the first deferral is not news").toEqual([]);

      // The saturated pass is news, and the card hears it once. Two more passes find the row deferred six
      // hours into the future — not due — so the sweep cannot even see it: the ladder rate-limits its own
      // telemetry, which is why the per-pass event row below is not the retry storm the other memos bound.
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: ago(DAY) });
      await sweep.reconcileStrandedWorkflowContinuations();
      const saturated = await history();
      expect(saturated, "the saturated episode announces itself once").toHaveLength(1);
      expect(saturated[0]).toContain("[recovery] workflow continuation deferral saturated");
      await sweep.reconcileStrandedWorkflowContinuations();
      await sweep.reconcileStrandedWorkflowContinuations();
      expect(await history(), "and stays quiet while the same episode continues").toHaveLength(1);
      expect(await auditRows("workflowWorkItem:reconcile-stranded-defer-sustained"), "those silent passes add no row")
        .toHaveLength(1);

      /*
      A second pass that CAN see the row is a second saturated deferral: counted again in the event store, silent
      on the card. "How many times has the widest rung been applied?" is now a COUNT query, and the card is not
      the counter. Re-aging `deferred_since` past the horizon would take the reveal path instead, so this pass
      stays one hour short of it.
      */
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: ago(6 * DAY) });
      await sweep.reconcileStrandedWorkflowContinuations();
      expect(await auditRows("workflowWorkItem:reconcile-stranded-defer-sustained"), "each saturated pass is countable")
        .toHaveLength(2);
      expect(await history(), "while the card still carries exactly one line").toHaveLength(1);

      // The reveal is the second and last line, and one reveal per episode means one line.
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: ago(8 * DAY) });
      await sweep.reconcileStrandedWorkflowContinuations();
      const revealed = await history();
      expect(revealed, "the reveal adds its own single line").toHaveLength(2);
      expect(revealed[1]).toContain("[recovery] workflow continuation deferral revealed");
    });

    it("writes nothing at all on the passes right after a reveal — no free shifts", async () => {
      /*
      "Ziadne volne posuny naprazdno" from the report. Once a reveal lands, its own CAS stamps `updated_at`, so the
      next passes fall inside the sweep's 10-minute grace and must be silent in every channel: no row write, no
      event, no card line. A pass that kept re-stamping here would put the row straight back under the due-gate
      the fix exists to open.
      */
      const store = h.store();
      const { itemId } = await seedHeldDependencyWait(store);
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: ago(8 * DAY) });
      await runSweep(store);

      const afterReveal = await readRow(store, itemId);
      expect(afterReveal?.retryAfter).toBeNull();
      const auditBaseline = (await auditRows("workflowWorkItem:reconcile-stranded-revealed")).length;
      const noActionBaseline = (await auditRows("workflowWorkItem:reconcile-stranded-no-action")).length;

      await runSweep(store);
      await runSweep(store);

      const after = await readRow(store, itemId);
      expect(after?.retryAfter, "a grace-window pass writes no new deferral").toBeNull();
      expect(after?.deferredSince, "and anchors no new episode").toBeNull();
      expect(after?.updatedAt, "and does not even touch the row").toBe(afterReveal?.updatedAt);
      expect(await auditRows("workflowWorkItem:reconcile-stranded-revealed"), "and emits no second reveal")
        .toHaveLength(auditBaseline);
      expect(await auditRows("workflowWorkItem:reconcile-stranded-no-action"), "nor a no-action finding")
        .toHaveLength(noActionBaseline);
    });

  });
  describe("scheduler regression (a revealed row is due again for the real claim listing)", () => {
    /*
    FNXC:StrandedContinuationDeferralHorizon 2026-11-02-12:27 (RUFU-299):
    `claimDueWorkflowWorkItem` selects through `listDueWorkflowWorkItems` with NO `states` filter, so the
    scheduler's own visibility is exactly that listing, and "no more free runs" is a claim about it. The
    listing is therefore the assertion surface, not the claim RESULT: `acquireWorkflowWorkItemLease` admits a
    `held` row only for the three `workflow-principal` / `workflow-named-principal` / `workflow-role-pool`
    families, and those reasons are suppressed by the classifier before any deferral is ever written. Asserting
    that a revealed `dependency:` hold becomes CLAIMABLE would pin a contract this repository never had; what
    RUFU-299 restores is that the row re-enters the scheduler's view instead of being skipped forever.
    */
    it("skips the row while deferred and lists it again after the reveal", async () => {
      const store = h.store();
      const { itemId } = await seedHeldDependencyWait(store);
      // The scheduler's filter shape, copied from `claimDueWorkflowWorkItem`: `now`, `limit`, no states.
      const schedulerListing = () => store.listDueWorkflowWorkItems({ limit: 25 });

      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ahead(TOP_RUNG), deferredSince: ago(8 * DAY) });
      expect(dueIds(await schedulerListing()), "a deferred row is invisible to the scheduler's selection step")
        .not.toContain(itemId);

      // The ladder must expire before any pass can measure the horizon — the honest bound is horizon + 1 rung.
      await arrange(itemId, { updatedAt: ago(7 * HOUR), retryAfter: ago(HOUR), deferredSince: ago(8 * DAY) });
      await runSweep(store);

      expect(dueIds(await schedulerListing()), "after the reveal the scheduler sees it again").toContain(itemId);
      const row = await readRow(store, itemId);
      expect(row?.retryAfter).toBeNull();
      expect(row?.deferredSince).toBeNull();

      /*
      The planning drain lists with `kinds: ["task"]` and `states: ["runnable", "retrying"]`. A revealed row stays
      `held` — the reveal refuses the hiding, it does not reclaim the wait — so it cannot enter that window and
      spend a planning slot on a row nothing can run. Verified against the real predicate rather than assumed
      from the state field, because the drain's filter is the contract.
      */
      expect(dueIds(await store.listDueWorkflowWorkItems({ kinds: ["task"], states: ["runnable", "retrying"] })))
        .not.toContain(itemId);
    });
  });
});
