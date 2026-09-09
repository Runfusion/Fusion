import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { buildPatchnodeEntryId, toPatchnodeOccurrenceKey } from "../../board/patchnode.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";
import { PATCHNODE_RECONCILE_TTL_MS } from "../../store.js";

pgDescribe("Patchnode ledger (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_patchnode", projectId: "patchnode-test" });

  beforeAll(async () => {
    await h.beforeAll();
    await applySchemaBaseline(h.adminDb());
  });
  const removeLedgerFailureTrigger = async () => {
    await h.adminDb().execute(sql.raw("DROP TRIGGER IF EXISTS patchnode_test_fail ON project.patchnode_entries; DROP FUNCTION IF EXISTS project.patchnode_test_fail();"));
  };

  const installLedgerFailureTrigger = async (taskId?: string) => {
    const escapedTaskId = taskId?.replaceAll("'", "''");
    const when = escapedTaskId ? ` WHEN (NEW.task_id = '${escapedTaskId}')` : "";
    await h.adminDb().execute(sql.raw(`CREATE OR REPLACE FUNCTION project.patchnode_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'patchnode test failure'; END $$; CREATE TRIGGER patchnode_test_fail BEFORE INSERT ON project.patchnode_entries FOR EACH ROW${when} EXECUTE FUNCTION project.patchnode_test_fail();`));
  };

  const resetReconcileMemo = () => {
    (h.store() as unknown as { patchnodeReconcileMemo: unknown }).patchnodeReconcileMemo = null;
  };

  const ledgerRows = (taskId: string) => h.adminDb().select().from(schema.project.patchnodeEntries).where(and(
    eq(schema.project.patchnodeEntries.projectId, h.layer().projectId!),
    eq(schema.project.patchnodeEntries.taskId, taskId),
  ));

  beforeEach(async () => {
    await h.beforeEach();
    resetReconcileMemo();
    await removeLedgerFailureTrigger();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await removeLedgerFailureTrigger();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  const createWithSummary = async (input: { title?: string; description: string; summary: string }) => {
    const task = await h.store().createTask({ title: input.title, description: input.description });
    return h.store().updateTask(task.id, { summary: input.summary });
  };

  const deliver = async (id: string) => {
    const store = h.store();
    await store.moveTask(id, "todo", { moveSource: "user" });
    await store.moveTask(id, "in-progress", { moveSource: "user" });
    await store.moveTask(id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    return store.moveTask(id, "done", { moveSource: "engine", skipMergeBlocker: true });
  };

  const seedTaskColumn = async (id: string, column: string, columnMovedAt: string) => {
    await h.adminDb().update(schema.project.tasks).set({ column, columnMovedAt, updatedAt: columnMovedAt }).where(and(
      eq(schema.project.tasks.projectId, h.layer().projectId!),
      eq(schema.project.tasks.id, id),
    ));
  };

  it("registers the project-scoped table and RLS policy", async () => {
    const rows = await h.adminDb().execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='project.patchnode_entries'::regclass`) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("moveTask records one completion with the persisted occurrence", async () => {
    const task = await createWithSummary({ title: "Patch", description: "Patch", summary: "Delivered summary" });
    const done = await deliver(task.id);
    const feed = await h.store().listPatchnodeEntries({ query: task.id });
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).toMatchObject({
      taskId: task.id,
      kind: "completed",
      body: "Delivered summary",
      occurrenceKey: toPatchnodeOccurrenceKey(done.columnMovedAt!),
    });
  });

  it("moveToDone records one completion", async () => {
    const store = h.store();
    const task = await createWithSummary({ title: "Direct done", description: "Direct done", summary: "Direct summary" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    const review = await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    review.enabledWorkflowSteps = [];
    await store.moveToDone(review, store.taskDir(task.id));
    expect((await store.listPatchnodeEntries({ query: task.id })).entries).toHaveLength(1);
  });

  it("records a second entry for re-delivery and preserves the first snapshot", async () => {
    const store = h.store();
    const task = await createWithSummary({ title: "First title", description: "Delivery", summary: "first" });
    await deliver(task.id);
    await h.adminDb().update(schema.project.tasks).set({ column: "in-progress", columnMovedAt: new Date().toISOString() }).where(and(
      eq(schema.project.tasks.projectId, h.layer().projectId!),
      eq(schema.project.tasks.id, task.id),
    ));
    await store.updateTask(task.id, { title: "Second title", summary: "second" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });
    const entries = (await store.listPatchnodeEntries({ query: task.id })).entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.body)).toEqual(["second", "first"]);
    expect(new Set(entries.map((entry) => entry.occurrenceKey)).size).toBe(2);
    expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(2);
  });

  it("deduplicates repeated capture of the same delivery", async () => {
    const store = h.store();
    const task = await createWithSummary({ description: "Idempotent", summary: "once" });
    const occurredAt = "2026-08-28T10:00:00Z";
    await store.recordPatchnodeCompletion(task, occurredAt);
    await store.recordPatchnodeCompletion(task, occurredAt);
    expect((await store.listPatchnodeEntries({ query: task.id })).entries).toHaveLength(1);
  });

  it("pairs a revert to the latest completion without overwriting its first cancellation", async () => {
    const store = h.store();
    const task = await createWithSummary({ description: "Revert", summary: "shipped" });
    await deliver(task.id);
    await store.recordPatchnodeRevert(task.id, { occurredAt: "2026-08-28T12:00:00Z", revertCommitSha: "abc" });
    await store.recordPatchnodeRevert(task.id, { occurredAt: "2026-08-29T12:00:00Z", revertCommitSha: "def" });
    const entries = (await store.listPatchnodeEntries({ query: task.id })).entries;
    expect(entries).toHaveLength(2);
    const completed = entries.find((entry) => entry.kind === "completed")!;
    const reverted = entries.find((entry) => entry.kind === "reverted")!;
    expect(reverted.revertsEntryId).toBe(completed.entryId);
    expect(completed).toMatchObject({ revertedAt: "2026-08-28T12:00:00Z", revertedCommitSha: "abc" });
  });

  it("does not redirect an already-recorded scalar revert marker to a re-delivery", async () => {
    const store = h.store();
    const task = await createWithSummary({ description: "Revert then redeliver", summary: "first delivery" });
    await deliver(task.id);
    const firstRevertedAt = "2026-08-28T12:00:00.000Z";
    await store.recordPatchnodeRevert(task.id, { occurredAt: firstRevertedAt, revertCommitSha: "first-revert" });
    await store.updateTask(task.id, {
      sourceMetadataPatch: { revertedAt: firstRevertedAt, revertedCommitSha: "first-revert" },
    });

    await seedTaskColumn(task.id, "in-progress", "2026-08-28T12:30:00.000Z");
    await store.updateTask(task.id, { summary: "second delivery" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });

    await store.reconcilePatchnodeLedger({ force: true });
    let entries = (await store.listPatchnodeEntries({ query: task.id })).entries;
    let completions = entries.filter((entry) => entry.kind === "completed");
    let reversions = entries.filter((entry) => entry.kind === "reverted");
    expect(completions).toHaveLength(2);
    expect(reversions).toHaveLength(1);
    const firstCompletionId = reversions[0]!.revertsEntryId;
    expect(completions.find((entry) => entry.entryId === firstCompletionId)?.revertedAt).toBe(firstRevertedAt);
    expect(completions.find((entry) => entry.entryId !== firstCompletionId)?.revertedAt).toBeNull();

    const secondRevertedAt = "2026-08-28T14:00:00.000Z";
    await store.recordPatchnodeRevert(task.id, { occurredAt: secondRevertedAt, revertCommitSha: "second-revert" });
    await store.updateTask(task.id, {
      sourceMetadataPatch: { revertedAt: secondRevertedAt, revertedCommitSha: "second-revert" },
    });
    await store.reconcilePatchnodeLedger({ force: true });

    entries = (await store.listPatchnodeEntries({ query: task.id })).entries;
    completions = entries.filter((entry) => entry.kind === "completed");
    reversions = entries.filter((entry) => entry.kind === "reverted");
    expect(reversions).toHaveLength(2);
    const firstCompletion = completions.find((entry) => entry.entryId === firstCompletionId)!;
    const secondCompletion = completions.find((entry) => entry.entryId !== firstCompletionId)!;
    expect(firstCompletion).toMatchObject({ revertedAt: firstRevertedAt, revertedCommitSha: "first-revert" });
    expect(secondCompletion).toMatchObject({ revertedAt: secondRevertedAt, revertedCommitSha: "second-revert" });
    expect(reversions.find((entry) => entry.occurredAt === secondRevertedAt)?.revertsEntryId).toBe(secondCompletion.entryId);
  });

  /*
  FNXC:PatchnodeRevertReconciliation 2026-08-28-22:17:
  A retried revert whose git outcome is "already reverted at HEAD" replays its ORIGINAL episode timestamp. Pinned pairing must keep that cancellation on the delivery in effect back then, leave the later re-delivery in effect, and stay idempotent across a forced reconciliation pass.
  */
  it("keeps an already-reverted retry pinned to its original delivery after a re-delivery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-28T09:00:00.000Z"));
    const store = h.store();
    const task = await createWithSummary({ description: "Already-reverted retry", summary: "first delivery" });
    await deliver(task.id);
    const firstRevertedAt = "2026-08-28T12:00:00.000Z";
    await store.recordPatchnodeRevert(task.id, { occurredAt: firstRevertedAt, revertCommitSha: "first-revert" });
    await store.updateTask(task.id, {
      sourceMetadataPatch: { revertedAt: firstRevertedAt, revertedCommitSha: "first-revert" },
    });

    vi.setSystemTime(new Date("2026-08-29T09:00:00.000Z"));
    await seedTaskColumn(task.id, "in-progress", "2026-08-29T08:30:00.000Z");
    await store.updateTask(task.id, { summary: "second delivery" });
    await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });

    // The already-reverted retry replays the original episode instead of opening a new one.
    await store.recordPatchnodeRevert(task.id, {
      occurredAt: firstRevertedAt,
      revertCommitSha: "first-revert",
      pairWithDeliveryAtOrBefore: true,
    });
    resetReconcileMemo();
    await store.reconcilePatchnodeLedger({ force: true });

    const entries = (await store.listPatchnodeEntries({ query: task.id })).entries;
    const completions = entries.filter((entry) => entry.kind === "completed");
    const reversions = entries.filter((entry) => entry.kind === "reverted");
    expect(completions).toHaveLength(2);
    expect(reversions).toHaveLength(1);
    expect(reversions[0]).toMatchObject({
      occurredAt: firstRevertedAt,
      entryId: buildPatchnodeEntryId("reverted", task.id, toPatchnodeOccurrenceKey("2026-08-28T09:00:00.000Z")),
    });
    const cancelled = completions.find((entry) => entry.entryId === reversions[0]!.revertsEntryId)!;
    const stillInEffect = completions.find((entry) => entry.entryId !== reversions[0]!.revertsEntryId)!;
    expect(cancelled).toMatchObject({ body: "first delivery", revertedAt: firstRevertedAt, revertedCommitSha: "first-revert" });
    expect(stillInEffect).toMatchObject({ body: "second delivery", revertedAt: null });
    expect(Date.parse(stillInEffect.occurredAt)).toBeGreaterThan(Date.parse(firstRevertedAt));
  });

  it("does not pair an unreconciled legacy revert marker to a later re-delivery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-19T08:00:00.000Z"));
    const store = h.store();
    const task = await createWithSummary({ description: "Legacy revert before redelivery", summary: "legacy delivery" });
    await seedTaskColumn(task.id, "done", "2026-08-19T09:00:00.000Z");
    const legacyRevertedAt = "2026-08-20T10:00:00.000Z";
    await store.updateTask(task.id, {
      sourceMetadataPatch: { revertedAt: legacyRevertedAt, revertedCommitSha: "legacy-revert" },
    });

    vi.setSystemTime(new Date("2026-08-21T11:00:00.000Z"));
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.updateTask(task.id, { summary: "later delivery" });
    await deliver(task.id);

    await store.reconcilePatchnodeLedger({ force: true });

    const entries = (await store.listPatchnodeEntries({ query: task.id })).entries;
    const completion = entries.find((entry) => entry.kind === "completed")!;
    const reverted = entries.find((entry) => entry.kind === "reverted")!;
    expect(entries).toHaveLength(2);
    expect(completion).toMatchObject({ body: "later delivery", revertedAt: null });
    expect(Date.parse(completion.occurredAt)).toBeGreaterThan(Date.parse(legacyRevertedAt));
    expect(reverted).toMatchObject({
      entryId: buildPatchnodeEntryId("reverted", task.id, "none"),
      occurredAt: legacyRevertedAt,
      revertsEntryId: null,
    });
  });

  it("records and deduplicates an unpaired legacy revert", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Legacy revert" });
    await store.recordPatchnodeRevert(task.id, { occurredAt: "2026-08-28T12:00:00Z" });
    await store.recordPatchnodeRevert(task.id, { occurredAt: "2026-08-29T12:00:00Z" });
    const entries = (await store.listPatchnodeEntries({ query: task.id })).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entryId: buildPatchnodeEntryId("reverted", task.id, "none"), revertsEntryId: null });
  });

  it("filters text and date ranges and reports pagination", async () => {
    const store = h.store();
    const first = await createWithSummary({ title: "Alpha", description: "Alpha", summary: "first body" });
    const second = await createWithSummary({ title: "Beta", description: "Beta", summary: "second body" });
    await store.recordPatchnodeCompletion(first, "2026-08-27T10:00:00Z");
    await store.recordPatchnodeCompletion(second, "2026-08-28T10:00:00Z");
    expect((await store.listPatchnodeEntries({ query: "FIRST BODY" })).entries.map((entry) => entry.taskId)).toEqual([first.id]);
    expect((await store.listPatchnodeEntries({ from: "2026-08-28", to: "2026-08-28" })).entries.map((entry) => entry.taskId)).toEqual([second.id]);
    expect(await store.listPatchnodeEntries({ limit: 1 })).toMatchObject({ totalEntries: 2, hasMore: true });
  });

  it("repairs a legacy completion hole insert-only", async () => {
    const store = h.store();
    const task = await createWithSummary({ title: "Legacy", description: "Legacy", summary: "legacy body" });
    const movedAt = "2026-08-26T10:00:00Z";
    await h.adminDb().update(schema.project.tasks).set({ column: "done", columnMovedAt: movedAt }).where(and(eq(schema.project.tasks.projectId, h.layer().projectId!), eq(schema.project.tasks.id, task.id)));
    await store.reconcilePatchnodeLedger({ force: true });
    await store.reconcilePatchnodeLedger({ force: true });
    const entries = (await store.listPatchnodeEntries({ query: task.id })).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ body: "legacy body", entryId: buildPatchnodeEntryId("completed", task.id, toPatchnodeOccurrenceKey(movedAt)) });
  });

  it("fails both atomic completion writers closed when the store has no project binding", async () => {
    const store = h.store();
    const layer = h.layer() as unknown as { projectId?: string };
    const projectId = layer.projectId!;

    const moveTaskCandidate = await createWithSummary({ description: "Unbound moveTask", summary: "must remain pending" });
    await store.moveTask(moveTaskCandidate.id, "todo", { moveSource: "user" });
    await store.moveTask(moveTaskCandidate.id, "in-progress", { moveSource: "user" });
    const moveTaskReview = await store.moveTask(moveTaskCandidate.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });

    layer.projectId = undefined;
    try {
      await expect(store.moveTaskInternal(
        moveTaskCandidate.id,
        "done",
        { moveSource: "engine", skipMergeBlocker: true },
        { fromHandoff: false },
        moveTaskReview,
      )).rejects.toThrow("Patchnode transaction write requires projectId");
    } finally {
      layer.projectId = projectId;
    }
    expect(await store.getTask(moveTaskCandidate.id)).toMatchObject({ column: "in-review" });

    const moveToDoneCandidate = await createWithSummary({ description: "Unbound moveToDone", summary: "must remain pending" });
    await store.moveTask(moveToDoneCandidate.id, "todo", { moveSource: "user" });
    await store.moveTask(moveToDoneCandidate.id, "in-progress", { moveSource: "user" });
    const moveToDoneReview = await store.moveTask(moveToDoneCandidate.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    moveToDoneReview.enabledWorkflowSteps = [];

    layer.projectId = undefined;
    try {
      await expect(store.moveToDone(moveToDoneReview, store.taskDir(moveToDoneCandidate.id)))
        .rejects.toThrow("Patchnode transaction write requires projectId");
    } finally {
      layer.projectId = projectId;
    }
    expect(await store.getTask(moveToDoneCandidate.id)).toMatchObject({ column: "in-review" });

    const fabricatedRows = await h.adminDb().select({ id: schema.project.tasks.id })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, "__legacy_unscoped__"),
        inArray(schema.project.tasks.id, [moveTaskCandidate.id, moveToDoneCandidate.id]),
      ));
    expect(fabricatedRows).toEqual([]);
    expect(await ledgerRows(moveTaskCandidate.id)).toEqual([]);
    expect(await ledgerRows(moveToDoneCandidate.id)).toEqual([]);
  });

  it("aborts a completion move when the in-transaction ledger insert fails", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Atomic failure", summary: "must not vanish" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    const original = await store.getTask(task.id);
    await installLedgerFailureTrigger();
    await expect(store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true })).rejects.toThrow("Failed query");
    const unchanged = await store.getTask(task.id);
    expect(unchanged).toMatchObject({ column: original.column, columnMovedAt: original.columnMovedAt });
    expect(unchanged.transitionPending?.toColumn).not.toBe("done");
    await removeLedgerFailureTrigger();
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });
    expect((await store.listPatchnodeEntries({ query: task.id })).entries).toHaveLength(1);
  });

  it("aborts moveToDone when its in-transaction ledger insert fails", async () => {
    const store = h.store();
    const task = await createWithSummary({ description: "Atomic direct completion", summary: "must commit together" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    const review = await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    review.enabledWorkflowSteps = [];
    const original = await store.getTask(task.id);

    await installLedgerFailureTrigger(task.id);
    await expect(store.moveToDone(review, store.taskDir(task.id))).rejects.toThrow();
    expect(await store.getTask(task.id)).toMatchObject({ column: original.column, columnMovedAt: original.columnMovedAt });
    expect(await ledgerRows(task.id)).toEqual([]);

    await removeLedgerFailureTrigger();
    const retry = await store.getTask(task.id);
    retry.enabledWorkflowSteps = [];
    await store.moveToDone(retry, store.taskDir(task.id));
    expect(await ledgerRows(task.id)).toHaveLength(1);
  });

  it("does not record a same-column terminal failure apply as a delivery", async () => {
    const store = h.store();
    const task = await createWithSummary({ description: "Same-column recovery", summary: "one delivery" });
    await deliver(task.id);
    const token = "patchnode-terminal-apply";
    const now = new Date().toISOString();
    await store.updateTask(task.id, {
      status: "failed",
      error: "opaque failure",
      wedgeNotification: {
        reasonKey: "terminal-failed",
        episodeId: "patchnode-episode",
        status: "resolved",
        transitionedAt: now,
        budgetRevision: 1,
        autoRecovery: {
          attempts: 1,
          lastAttemptAt: now,
          lastApplyStartedAt: now,
          applyToken: token,
          lastBudgetWriteAt: now,
        },
      },
    } as never);

    const result = await store.applyTerminalFailureAutoRecoveryRetry(task.id, {
      applyToken: token,
      patch: { status: null, error: null },
      targetColumn: "done",
      moveOptions: { preserveProgress: true, moveSource: "engine", skipMergeBlocker: true },
    });

    expect(result.outcome).toBe("applied");
    expect(await ledgerRows(task.id)).toHaveLength(1);
  });

  it("re-arms feed reconciliation after its TTL", async () => {
    const store = h.store();
    expect((await store.listPatchnodeEntries()).entries).toEqual([]);
    const task = await createWithSummary({ description: "Late legacy row", summary: "found on next sweep" });
    await seedTaskColumn(task.id, "done", "2026-08-25T08:00:00.000Z");

    expect((await store.listPatchnodeEntries({ query: task.id })).entries).toEqual([]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + PATCHNODE_RECONCILE_TTL_MS + 1);
    expect((await store.listPatchnodeEntries({ query: task.id })).entries).toHaveLength(1);
    clock.mockRestore();
  });

  it("preserves a delivery after a later move rewrites the task state", async () => {
    const store = h.store();
    const task = await createWithSummary({ title: "Original title", description: "Superseded", summary: "original body" });
    await deliver(task.id);
    const original = (await ledgerRows(task.id))[0]!;

    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.updateTask(task.id, { title: "Later title", summary: "later body" });
    await store.reconcilePatchnodeLedger({ force: true });

    expect(await ledgerRows(task.id)).toMatchObject([{
      entryId: original.entryId,
      day: original.day,
      occurrenceKey: original.occurrenceKey,
      title: "Original title",
      body: "original body",
    }]);

    await store.deleteTask(task.id);
    expect(await ledgerRows(task.id)).toMatchObject([{ entryId: original.entryId, title: "Original title", body: "original body" }]);
  });

  it("keeps each completion body as a point-in-time snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-26T08:00:00.000Z"));
    const store = h.store();
    const task = await createWithSummary({ description: "Snapshot", summary: "first" });
    await deliver(task.id);
    await store.updateTask(task.id, { summary: "second" });
    await store.reconcilePatchnodeLedger({ force: true });
    expect(await ledgerRows(task.id)).toMatchObject([{ body: "first", day: "2026-08-26" }]);

    vi.setSystemTime(new Date("2026-08-27T08:00:00.000Z"));
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await deliver(task.id);

    const rows = await ledgerRows(task.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.day}:${row.body}`).sort()).toEqual(["2026-08-26:first", "2026-08-27:second"]);
  });

  it("survives task soft deletion", async () => {
    const store = h.store();
    const task = await createWithSummary({ title: "Permanent", description: "Permanent", summary: "survives" });
    await deliver(task.id);
    await store.deleteTask(task.id);
    expect((await store.listPatchnodeEntries({ query: task.id })).entries[0]).toMatchObject({ title: "Permanent", body: "survives" });
    const taskRows = await h.adminDb().select({ id: schema.project.tasks.id }).from(schema.project.tasks).where(eq(schema.project.tasks.id, task.id));
    expect(taskRows).toEqual([{ id: task.id }]);
  });

  it("has no expiry or size-limiting implementation", async () => {
    const source = await readFile(new URL("../../task-store/async/async-patchnode.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:prune|RETENTION|ROW_CAP)\b/);
  });
});
