import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentStore } from "../agents/agent-store.js";
import { getCanonicalAgentInstructionsBundleDirName } from "../types.js";
import {
  BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG,
  BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST,
} from "../agents/workflow-role-agent-defaults.js";
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
      const definition = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.find((item) => item.role === agent.metadata?.workflowRole);
      expect(agent.metadata?.builtInWorkflowRole).toBe(true);
      expect(definition).toBeDefined();
      expect(agent.instructionsText).toBe(definition!.instructionsText);
      expect(agent.soul).toBe(definition!.soul);
      expect(agent.instructionsPath).toBeUndefined();
      expect(agent.bundleConfig).toEqual(BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG);
      expect(await agentStore.listBundleFiles(agent.id)).toEqual(["AGENTS.md", "soul.md"]);
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

  it("retries managed mirror materialization after a post-transaction filesystem failure", async () => {
    const first = await agentStore.provisionBuiltinWorkflowRoleAgents();
    const planner = first.find((agent) => agent.metadata?.workflowRole === "triage")!;
    const bundleDir = join(
      harness.rootDir,
      "agents",
      getCanonicalAgentInstructionsBundleDirName(planner.name, planner.id),
    );
    const entryPath = join(bundleDir, "AGENTS.md");

    // FNXC:WorkflowAgentIdentities 2026-08-08-06:27: A directory at the entry-file path
    // deterministically fails the post-commit write without adding sleeps or mock-only behavior.
    await rm(entryPath, { force: true });
    await mkdir(entryPath);
    await expect(agentStore.provisionBuiltinWorkflowRoleAgents()).rejects.toThrow();

    const durableAfterFailure = (await agentStore.listAgents({ includeEphemeral: true })).filter(
      (agent) => agent.metadata?.builtInWorkflowRole === true,
    );
    expect(durableAfterFailure).toHaveLength(4);

    await rm(entryPath, { recursive: true, force: true });
    const retried = await agentStore.provisionBuiltinWorkflowRoleAgents();
    expect(retried.map((agent) => agent.id).sort()).toEqual(first.map((agent) => agent.id).sort());
    expect(await agentStore.listBundleFiles(planner.id)).toEqual(["AGENTS.md", "soul.md"]);
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
