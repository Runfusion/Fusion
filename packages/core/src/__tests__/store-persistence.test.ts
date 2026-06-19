import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentStore } from "../agent-store.js";
import { TaskStore } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  describe("assignedAgentId persistence", () => {
    it("creates a task with assignedAgentId when provided", async () => {
      const task = await harness.store().createTask({
        description: "Assigned task",
        assignedAgentId: "agent-123",
      });

      expect(task.assignedAgentId).toBe("agent-123");

      const detail = await harness.store().getTask(task.id);
      expect(detail.assignedAgentId).toBe("agent-123");
    });

    it("updates a task to set assignedAgentId", async () => {
      const task = await harness.store().createTask({ description: "Unassigned task" });

      const updated = await harness.store().updateTask(task.id, { assignedAgentId: "agent-456" });
      expect(updated.assignedAgentId).toBe("agent-456");

      const detail = await harness.store().getTask(task.id);
      expect(detail.assignedAgentId).toBe("agent-456");
    });

    it("updates a task to clear assignedAgentId with null", async () => {
      const task = await harness.store().createTask({
        description: "Assigned then cleared",
        assignedAgentId: "agent-789",
      });

      const cleared = await harness.store().updateTask(task.id, { assignedAgentId: null });
      expect(cleared.assignedAgentId).toBeUndefined();

      const detail = await harness.store().getTask(task.id);
      expect(detail.assignedAgentId).toBeUndefined();
    });

    it("returns assignedAgentId values from listTasks", async () => {
      const assigned = await harness.store().createTask({
        description: "Assigned task in list",
        assignedAgentId: "agent-list",
      });
      await harness.store().createTask({ description: "Unassigned task in list" });

      const tasks = await harness.store().listTasks();
      const listedAssigned = tasks.find((t) => t.id === assigned.id);

      expect(listedAssigned?.assignedAgentId).toBe("agent-list");
    });
  });

  describe("tokenUsage persistence", () => {
    it("round-trips per-model token buckets through write and read", async () => {
      const task = await harness.store().createTask({ description: "Per-model token task" });
      const perModel = [
        {
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
          inputTokens: 70,
          outputTokens: 30,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 100,
          firstUsedAt: "2026-03-01T00:00:00.000Z",
          lastUsedAt: "2026-03-01T00:01:00.000Z",
        },
        {
          modelProvider: "openai",
          modelId: "gpt-5",
          inputTokens: 25,
          outputTokens: 15,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 40,
          firstUsedAt: "2026-03-01T00:02:00.000Z",
          lastUsedAt: "2026-03-01T00:03:00.000Z",
        },
      ];

      await harness.store().updateTask(task.id, {
        tokenUsage: {
          inputTokens: 95,
          outputTokens: 45,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 140,
          firstUsedAt: "2026-03-01T00:00:00.000Z",
          lastUsedAt: "2026-03-01T00:03:00.000Z",
          modelProvider: "openai",
          modelId: "gpt-5",
          perModel,
        },
      });

      const detail = await harness.store().getTask(task.id);

      expect(detail.tokenUsage?.perModel).toEqual(perModel);
    });
  });

  describe("graphResumeRetryCount persistence", () => {
    it("defaults to zero and round-trips updateTask values", async () => {
      const task = await harness.store().createTask({ description: "Graph retry counter task" });

      expect((await harness.store().getTask(task.id)).graphResumeRetryCount).toBe(0);

      const updated = await harness.store().updateTask(task.id, { graphResumeRetryCount: 2 });
      expect(updated.graphResumeRetryCount).toBe(2);
      expect((await harness.store().getTask(task.id)).graphResumeRetryCount).toBe(2);
    });

    it("clears graphResumeRetryCount with null", async () => {
      const task = await harness.store().createTask({ description: "Graph retry clear task" });
      await harness.store().updateTask(task.id, { graphResumeRetryCount: 1 });

      const cleared = await harness.store().updateTask(task.id, { graphResumeRetryCount: null });

      expect(cleared.graphResumeRetryCount).toBeNull();
      expect((await harness.store().getTask(task.id)).graphResumeRetryCount).toBeUndefined();
    });
  });

  describe("agent taskId sync on reassignment", () => {
    it("reassignment clears the old agent taskId and sets the new agent taskId", async () => {
      harness.store().close();
      const store = new TaskStore(harness.rootDir(), harness.globalDir());
      await store.init();
      const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();

      try {
        const task = await store.createTask({ description: "Reassignment target" });
        const agentA = await agentStore.createAgent({ name: "Agent A", role: "executor" });
        const agentB = await agentStore.createAgent({ name: "Agent B", role: "executor" });

        await store.updateTask(task.id, { assignedAgentId: agentA.id });
        expect((await agentStore.getAgent(agentA.id))?.taskId).toBe(task.id);

        await store.updateTask(task.id, { assignedAgentId: agentB.id });

        expect((await agentStore.getAgent(agentA.id))?.taskId).toBeUndefined();
        expect((await agentStore.getAgent(agentB.id))?.taskId).toBe(task.id);
      } finally {
        agentStore.close();
        store.close();
      }
    });

    it("reassignment clears stale checkedOutBy when the outgoing agent held the lease", async () => {
      harness.store().close();
      const store = new TaskStore(harness.rootDir(), harness.globalDir());
      await store.init();
      const agentStore = new AgentStore({ rootDir: store.getFusionDir(), taskStore: store });
      await agentStore.init();

      try {
        const task = await store.createTask({ description: "Checkout cleanup target" });
        const agentA = await agentStore.createAgent({ name: "Agent A Checkout", role: "executor" });
        const agentB = await agentStore.createAgent({ name: "Agent B Checkout", role: "executor" });

        await store.updateTask(task.id, { assignedAgentId: agentA.id });
        await agentStore.checkoutTask(agentA.id, task.id);
        expect((await store.getTask(task.id)).checkedOutBy).toBe(agentA.id);

        const updated = await store.updateTask(task.id, { assignedAgentId: agentB.id });
        expect(updated.checkedOutBy).toBeUndefined();
      } finally {
        agentStore.close();
        store.close();
      }
    });

    it("unassignment clears the agent taskId", async () => {
      harness.store().close();
      const store = new TaskStore(harness.rootDir(), harness.globalDir());
      await store.init();
      const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();

      try {
        const task = await store.createTask({ description: "Unassign target" });
        const agent = await agentStore.createAgent({ name: "Sole Agent", role: "executor" });

        await store.updateTask(task.id, { assignedAgentId: agent.id });
        expect((await agentStore.getAgent(agent.id))?.taskId).toBe(task.id);

        await store.updateTask(task.id, { assignedAgentId: null });

        expect((await agentStore.getAgent(agent.id))?.taskId).toBeUndefined();
      } finally {
        agentStore.close();
        store.close();
      }
    });

    it("re-setting the same agent id is a no-op for agent task links", async () => {
      harness.store().close();
      const store = new TaskStore(harness.rootDir(), harness.globalDir());
      await store.init();
      const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();

      try {
        const task = await store.createTask({ description: "Idempotent target" });
        const agentA = await agentStore.createAgent({ name: "Agent Same", role: "executor" });

        await store.updateTask(task.id, { assignedAgentId: agentA.id });
        expect((await agentStore.getAgent(agentA.id))?.taskId).toBe(task.id);

        await store.updateTask(task.id, { assignedAgentId: agentA.id });

        expect((await agentStore.getAgent(agentA.id))?.taskId).toBe(task.id);
      } finally {
        agentStore.close();
        store.close();
      }
    });

    it("does not clear the outgoing agent taskId when it already moved to another task", async () => {
      harness.store().close();
      const store = new TaskStore(harness.rootDir(), harness.globalDir());
      await store.init();
      const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
      await agentStore.init();

      try {
        const task1 = await store.createTask({ description: "Race guard task 1" });
        const task2 = await store.createTask({ description: "Race guard task 2" });
        const agentA = await agentStore.createAgent({ name: "Agent Race A", role: "executor" });
        const agentB = await agentStore.createAgent({ name: "Agent Race B", role: "executor" });

        await store.updateTask(task1.id, { assignedAgentId: agentA.id });
        expect((await agentStore.getAgent(agentA.id))?.taskId).toBe(task1.id);
        expect((await agentStore.getAgent(agentB.id))?.taskId).toBeUndefined();

        await agentStore.syncExecutionTaskLink(agentA.id, task2.id);
        expect((await agentStore.getAgent(agentA.id))?.taskId).toBe(task2.id);

        await store.updateTask(task1.id, { assignedAgentId: agentB.id });

        expect((await agentStore.getAgent(agentA.id))?.taskId).toBe(task2.id);
        expect((await agentStore.getAgent(agentB.id))?.taskId).toBe(task1.id);
      } finally {
        agentStore.close();
        store.close();
      }
    });
  });

  describe("pausedByAgentId persistence", () => {
    it("creates and lists a task with pausedByAgentId", async () => {
      const task = await harness.store().createTask({ description: "Agent paused task" });
      const updated = await harness.store().updateTask(task.id, { pausedByAgentId: "agent-1" });

      expect(updated.pausedByAgentId).toBe("agent-1");

      const detail = await harness.store().getTask(task.id);
      expect(detail.pausedByAgentId).toBe("agent-1");

      const tasks = await harness.store().listTasks();
      const listed = tasks.find((t) => t.id === task.id);
      expect(listed?.pausedByAgentId).toBe("agent-1");
    });

    it("clears pausedByAgentId with null via updateTask", async () => {
      const task = await harness.store().createTask({ description: "Clear agent pause marker" });
      await harness.store().updateTask(task.id, { pausedByAgentId: "agent-2" });

      const cleared = await harness.store().updateTask(task.id, { pausedByAgentId: null });
      expect(cleared.pausedByAgentId).toBeUndefined();

      const detail = await harness.store().getTask(task.id);
      expect(detail.pausedByAgentId).toBeUndefined();
    });

    it("auto-unpauses a task when the pausing agent is unassigned", async () => {
      const task = await harness.store().createTask({ description: "Auto-unpause on unassign", assignedAgentId: "agent-7" });
      await harness.store().pauseTask(task.id, true, undefined, { pausedByAgentId: "agent-7" });

      const beforeUnassign = await harness.store().getTask(task.id);
      expect(beforeUnassign.paused).toBe(true);
      expect(beforeUnassign.pausedByAgentId).toBe("agent-7");

      const updated = await harness.store().updateTask(task.id, { assignedAgentId: null });
      expect(updated.paused).toBeFalsy();
      expect(updated.pausedByAgentId).toBeUndefined();
      expect(updated.assignedAgentId).toBeUndefined();
    });

    it("does not auto-unpause when the pause was set by a different agent", async () => {
      const task = await harness.store().createTask({ description: "Different agent paused", assignedAgentId: "agent-current" });
      await harness.store().pauseTask(task.id, true, undefined, { pausedByAgentId: "agent-other" });

      const updated = await harness.store().updateTask(task.id, { assignedAgentId: null });
      expect(updated.paused).toBe(true);
      expect(updated.pausedByAgentId).toBe("agent-other");
    });
  });

  describe("branch field persistence", () => {
    it("persists baseBranch and branch when provided at create time", async () => {
      const task = await harness.store().createTask({
        description: "Branch fields on create",
        baseBranch: "main",
        branch: "fusion/fn-001-custom",
      });

      expect(task.baseBranch).toBe("main");
      expect(task.branch).toBe("fusion/fn-001-custom");

      const detail = await harness.store().getTask(task.id);
      expect(detail.baseBranch).toBe("main");
      expect(detail.branch).toBe("fusion/fn-001-custom");
    });

    it("preserves branch/baseBranch independently and clears with null without disturbing unrelated fields", async () => {
      const task = await harness.store().createTask({
        description: "Branch field update",
        title: "Keep this title",
        baseBranch: "main",
        branch: "fusion/fn-001-initial",
      });

      const updatedBranchOnly = await harness.store().updateTask(task.id, {
        branch: "fusion/fn-001-updated",
      });
      expect(updatedBranchOnly.branch).toBe("fusion/fn-001-updated");
      expect(updatedBranchOnly.baseBranch).toBe("main");

      const updatedBaseOnly = await harness.store().updateTask(task.id, {
        baseBranch: "release/2026.05",
      });
      expect(updatedBaseOnly.baseBranch).toBe("release/2026.05");
      expect(updatedBaseOnly.branch).toBe("fusion/fn-001-updated");

      const clearedBranch = await harness.store().updateTask(task.id, { branch: null });
      expect(clearedBranch.branch).toBeUndefined();
      expect(clearedBranch.baseBranch).toBe("release/2026.05");
      expect(clearedBranch.title).toBe("Keep this title");

      const clearedBaseBranch = await harness.store().updateTask(task.id, { baseBranch: null });
      expect(clearedBaseBranch.baseBranch).toBeUndefined();
      expect(clearedBaseBranch.branch).toBeUndefined();
      expect(clearedBaseBranch.title).toBe("Keep this title");
    });

    it("persists planning branch context metadata on create", async () => {
      const task = await harness.store().createTask({
        description: "Planning branch context",
        baseBranch: "release/2026.10",
        branch: "planning/session-42",
        branchContext: {
          groupId: "planning-session-42",
          source: "planning",
          assignmentMode: "shared",
          inheritedBaseBranch: "release/2026.10",
        },
      });

      expect(task.branchContext).toEqual({
        groupId: "planning-session-42",
        source: "planning",
        assignmentMode: "shared",
        inheritedBaseBranch: "release/2026.10",
      });

      const detail = await harness.store().getTask(task.id);
      expect(detail.branchContext).toEqual(task.branchContext);
      expect(detail.sourceMetadata).toMatchObject({
        fusionBranchContext: {
          groupId: "planning-session-42",
          source: "planning",
          assignmentMode: "shared",
          inheritedBaseBranch: "release/2026.10",
        },
      });
    });

    it("canonicalizes (trims) a padded groupId when persisting branch context", async () => {
      const task = await harness.store().createTask({
        description: "Padded groupId canonicalization",
        branchContext: {
          groupId: "  BG-123  ",
          source: "planning",
          assignmentMode: "shared",
        },
      });

      // The persisted branch-context metadata must carry the trimmed groupId so
      // it matches exact group-id comparisons later (a padded "  BG-123  " would
      // look valid here but fail equality checks downstream). The reloaded task
      // re-parses from that metadata, so its groupId is canonical too.
      const detail = await harness.store().getTask(task.id);
      expect(detail.branchContext?.groupId).toBe("BG-123");
      expect(detail.sourceMetadata).toMatchObject({
        fusionBranchContext: { groupId: "BG-123" },
      });
    });

    it("round-trips branch fields through listTasks and reload", async () => {
      harness.store().close();
      await harness.reopenDiskBackedStore();

      const created = await harness.store().createTask({
        description: "Branch field reinit persistence",
        baseBranch: "develop",
        branch: "fusion/fn-001-reinit",
      });

      const listed = (await harness.store().listTasks()).find((task) => task.id === created.id);
      expect(listed?.baseBranch).toBe("develop");
      expect(listed?.branch).toBe("fusion/fn-001-reinit");

      harness.store().close();
      await harness.reopenDiskBackedStore();

      const reloaded = await harness.store().getTask(created.id);
      expect(reloaded.baseBranch).toBe("develop");
      expect(reloaded.branch).toBe("fusion/fn-001-reinit");
    });
  });

  describe("autoMerge field persistence", () => {
    it("persists true/false and clears with null via updateTask", async () => {
      const task = await harness.store().createTask({ description: "autoMerge persistence" });

      const enabled = await harness.store().updateTask(task.id, { autoMerge: true });
      expect(enabled.autoMerge).toBe(true);

      const disabled = await harness.store().updateTask(task.id, { autoMerge: false });
      expect(disabled.autoMerge).toBe(false);

      const cleared = await harness.store().updateTask(task.id, { autoMerge: null });
      expect(cleared.autoMerge).toBeUndefined();

      const detail = await harness.store().getTask(task.id);
      expect(detail.autoMerge).toBeUndefined();
    });
  });

  describe("nodeId persistence", () => {
    it("creates a task with nodeId when provided", async () => {
      const task = await harness.store().createTask({
        description: "Node-targeted task",
        nodeId: "node-123",
      });

      expect(task.nodeId).toBe("node-123");

      const detail = await harness.store().getTask(task.id);
      expect(detail.nodeId).toBe("node-123");
    });

    it("updates and clears nodeId via updateTask", async () => {
      const task = await harness.store().createTask({ description: "Task to mutate nodeId" });

      const updated = await harness.store().updateTask(task.id, { nodeId: "node-456" });
      expect(updated.nodeId).toBe("node-456");

      const cleared = await harness.store().updateTask(task.id, { nodeId: null });
      expect(cleared.nodeId).toBeUndefined();
    });

    it("returns nodeId values from listTasks", async () => {
      const assignedNode = await harness.store().createTask({
        description: "Task with node in list",
        nodeId: "node-list",
      });
      await harness.store().createTask({ description: "Task without node in list" });

      const tasks = await harness.store().listTasks();
      const listed = tasks.find((t) => t.id === assignedNode.id);

      expect(listed?.nodeId).toBe("node-list");
    });
  });

  describe("pausedReason persistence", () => {
    it("round-trips pausedReason through updateTask + getTask", async () => {
      const task = await harness.store().createTask({ description: "Pause me" });

      await harness.store().updateTask(task.id, {
        paused: true,
        pausedReason: "workflow-cli-approval:build: npm run build",
      });

      const detail = await harness.store().getTask(task.id);
      expect(detail.paused).toBe(true);
      // Regression: pausedReason was written to the in-memory task and read by
      // the SELECT clause, but omitted from the upsert columns/values and the
      // row→Task mapping — so it never survived a getTask. The workflow CLI
      // approval and await-input pause/resume cycles depend on it persisting.
      expect(detail.pausedReason).toBe("workflow-cli-approval:build: npm run build");
    });

    it("clears pausedReason when set to null", async () => {
      const task = await harness.store().createTask({ description: "Pause then clear" });
      await harness.store().updateTask(task.id, { paused: true, pausedReason: "token_budget_exceeded" });
      expect((await harness.store().getTask(task.id)).pausedReason).toBe("token_budget_exceeded");

      await harness.store().updateTask(task.id, { paused: false, pausedReason: null });
      expect((await harness.store().getTask(task.id)).pausedReason).toBeUndefined();
    });

    it("returns pausedReason from listTasks", async () => {
      const paused = await harness.store().createTask({ description: "Paused in list" });
      await harness.store().updateTask(paused.id, { paused: true, pausedReason: "worktrunk_operation_failed" });

      const tasks = await harness.store().listTasks();
      const listed = tasks.find((t) => t.id === paused.id);
      expect(listed?.pausedReason).toBe("worktrunk_operation_failed");
    });

    it("survives a disk-backed store reload", async () => {
      // The original bug was "pause state vanished on reload" — an in-memory
      // cache could mask a missing persist column, so close and reopen the
      // store from disk before asserting.
      harness.store().close();
      await harness.reopenDiskBackedStore();

      const task = await harness.store().createTask({ description: "Pause across reload" });
      await harness.store().updateTask(task.id, {
        paused: true,
        pausedReason: "workflow-input:ask: What environment should this deploy to?",
      });

      harness.store().close();
      await harness.reopenDiskBackedStore();

      const reloaded = await harness.store().getTask(task.id);
      expect(reloaded.paused).toBe(true);
      expect(reloaded.pausedReason).toBe("workflow-input:ask: What environment should this deploy to?");
    });
  });
});
