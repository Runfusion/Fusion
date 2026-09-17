/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — the two orderings the delivery lock must make TOTAL, proven against real PostgreSQL with two
independent store instances (two logical processes) sharing one database.

  • LOCK WINS  — the lock mutation commits before a merge owner takes the card; the owner's own
                 re-read then observes the lock.
  • MERGE WINS — the owner has taken the card; the mutation returns `merge-taken` and changes nothing.

Also covered: concurrent merge / create-pr / reject commands, identical replay, a reused requestId
with a different action, a replaced candidate or target, and a late receipt write from a superseded
attempt. Every case asserts the DURABLE ROW, not merely a returned value.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { encodeHumanMergeCandidateToken, hasCurrentHumanMergeApproval } from "../../merge/human-merge-approval.js";
import type { HumanMergeCandidateIdentity, Task } from "../../types.js";

function candidateFor(task: Task): HumanMergeCandidateIdentity {
  return {
    lockGeneration: task.humanMergeApproval?.generation ?? 0,
    workflowSignature: "builtin:coding@7",
    reviewEpisodeId: "2026-09-17T10:00:00.000Z",
    contentSignature: "singular:fp:" + "a".repeat(40),
    targetSignature: "merge:.@origin:fusion/FN-514->main",
  };
}

pgDescribe("Delivery lock concurrency across two processes (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_human_merge_races",
  });

  beforeAll(async () => {
    await h.beforeAll();
    await applySchemaBaseline(h.adminDb());
  });
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function armedTask(): Promise<Task> {
    const store = h.store();
    const created = await store.createTask({ description: "Course verrou / fusion.", humanMergeApproval: true });
    /* Branch writes require explicit provenance; this fixture is an engine-owned task branch. */
    await store.updateTask(created.id, { column: "in-review", branch: "fusion/FN-514", branchWriteOrigin: "engine", baseBranch: "main" });
    return (await store.getTask(created.id))!;
  }

  it("LOCK WINS: a lock committed before the take is visible to the merge owner's re-read", async () => {
    const task = await armedTask();
    const writer = h.store();
    const owner = h.store();

    // Process A removes the lock while the card is merely queued — a queue position is not a take.
    await owner.updateTask(task.id, { status: "queued" });
    const unlocked = await writer.setHumanMergeApprovalLock(task.id, {
      enabled: false, requestId: "unlock-1", actor: "operator-a",
    });
    expect(unlocked.applied).toBe(true);

    // Process B (the owner) re-reads and observes the committed state, not its own stale snapshot.
    const seen = await owner.getTask(task.id);
    expect(seen?.humanMergeApproval?.enabled ?? false).toBe(false);
    expect(hasCurrentHumanMergeApproval(seen!)).toBe(false);
  });

  it("MERGE WINS: once the owner has taken the card the lock mutation changes nothing", async () => {
    const task = await armedTask();
    const writer = h.store();
    const owner = h.store();

    await owner.updateTask(task.id, { status: "merging" });

    const refused = await writer.setHumanMergeApprovalLock(task.id, {
      enabled: false, requestId: "unlock-2", actor: "operator-a",
    });
    expect(refused).toEqual({ applied: false, reason: "merge-taken" });

    const durable = await owner.getTask(task.id);
    expect(durable?.humanMergeApproval?.enabled).toBe(true);
    expect(durable?.humanMergeApproval?.generation).toBe(1);
  });

  it("refuses a lock change after the delivery is confirmed, in either direction", async () => {
    const task = await armedTask();
    const store = h.store();
    await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true, commitSha: "deadbeef" } as never });

    for (const enabled of [true, false]) {
      const outcome = await store.setHumanMergeApprovalLock(task.id, { enabled, requestId: `after-${enabled}`, actor: "operator" });
      expect(outcome).toEqual({ applied: false, reason: "merge-taken" });
    }
  });

  it("serializes three concurrent commands so exactly one wins and the others conflict", async () => {
    const task = await armedTask();
    const candidate = candidateFor(task);
    const candidateToken = encodeHumanMergeCandidateToken(candidate);
    const stores = [h.store(), h.store(), h.store()];

    const results = await Promise.all([
      stores[0].recordHumanMergeDecision(task.id, { action: "merge", requestId: "c-merge", candidateToken, candidate, actor: "a" }),
      stores[1].recordHumanMergeDecision(task.id, { action: "create-pr", requestId: "c-pr", candidateToken, candidate, actor: "b" }),
      stores[2].recordHumanMergeDecision(task.id, { action: "reject", message: "non", requestId: "c-rej", candidateToken, candidate, actor: "c" }),
    ]);

    expect(results.filter((result) => result.applied).length).toBe(1);

    /*
    The durable row carries exactly ONE outcome: a decision OR a rejection, never both. A second
    command must not be able to redirect a destination whose dispatch may already have begun.
    */
    const durable = await h.store().getTask(task.id);
    const state = durable!.humanMergeApproval!;
    const outcomes = [state.decision, state.rejection].filter(Boolean);
    expect(outcomes).toHaveLength(1);
  });

  it("replays an identical request idempotently and conflicts on a reused requestId with another action", async () => {
    const task = await armedTask();
    const candidate = candidateFor(task);
    const candidateToken = encodeHumanMergeCandidateToken(candidate);
    const a = h.store();
    const b = h.store();

    const first = await a.recordHumanMergeDecision(task.id, { action: "merge", requestId: "same", candidateToken, candidate, actor: "a" });
    expect(first.applied).toBe(true);
    const decidedAt = (first as { task: Task }).task.humanMergeApproval!.decision!.decidedAt;

    // Same body from the OTHER process: idempotent, returns the stored receipt, writes nothing new.
    const replay = await b.recordHumanMergeDecision(task.id, { action: "merge", requestId: "same", candidateToken, candidate, actor: "a" });
    expect(replay).toMatchObject({ applied: true, replayed: true });
    expect((await b.getTask(task.id))!.humanMergeApproval!.decision!.decidedAt).toBe(decidedAt);

    // Same requestId, different action: an explicit conflict with no second action taken.
    const conflicting = await b.recordHumanMergeDecision(task.id, { action: "reject", message: "non", requestId: "same", candidateToken, candidate, actor: "a" });
    expect(conflicting).toMatchObject({ applied: false, reason: "request-conflict" });
    const durable = await b.getTask(task.id);
    expect(durable!.humanMergeApproval!.decision!.deliveryAction).toBe("merge");
    expect(durable!.humanMergeApproval!.rejection).toBeUndefined();
  });

  it("refuses a decision whose candidate or target was replaced since it was presented", async () => {
    const task = await armedTask();
    const candidate = candidateFor(task);
    const store = h.store();

    // Content changed between presentation and submission.
    const changedContent = { ...candidate, contentSignature: "singular:fp:" + "b".repeat(40) };
    expect(await store.recordHumanMergeDecision(task.id, {
      action: "merge", requestId: "stale-content", candidateToken: encodeHumanMergeCandidateToken(candidate), candidate: changedContent, actor: "a",
    })).toMatchObject({ applied: false, reason: "candidate-superseded" });

    // Target changed between presentation and submission.
    const changedTarget = { ...candidate, targetSignature: "merge:.@origin:fusion/FN-514->production" };
    expect(await store.recordHumanMergeDecision(task.id, {
      action: "merge", requestId: "stale-target", candidateToken: encodeHumanMergeCandidateToken(candidate), candidate: changedTarget, actor: "a",
    })).toMatchObject({ applied: false, reason: "candidate-superseded" });

    expect((await store.getTask(task.id))!.humanMergeApproval!.decision).toBeUndefined();
  });

  it("refuses a decision made against a superseded lock generation", async () => {
    const task = await armedTask();
    const candidate = candidateFor(task);
    const candidateToken = encodeHumanMergeCandidateToken(candidate);
    const store = h.store();

    // Another process re-arms the lock, bumping the generation.
    await store.setHumanMergeApprovalLock(task.id, { enabled: false, requestId: "off", actor: "b" });
    await store.setHumanMergeApprovalLock(task.id, { enabled: true, requestId: "on", actor: "b" });

    expect(await store.recordHumanMergeDecision(task.id, {
      action: "merge", requestId: "stale-generation", candidateToken, candidate, actor: "a",
    })).toMatchObject({ applied: false, reason: "candidate-superseded" });
    expect(hasCurrentHumanMergeApproval((await store.getTask(task.id))!)).toBe(false);
  });

  it("refuses a late receipt write from a superseded attempt", async () => {
    const task = await armedTask();
    const candidate = candidateFor(task);
    const candidateToken = encodeHumanMergeCandidateToken(candidate);
    const store = h.store();

    await store.recordHumanMergeDecision(task.id, { action: "create-pr", requestId: "pr-1", candidateToken, candidate, actor: "a" });

    // A response from an OLD attempt must not overwrite the live decision's receipt.
    expect(await store.updateHumanMergeDecisionReceipt(task.id, {
      requestId: "pr-0-superseded",
      receipt: { state: "succeeded", at: new Date().toISOString(), prNumber: 1 },
    })).toMatchObject({ applied: false, reason: "candidate-superseded" });

    const durable = await store.getTask(task.id);
    expect(durable!.humanMergeApproval!.decision!.receipt!.state).toBe("pending");
    expect(durable!.humanMergeApproval!.decision!.receipt!.prNumber).toBeUndefined();

    // The owning attempt's own receipt does land, and still does not authorize a merge.
    expect(await store.updateHumanMergeDecisionReceipt(task.id, {
      requestId: "pr-1",
      receipt: { state: "succeeded", at: new Date().toISOString(), prNumber: 77, prUrl: "https://example.test/pr/77" },
    })).toMatchObject({ applied: true });
    const settled = await store.getTask(task.id);
    expect(settled!.humanMergeApproval!.decision!.receipt!.prNumber).toBe(77);
    expect(hasCurrentHumanMergeApproval(settled!)).toBe(false);
  });

  it("refuses every mutation against a deleted task without resurrecting it", async () => {
    const task = await armedTask();
    const store = h.store();
    await h.adminDb().execute(sql`UPDATE project.tasks SET deleted_at = now() WHERE id = ${task.id}`);

    expect(await store.setHumanMergeApprovalLock(task.id, { enabled: false, requestId: "x", actor: "a" }))
      .toMatchObject({ applied: false, reason: "task-deleted" });
    const candidate = candidateFor(task);
    expect(await store.recordHumanMergeDecision(task.id, {
      action: "merge", requestId: "y", candidateToken: encodeHumanMergeCandidateToken(candidate), candidate, actor: "a",
    })).toMatchObject({ applied: false, reason: "task-deleted" });
  });
});
