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
  claimPlanningSessionTaskCreation,
  finalizePlanningSessionTaskCreation,
  getAiSession,
  reconcilePlanningSessionTaskCreation,
  releasePlanningSessionTaskCreation,
  upsertAiSession,
  type AiSessionRow,
} from "../../async-ai-session-store.js";

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
});
