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
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { AgentStore } from "../agents/agent-store.js";
import { TaskStore } from "../store.js";
import { AgentTaskRoutingPolicyError } from "../agents/agent-role-policy.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  createTaskStoreForTest,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("task→agent routing policy (issue #2015)", () => {
  // FNXC:WorkflowAgentRouting 2026-08-07-18:40: bind a real projectId so FN-8764 built-in
  // workflow-owner provisioning in AgentStore.init() has a partition. The cross-project
  // isolation case below uses a DISTINCT projectId so the two stores are genuinely separate.
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_routing",
    projectId: "proj_agent_routing",
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
    it("does not select a remembered-owner todo task when only userPaused remains true", async () => {
      const executor = await agentStore.createAgent({ name: "Exec", role: "executor" });
      const task = await h.store().createTask({ description: "manually parked work" });
      await h.store().updateTask(task.id, { assignedAgentId: executor.id });
      await h.store().moveTask(task.id, "todo");
      await h.store().moveTask(task.id, "in-progress");
      await h.store().moveTask(task.id, "todo", { moveSource: "user" });

      const parked = await h.store().getTask(task.id);
      expect(parked).toMatchObject({ assignedAgentId: executor.id, userPaused: true });
      expect(parked?.paused).not.toBe(true);
      await expect(
        h.store().selectNextTaskForAgent(executor.id, { id: executor.id, role: executor.role }),
      ).resolves.toBeNull();
    });

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

  describe("durable executor handoff", () => {
    it("releases a queued engineer-owned task once so a Workflow Executor can claim it", async () => {
      const engineer = await agentStore.createAgent({ name: "Engineer", role: "engineer" });
      const executor = await agentStore.createAgent({ name: "Handoff Executor", role: "executor" });
      const task = await h.store().createTask({ description: "executor-class implementation" });
      await agentStore.assignTask(engineer.id, task.id);
      await h.store().updateTask(task.id, { assignedAgentId: engineer.id });
      await h.store().moveTask(task.id, "todo");

      const first = await agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id);
      const second = await agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id);

      expect(first.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, reason: "already_released" });
      expect((await h.store().getTask(task.id))?.assignedAgentId).toBeUndefined();
      expect((await agentStore.getAgent(engineer.id))?.taskId).toBeUndefined();
      await expect(agentStore.claimTaskForAgent(executor.id, task.id)).resolves.toMatchObject({ ok: true });
    });

    async function idlePrincipalHold() {
      const engineer = await agentStore.createAgent({ name: "Unavailable Engineer", role: "engineer" });
      const task = await h.store().createTask({ description: "admitted implementation" });
      await agentStore.assignTask(engineer.id, task.id);
      await h.store().updateTask(task.id, { assignedAgentId: engineer.id });
      await h.store().moveTask(task.id, "todo");
      await h.store().moveTask(task.id, "in-progress");
      await h.store().updateTask(task.id, { workflowIrPinNodeId: "steps" });
      await agentStore.updateAgentState(engineer.id, "paused");
      const item = await h.store().upsertWorkflowWorkItem({
        runId: `${task.id}:held`, taskId: task.id, nodeId: "step-execute", nodeInstanceId: "steps#0:step-execute", kind: "task", state: "held",
        blockedReason: "workflow-principal-named-principal-unavailable:executor",
        principalAgentId: engineer.id, workflowRole: "executor", authorityKind: "task-assignee",
      });
      return { engineer, task, item };
    }

    it("atomically releases an unavailable idle WIP owner and wakes its exact held continuation in place", async () => {
      const { engineer, task, item } = await idlePrincipalHold();
      await expect(agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id)).resolves.toMatchObject({ ok: false, reason: "not_queued" });
      await expect(agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id, undefined, {
        allowIdleWipPrincipalHold: true,
      })).resolves.toMatchObject({ ok: true });
      expect(await h.store().getTask(task.id)).toMatchObject({ column: "in-progress", workflowIrPinNodeId: "steps", assignedAgentId: undefined });
      expect(await agentStore.getAgent(engineer.id)).toMatchObject({ state: "paused", taskId: undefined });
      expect(await h.store().listWorkflowWorkItemsForTask(task.id)).toEqual([expect.objectContaining({ id: item.id, state: "runnable", principalAgentId: null, blockedReason: null, nodeInstanceId: "steps#0:step-execute" })]);
    });

    it("rolls back assignment release when its durable continuation cannot be resumed", async () => {
      const { engineer, task, item } = await idlePrincipalHold();
      const transition = vi.spyOn(h.store(), "transitionWorkflowWorkItem").mockResolvedValue(item);
      await expect(agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id, undefined, {
        allowIdleWipPrincipalHold: true,
      })).rejects.toThrow("lost its held continuation");
      transition.mockRestore();
      expect(await h.store().getTask(task.id)).toMatchObject({ assignedAgentId: engineer.id });
      expect(await agentStore.getAgent(engineer.id)).toMatchObject({ taskId: task.id });
      expect((await h.store().listWorkflowWorkItemsForTask(task.id))[0]).toMatchObject({ id: item.id, state: "held" });
    });

    it.each(["task-pause", "user-pause", "checkout", "running", "reviewer", "wrong-pin", "available-owner", "competing-work", "column-binding", "wrong-instance"])("preserves ownership and held work when WIP handoff sees %s", async (fence) => {
      const { engineer, task, item } = await idlePrincipalHold();
      if (fence === "task-pause") await h.store().updateTask(task.id, { paused: true, pausedByAgentId: engineer.id });
      if (fence === "user-pause") await h.store().updateTask(task.id, { paused: true, userPaused: true });
      if (fence === "checkout") await h.store().updateTask(task.id, { checkedOutBy: engineer.id });
      if (fence === "running") await h.store().transitionWorkflowWorkItem(item.id, "running");
      if (fence === "reviewer") await h.store().transitionWorkflowWorkItem(item.id, "held", { blockedReason: "workflow-principal-named-principal-unavailable:reviewer", workflowRole: "reviewer" });
      if (fence === "column-binding") await h.store().transitionWorkflowWorkItem(item.id, "held", { authorityKind: "column-binding" });
      if (fence === "wrong-instance") await h.store().transitionWorkflowWorkItem(item.id, "held", { nodeInstanceId: "steps#99:step-execute" });
      if (fence === "wrong-pin") await h.store().updateTask(task.id, { workflowIrPinNodeId: "other" });
      if (fence === "available-owner") await agentStore.updateAgentState(engineer.id, "active");
      if (fence === "competing-work") await h.store().upsertWorkflowWorkItem({ runId: `${task.id}:other`, taskId: task.id, nodeId: "execute", kind: "workflow-step", state: "running" });
      await expect(agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id, undefined, {
        allowIdleWipPrincipalHold: true, allowAgentOwnedPause: true,
      })).resolves.toMatchObject({ ok: false });
      expect(await h.store().getTask(task.id)).toMatchObject({ column: "in-progress", assignedAgentId: engineer.id });
      expect((await h.store().listWorkflowWorkItemsForTask(task.id)).find(work => work.id === item.id)?.state).toBe(fence === "running" ? "running" : "held");
    });

    it("releases an unavailable owner's automatic pause but preserves human pause authority", async () => {
      const engineer = await agentStore.createAgent({ name: "Paused Engineer", role: "engineer" });
      const task = await h.store().createTask({ description: "agent-owned pause recovery" });
      await agentStore.assignTask(engineer.id, task.id);
      await h.store().updateTask(task.id, {
        assignedAgentId: engineer.id,
        paused: true,
        pausedByAgentId: engineer.id,
      });
      await h.store().moveTask(task.id, "todo");

      await expect(agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id, undefined, {
        allowAgentOwnedPause: true,
      })).resolves.toMatchObject({ ok: true });
      expect(await h.store().getTask(task.id)).toMatchObject({
        assignedAgentId: undefined,
        paused: undefined,
        pausedByAgentId: undefined,
      });
      expect((await agentStore.getAgent(engineer.id))?.taskId).toBeUndefined();
    });

    it("does not erase an operator assignment committed while another store waits to hand off", async () => {
      const engineer = await agentStore.createAgent({ name: "Stale Engineer", role: "engineer" });
      const executor = await agentStore.createAgent({ name: "Operator Executor", role: "executor" });
      const task = await h.store().createTask({ description: "cross-process ownership fence" });
      await agentStore.assignTask(engineer.id, task.id);
      await h.store().updateTask(task.id, { assignedAgentId: engineer.id });
      await h.store().moveTask(task.id, "todo");

      let releaseAdvisoryLock!: () => void;
      const advisoryLockReleased = new Promise<void>((resolve) => { releaseAdvisoryLock = resolve; });
      let advisoryLockAcquired!: () => void;
      const advisoryLockAcquiredPromise = new Promise<void>((resolve) => { advisoryLockAcquired = resolve; });
      const lockHolder = h.adminSql().begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`task:${h.layer().projectId}:${task.id}`}, 0))`;
        advisoryLockAcquired();
        await advisoryLockReleased;
      });
      await advisoryLockAcquiredPromise;

      const secondProcessStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer(), taskStore: h.store() });
      // Queue the operator write first while the advisory lock is held. Once it
      // commits, the heartbeat from the other store must re-read that owner.
      const operatorAssignment = (async () => {
        await h.store().updateTask(task.id, { assignedAgentId: executor.id });
        await secondProcessStore.assignTask(executor.id, task.id);
      })();
      await Promise.resolve();
      const staleHandoff = agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id);
      releaseAdvisoryLock();

      await operatorAssignment;
      await expect(staleHandoff).resolves.toMatchObject({ ok: false, reason: "assigned_to_other" });
      await lockHolder;
      expect((await h.store().getTask(task.id))?.assignedAgentId).toBe(executor.id);
      expect((await agentStore.getAgent(engineer.id))?.taskId).toBeUndefined();
      expect((await agentStore.getAgent(executor.id))?.taskId).toBe(task.id);
      secondProcessStore.close();
    });

    it("revalidates cache and lifecycle publication after a newer assignment", async () => {
      const engineer = await agentStore.createAgent({ name: "Publishing Engineer", role: "engineer" });
      const executor = await agentStore.createAgent({ name: "Publishing Executor", role: "executor" });
      const task = await h.store().createTask({ description: "post-commit publication ownership fence" });
      await agentStore.assignTask(engineer.id, task.id);
      await h.store().updateTask(task.id, { assignedAgentId: engineer.id });
      await h.store().moveTask(task.id, "todo");

      const store = h.store();
      // A separate TaskStore models the dashboard/executor process that wins
      // after the heartbeat has committed but before it can publish a mirror.
      const otherStore = new TaskStore(h.rootDir(), h.globalDir(), { asyncLayer: h.layer() });
      const operatorAgentStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer(), taskStore: otherStore });
      await operatorAgentStore.init();
      let releasePublication!: () => void;
      const publicationBlocked = new Promise<void>((resolve) => { releasePublication = resolve; });
      let mirrorPublicationStarted!: () => void;
      const mirrorPublicationStartedPromise = new Promise<void>((resolve) => { mirrorPublicationStarted = resolve; });
      const writeTaskJsonFile = store.writeTaskJsonFile.bind(store);
      vi.spyOn(store, "isWatching", "get").mockReturnValue(true);
      vi.spyOn(store, "writeTaskJsonFile").mockImplementation(async (dir, candidate) => {
        if (candidate.id === task.id && candidate.assignedAgentId === undefined) {
          mirrorPublicationStarted();
          await publicationBlocked;
        }
        await writeTaskJsonFile(dir, candidate);
      });

      let releaseCacheRefresh!: () => void;
      const cacheRefreshBlocked = new Promise<void>((resolve) => { releaseCacheRefresh = resolve; });
      let refreshRead!: () => void;
      const refreshReadPromise = new Promise<void>((resolve) => { refreshRead = resolve; });
      const publishedOwners: Array<string | undefined> = [];
      store.on("task:updated", (candidate) => {
        if (candidate.id === task.id) publishedOwners.push(candidate.assignedAgentId);
      });
      (store as unknown as {
        __afterHandoffPublicationReadForTest?: () => void | Promise<void>;
      }).__afterHandoffPublicationReadForTest = async () => {
        refreshRead();
        await cacheRefreshBlocked;
      };

      const handoff = agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id);
      await mirrorPublicationStartedPromise;
      releasePublication();
      // Pause immediately after the releasing store read the unassigned row.
      // The operator assignment commits before publication resumes, so the
      // handoff must re-read the row instead of emitting that stale release.
      await refreshReadPromise;
      await otherStore.updateTask(task.id, { assignedAgentId: executor.id });
      await operatorAgentStore.assignTask(executor.id, task.id);
      releaseCacheRefresh();

      await expect(handoff).resolves.toMatchObject({ ok: true });
      expect((await store.getTask(task.id))?.assignedAgentId).toBe(executor.id);
      await expect(store.readTaskJson(store.taskDir(task.id))).resolves.toMatchObject({ assignedAgentId: executor.id });
      expect(store.taskCache.get(task.id)?.assignedAgentId).toBe(executor.id);
      expect(publishedOwners).not.toContain(undefined);
      expect(publishedOwners.at(-1)).toBe(executor.id);
    });

    it("never releases a user-paused task or a newer operator assignment", async () => {
      const engineer = await agentStore.createAgent({ name: "Engineer", role: "engineer" });
      const executor = await agentStore.createAgent({ name: "Handoff Executor", role: "executor" });
      const task = await h.store().createTask({ description: "manually controlled implementation" });
      await h.store().updateTask(task.id, { assignedAgentId: engineer.id });
      await h.store().moveTask(task.id, "todo");
      await h.store().moveTask(task.id, "in-progress");
      await h.store().moveTask(task.id, "todo", { moveSource: "user" });

      await expect(agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id)).resolves.toMatchObject({ ok: false, reason: "paused" });
      expect(await h.store().getTask(task.id)).toMatchObject({ assignedAgentId: engineer.id, userPaused: true });

      await h.store().updateTask(task.id, { assignedAgentId: executor.id });
      await expect(agentStore.handoffTaskToWorkflowExecutor(engineer.id, task.id)).resolves.toMatchObject({ ok: false, reason: "assigned_to_other" });
      expect((await h.store().getTask(task.id))?.assignedAgentId).toBe(executor.id);
    });
  });

  describe("project isolation", () => {
    it("an agent registered in another project's store can never be bound to this project's tasks", async () => {
      const otherHarness = await createTaskStoreForTest({ prefix: "fusion_agent_routing_other", projectId: "proj_agent_routing_other" });
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
