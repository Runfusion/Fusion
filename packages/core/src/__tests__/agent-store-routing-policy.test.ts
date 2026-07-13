/**
 * FNXC:AgentRouting 2026-07-12-13:00:
 * Regression suite for GitHub issue Runfusion/Fusion#2015 (FN-7851): product-code implementation tasks were
 * repeatedly bound to a liaison-only agent. Two invariants are locked here across ALL binding primitives:
 *   1. Role guard — the previously UNGUARDED primitives (AgentStore.checkoutTask, AgentStore.assignTask) and
 *      the inbox selector's in-progress branch enforce the same executor-role policy as claimTaskForAgent.
 *   2. Assignment policy — an agent with runtimeConfig.assignmentPolicy "explicit-only" is excluded from
 *      automatic routing, and "none" can NEVER be bound to an implementation task, even with
 *      executorRoleOverride (the liaison guarantee).
 * Plus project isolation: an agent registered in another project's store can never be bound to this
 * project's tasks through any binding primitive.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { AgentStore } from "../agent-store.js";
import { AgentTaskRoutingPolicyError } from "../agent-role-policy.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  createTaskStoreForTest,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("task→agent routing policy (issue #2015)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_routing",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  let agentStore: AgentStore;

  beforeEach(async () => {
    await h.beforeEach();
    agentStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer(), taskStore: h.store() });
    await agentStore.init();
  });

  afterEach(async () => {
    try { agentStore?.close(); } catch { /* best-effort */ }
    await h.afterEach();
  });

  describe("checkoutTask guard (previously unguarded)", () => {
    it("rejects a fresh checkout by a role-incompatible agent", async () => {
      const liaison = await agentStore.createAgent({ name: "Liaison", role: "custom" });
      const task = await h.store().createTask({ description: "product-code work" });

      await expect(agentStore.checkoutTask(liaison.id, task.id)).rejects.toBeInstanceOf(AgentTaskRoutingPolicyError);
      const after = await h.store().getTask(task.id);
      expect(after?.checkedOutBy).toBeUndefined();
    });

    it("rejects a fresh checkout by an executor-ROLE agent with assignmentPolicy 'none' (liaison case)", async () => {
      const liaison = await agentStore.createAgent({
        name: "Platform Liaison",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "none" },
      });
      const task = await h.store().createTask({ description: "backend healthcheck fix" });

      await expect(agentStore.checkoutTask(liaison.id, task.id)).rejects.toBeInstanceOf(AgentTaskRoutingPolicyError);
    });

    it("rejects an automatic (unassigned) checkout by an 'explicit-only' executor but allows it when explicitly assigned", async () => {
      const explicitOnly = await agentStore.createAgent({
        name: "Explicit Only",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "explicit-only" },
      });
      const task = await h.store().createTask({ description: "implementation work" });

      await expect(agentStore.checkoutTask(explicitOnly.id, task.id)).rejects.toBeInstanceOf(AgentTaskRoutingPolicyError);

      await h.store().updateTask(task.id, { assignedAgentId: explicitOnly.id });
      const updated = await agentStore.checkoutTask(explicitOnly.id, task.id);
      expect(updated.checkedOutBy).toBe(explicitOnly.id);
    });

    it("still allows lease renewal by the existing holder", async () => {
      const executor = await agentStore.createAgent({ name: "Exec", role: "executor" });
      const task = await h.store().createTask({ description: "work" });
      await agentStore.checkoutTask(executor.id, task.id, { nodeId: "node-a", runId: "run-1", leaseEpoch: 0 });

      // Simulate policy tightened AFTER the hold was acquired — renewal must not strand the run.
      await agentStore.updateAgent(executor.id, { runtimeConfig: { assignmentPolicy: "none" } });
      const held = await h.store().getTask(task.id);
      const renewed = await agentStore.checkoutTask(executor.id, task.id, {
        nodeId: "node-a",
        runId: "run-2",
        leaseEpoch: held?.checkoutLeaseEpoch ?? 0,
      });
      expect(renewed.checkedOutBy).toBe(executor.id);
    });

    it("honors executorRoleOverride for explicitly assigned tasks but never for policy 'none'", async () => {
      const custom = await agentStore.createAgent({ name: "Custom Override", role: "custom" });
      const task = await h.store().createTask({
        description: "override-delegated work",
        source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
      });
      await h.store().updateTask(task.id, { assignedAgentId: custom.id });
      const updated = await agentStore.checkoutTask(custom.id, task.id);
      expect(updated.checkedOutBy).toBe(custom.id);

      const liaison = await agentStore.createAgent({
        name: "Liaison None",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "none" },
      });
      const overrideTask = await h.store().createTask({
        description: "override-delegated liaison work",
        source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
      });
      await h.store().updateTask(overrideTask.id, { assignedAgentId: liaison.id });
      await expect(agentStore.checkoutTask(liaison.id, overrideTask.id)).rejects.toBeInstanceOf(AgentTaskRoutingPolicyError);
    });
  });

  describe("assignTask guard (previously unguarded)", () => {
    it("rejects binding an implementation task to a role-incompatible agent", async () => {
      const reviewer = await agentStore.createAgent({ name: "Reviewer", role: "reviewer" });
      const task = await h.store().createTask({ description: "implementation work" });

      await expect(agentStore.assignTask(reviewer.id, task.id)).rejects.toBeInstanceOf(AgentTaskRoutingPolicyError);
      const after = await agentStore.getAgent(reviewer.id);
      expect(after?.taskId).toBeUndefined();
    });

    it("rejects binding to a policy-'none' executor even when the task carries executorRoleOverride", async () => {
      const liaison = await agentStore.createAgent({
        name: "Liaison",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "none" },
      });
      const task = await h.store().createTask({
        description: "work",
        source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
      });

      await expect(agentStore.assignTask(liaison.id, task.id)).rejects.toBeInstanceOf(AgentTaskRoutingPolicyError);
    });

    it("allows executors, explicit-only executors, clears, and unresolvable ids", async () => {
      const executor = await agentStore.createAgent({ name: "Exec", role: "executor" });
      const explicitOnly = await agentStore.createAgent({
        name: "Explicit Only",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "explicit-only" },
      });
      const task = await h.store().createTask({ description: "work" });

      await expect(agentStore.assignTask(executor.id, task.id)).resolves.toMatchObject({ taskId: task.id });
      await agentStore.assignTask(executor.id, undefined);
      // assignTask IS explicit routing — explicit-only agents accept it.
      await expect(agentStore.assignTask(explicitOnly.id, task.id)).resolves.toMatchObject({ taskId: task.id });

      const liaison = await agentStore.createAgent({
        name: "Liaison",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "none" },
      });
      // Hosts WITHOUT a TaskStore stay fail-open (display-only linkage; cannot resolve the column).
      const bareStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer() });
      await bareStore.init();
      try {
        const bareLiaison = await bareStore.createAgent({
          name: "Bare Liaison",
          role: "executor",
          runtimeConfig: { assignmentPolicy: "none" },
        });
        await expect(bareStore.assignTask(bareLiaison.id, "KB-unresolvable")).resolves.toMatchObject({ taskId: "KB-unresolvable" });
      } finally {
        bareStore.close();
      }
    });
  });

  describe("claimTaskForAgent policy", () => {
    it("refuses auto-claim for explicit-only and none policies, allows explicit claim for explicit-only", async () => {
      const explicitOnly = await agentStore.createAgent({
        name: "Explicit Only",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "explicit-only" },
      });
      const liaison = await agentStore.createAgent({
        name: "Liaison",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "none" },
      });
      const unassigned = await h.store().createTask({ description: "backlog work" });

      const autoClaim = await agentStore.claimTaskForAgent(explicitOnly.id, unassigned.id);
      expect(autoClaim.ok).toBe(false);

      const liaisonClaim = await agentStore.claimTaskForAgent(liaison.id, unassigned.id);
      expect(liaisonClaim.ok).toBe(false);

      const assigned = await h.store().createTask({ description: "assigned work" });
      await h.store().updateTask(assigned.id, { assignedAgentId: explicitOnly.id });
      const explicitClaim = await agentStore.claimTaskForAgent(explicitOnly.id, assigned.id);
      expect(explicitClaim.ok).toBe(true);
    });

    it("refuses explicit claim for policy 'none' even with executorRoleOverride", async () => {
      const liaison = await agentStore.createAgent({
        name: "Liaison",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "none" },
      });
      const task = await h.store().createTask({
        description: "override work",
        source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
      });
      await h.store().updateTask(task.id, { assignedAgentId: liaison.id });

      const claim = await agentStore.claimTaskForAgent(liaison.id, task.id);
      expect(claim.ok).toBe(false);
      if (!claim.ok) {
        expect(claim.reason).toContain("assignmentPolicy \"none\"");
      }
    });
  });

  describe("selectNextTaskForAgent bind compatibility", () => {
    it("does not re-select a mis-bound in-progress implementation task for a role-incompatible agent", async () => {
      const liaison = await agentStore.createAgent({ name: "Liaison", role: "custom" });
      const task = await h.store().createTask({ description: "mis-bound work" });
      await h.store().updateTask(task.id, { assignedAgentId: liaison.id });
      await h.store().moveTask(task.id, "todo");
      await h.store().moveTask(task.id, "in-progress");

      const selection = await h.store().selectNextTaskForAgent(liaison.id, { id: liaison.id, role: liaison.role });
      expect(selection).toBeNull();
    });

    it("does not re-select an in-progress task for a policy-'none' executor even with executorRoleOverride", async () => {
      const liaison = await agentStore.createAgent({
        name: "Liaison",
        role: "executor",
        runtimeConfig: { assignmentPolicy: "none" },
      });
      const task = await h.store().createTask({
        description: "override mis-bound work",
        source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
      });
      await h.store().updateTask(task.id, { assignedAgentId: liaison.id });
      await h.store().moveTask(task.id, "todo");
      await h.store().moveTask(task.id, "in-progress");

      const selection = await h.store().selectNextTaskForAgent(liaison.id, {
        id: liaison.id,
        role: liaison.role,
        runtimeConfig: liaison.runtimeConfig,
      });
      expect(selection).toBeNull();
    });

    it("still resumes in-progress work for a legitimate executor and honors executorRoleOverride for auto-policy agents", async () => {
      const executor = await agentStore.createAgent({ name: "Exec", role: "executor" });
      const task = await h.store().createTask({ description: "real work" });
      await h.store().updateTask(task.id, { assignedAgentId: executor.id });
      await h.store().moveTask(task.id, "todo");
      await h.store().moveTask(task.id, "in-progress");

      const selection = await h.store().selectNextTaskForAgent(executor.id, { id: executor.id, role: executor.role });
      expect(selection?.task.id).toBe(task.id);
      expect(selection?.priority).toBe("in_progress");

      const custom = await agentStore.createAgent({ name: "Custom", role: "custom" });
      const overrideTask = await h.store().createTask({
        description: "override-delegated",
        source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
      });
      await h.store().updateTask(overrideTask.id, { assignedAgentId: custom.id });
      await h.store().moveTask(overrideTask.id, "todo");
      const overrideSelection = await h.store().selectNextTaskForAgent(custom.id, { id: custom.id, role: custom.role });
      expect(overrideSelection?.task.id).toBe(overrideTask.id);
    });
  });

  describe("project isolation", () => {
    it("an agent registered in another project's store can never be bound to this project's tasks", async () => {
      const otherHarness = await createTaskStoreForTest({ prefix: "fusion_agent_routing_other" });
      const otherAgentStore = new AgentStore({ rootDir: otherHarness.rootDir, asyncLayer: otherHarness.layer, taskStore: otherHarness.store });
      await otherAgentStore.init();

      try {
        const foreignAgent = await otherAgentStore.createAgent({ name: "Foreign Executor", role: "executor" });
        const task = await h.store().createTask({ description: "this project's work" });

        // Every binding primitive resolves the agent against THIS project's store — a foreign agent id
        // must be rejected outright, never bound.
        await expect(agentStore.checkoutTask(foreignAgent.id, task.id)).rejects.toThrow(`Agent ${foreignAgent.id} not found`);
        await expect(agentStore.assignTask(foreignAgent.id, task.id)).rejects.toThrow(`Agent ${foreignAgent.id} not found`);
        await expect(agentStore.claimTaskForAgent(foreignAgent.id, task.id)).rejects.toThrow(`Agent ${foreignAgent.id} not found`);

        const after = await h.store().getTask(task.id);
        expect(after?.assignedAgentId).toBeUndefined();
        expect(after?.checkedOutBy).toBeUndefined();
      } finally {
        otherAgentStore.close();
        await otherHarness.teardown();
      }
    });
  });
});
