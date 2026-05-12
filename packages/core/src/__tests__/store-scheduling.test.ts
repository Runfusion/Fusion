import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { TaskStore, TaskHasDependentsError } from "../store.js";
import { buildResearchDocumentKey, type Task } from "../types.js";
import { createTaskStoreTestHarness, makeTmpDir } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createTaskStoreTestHarness();
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    rootDir = harness.rootDir();
    globalDir = harness.globalDir();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  const createTestTask = () => harness.createTestTask();
  const createTaskWithSteps = () => harness.createTaskWithSteps();
  const deleteTaskDir = (taskId: string) => harness.deleteTaskDir(taskId);
  const createSourceIssueFixture = () => harness.createSourceIssueFixture();
  const insertLogEntryWithTimestamp = (...args: any[]) => (harness as any).insertLogEntryWithTimestamp(...args);

  describe("nodeId in-progress blocking", () => {
    it("throws when updating nodeId on an in-progress task", async () => {
      const task = await store.createTask({ description: "In progress task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.updateTask(task.id, { nodeId: "node-abc" }))
        .rejects.toThrow(/in progress/i);
    });

    it("allows updating nodeId on a todo task", async () => {
      const task = await store.createTask({ description: "Todo task" });

      const updated = await store.updateTask(task.id, { nodeId: "node-todo" });
      expect(updated.nodeId).toBe("node-todo");
    });

    it("allows updating nodeId on an in-review task", async () => {
      const task = await store.createTask({ description: "Review task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const updated = await store.updateTask(task.id, { nodeId: "node-review" });
      expect(updated.nodeId).toBe("node-review");
    });

    it("allows other updates on in-progress tasks (non-nodeId)", async () => {
      const task = await store.createTask({ description: "In progress title update" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const updated = await store.updateTask(task.id, { title: "Updated title" });
      expect(updated.title).toBe("Updated title");
    });

    it("allows clearing nodeId on a done task", async () => {
      const task = await store.createTask({ description: "Done task", nodeId: "node-done" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const updated = await store.updateTask(task.id, { nodeId: null });
      expect(updated.nodeId).toBeUndefined();
    });

    it("does not throw when nodeId update is undefined on an in-progress task", async () => {
      const task = await store.createTask({ description: "In progress no-op", nodeId: "node-stable" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const updated = await store.updateTask(task.id, { nodeId: undefined });
      expect(updated.nodeId).toBe("node-stable");
    });

    it("includes task ID in nodeId override blocking error", async () => {
      const task = await store.createTask({ description: "In progress blocked id" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.updateTask(task.id, { nodeId: "node-abc" })).rejects.toThrow(task.id);
    });

    it("allows priority updates on in-progress tasks without changing existing nodeId", async () => {
      const task = await store.createTask({ description: "In progress priority", nodeId: "node-keep" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const updated = await store.updateTask(task.id, { priority: "high" });
      expect(updated.priority).toBe("high");
      expect(updated.nodeId).toBe("node-keep");
    });
  });


  describe("getTasksByAssignedAgent", () => {
    it("returns only tasks assigned to the requested agent", async () => {
      const mine = await store.createTask({ description: "mine", assignedAgentId: "agent-1" });
      await store.createTask({ description: "other", assignedAgentId: "agent-2" });
      await store.createTask({ description: "unassigned" });

      const tasks = await store.getTasksByAssignedAgent("agent-1");
      expect(tasks.map((task) => task.id)).toEqual([mine.id]);
    });

    it("supports pausedOnly filter", async () => {
      const paused = await store.createTask({ description: "paused", assignedAgentId: "agent-1" });
      const active = await store.createTask({ description: "active", assignedAgentId: "agent-1" });
      await store.updateTask(paused.id, { paused: true });

      const tasks = await store.getTasksByAssignedAgent("agent-1", { pausedOnly: true });
      expect(tasks.map((task) => task.id)).toEqual([paused.id]);
      expect(tasks.some((task) => task.id === active.id)).toBe(false);
    });

    it("supports excludeArchived filter", async () => {
      const active = await store.createTask({ description: "active", assignedAgentId: "agent-1" });
      const archived = await store.createTask({ description: "archived", assignedAgentId: "agent-1", column: "done" });
      await store.archiveTask(archived.id, false);

      const tasks = await store.getTasksByAssignedAgent("agent-1", { excludeArchived: true });
      expect(tasks.map((task) => task.id)).toEqual([active.id]);
    });
  });


  describe("selectNextTaskForAgent", () => {
    it("returns null when no tasks exist", async () => {
      await expect(store.selectNextTaskForAgent("agent-1")).resolves.toBeNull();
    });

    it("returns in-progress task assigned to the agent", async () => {
      const inProgress = await store.createTask({
        description: "In-progress task",
        column: "in-progress",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(inProgress.id);
      expect(selected?.priority).toBe("in_progress");
    });

    it("prefers in-progress over todo when both exist for the agent", async () => {
      await store.createTask({
        description: "Ready todo task",
        column: "todo",
        assignedAgentId: "agent-1",
      });
      const inProgress = await store.createTask({
        description: "In-progress task",
        column: "in-progress",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(inProgress.id);
      expect(selected?.priority).toBe("in_progress");
    });

    it("returns todo task with all dependencies done", async () => {
      const dep = await store.createTask({ description: "Done dep", column: "done" });
      const readyTodo = await store.createTask({
        description: "Ready todo",
        column: "todo",
        assignedAgentId: "agent-1",
        dependencies: [dep.id],
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(readyTodo.id);
      expect(selected?.priority).toBe("todo");
    });

    it("skips todo task with unresolved dependencies that are not actionable", async () => {
      const dep = await store.createTask({ description: "Unresolved dep", column: "todo" });
      await store.createTask({
        description: "Blocked todo",
        column: "todo",
        assignedAgentId: "agent-1",
        dependencies: [dep.id],
      });

      await expect(store.selectNextTaskForAgent("agent-1")).resolves.toBeNull();
    });

    it("returns blocked task with partially done dependencies when no higher-priority tasks exist", async () => {
      const doneDep = await store.createTask({ description: "Done dep", column: "done" });
      const blockedDep = await store.createTask({ description: "Blocked dep", column: "todo" });
      const partiallyActionable = await store.createTask({
        description: "Partially actionable todo",
        column: "todo",
        assignedAgentId: "agent-1",
        dependencies: [doneDep.id, blockedDep.id],
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(partiallyActionable.id);
      expect(selected?.priority).toBe("blocked");
    });

    it("skips paused tasks", async () => {
      const pausedTodo = await store.createTask({
        description: "Paused todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });
      await store.updateTask(pausedTodo.id, { paused: true });

      await expect(store.selectNextTaskForAgent("agent-1")).resolves.toBeNull();
    });

    it("skips tasks assigned to a different agent", async () => {
      await store.createTask({
        description: "Other agent task",
        column: "todo",
        assignedAgentId: "agent-2",
      });

      await expect(store.selectNextTaskForAgent("agent-1")).resolves.toBeNull();
    });

    it("resolves FIFO ordering within the same priority tier", async () => {
      const older = await store.createTask({
        description: "Older ready todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.createTask({
        description: "Newer ready todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1");

      expect(selected?.task.id).toBe(older.id);
      expect(selected?.priority).toBe("todo");
    });

    it("returns null when no tasks are assigned to the queried agent", async () => {
      await store.createTask({
        description: "Unassigned todo",
        column: "todo",
      });

      await expect(store.selectNextTaskForAgent("agent-without-tasks")).resolves.toBeNull();
    });

    it("skips implementation todos for non-executor role agents", async () => {
      await store.createTask({
        description: "Assigned todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });

      await expect(
        store.selectNextTaskForAgent("agent-1", { id: "agent-1", role: "reviewer" }),
      ).resolves.toBeNull();
    });

    it("returns implementation todos for executor role agents", async () => {
      const todo = await store.createTask({
        description: "Assigned todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1", {
        id: "agent-1",
        role: "executor",
      });

      expect(selected?.task.id).toBe(todo.id);
      expect(selected?.priority).toBe("todo");
    });

    it("returns assigned implementation todos for engineer role agents", async () => {
      const todo = await store.createTask({
        description: "Assigned engineer todo",
        column: "todo",
        assignedAgentId: "agent-1",
      });

      const selected = await store.selectNextTaskForAgent("agent-1", {
        id: "agent-1",
        role: "engineer",
      });

      expect(selected?.task.id).toBe(todo.id);
      expect(selected?.priority).toBe("todo");
    });

    it("does not auto-claim unassigned implementation backlog for engineer role agents", async () => {
      await store.createTask({
        description: "Unassigned todo",
        column: "todo",
      });

      await expect(
        store.selectNextTaskForAgent("agent-1", { id: "agent-1", role: "engineer" }),
      ).resolves.toBeNull();
    });

    it("allows non-executor role agents to pick assigned todos when override metadata is set", async () => {
      const delegated = await store.createTask({
        description: "Assigned todo override",
        column: "todo",
        assignedAgentId: "agent-1",
        source: { sourceType: "api", sourceMetadata: { executorRoleOverride: true } },
      });

      const selected = await store.selectNextTaskForAgent("agent-1", {
        id: "agent-1",
        role: "reviewer",
      });

      expect(selected?.task.id).toBe(delegated.id);
      expect(selected?.priority).toBe("todo");
    });
  });

  // ── Lock serialization test ──────────────────────────────────────


});
