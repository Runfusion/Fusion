/*
FNXC:PlanningMultiTask 2026-07-24-01:40:
PostgreSQL integration coverage for the planning create-claim lifecycle after the
multi-task-per-plan change. Pins two invariants against the real jsonb SQL:
1. Claim-lifecycle writes are SURGICAL — claim/finalize/reconcile/release only touch the four
   claim keys, so concurrently-written epoch fields (taskCreationEpoch, createdTaskIds) always
   survive (review finding: the previous whole-payload read-modify-write could silently revert
   a concurrent epoch rotation).
2. reconcile's expectedTaskCreationEpoch guard is a no-op when the row's epoch has advanced,
   so an archived task is never re-linked onto a newer epoch.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  advancePlanningSessionTaskCreationEpoch,
  claimPlanningSessionTaskCreation,
  finalizePlanningSessionTaskCreation,
  getAiSession,
  reconcilePlanningSessionTaskCreation,
  releasePlanningSessionTaskCreation,
  upsertAiSession,
  type AiSessionRow,
} from "../../async-stores/async-ai-session-store.js";

const pgTest = pgDescribe;

function planningRow(id: string, inputPayload: Record<string, unknown>): AiSessionRow {
  const now = new Date().toISOString();
  return {
    id,
    type: "planning",
    status: "complete",
    title: "Multi-task plan",
    inputPayload: JSON.stringify({ initialPlan: "Build the thing", ...inputPayload }),
    conversationHistory: "[]",
    currentQuestion: null,
    result: null,
    thinkingOutput: "",
    error: null,
    projectId: null,
    createdAt: now,
    updatedAt: now,
  } as AiSessionRow;
}

function payloadOf(row: AiSessionRow | null): Record<string, unknown> {
  return JSON.parse((row?.inputPayload as string) ?? "{}") as Record<string, unknown>;
}

pgTest("planning session claim lifecycle (multi-task epochs)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_planning_claim",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("claim/finalize/release only touch claim keys and preserve concurrent epoch fields", async () => {
    const db = h.layer().db;
    const sessionId = "planning-claim-surgical";
    await upsertAiSession(db, planningRow(sessionId, {
      taskCreationEpoch: 1,
      createdTaskIds: ["FN-1"],
    }));

    const token = "owner-token-1";
    const claimed = await claimPlanningSessionTaskCreation(db, sessionId, token, new Date().toISOString());
    expect(claimed).not.toBeNull();
    const afterClaim = payloadOf(claimed);
    expect(afterClaim.createClaimStatus).toBe("creating");
    expect(afterClaim.taskCreationEpoch).toBe(1);
    expect(afterClaim.createdTaskIds).toEqual(["FN-1"]);
    expect(afterClaim.createdTaskId).toBeUndefined();
    expect(afterClaim.initialPlan).toBe("Build the thing");

    // Second claim while creating must lose the CAS.
    expect(await claimPlanningSessionTaskCreation(db, sessionId, "other-token", new Date().toISOString())).toBeNull();

    const finalized = await finalizePlanningSessionTaskCreation(db, sessionId, token, "FN-2");
    const afterFinalize = payloadOf(finalized);
    expect(afterFinalize.createClaimStatus).toBe("created");
    expect(afterFinalize.createdTaskId).toBe("FN-2");
    expect(afterFinalize.claimOwnerToken).toBeUndefined();
    expect(afterFinalize.taskCreationEpoch).toBe(1);
    expect(afterFinalize.createdTaskIds).toEqual(["FN-1"]);

    // Wrong-token release is a no-op; the row keeps its finalized linkage.
    expect(await releasePlanningSessionTaskCreation(db, sessionId, "other-token")).toBeNull();
    expect(payloadOf(await getAiSession(db, sessionId)).createClaimStatus).toBe("created");
  });

  it("reconcile with a stale expected epoch is a no-op instead of re-linking an archived task", async () => {
    const db = h.layer().db;
    const sessionId = "planning-claim-epoch-guard";
    await upsertAiSession(db, planningRow(sessionId, {
      taskCreationEpoch: 2,
      createdTaskIds: ["FN-1", "FN-2"],
    }));

    // Caller derived its claim key under epoch 1; the plan has since rotated to epoch 2.
    expect(await reconcilePlanningSessionTaskCreation(db, sessionId, "FN-STALE", 1)).toBeNull();
    const untouched = payloadOf(await getAiSession(db, sessionId));
    expect(untouched.createdTaskId).toBeUndefined();
    expect(untouched.taskCreationEpoch).toBe(2);

    // Matching epoch reconciles normally and preserves the epoch fields.
    const reconciled = await reconcilePlanningSessionTaskCreation(db, sessionId, "FN-3", 2);
    const afterReconcile = payloadOf(reconciled);
    expect(afterReconcile.createClaimStatus).toBe("created");
    expect(afterReconcile.createdTaskId).toBe("FN-3");
    expect(afterReconcile.taskCreationEpoch).toBe(2);
    expect(afterReconcile.createdTaskIds).toEqual(["FN-1", "FN-2"]);
  });

  /*
  FNXC:PlanningMultiTask 2026-07-24-03:40:
  Review finding: claim and finalize need the same epoch guard as reconcile, or a stale-epoch
  creator could finalize an old-epoch task onto a session a concurrent edit already rotated.
  */
  it("claim and finalize with a stale expected epoch are no-ops", async () => {
    const db = h.layer().db;
    const sessionId = "planning-claim-epoch-guarded-writes";
    await upsertAiSession(db, planningRow(sessionId, { taskCreationEpoch: 2, createdTaskIds: ["FN-1"] }));

    // Stale-epoch claim loses the CAS entirely.
    expect(await claimPlanningSessionTaskCreation(db, sessionId, "stale-token", new Date().toISOString(), 1)).toBeNull();
    expect(payloadOf(await getAiSession(db, sessionId)).createClaimStatus).toBeUndefined();

    // Matching-epoch claim succeeds; a finalize whose expected epoch went stale mid-flight is a no-op.
    const claimed = await claimPlanningSessionTaskCreation(db, sessionId, "live-token", new Date().toISOString(), 2);
    expect(claimed).not.toBeNull();
    expect(await finalizePlanningSessionTaskCreation(db, sessionId, "live-token", "FN-STALE", 1)).toBeNull();
    const afterStaleFinalize = payloadOf(await getAiSession(db, sessionId));
    expect(afterStaleFinalize.createClaimStatus).toBe("creating");
    expect(afterStaleFinalize.createdTaskId).toBeUndefined();

    const finalized = await finalizePlanningSessionTaskCreation(db, sessionId, "live-token", "FN-4", 2);
    expect(payloadOf(finalized).createdTaskId).toBe("FN-4");
  });

  it("advances the epoch after the linked task is soft-deleted so recreation gets a fresh proposal key", async () => {
    const db = h.layer().db;
    const store = h.store();
    const sessionId = "planning-soft-deleted-task";
    const firstProposalKey = `planning-session:${sessionId}`;
    const firstTask = await store.createTask({
      title: "First planned task",
      description: "The task that will be soft-deleted.",
      proposalClaimId: firstProposalKey,
    });
    await upsertAiSession(db, planningRow(sessionId, {
      createClaimStatus: "created",
      createdTaskId: firstTask.id,
    }));

    await store.deleteTask(firstTask.id);
    expect((await store.listTasks({ includeArchived: true })).some((task) => task.id === firstTask.id)).toBe(false);
    await expect(store.createTask({
      title: "Colliding replacement",
      description: "The soft-deleted row must retain its unique proposal key.",
      proposalClaimId: firstProposalKey,
    })).rejects.toThrow();

    const advanced = await advancePlanningSessionTaskCreationEpoch(
      db,
      sessionId,
      firstTask.id,
      0,
    );
    expect(payloadOf(advanced)).toMatchObject({
      createClaimStatus: "none",
      taskCreationEpoch: 1,
      createdTaskIds: [firstTask.id],
    });
    expect(payloadOf(advanced).createdTaskId).toBeUndefined();

    /*
    FNXC:PlanningMultiTask 2026-08-03-18:32:
    Retried requests carry the old task id and epoch. The epoch CAS must advance only once.
    */
    expect(await advancePlanningSessionTaskCreationEpoch(db, sessionId, firstTask.id, 0)).toBeNull();
    expect(payloadOf(await getAiSession(db, sessionId)).taskCreationEpoch).toBe(1);

    const replacement = await store.createTask({
      title: "Replacement planned task",
      description: "A fresh task from the same planning session.",
      proposalClaimId: `planning-session:${sessionId}#1`,
    });
    expect(replacement.id).not.toBe(firstTask.id);
    expect(replacement.proposalClaimId).toBe(`planning-session:${sessionId}#1`);
  });
});
