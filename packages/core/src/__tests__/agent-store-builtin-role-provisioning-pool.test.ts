import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentStore } from "../agents/agent-store.js";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../__test-utils__/pg-test-harness.js";

/*
FNXC:WorkflowAgentRouting 2026-08-07-16:40:
Regression guard for the FN-8764 provisioning deadlock. `provisionBuiltinWorkflowRoleAgents`
takes a project-scoped `pg_advisory_xact_lock` inside `transactionImmediate`, so the lock
holder occupies one pooled connection for the whole transaction. When the provisioning work
ran on the POOL instead of on `tx`, the holder needed a SECOND connection to finish while
concurrent callers occupied the remaining slots blocking on that same lock — with
DEFAULT_POOL_MAX=3 that self-deadlocked and every later DB-backed query (i.e. every API
route) queued forever behind an exhausted pool.

The invariant is "the lock and its work share one connection", so these tests bound the pool
rather than reproducing the original three-caller race: `poolMax: 1` makes ANY second
connection checkout unsatisfiable, which fails the pre-fix code deterministically instead of
depending on scheduling. Both the create path (no built-ins yet) and the idempotent re-entry
path (built-ins already present) are covered, since only the former exercises writes under
the lock. Each assertion carries its own timeout so a regression surfaces as a failure rather
than a hung suite.
*/
pgDescribe("AgentStore built-in workflow role provisioning under a saturated pool", () => {
  let harness: PgTestHarness;
  let agentStore: AgentStore;

  beforeEach(async () => {
    harness = await createTaskStoreForTest({ poolMax: 1, prefix: "fusion_test_provision_pool" });
    agentStore = new AgentStore({
      rootDir: harness.rootDir,
      // The advisory lock is project-scoped, so the layer must be project-bound;
      // the shared harness layer is deliberately project-agnostic (projectId "").
      asyncLayer: { ...harness.layer, projectId: "proj_provision_pool" },
      taskStore: harness.store,
    });
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it("completes the initial create path on a single-connection pool", async () => {
    const agents = await agentStore.provisionBuiltinWorkflowRoleAgents();

    expect(agents).toHaveLength(4);
    expect(agents.map((a) => a.metadata?.workflowRole).sort()).toEqual([
      "executor",
      "merger",
      "reviewer",
      "triage",
    ]);
    for (const agent of agents) {
      expect(agent.metadata?.builtInWorkflowRole).toBe(true);
    }
  }, 20_000);

  it("stays idempotent on re-entry without checking out a second connection", async () => {
    const first = await agentStore.provisionBuiltinWorkflowRoleAgents();
    const second = await agentStore.provisionBuiltinWorkflowRoleAgents();

    expect(second).toHaveLength(4);
    // Re-entry must reuse the same durable owners, not add duplicates.
    expect(second.map((a) => a.id).sort()).toEqual(first.map((a) => a.id).sort());

    const durable = (await agentStore.listAgents({ includeEphemeral: true })).filter(
      (a) => a.metadata?.builtInWorkflowRole === true,
    );
    expect(durable).toHaveLength(4);
  }, 20_000);

  it("serializes concurrent callers without deadlocking or duplicating owners", async () => {
    // The original failure needed >1 in-flight caller. Even serialized behind a
    // single connection, concurrent callers must converge on one set of owners.
    const [a, b, c] = await Promise.all([
      agentStore.provisionBuiltinWorkflowRoleAgents(),
      agentStore.provisionBuiltinWorkflowRoleAgents(),
      agentStore.provisionBuiltinWorkflowRoleAgents(),
    ]);

    for (const result of [a, b, c]) {
      expect(result).toHaveLength(4);
    }

    const durable = (await agentStore.listAgents({ includeEphemeral: true })).filter(
      (agent) => agent.metadata?.builtInWorkflowRole === true,
    );
    expect(durable).toHaveLength(4);
  }, 30_000);
});
