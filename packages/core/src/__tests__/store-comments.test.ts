import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";

import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { TaskStore, TaskHasDependentsError } from "../store.js";
import { buildResearchDocumentKey, type Task } from "../types.js";
import { createSharedTaskStoreTestHarness, makeTmpDir } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
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

  describe("task comments", () => {
    it("adds a task comment to a task", async () => {
      const task = await createTestTask();
      const updated = await store.addTaskComment(task.id, "Please review this", "alice");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("Please review this");
      expect(updated.comments![0].author).toBe("alice");
      expect(updated.comments![0].id).toBeDefined();
      expect(updated.comments![0].createdAt).toBeDefined();
      expect(updated.comments![0].updatedAt).toBeDefined();
    });

    it("updates an existing task comment", async () => {
      const task = await createTestTask();
      const added = await store.addTaskComment(task.id, "First draft", "alice");
      const commentId = added.comments![0].id;

      const updated = await store.updateTaskComment(task.id, commentId, "Updated draft");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("Updated draft");
      expect(updated.comments![0].updatedAt).toBeDefined();
      expect(updated.log.some((entry) => entry.action === "Comment updated")).toBe(true);
    });

    it("deletes a task comment", async () => {
      const task = await createTestTask();
      const added = await store.addTaskComment(task.id, "Disposable", "alice");
      const commentId = added.comments![0].id;

      const updated = await store.deleteTaskComment(task.id, commentId);

      expect(updated.comments).toBeUndefined();
      expect(updated.log.some((entry) => entry.action === "Comment deleted")).toBe(true);
    });

    it("throws when updating a missing task comment", async () => {
      const task = await createTestTask();

      await expect(store.updateTaskComment(task.id, "missing", "Nope")).rejects.toThrow(
        `Comment missing not found on task ${task.id}`,
      );
    });

    it("throws when deleting a missing task comment", async () => {
      const task = await createTestTask();

      await expect(store.deleteTaskComment(task.id, "missing")).rejects.toThrow(
        `Comment missing not found on task ${task.id}`,
      );
    });

    it("persists all comments in unified comments field", async () => {
      const task = await createTestTask();
      await store.addTaskComment(task.id, "General note", "alice");
      await store.addComment(task.id, "Execution note");

      const reopened = await store.getTask(task.id);
      // Both comments should be in the unified comments array
      expect(reopened.comments).toHaveLength(2);
      expect(reopened.comments![0].text).toBe("General note");
      expect(reopened.comments![1].text).toBe("Execution note");
    });
  });


  describe("addComment", () => {
    it("adds a steering comment to a task", async () => {
      const task = await createTestTask();
      const updated = await store.addComment(task.id, "Please handle the edge case");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("Please handle the edge case");
      expect(updated.comments![0].author).toBe("user");
      expect(updated.comments![0].id).toBeDefined();
      expect(updated.comments![0].createdAt).toBeDefined();
    });

    it("accepts agent as author", async () => {
      const task = await createTestTask();
      const updated = await store.addComment(task.id, "Note from agent", "agent");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].author).toBe("agent");
    });

    it("initializes comments array if undefined", async () => {
      const task = await createTestTask();
      expect(task.comments).toBeUndefined();

      const updated = await store.addComment(task.id, "First comment");
      expect(updated.comments).toBeDefined();
      expect(updated.comments).toHaveLength(1);
    });

    it("appends multiple comments in order", async () => {
      const task = await createTestTask();
      await store.addComment(task.id, "First comment");
      await store.addComment(task.id, "Second comment");
      await store.addComment(task.id, "Third comment");

      const fetched = await store.getTask(task.id);
      expect(fetched.comments).toHaveLength(3);
      expect(fetched.comments![0].text).toBe("First comment");
      expect(fetched.comments![1].text).toBe("Second comment");
      expect(fetched.comments![2].text).toBe("Third comment");
    });

    it("generates unique IDs for each comment", async () => {
      const task = await createTestTask();
      const updated1 = await store.addComment(task.id, "Comment 1");
      const updated2 = await store.addComment(task.id, "Comment 2");

      const id1 = updated1.comments![0].id;
      const id2 = updated2.comments![1].id;
      expect(id1).not.toBe(id2);
    });

    it("emits task:updated event", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:updated", (t) => events.push(t));

      await store.addComment(task.id, "Test comment");

      expect(events).toHaveLength(1);
      expect(events[0].comments).toHaveLength(1);
      expect(events[0].comments![0].text).toBe("Test comment");
    });

    it("persists to disk and round-trips correctly", async () => {
      const task = await createTestTask();
      await store.addComment(task.id, "Persisted comment");

      const fetched = await store.getTask(task.id);
      expect(fetched.comments).toHaveLength(1);
      expect(fetched.comments![0].text).toBe("Persisted comment");
      expect(fetched.comments![0].author).toBe("user");
    });

    it("adds log entry for the action", async () => {
      const task = await createTestTask();
      const updated = await store.addComment(task.id, "Comment with log");

      expect(updated.log.some((l) => l.action === "Comment added by user")).toBe(true);
    });

    it("updates updatedAt timestamp", async () => {
      const task = await createTestTask();
      const before = task.updatedAt;
      await new Promise((r) => setTimeout(r, 10)); // Ensure time passes

      const updated = await store.addComment(task.id, "Timestamp test");
      expect(updated.updatedAt).not.toBe(before);
    });

    it("creates refinement task when steering comment added to done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Need to fix edge case");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length + 1);

      // FN-7165 titles refinements as `${sourceId}: ${feedback}` (not "Refinement …"),
      // so identify the new task by its feedback-derived title.
      const refinement = allTasksAfter.find((t) => t.id !== task.id && t.title?.includes("Need to fix edge case"));
      expect(refinement).toBeDefined();
      expect(refinement?.column).toBe("triage");
      expect(refinement?.dependencies).toContain(task.id);
    });

    it("does not create refinement when steering comment added to non-done task (triage)", async () => {
      const task = await store.createTask({ description: "Original task" });
      // Task starts in triage

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("does not create refinement when steering comment added to non-done task (in-progress)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("does not create refinement when steering comment added to non-done task (in-review)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Some feedback");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("steering comment is still added to original task even when refinement is created", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const updated = await store.addComment(task.id, "Need to fix edge case");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("Need to fix edge case");
    });

    it("refinement task has correct dependency on original done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.addComment(task.id, "Need to fix edge case");

      const allTasks = await store.listTasks();
      const refinement = allTasks.find((t) => t.id !== task.id && t.dependencies?.includes(task.id));

      expect(refinement).toBeDefined();
      expect(refinement?.dependencies).toEqual([task.id]);
    });

    it("does not create refinement for agent-authored comments", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Agent feedback", "agent");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("does not fail when steering comment is empty or whitespace on done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Should not throw - refineTask will reject empty feedback but we catch it
      const updated = await store.addComment(task.id, "   ");

      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("   ");
    });

    it("logs warning and still persists comment when best-effort auto-refinement fails", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const runContext = { runId: "run-refinement-failure", agentId: "agent-refinement" };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const refineSpy = vi.spyOn(store, "refineTask").mockRejectedValue(new Error("refine unavailable"));

      try {
        const taskCountBefore = (await store.listTasks()).length;
        const updated = await store.addComment(task.id, "Need refinement", "user", undefined, runContext);

        expect(updated.comments).toHaveLength(1);
        expect(updated.comments![0].text).toBe("Need refinement");

        const taskCountAfter = (await store.listTasks()).length;
        expect(taskCountAfter).toBe(taskCountBefore);

        const persisted = await store.getTask(task.id);
        expect(persisted.comments).toHaveLength(1);
        expect(persisted.comments![0].text).toBe("Need refinement");

        expect(refineSpy).toHaveBeenCalledWith(task.id, "Need refinement");

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Best-effort post-comment auto-refinement failed"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          taskId: task.id,
          author: "user",
          commentLength: "Need refinement".length,
          column: "done",
          priorStatus: null,
          phase: "addComment:auto-refinement",
          runId: "run-refinement-failure",
          agentId: "agent-refinement",
          error: "refine unavailable",
        });
      } finally {
        refineSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("logs warning and still persists comment when status update fails during awaiting-approval invalidation", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const runContext = { runId: "run-invalidation-failure", agentId: "agent-invalidation" };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const updateSpy = vi.spyOn(store, "updateTask").mockRejectedValueOnce(new Error("status update failed"));

      try {
        const updated = await store.addComment(task.id, "New user feedback", "user", undefined, runContext);

        expect(updated.comments).toHaveLength(1);
        expect(updated.comments![0].text).toBe("New user feedback");

        const persisted = await store.getTask(task.id);
        expect(persisted.comments).toHaveLength(1);
        expect(persisted.comments![0].text).toBe("New user feedback");
        expect(persisted.status).toBe("awaiting-approval");

        expect(updateSpy).toHaveBeenCalled();

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Best-effort post-comment re-triage failed"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          taskId: task.id,
          author: "user",
          commentLength: "New user feedback".length,
          column: "triage",
          priorStatus: "awaiting-approval",
          phase: "addComment:awaiting-approval-invalidation",
          stage: "status-update",
          nextStatus: "needs-replan",
          runId: "run-invalidation-failure",
          agentId: "agent-invalidation",
          error: "status update failed",
        });
      } finally {
        updateSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("logs warning and keeps invalidated status when log entry fails after awaiting-approval invalidation", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const runContext = { runId: "run-post-invalidation-log-failure", agentId: "agent-invalidation" };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logEntrySpy = vi.spyOn(store, "logEntry").mockRejectedValueOnce(new Error("log entry failed"));

      try {
        const updated = await store.addComment(task.id, "New user feedback", "user", undefined, runContext);

        expect(updated.comments).toHaveLength(1);
        expect(updated.comments![0].text).toBe("New user feedback");

        const persisted = await store.getTask(task.id);
        expect(persisted.comments).toHaveLength(1);
        expect(persisted.comments![0].text).toBe("New user feedback");
        expect(persisted.status).toBe("needs-replan");

        expect(logEntrySpy).toHaveBeenCalled();

        const warningCall = warnSpy.mock.calls.find(
          (call) => typeof call[0] === "string" && call[0].includes("[task-store] Best-effort post-comment re-triage failed"),
        );
        expect(warningCall).toBeDefined();

        const [, context] = warningCall as [string, Record<string, unknown>];
        expect(context).toMatchObject({
          taskId: task.id,
          author: "user",
          commentLength: "New user feedback".length,
          column: "triage",
          priorStatus: "awaiting-approval",
          phase: "addComment:awaiting-approval-invalidation",
          stage: "post-invalidation-log-entry",
          nextStatus: "needs-replan",
          runId: "run-post-invalidation-log-failure",
          agentId: "agent-invalidation",
          error: "log entry failed",
        });
      } finally {
        logEntrySpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("addSteeringComment on done task does NOT create a refinement task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addSteeringComment(task.id, "Please handle the edge case");

      const allTasksAfter = await store.listTasks();
      // No refinement task should be created
      expect(allTasksAfter).toHaveLength(allTasksBefore.length);
    });

    it("addSteeringComment writes to both comments and steeringComments", async () => {
      const task = await createTestTask();

      const updated = await store.addSteeringComment(task.id, "Focus on error handling");

      // Should appear in unified comments (for UI display)
      expect(updated.comments).toBeDefined();
      expect(updated.comments!.some(c => c.text === "Focus on error handling")).toBe(true);

      // Should appear in steeringComments (for executor injection)
      expect(updated.steeringComments).toBeDefined();
      expect(updated.steeringComments!.some(c => c.text === "Focus on error handling")).toBe(true);
    });

    it("addSteeringComment steeringComments persist through round-trip", async () => {
      const task = await createTestTask();

      await store.addSteeringComment(task.id, "Focus on error handling");

      const fetched = await store.getTask(task.id);
      expect(fetched.steeringComments).toBeDefined();
      expect(fetched.steeringComments!).toHaveLength(1);
      expect(fetched.steeringComments![0].text).toBe("Focus on error handling");
    });

    it("steering comments do not duplicate in comments across read-write cycles", async () => {
      const task = await createTestTask();

      // Add a steering comment (writes to both comments and steeringComments columns)
      await store.addSteeringComment(task.id, "Focus on error handling");

      // Read the task back — comments should have exactly 1 entry
      const read1 = await store.getTask(task.id);
      expect(read1.comments).toHaveLength(1);
      expect(read1.steeringComments).toHaveLength(1);

      // Simulate a write-back (updateTask writes via upsertTask)
      await store.updateTask(task.id, { status: "planning" });

      // Read again — should still have exactly 1 comment, not 2
      const read2 = await store.getTask(task.id);
      expect(read2.comments).toHaveLength(1);
      expect(read2.comments![0].text).toBe("Focus on error handling");
    });

    it("no duplication accumulation over multiple read-write cycles with steering comments", async () => {
      const task = await createTestTask();

      await store.addSteeringComment(task.id, "Comment A");
      await store.addSteeringComment(task.id, "Comment B");

      // Perform 5 read-write cycles
      for (let i = 0; i < 5; i++) {
        const fetched = await store.getTask(task.id);
        expect(fetched.comments).toHaveLength(2);
        expect(fetched.steeringComments).toHaveLength(2);
        // Write back via an innocuous update
        await store.updateTask(task.id, { status: "planning" });
      }

      // Final read — still exactly 2 comments
      const final = await store.getTask(task.id);
      expect(final.comments).toHaveLength(2);
      expect(final.comments!.map(c => c.text).sort()).toEqual(["Comment A", "Comment B"]);
    });

    it("mixed regular and steering comments maintain correct counts through cycles", async () => {
      const task = await createTestTask();

      // Add 1 regular comment and 1 steering comment
      await store.addTaskComment(task.id, "Regular note", "alice");
      await store.addSteeringComment(task.id, "Steering note");

      // Should have 2 comments total, 1 steering comment
      const read1 = await store.getTask(task.id);
      expect(read1.comments).toHaveLength(2);
      expect(read1.steeringComments).toHaveLength(1);

      // Perform 3 read-write cycles
      for (let i = 0; i < 3; i++) {
        const fetched = await store.getTask(task.id);
        expect(fetched.comments).toHaveLength(2);
        await store.updateTask(task.id, { status: "planning" });
      }

      const final = await store.getTask(task.id);
      expect(final.comments).toHaveLength(2);
      expect(final.steeringComments).toHaveLength(1);
    });

    it("regular addComment on done task still creates refinement", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const allTasksBefore = await store.listTasks();

      await store.addComment(task.id, "Need to fix edge case");

      const allTasksAfter = await store.listTasks();
      expect(allTasksAfter).toHaveLength(allTasksBefore.length + 1);

      // FN-7165 titles refinements as `${sourceId}: ${feedback}` (not "Refinement …"),
      // so identify the new task by its feedback-derived title.
      const refinement = allTasksAfter.find((t) => t.id !== task.id && t.title?.includes("Need to fix edge case"));
      expect(refinement).toBeDefined();
    });

    it("transitions awaiting-approval to needs-replan when user comments on triage task", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      // Keep in triage but set awaiting-approval status
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const result = await store.addComment(task.id, "I want to change the approach", "user");

      // Re-read the task to get the Phase 3 status update
      const updated = await store.getTask(task.id);

      // Task should remain in triage but status should change to needs-replan
      expect(updated.column).toBe("triage");
      expect(updated.status).toBe("needs-replan");
      // Comment should still be added
      expect(updated.comments).toHaveLength(1);
      expect(updated.comments![0].text).toBe("I want to change the approach");
    });

    it("does NOT transition to needs-replan when agent comments on awaiting-approval task", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      await store.updateTask(task.id, { status: "awaiting-approval" });

      const updated = await store.addComment(task.id, "Agent system note", "agent");

      // Status should remain awaiting-approval for agent comments
      expect(updated.status).toBe("awaiting-approval");
      // Comment should still be added
      expect(updated.comments).toHaveLength(1);
    });

    it("transitions to needs-replan when user comments on non-awaiting-approval triage task with real spec", async () => {
      const task = await store.createTask({ description: "Task in triage" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# Task: ${task.id} - Triage Plan\n\n## Mission\n\nPlanned task.`);

      await store.addComment(task.id, "User feedback", "user");
      const updated = await store.getTask(task.id);

      expect(updated.status).toBe("needs-replan");
      expect(updated.column).toBe("triage");
      expect(updated.comments?.[0]?.text).toBe("User feedback");
    });

    it("does NOT transition to needs-replan when user comments on triage task with bootstrap stub prompt", async () => {
      const task = await store.createTask({ description: "Task in triage" });

      await store.addComment(task.id, "User feedback", "user");
      const updated = await store.getTask(task.id);

      expect(updated.status).toBeUndefined();
    });

    it("transitions todo task to needs-replan when user comments and task has real spec", async () => {
      const task = await store.createTask({ description: "Task in todo", column: "todo" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# Task: ${task.id} - Todo Plan\n\n## Mission\n\nPlanned task.`);

      await store.addComment(task.id, "Please update approach", "user");
      const updated = await store.getTask(task.id);

      expect(updated.status).toBe("needs-replan");
      expect(updated.column).toBe("todo");
      expect(updated.log.some((entry) => entry.action === "User comment requested re-specification of planned task")).toBe(true);
    });

    it("does NOT transition todo task to needs-replan when prompt matches bootstrap stub", async () => {
      const task = await store.createTask({ description: "Task in todo", column: "todo" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# ${task.id}\n\nTask in todo\n`);

      await store.addComment(task.id, "Please update approach", "user");
      const updated = await store.getTask(task.id);

      expect(updated.status).toBeUndefined();
    });

    it("does NOT transition to needs-replan when user comments on in-progress task", async () => {
      const task = await store.createTask({ description: "Task in progress", column: "todo" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# Task: ${task.id} - Plan\n\n## Mission\n\nPlanned task.`);
      await store.moveTask(task.id, "in-progress");

      await store.addComment(task.id, "Please adjust implementation", "user");
      const updated = await store.getTask(task.id);

      expect(updated.column).toBe("in-progress");
      expect(updated.status).toBeUndefined();
    });

    it("does NOT transition to needs-replan when user comments on in-review task", async () => {
      const task = await store.createTask({ description: "Task in review", column: "todo" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, `# Task: ${task.id} - Plan\n\n## Mission\n\nPlanned task.`);
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      await store.addComment(task.id, "Please adjust before merge", "user");
      const updated = await store.getTask(task.id);

      expect(updated.column).toBe("in-review");
      expect(updated.status).toBeUndefined();
    });
  });


  describe("task comments and merge details types", () => {
    it("has undefined comments on new tasks", async () => {
      const task = await createTestTask();
      const reopened = await store.getTask(task.id);

      expect(reopened.comments).toBeUndefined();
    });

    it("supports the task comment and merge details shapes", async () => {
      const comment: NonNullable<Task["comments"]>[number] = {
        id: `comment-${Date.now()}`,
        text: "Looks good",
        author: "alice",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const mergeDetails: NonNullable<Task["mergeDetails"]> = {
        commitSha: "abc123def456",
        filesChanged: 3,
        insertions: 10,
        deletions: 2,
        mergeCommitMessage: "feat(KB-001): merge fusion/fn-001",
        mergedAt: new Date().toISOString(),
        mergeConfirmed: true,
        prNumber: 42,
      };
      const taskShape: Pick<Task, "comments" | "mergeDetails"> = {
        comments: [comment],
        mergeDetails,
      };

      expect(taskShape.comments).toEqual([comment]);
      expect(taskShape.mergeDetails).toEqual(mergeDetails);
    });
  });


  describe("updatePrInfo", () => {
    it("adds PR info to a task without existing PR", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };

      const updated = await store.updatePrInfo(task.id, prInfo);

      expect(updated.prInfo).toEqual(prInfo);
      expect(updated.log.some((l) => l.action === "PR linked" && l.outcome?.includes("#42"))).toBe(true);
    });

    it("keeps PR number/url after moving task to done", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };

      await store.updatePrInfo(task.id, prInfo);
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const updated = await store.getTask(task.id);
      expect(updated.prInfo?.number).toBe(42);
      expect(updated.prInfo?.url).toBe("https://github.com/owner/repo/pull/42");
    });

    it("updates existing PR info with new values", async () => {
      const task = await createTestTask();
      const prInfo1 = {
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        status: "open" as const,
        title: "Initial PR",
        headBranch: "branch-1",
        baseBranch: "main",
        commentCount: 0,
      };
      await store.updatePrInfo(task.id, prInfo1);

      const prInfo2 = {
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        status: "merged" as const,
        title: "Initial PR (updated)",
        headBranch: "branch-1",
        baseBranch: "main",
        commentCount: 3,
        lastCommentAt: "2026-01-01T00:00:00.000Z",
      };
      const updated = await store.updatePrInfo(task.id, prInfo2);

      expect(updated.prInfo?.status).toBe("merged");
      expect(updated.prInfo?.commentCount).toBe(3);
      expect(updated.prInfo?.lastCommentAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("clears PR info when passed null", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };
      await store.updatePrInfo(task.id, prInfo);

      const updated = await store.updatePrInfo(task.id, null);

      expect(updated.prInfo).toBeUndefined();
      expect(updated.log.some((l) => l.action === "PR unlinked")).toBe(true);
    });

    it("emits task:updated event when PR info changes", async () => {
      const task = await createTestTask();
      const events: any[] = [];
      store.on("task:updated", (t) => events.push(t));

      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };
      await store.updatePrInfo(task.id, prInfo);

      expect(events).toHaveLength(1);
      expect(events[0].prInfo?.number).toBe(42);
    });

    it("does NOT emit task:updated when PR info is unchanged", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };
      await store.updatePrInfo(task.id, prInfo);

      const events: any[] = [];
      store.on("task:updated", (t) => events.push(t));

      // Update with same values (status and number unchanged)
      await store.updatePrInfo(task.id, { ...prInfo });

      // Should not emit because number and status are the same
      expect(events).toHaveLength(0);
    });

    it("persists to disk and round-trips correctly", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 5,
        lastCommentAt: "2026-03-30T12:00:00.000Z",
      };

      await store.updatePrInfo(task.id, prInfo);
      const fetched = await store.getTask(task.id);

      expect(fetched.prInfo).toEqual(prInfo);
    });

    it("round-trips PR conflict diagnostics and keeps the field optional", async () => {
      const task = await createTestTask();
      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 5,
        mergeable: "conflicting" as const,
        conflictDiagnostics: {
          conflictingFiles: ["packages/dashboard/src/github.ts"],
          suggestedCommands: ["git fetch origin", "git rebase origin/main"],
          capturedAt: "2026-05-18T00:00:00.000Z",
        },
      };

      await store.updatePrInfo(task.id, prInfo);
      const fetched = await store.getTask(task.id);
      expect(fetched.prInfo).toEqual(prInfo);

      const taskJsonPath = join(rootDir, ".fusion", "tasks", task.id, "task.json");
      const raw = await readFile(taskJsonPath, "utf-8");
      const serialized = JSON.parse(raw) as Task;
      expect(serialized.prInfo?.conflictDiagnostics?.conflictingFiles).toEqual(["packages/dashboard/src/github.ts"]);

      const prInfoWithoutDiagnostics = {
        ...prInfo,
        mergeable: "clean" as const,
        conflictDiagnostics: undefined,
      };
      await store.updatePrInfo(task.id, prInfoWithoutDiagnostics);

      const fetchedWithoutDiagnostics = await store.getTask(task.id);
      expect(fetchedWithoutDiagnostics.prInfo?.conflictDiagnostics).toBeUndefined();
    });

    it("updates updatedAt timestamp", async () => {
      const task = await createTestTask();
      const before = task.updatedAt;
      await new Promise((r) => setTimeout(r, 10)); // Ensure time passes

      const prInfo = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "open" as const,
        title: "Fix the bug",
        headBranch: "kb-001-fix-bug",
        baseBranch: "main",
        commentCount: 0,
      };
      const updated = await store.updatePrInfo(task.id, prInfo);

      expect(updated.updatedAt).not.toBe(before);
    });

    it("serializes concurrent updates correctly", async () => {
      const task = await createTestTask();

      // Fire 5 concurrent updates
      const promises = Array.from({ length: 5 }, (_, i) =>
        store.updatePrInfo(task.id, {
          url: `https://github.com/owner/repo/pull/${i + 1}`,
          number: i + 1,
          status: "open" as const,
          title: `PR ${i + 1}`,
          headBranch: `branch-${i + 1}`,
          baseBranch: "main",
          commentCount: i,
        }),
      );

      await Promise.all(promises);

      // Read back and verify valid JSON
      const taskJsonPath = join(rootDir, ".fusion", "tasks", task.id, "task.json");
      const raw = await readFile(taskJsonPath, "utf-8");
      const result = JSON.parse(raw) as Task;

      // Should have exactly one of the PRs set (last one wins)
      expect(result.prInfo).toBeDefined();
      expect(result.prInfo!.number).toBeGreaterThanOrEqual(1);
      expect(result.prInfo!.number).toBeLessThanOrEqual(5);

      // Should have all the PR linked log entries
      const prLogs = result.log.filter((l) => l.action === "PR linked");
      expect(prLogs).toHaveLength(5);
    });
  });


});
