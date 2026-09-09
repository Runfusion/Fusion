/*
FNXC:EphemeralAgentTaskCreation 2026-07-30-18:30:
A released proposal lease may be reclaimed while its original creator is still
inserting. This PostgreSQL integration test exercises the real partial unique
index race: every attempt uses the proposal's stable key and must return one
already-materialized task rather than surfacing 23505 or creating another row.
*/

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowIr } from "../../workflows/workflow-ir-types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

function planningWorkflowIr(): WorkflowIr {
  return {
    version: "v2",
    name: "planning-wake-lanes",
    columns: [
      { id: "planning-inbox", name: "Planning inbox", traits: [{ trait: "intake" }] },
      { id: "ready-to-plan", name: "Ready to plan", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "checking", name: "Checking", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "planning-inbox" },
      { id: "plan", kind: "prompt", column: "ready-to-plan", config: { name: "Plan", prompt: "Specify." } },
      { id: "build", kind: "prompt", column: "building", config: { name: "Build", prompt: "Implement." } },
      { id: "review", kind: "prompt", column: "checking", config: { name: "Review", prompt: "Review." } },
      { id: "merge", kind: "merge-attempt", column: "checking", config: { capability: "task-merge" } },
      { id: "end", kind: "end", column: "shipped" },
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "build", condition: "success" },
      { from: "build", to: "review", condition: "success" },
      { from: "review", to: "merge", condition: "success" },
      { from: "merge", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

pgTest("TaskStore proposal claim idempotency", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_proposal_claim",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  FNXC:PlanningModeScheduling 2026-08-03-09:44:
  This uses the real PostgreSQL TaskStore boundary rather than a route mock: a selected workflow
  must be durable before task:created exposes its renamed intake/hold lanes, and a proposal replay
  must not emit another creation wake that could schedule duplicate planning work.
  */
  it("publishes selected workflow lanes once across proposal-claim replay", async () => {
    const stableProposalKey = "proposal-reclaim-race-stable-key";
    const store = h.store();
    const definition = await store.createWorkflowDefinition({ name: "Planning wake lanes", ir: planningWorkflowIr() });
    const events: Array<{ id: string; lanes?: { intake?: string; hold?: string } }> = [];
    store.on("task:created", (task, meta) => events.push({ id: task.id, lanes: meta?.lanes }));

    const [originalCreate, reclaimedCreate] = await Promise.all([
      store.createTask({
        title: "Original proposal materialization",
        description: "Original creator resumes after its lease was released.",
        proposalClaimId: stableProposalKey,
        workflowId: definition.id,
      }),
      store.createTask({
        title: "Reclaimed proposal materialization",
        description: "Reclaimed creator uses the same stable proposal key.",
        proposalClaimId: stableProposalKey,
        workflowId: definition.id,
      }),
    ]);

    expect(reclaimedCreate.id).toBe(originalCreate.id);
    expect(reclaimedCreate.proposalClaimId).toBe(stableProposalKey);
    const persisted = (await store.listTasks()).filter((task) => task.proposalClaimId === stableProposalKey);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe(originalCreate.id);
    expect(events).toEqual([{
      id: originalCreate.id,
      lanes: expect.objectContaining({ intake: "planning-inbox", hold: "ready-to-plan" }),
    }]);
  });
});
