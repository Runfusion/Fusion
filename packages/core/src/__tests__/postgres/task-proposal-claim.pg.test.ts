/*
FNXC:EphemeralAgentTaskCreation 2026-07-30-18:30:
A released proposal lease may be reclaimed while its original creator is still
inserting. This PostgreSQL integration test exercises the real partial unique
index race: every attempt uses the proposal's stable key and must return one
already-materialized task rather than surfacing 23505 or creating another row.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore proposal claim idempotency", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_proposal_claim",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("returns the existing task when a reclaim races the original proposal insert", async () => {
    const stableProposalKey = "proposal-reclaim-race-stable-key";
    const store = h.store();

    const [originalCreate, reclaimedCreate] = await Promise.all([
      store.createTask({
        title: "Original proposal materialization",
        description: "Original creator resumes after its lease was released.",
        proposalClaimId: stableProposalKey,
      }),
      store.createTask({
        title: "Reclaimed proposal materialization",
        description: "Reclaimed creator uses the same stable proposal key.",
        proposalClaimId: stableProposalKey,
      }),
    ]);

    expect(reclaimedCreate.id).toBe(originalCreate.id);
    expect(reclaimedCreate.proposalClaimId).toBe(stableProposalKey);
    const persisted = (await store.listTasks()).filter((task) => task.proposalClaimId === stableProposalKey);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe(originalCreate.id);
  });
});
