import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createTaskStoreTestHarness, makeTmpDir, mockedExecSync, mockedRunCommandAsync } from "./store-test-helpers.js";
import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { TaskStore, TaskHasDependentsError } from "../store.js";
import type { runCommandAsync } from "../run-command.js";
import { buildResearchDocumentKey, type Task } from "../types.js";
import { setTaskCreatedHook } from "../task-creation-hooks.js";

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

  describe("createTask task-created hook options", () => {
    afterEach(() => {
      setTaskCreatedHook(undefined);
    });

    it("skips task-created hook when invokeTaskCreatedHook is false", async () => {
      const hookSpy = vi.fn();
      setTaskCreatedHook(hookSpy);

      await store.createTask(
        { description: "Task without post-create hook" },
        { invokeTaskCreatedHook: false },
      );

      expect(hookSpy).not.toHaveBeenCalled();
    });

    it("invokes task-created hook by default", async () => {
      const hookSpy = vi.fn();
      setTaskCreatedHook(hookSpy);

      const created = await store.createTask({ description: "Task with default post-create hook" });

      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: created.id }),
        expect.any(TaskStore),
      );
    });
  });

  describe("duplicateTask", () => {
    it("duplicates from triage column", async () => {
      const task = await store.createTask({ description: "Test task" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.id).not.toBe(task.id);
      expect(duplicated.id).toMatch(/^FN-\d+$/);
      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(task.description);
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("duplicates from todo column", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("duplicates from in-progress column", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      await store.moveTask(task.id, "in-progress");
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("duplicates from in-review column", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("duplicates from done column", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.column).toBe("triage");
      expect(duplicated.description).toContain(`(Duplicated from ${task.id})`);
    });

    it("new task is always in triage regardless of source column", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const duplicated = await store.duplicateTask(task.id);
      expect(duplicated.column).toBe("triage");
    });

    it("description includes source reference", async () => {
      const task = await store.createTask({ description: "Original description" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.description).toBe(`Original description\n\n(Duplicated from ${task.id})`);
    });

    it("resets execution state (no steps, no worktree, etc.)", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      // Add some execution state
      await store.updateTask(task.id, { worktree: "/some/path", status: "executing" });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.steps).toEqual([]);
      expect(duplicated.currentStep).toBe(0);
      expect(duplicated.worktree).toBeUndefined();
      expect(duplicated.status).toBeUndefined();
    });

    it("clears nullable execution fields via updateTask(null)", async () => {
      const task = await store.createTask({ description: "Test clear nullable execution fields", column: "todo" });
      await store.updateTask(task.id, {
        worktree: "/some/path",
        branch: "fusion/fn-001",
        baseBranch: "main",
        baseCommitSha: "abc123",
        status: "executing",
        error: "boom",
      });

      const updated = await store.updateTask(task.id, {
        worktree: null,
        branch: null,
        baseBranch: null,
        baseCommitSha: null,
        status: null,
        error: null,
      });

      expect(updated.worktree).toBeUndefined();
      expect(updated.branch).toBeUndefined();
      expect(updated.baseBranch).toBeUndefined();
      expect(updated.baseCommitSha).toBeUndefined();
      expect(updated.status).toBeUndefined();
      expect(updated.error).toBeUndefined();
    });

    it("does NOT copy dependencies", async () => {
      const dep = await store.createTask({ description: "Dependency" });
      const task = await store.createTask({ description: "Test task", dependencies: [dep.id] });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.dependencies).toEqual([]);
    });

    it("does NOT copy attachments", async () => {
      const task = await store.createTask({ description: "Test task" });
      // Add an attachment
      await store.addAttachment(task.id, "test.png", Buffer.from("fake"), "image/png");

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.attachments).toBeUndefined();
    });

    it("does NOT copy steering comments", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.addComment(task.id, "Test comment");

      const duplicated = await store.duplicateTask(task.id);

      // Comments should not be copied when duplicating
      expect(duplicated.comments).toBeUndefined();
    });

    it("emits task:created event", async () => {
      const task = await store.createTask({ description: "Test task" });
      const events: any[] = [];
      store.on("task:created", (t) => events.push(t));

      const duplicated = await store.duplicateTask(task.id);

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(duplicated.id);
    });

    it("adds log entry for duplicate action", async () => {
      const task = await store.createTask({ description: "Test task" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.log).toHaveLength(1);
      expect(duplicated.log[0].action).toContain(`Duplicated from ${task.id}`);
    });

    it("copies source PROMPT.md content", async () => {
      const task = await store.createTask({ description: "Test task" });
      const sourceDetail = await store.getTask(task.id);

      const duplicated = await store.duplicateTask(task.id);
      const dupDetail = await store.getTask(duplicated.id);

      expect(dupDetail.prompt).toBe(sourceDetail.prompt);
    });

    it("throws ENOENT when source task does not exist", async () => {
      await expect(store.duplicateTask("KB-999")).rejects.toThrow();
    });

    it("copies title if present", async () => {
      const task = await store.createTask({ title: "My Task", description: "Test" });
      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.title).toBe("My Task");
    });

    it("does NOT copy prInfo", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.updatePrInfo(task.id, {
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        status: "open",
        title: "Test PR",
        headBranch: "fusion/fn-001",
        baseBranch: "main",
        commentCount: 0,
      });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.prInfo).toBeUndefined();
    });

    it("does NOT copy paused state", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.pauseTask(task.id, true);

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.paused).toBeUndefined();
    });

    it("does NOT copy blockedBy", async () => {
      const blocker = await store.createTask({ description: "Blocker" });
      const task = await store.createTask({ description: "Test task" });
      await store.updateTask(task.id, { blockedBy: blocker.id });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.blockedBy).toBeUndefined();
    });

    it("copies baseBranch", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.updateTask(task.id, { baseBranch: "some-branch" });

      const duplicated = await store.duplicateTask(task.id);

      expect(duplicated.baseBranch).toBe("some-branch");
    });
  });

  // ── Refine Task Tests ────────────────────────────────────────────


  describe("refineTask", () => {
    it("creates refinement from done task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need to fix edge case");

      expect(refined.id).not.toBe(task.id);
      expect(refined.id).toMatch(/^FN-\d+$/);
      expect(refined.column).toBe("triage");
      // Untitled source: uses first line of description as readable label
      expect(refined.title).toBe("Refinement: Original task");
    });

    it("creates refinement from in-review task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.column).toBe("triage");
      // Untitled source: uses first line of description as readable label
      expect(refined.title).toBe("Refinement: Original task");
    });

    it("throws error when refining task in triage", async () => {
      const task = await store.createTask({ description: "Original task" });
      // Task starts in triage

      await expect(store.refineTask(task.id, "Feedback")).rejects.toThrow("must be in 'done' or 'in-review'");
    });

    it("throws error when refining task in todo", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");

      await expect(store.refineTask(task.id, "Feedback")).rejects.toThrow("must be in 'done' or 'in-review'");
    });

    it("throws error when refining task in in-progress", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.refineTask(task.id, "Feedback")).rejects.toThrow("must be in 'done' or 'in-review'");
    });

    it("throws error when feedback is empty", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await expect(store.refineTask(task.id, "")).rejects.toThrow("Feedback is required");
    });

    it("throws error when feedback is whitespace only", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await expect(store.refineTask(task.id, "   ")).rejects.toThrow("Feedback is required");
    });

    it("sets correct title format with original title", async () => {
      const task = await store.createTask({ title: "My Feature", description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Add more tests");

      expect(refined.title).toBe("Refinement: My Feature");
    });

    it("sets correct title format without original title (uses description fallback)", async () => {
      const task = await store.createTask({ description: "Fix the login bug" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Add more tests");

      // Falls back to first line of description when no title
      expect(refined.title).toBe("Refinement: Fix the login bug");
    });

    it("description includes feedback and refines reference", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Fix the edge case handling");

      expect(refined.description).toBe(`Fix the edge case handling\n\nRefines: ${task.id}`);
    });

    it("sets dependency on original task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.dependencies).toEqual([task.id]);
    });

    it("adds log entry for refinement creation", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.log).toHaveLength(1);
      expect(refined.log[0].action).toBe(`Created as refinement of ${task.id}`);
    });

    it("emits task:created event", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const events: any[] = [];
      store.on("task:created", (t) => events.push(t));

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(refined.id);
    });

    it("copies attachments from original task", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Add an attachment
      await store.addAttachment(task.id, "test.png", Buffer.from("fake image"), "image/png");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.attachments).toHaveLength(1);
      expect(refined.attachments![0].originalName).toBe("test.png");
      expect(refined.attachments![0].mimeType).toBe("image/png");
    });

    it("copies attachment files to new task directory", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Add an attachment
      await store.addAttachment(task.id, "test.png", Buffer.from("fake image data"), "image/png");

      const refined = await store.refineTask(task.id, "Need improvements");

      // Verify file exists in new task directory
      const attachDir = join(rootDir, ".fusion", "tasks", refined.id, "attachments");
      const files = await readdir(attachDir);
      expect(files.length).toBe(1);

      // Verify content was copied
      const content = await readFile(join(attachDir, files[0]));
      expect(content.toString()).toBe("fake image data");
    });

    it("works when source has no attachments", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.attachments).toBeUndefined();
    });

    it("resets execution state (no steps, no worktree, etc.)", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      expect(refined.steps).toEqual([]);
      expect(refined.currentStep).toBe(0);
      expect(refined.worktree).toBeUndefined();
      expect(refined.status).toBeUndefined();
    });

    it("creates PROMPT.md for the refinement", async () => {
      const task = await store.createTask({ description: "Original task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");

      const detail = await store.getTask(refined.id);
      // Untitled source: uses first line of description
      expect(detail.prompt).toContain("Refinement: Original task");
      expect(detail.prompt).toContain("Need improvements");
      expect(detail.prompt).toContain(`Refines: ${task.id}`);
    });

    it("uses first non-empty line of description when title is absent", async () => {
      const task = await store.createTask({
        description: "Use source task labels for refinement titles\n\nThis is a longer description.",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Add more tests");

      expect(refined.title).toBe("Refinement: Use source task labels for refinement titles");
    });

    it("collapses internal whitespace in description fallback", async () => {
      const task = await store.createTask({
        description: "Fix the  \t  spacing   issue   in UI",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "More feedback");

      expect(refined.title).toBe("Refinement: Fix the spacing issue in UI");
    });

    it("skips leading blank lines in multi-line description", async () => {
      const task = await store.createTask({
        description: "\n  \n  \nFirst real line of description\nSecond line",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Feedback");

      expect(refined.title).toBe("Refinement: First real line of description");
    });

    it("falls back to task ID when description has no non-empty lines", async () => {
      // Create a task with a valid description, then update to all-whitespace
      // (createTask rejects all-whitespace descriptions, but updates could produce this edge case)
      const task = await store.createTask({ description: "Valid description" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.updateTask(task.id, { description: "   \n  \n\t\n" });

      const refined = await store.refineTask(task.id, "Feedback");

      expect(refined.title).toBe(`Refinement: ${task.id}`);
    });

    it("PROMPT.md heading matches the refinement title", async () => {
      const task = await store.createTask({
        title: "My Feature",
        description: "Some description",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");
      const detail = await store.getTask(refined.id);

      expect(refined.title).toBe("Refinement: My Feature");
      expect(detail.prompt).toMatch(/^# Refinement: My Feature\n/);
    });

    it("PROMPT.md heading uses description fallback when untitled", async () => {
      const task = await store.createTask({
        description: "Fix the login bug on settings page",
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const refined = await store.refineTask(task.id, "Need improvements");
      const detail = await store.getTask(refined.id);

      expect(refined.title).toBe("Refinement: Fix the login bug on settings page");
      expect(detail.prompt).toMatch(/^# Refinement: Fix the login bug on settings page\n/);
    });

    it("throws ENOENT when source task does not exist", async () => {
      await expect(store.refineTask("KB-999", "Feedback")).rejects.toThrow();
    });
  });


  // ── Archive/Unarchive Tests ──────────────────────────────────────


  describe("branch cleanup on delete and archive", () => {
    beforeEach(() => {
      mockedExecSync.mockClear();
      mockedRunCommandAsync.mockClear();
    });

    afterEach(() => {
      mockedExecSync.mockImplementation(
        (...args: Parameters<typeof execSync>) => {
          // Restore pass-through to real implementation
          const { execSync: realExecSync } = require("node:child_process");
          return realExecSync(...args);
        },
      );
      mockedRunCommandAsync.mockImplementation((...args: Parameters<typeof runCommandAsync>) =>
        vi.importActual<typeof import("../run-command.js")>("../run-command.js").then((mod) =>
          mod.runCommandAsync(...args),
        ),
      );
    });

    it("deleteTask attempts branch cleanup via cleanupBranchForTask", async () => {
      const task = await createTestTask();

      // Mock: verify succeeds, delete succeeds
      mockedRunCommandAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --verify") || cmd.includes("git branch -D")) {
          return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false };
        }
        throw new Error(`unexpected runCommandAsync call: ${cmd}`);
      });

      await store.deleteTask(task.id);

      const calls = mockedRunCommandAsync.mock.calls.map((c) => c[0] as string);
      const verifyCalls = calls.filter((c) => c.includes("git rev-parse --verify") && c.includes(`fusion/${task.id.toLowerCase()}`));
      const deleteCalls = calls.filter((c) => c.includes("git branch -D") && c.includes(`fusion/${task.id.toLowerCase()}`));
      expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("deleteTask cleans up stored branch and derived branch when set", async () => {
      const task = await store.createTask({ description: "Branch test" });
      await store.updateTask(task.id, { branch: "fusion/my-custom-branch" });

      mockedRunCommandAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --verify") || cmd.includes("git branch -D")) {
          return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false };
        }
        throw new Error(`unexpected runCommandAsync call: ${cmd}`);
      });

      await store.deleteTask(task.id);

      const calls = mockedRunCommandAsync.mock.calls.map((c) => c[0] as string);

      // Should verify and delete both stored and derived branches
      const customBranchVerify = calls.filter((c) => c.includes(`git rev-parse --verify "fusion/my-custom-branch"`));
      const customBranchDelete = calls.filter((c) => c.includes(`git branch -D "fusion/my-custom-branch"`));
      const derivedBranchVerify = calls.filter((c) => c.includes(`git rev-parse --verify "fusion/${task.id.toLowerCase()}"`));
      const derivedBranchDelete = calls.filter((c) => c.includes(`git branch -D "fusion/${task.id.toLowerCase()}"`));
      expect(customBranchVerify.length).toBeGreaterThanOrEqual(1);
      expect(customBranchDelete.length).toBeGreaterThanOrEqual(1);
      expect(derivedBranchVerify.length).toBeGreaterThanOrEqual(1);
      expect(derivedBranchDelete.length).toBeGreaterThanOrEqual(1);
    });

    it("deleteTask succeeds even when branch cleanup fails", async () => {
      const task = await createTestTask();

      mockedRunCommandAsync.mockResolvedValue({
        stdout: "",
        stderr: "not a git repo",
        exitCode: 128,
        signal: null,
        bufferExceeded: false,
        timedOut: false,
      });

      const deleted = await store.deleteTask(task.id);
      expect(deleted.id).toBe(task.id);
    });

    it("archiveTask with cleanup attempts branch cleanup", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      mockedRunCommandAsync.mockImplementation(async (cmd: string) => {
        if (cmd.includes("git rev-parse --verify") || cmd.includes("git branch -D")) {
          return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false };
        }
        throw new Error(`unexpected runCommandAsync call: ${cmd}`);
      });

      await store.archiveTask(task.id, true);

      const calls = mockedRunCommandAsync.mock.calls.map((c) => c[0] as string);
      const verifyCalls = calls.filter((c) => c.includes("git rev-parse --verify") && c.includes(`fusion/${task.id.toLowerCase()}`));
      const deleteCalls = calls.filter((c) => c.includes("git branch -D") && c.includes(`fusion/${task.id.toLowerCase()}`));
      expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("archiveTask without cleanup does NOT attempt branch cleanup", async () => {
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      mockedRunCommandAsync.mockClear();

      await store.archiveTask(task.id, false);

      const calls = mockedRunCommandAsync.mock.calls.map((c) => c[0] as string);
      const branchCommands = calls.filter((c) => c.includes("git branch -D") || c.includes("git rev-parse --verify"));
      expect(branchCommands).toHaveLength(0);
    });
  });


  describe("project memory bootstrap", () => {
    it("creates .fusion/memory/MEMORY.md on init when memoryEnabled is default (true)", async () => {
      const memoryPath = join(rootDir, ".fusion", "memory", "MEMORY.md");
      expect(existsSync(memoryPath)).toBe(true);

      const content = await readFile(memoryPath, "utf-8");
      expect(content).toContain("# Project Memory");
      expect(content).toContain("## Architecture");
      expect(content).toContain("## Conventions");
    });

    it("does not create .fusion/memory/MEMORY.md when memoryEnabled is false after re-init", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      let localStore: TaskStore | undefined;
      let secondStore: TaskStore | undefined;
      try {
        localStore = new TaskStore(localRoot, localGlobal);
        await localStore.init();
        await localStore.updateSettings({ memoryEnabled: false } as any);

        const memoryPath = join(localRoot, ".fusion", "memory", "MEMORY.md");
        if (existsSync(memoryPath)) {
          await unlink(memoryPath);
        }
        expect(existsSync(memoryPath)).toBe(false);

        localStore.close();
        localStore = undefined;

        secondStore = new TaskStore(localRoot, localGlobal);
        await secondStore.init();

        expect(existsSync(memoryPath)).toBe(false);
      } finally {
        secondStore?.close();
        localStore?.close();
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });

    it("creates .fusion/memory/MEMORY.md when memory is toggled on via updateSettings", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      let localStore: TaskStore | undefined;
      try {
        localStore = new TaskStore(localRoot, localGlobal, { inMemoryDb: true });
        await localStore.init();

        await localStore.updateSettings({ memoryEnabled: false } as any);
        const memoryPath = join(localRoot, ".fusion", "memory", "MEMORY.md");

        if (existsSync(memoryPath)) {
          await unlink(memoryPath);
        }
        expect(existsSync(memoryPath)).toBe(false);

        await localStore.updateSettings({ memoryEnabled: true } as any);
        expect(existsSync(memoryPath)).toBe(true);

        const content = await readFile(memoryPath, "utf-8");
        expect(content).toContain("# Project Memory");
      } finally {
        localStore?.close();
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });

    it("does not overwrite existing memory content when toggled on", async () => {
      const localRoot = makeTmpDir();
      const localGlobal = makeTmpDir();
      let localStore: TaskStore | undefined;
      try {
        localStore = new TaskStore(localRoot, localGlobal, { inMemoryDb: true });
        await localStore.init();
        const memoryPath = join(localRoot, ".fusion", "memory", "MEMORY.md");

        const customContent = "# My Custom Memory\n\nImportant stuff";
        await writeFile(memoryPath, customContent, "utf-8");

        await localStore.updateSettings({ memoryEnabled: false } as any);
        await localStore.updateSettings({ memoryEnabled: true } as any);

        const content = await readFile(memoryPath, "utf-8");
        expect(content).toBe(customContent);
      } finally {
        localStore?.close();
        await rm(localRoot, { recursive: true, force: true });
        await rm(localGlobal, { recursive: true, force: true });
      }
    });
  });




  describe("research document key helper", () => {
    it("builds canonical research document keys", () => {
      expect(buildResearchDocumentKey("RR-1")).toBe("research-RR-1");
      expect(buildResearchDocumentKey("RR/1")).toBe("research-RR1");
    });

    it("rejects run IDs that sanitize to an empty string", () => {
      expect(() => buildResearchDocumentKey("!!!")).toThrow("Invalid research run id");
    });
  });

  // ── Title Handling Tests ────────────────────────────────────────


});
