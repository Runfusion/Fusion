import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { DependencyCycleError, TaskStore, TaskHasDependentsError } from "../store.js";
import { setCreateFnAgent } from "../ai-engine-loader.js";
import { setTaskCreatedHook } from "../task-creation-hooks.js";
import { buildResearchDocumentKey, type Task } from "../types.js";
import { createSharedTaskStoreTestHarness, makeTmpDir } from "./store-test-helpers.js";

describe("TaskStore", () => {
  // FNXC:TestInfrastructure 2026-06-21-11:30:
  // Use the shared in-memory harness (build store once, truncate+reset between
  // tests) instead of per-test recreate. Per-test mkdtemp + new TaskStore +
  // recursive rm dominated this 51-test file's wall-clock; the shared harness
  // amortizes setup while preserving isolation via full table truncation +
  // filesystem reset. Part of the FN-5048 "do not add slow tests" cleanup.
  const harness = createSharedTaskStoreTestHarness();
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);

  beforeEach(async () => {
    await harness.beforeEach();
    rootDir = harness.rootDir();
    globalDir = harness.globalDir();
    store = harness.store();
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    setCreateFnAgent(undefined);
    await harness.afterEach();
  });

  const createTestTask = () => harness.createTestTask();
  const createTaskWithSteps = () => harness.createTaskWithSteps();
  const deleteTaskDir = (taskId: string) => harness.deleteTaskDir(taskId);
  const createSourceIssueFixture = () => harness.createSourceIssueFixture();
  const insertLogEntryWithTimestamp = (...args: any[]) => (harness as any).insertLogEntryWithTimestamp(...args);

  describe("FN-5413 null description coercion", () => {
    it.each([
      ["undefined", undefined],
      ["null", null],
    ])("coerces %s description to empty string on persist", async (_label, description) => {
      const created = await store.createTask({
        description: "Initial description",
      });

      const task = await store.getTask(created.id);
      (task as Task & { description?: string | null }).description = description;

      expect(() => {
        (store as unknown as { upsertTaskWithFtsRecovery: (task: Task) => void }).upsertTaskWithFtsRecovery(task);
      }).not.toThrow();

      const persisted = await store.getTask(created.id);
      expect(persisted.description).toBe("");
    });
  });

  describe("startup watch recovery", () => {
    it("does not crash done-task backfill when a DB row has no task.json mirror", async () => {
      const task = await store.createTask({ description: "done task with missing mirror" });
      (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare(`UPDATE tasks SET "column" = ?, updatedAt = ? WHERE id = ?`)
        .run("done", new Date().toISOString(), task.id);
      await deleteTaskDir(task.id);

      await expect(store.watch()).resolves.toBeUndefined();
      await store.close();
    });
  });

  describe("breakIntoSubtasks task creation flag", () => {
    it("persists breakIntoSubtasks=true when explicitly requested", async () => {
      const task = await store.createTask({
        description: "Large feature",
        breakIntoSubtasks: true,
      });

      expect(task.breakIntoSubtasks).toBe(true);

      const detail = await store.getTask(task.id);
      expect(detail.breakIntoSubtasks).toBe(true);
    });

    it("persists modelPresetId when provided during task creation", async () => {
      const task = await store.createTask({
        description: "Preset task",
        modelPresetId: "budget",
      });

      expect(task.modelPresetId).toBe("budget");

      const detail = await store.getTask(task.id);
      expect(detail.modelPresetId).toBe("budget");
    });

    it("leaves breakIntoSubtasks unset by default", async () => {
      const task = await store.createTask({
        description: "Regular task",
      });

      expect(task.breakIntoSubtasks).toBeUndefined();

      const detail = await store.getTask(task.id);
      expect(detail.breakIntoSubtasks).toBeUndefined();
    });

    it("persists missionId and sliceId when provided during task creation", async () => {
      const task = await store.createTask({
        description: "Mission-linked task",
        missionId: "MS-001",
        sliceId: "SL-001",
      });

      expect(task.missionId).toBe("MS-001");
      expect(task.sliceId).toBe("SL-001");

      const detail = await store.getTask(task.id);
      expect(detail.missionId).toBe("MS-001");
      expect(detail.sliceId).toBe("SL-001");
    });

    it("leaves missionId and sliceId unset when not provided", async () => {
      const task = await store.createTask({
        description: "Regular task",
      });

      expect(task.missionId).toBeUndefined();
      expect(task.sliceId).toBeUndefined();

      const detail = await store.getTask(task.id);
      expect(detail.missionId).toBeUndefined();
      expect(detail.sliceId).toBeUndefined();
    });
  });



  describe("createTask task-created hook invocation", () => {
    it("skips hook when invokeTaskCreatedHook is false and defaults to invoking", async () => {
      const hookSpy = vi.fn();
      setTaskCreatedHook(hookSpy);

      await store.createTask(
        { description: "Hook should be skipped" },
        { invokeTaskCreatedHook: false },
      );
      expect(hookSpy).not.toHaveBeenCalled();

      await store.createTask({ description: "Hook should run" });
      expect(hookSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("createTask — model overrides", () => {
    it("persists executor and validator model overrides on creation", async () => {
      const created = await store.createTask({
        title: "Task with model overrides",
        description: "Use explicit executor and validator models",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      });

      expect(created.modelProvider).toBe("anthropic");
      expect(created.modelId).toBe("claude-sonnet-4-5");
      expect(created.validatorModelProvider).toBe("openai");
      expect(created.validatorModelId).toBe("gpt-4o");

      const persisted = await store.getTask(created.id);
      expect(persisted.modelProvider).toBe("anthropic");
      expect(persisted.modelId).toBe("claude-sonnet-4-5");
      expect(persisted.validatorModelProvider).toBe("openai");
      expect(persisted.validatorModelId).toBe("gpt-4o");
    });
  });


  describe("createTask — assigneeUserId", () => {
    it("persists assigneeUserId on creation", async () => {
      const created = await store.createTask({
        title: "Task with user assignment",
        description: "A task assigned to a user",
        assigneeUserId: "requesting-user",
      });

      expect(created.assigneeUserId).toBe("requesting-user");

      const persisted = await store.getTask(created.id);
      expect(persisted.assigneeUserId).toBe("requesting-user");
    });
  });


  describe("task provenance", () => {
    it("defaults sourceType to unknown when source is omitted", async () => {
      const task = await store.createTask({ description: "Provenance default" });
      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("unknown");
    });

    it("persists simple source type from createTask", async () => {
      const task = await store.createTask({
        description: "Created from dashboard",
        source: { sourceType: "dashboard_ui" },
      });
      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("dashboard_ui");
    });

    it("roundtrips full provenance metadata", async () => {
      const task = await store.createTask({
        description: "Heartbeat-generated task",
        source: {
          sourceType: "agent_heartbeat",
          sourceAgentId: "agent-123",
          sourceRunId: "run-456",
          sourceSessionId: "session-789",
          sourceMessageId: "msg-001",
          sourceMetadata: { reason: "scheduled" },
        },
      });

      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("agent_heartbeat");
      expect(fetched.sourceAgentId).toBe("agent-123");
      expect(fetched.sourceRunId).toBe("run-456");
      expect(fetched.sourceSessionId).toBe("session-789");
      expect(fetched.sourceMessageId).toBe("msg-001");
      expect(fetched.sourceMetadata).toEqual({ reason: "scheduled" });
    });

    it("sets duplicate and refine provenance parent links", async () => {
      const source = await store.createTask({ title: "Fix FN-123 bug", description: "Original" });
      const duplicated = await store.duplicateTask(source.id);
      expect(duplicated.sourceType).toBe("task_duplicate");
      expect(duplicated.sourceParentTaskId).toBe(source.id);
      expect(duplicated.title).toBe("Fix bug");
      expect(duplicated.description).toContain(`(Duplicated from ${source.id})`);

      await store.moveTask(source.id, "todo");
      await store.moveTask(source.id, "in-progress");
      await store.moveTask(source.id, "in-review");
      await store.moveTask(source.id, "done");
      const refined = await store.refineTask(source.id, "Needs polish");
      expect(refined.sourceType).toBe("task_refine");
      expect(refined.sourceParentTaskId).toBe(source.id);
      expect(refined.title).toBe("Refinement: Fix bug");
    });

    it("FN-4898: prevents title/ID drift on duplicateTask", async () => {
      const source = await store.createTask({ title: "Finalize FN-4847: mark steps done", description: "x" });
      const duplicated = await store.duplicateTask(source.id);
      expect(duplicated.title).toBe("Finalize mark steps done");
      expect(duplicated.sourceParentTaskId).toBe(source.id);
      expect(duplicated.description).toContain(`(Duplicated from ${source.id})`);
    });

    it("preserves provenance on updateTask", async () => {
      const task = await store.createTask({
        description: "Will be updated",
        source: {
          sourceType: "automation",
          sourceAgentId: "agent-auto",
          sourceMetadata: { trigger: "nightly" },
        },
      });

      await store.updateTask(task.id, { title: "Updated" });
      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("automation");
      expect(fetched.sourceAgentId).toBe("agent-auto");
      expect(fetched.sourceMetadata).toEqual({ trigger: "nightly" });
    });

    it("persists research provenance metadata", async () => {
      const task = await store.createTask({
        description: "Research finding follow-up",
        source: {
          sourceType: "research",
          sourceMetadata: {
            runId: "RR-42",
            findingId: "finding-1",
            findingLabel: "Key risk",
            documentKey: "research-RR-42",
          },
        },
      });

      const fetched = await store.getTask(task.id);
      expect(fetched.sourceType).toBe("research");
      expect(fetched.sourceMetadata).toEqual({
        runId: "RR-42",
        findingId: "finding-1",
        findingLabel: "Key risk",
        documentKey: "research-RR-42",
      });
    });
  });


  describe("title handling", () => {
    it("creates task with undefined title when none provided", async () => {
      const task = await store.createTask({ description: "Fix the login bug on the settings page" });
      
      expect(task.title).toBeUndefined();
      expect(task.description).toBe("Fix the login bug on the settings page");
      
      // Verify persisted to disk
      const fetched = await store.getTask(task.id);
      expect(fetched.title).toBeUndefined();
    });

    it("creates task with provided title", async () => {
      const task = await store.createTask({
        title: "Custom Title",
        description: "This is the description",
      });

      expect(task.title).toBe("Custom Title");
      
      const fetched = await store.getTask(task.id);
      expect(fetched.title).toBe("Custom Title");
    });

    it("trims whitespace from provided title", async () => {
      const task = await store.createTask({
        title: "  Padded Title  ",
        description: "Some description",
      });

      expect(task.title).toBe("Padded Title");
    });

    it("treats empty string title as undefined", async () => {
      const task = await store.createTask({
        title: "",
        description: "Some description",
      });

      expect(task.title).toBeUndefined();
    });

    it("treats whitespace-only title as undefined", async () => {
      const task = await store.createTask({
        title: "   ",
        description: "Some description",
      });

      expect(task.title).toBeUndefined();
    });

    it("preserves description exactly as provided", async () => {
      const description = "Fix $$$ bug @ home-page (urgent!)";
      const task = await store.createTask({ description });

      expect(task.description).toBe(description);
    });

    it("includes ID only in PROMPT.md heading when no title", async () => {
      const task = await store.createTask({ description: "Implement the new feature" });
      const detail = await store.getTask(task.id);

      // Heading should be just the task ID when no title is provided
      expect(detail.prompt).toMatch(/^# FN-001\n/);
    });

    it("includes title in PROMPT.md heading when provided", async () => {
      const task = await store.createTask({
        title: "My Feature",
        description: "Build something great",
        column: "todo",
      });
      const detail = await store.getTask(task.id);

      expect(detail.prompt).toMatch(/^# FN-001: My Feature\n/);
    });

    it("handles empty description gracefully (should throw)", async () => {
      await expect(store.createTask({ description: "" })).rejects.toThrow("Description is required");
    });
  });

  // ── Archive Cleanup Tests ────────────────────────────────────────


  describe("createTask with title summarization", () => {
    it("should use generated title when onSummarize returns a title", async () => {
      const longDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Generated Title");

      const task = await store.createTask(
        { description: longDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Title is not set synchronously - summarization happens async
      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).toHaveBeenCalledWith(longDescription);

      // Wait for async summarization to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify title was set asynchronously
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("AI Generated Title");
    });

    it("should not call onSummarize when title is already provided", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { title: "User Title", description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBe("User Title");
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should not call onSummarize when description is too short", async () => {
      const shortDescription = "a".repeat(100);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: shortDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should not call onSummarize when autoSummarizeTitles is false", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: false } }
      );

      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should not call onSummarize when no settings provided", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize }
      );

      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should call onSummarize when summarize input flag is true", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: "a".repeat(201), summarize: true },
        { onSummarize: mockOnSummarize }
      );

      // Title is not set synchronously
      expect(task.title).toBeUndefined();
      expect(mockOnSummarize).toHaveBeenCalled();

      // Wait for async summarization to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify title was set asynchronously
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("AI Title");
    });

    it("resolves and calls a store-managed summarizer when summarize input flag is true", async () => {
      const longDescription = "a".repeat(201);
      const promptSpy = vi.fn(async () => {});
      const createFnAgent = vi.fn(async () => ({
        session: {
          prompt: promptSpy,
          state: { messages: [{ role: "assistant", content: "Generated Store Title" }] },
        },
      }));
      setCreateFnAgent(createFnAgent);

      const task = await store.createTask(
        { description: longDescription, summarize: true },
        {
          settings: {
            autoSummarizeTitles: false,
            titleSummarizerProvider: "mock",
            titleSummarizerModelId: "title-model",
          },
        },
      );

      expect(task.title).toBeUndefined();

      await vi.waitFor(async () => {
        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.title).toBe("Generated Store Title");
      });
      expect(createFnAgent).toHaveBeenCalledWith(expect.objectContaining({
        cwd: rootDir,
        defaultProvider: "mock",
        defaultModelId: "title-model",
      }));
      expect(promptSpy).toHaveBeenCalledWith(expect.stringContaining(longDescription));
    });


    it("should ignore malformed confirmation-prose generated titles", async () => {
      const mockOnSummarize = vi
        .fn()
        .mockResolvedValue("Created task **FN-9999** in the triage column. Here's a summary.");

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBeUndefined();
    });

    it("FN-5077: malformed drift-stripped fragment title is not persisted", async () => {
      const description = "Extend deterministic content-fingerprint dedup guard beyond dashboard POST /tasks to remaining intake surfaces (CLI direct-store create path, planning/subtask flow, InlineCreateCard, mission feature-triage).";
      const task = await store.createTask(
        { title: "Close as duplicate of FN-5060", description },
        { onSummarize: vi.fn().mockResolvedValue(null), settings: { autoSummarizeTitles: true } },
      );

      expect(task.title).toBeUndefined();
      const persisted = await store.getTask(task.id);
      expect(persisted.title).toBeUndefined();
      expect(persisted.description).toBe(description);
    });

    it("should handle onSummarize returning null", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue(null);

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Task created without title
      expect(task.title).toBeUndefined();

      // Wait for async summarization to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Title should remain undefined
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBeUndefined();
    });

    it("should handle onSummarize throwing error gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockOnSummarize = vi.fn().mockRejectedValue(new Error("AI service failed"));

      try {
        const task = await store.createTask(
          { description: "a".repeat(201) },
          { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
        );

        expect(task.title).toBeUndefined();
        expect(task.id).toMatch(/^FN-\d+$/); // Task still created

        // Wait for async error to be logged
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(consoleSpy).toHaveBeenCalled();
        const [message, context] = consoleSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(message).toContain("[task-store] Title summarization failed for task");
        expect(context).toMatchObject({
          taskId: task.id,
          descriptionLength: 201,
          autoSummarizeEnabled: true,
          error: "AI service failed",
        });
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it("logs outer promise-chain failure when inner warning logger throws", async () => {
      const syntheticError = "Synthetic warn logger failure";
      // Throw inside warn logging so the failure escapes the inner summarize try/catch
      // and is handled by the outer Promise.resolve().then(...).catch(...) branch.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
        throw new Error(syntheticError);
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mockOnSummarize = vi.fn().mockRejectedValue(new Error("AI service failed"));

      try {
        const task = await store.createTask(
          { description: "a".repeat(201) },
          { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
        );

        expect(task.id).toMatch(/^FN-\d+$/);
        expect(task.title).toBeUndefined();

        await new Promise((resolve) => setTimeout(resolve, 10));

        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.title).toBeUndefined();

        const outerErrorCall = errorSpy.mock.calls.find(([message]) =>
          typeof message === "string"
          && message.includes("[task-store] Unexpected title summarization promise-chain failure")
        );
        expect(outerErrorCall).toBeDefined();

        const [message, context] = outerErrorCall as [string, Record<string, unknown>];
        expect(message).toContain("[task-store] Unexpected title summarization promise-chain failure");
        expect(context).toMatchObject({
          taskId: task.id,
          descriptionLength: 201,
          autoSummarizeEnabled: true,
          error: syntheticError,
        });
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("should trigger summarization at exactly 201 characters", async () => {
      const boundaryDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: boundaryDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(mockOnSummarize).toHaveBeenCalled();

      // Wait for async summarization
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("AI Title");
    });

    it("should not trigger summarization at exactly 200 characters", async () => {
      const boundaryDescription = "a".repeat(200);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { description: boundaryDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(mockOnSummarize).not.toHaveBeenCalled();
      expect(task.title).toBeUndefined();
    });

    it("should prioritize explicit title over summarize flag", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title");

      const task = await store.createTask(
        { title: "User Title", description: "a".repeat(201), summarize: true },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      expect(task.title).toBe("User Title");
      expect(mockOnSummarize).not.toHaveBeenCalled();
    });

    it("should include generated title in PROMPT.md heading", async () => {
      const mockOnSummarize = vi.fn().mockResolvedValue("Generated Task Title");

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Title not set synchronously
      expect(task.title).toBeUndefined();

      // Wait for async summarization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify title and PROMPT.md were updated
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("Generated Task Title");
      expect(updatedTask.prompt).toMatch(/^# FN-\d+: Generated Task Title\n/);
    });

    it("should preserve original description when generating a title", async () => {
      const originalDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Summary Title");

      const task = await store.createTask(
        { description: originalDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Title not set synchronously
      expect(task.title).toBeUndefined();
      expect(task.description).toBe(originalDescription);

      // Wait for async summarization
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("AI Summary Title");
      expect(updatedTask.description).toBe(originalDescription);
    });

    it("should not overwrite user-set title during async summarization", async () => {
      const mockOnSummarize = vi.fn().mockImplementation(async () => {
        // Simulate slow AI response
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "AI Title";
      });

      const task = await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Immediately update with user title
      await store.updateTask(task.id, { title: "User Title" });

      // Wait for delayed onSummarize to resolve
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Title should still be "User Title" (race guard should have prevented overwrite)
      const updatedTask = await store.getTask(task.id);
      expect(updatedTask.title).toBe("User Title");
    });
  });

  // ── Utility Path Independence Regression ─────────────────────────────────────
  // FN-1727: Title summarization runs on a separate utility lane (async microtask)
  // and is NOT gated by task-lane semaphore settings. This test proves that:
  // 1. createTask returns immediately (synchronous) regardless of maxConcurrent
  // 2. onSummarize callback fires asynchronously via Promise.resolve().then()
  // 3. Task creation succeeds even when onSummarize would be blocked by semaphore
  //
  // The engine's maxConcurrent setting lives at the execution layer and does NOT
  // affect the core store's createTask method, which has no semaphore dependency.

  describe("createTask summarization is independent of engine maxConcurrent settings", () => {
    it("creates task and calls onSummarize even with maxConcurrent: 0", async () => {
      // Set extreme concurrency setting to prove the core store is unaffected.
      // Note: The core store does NOT read maxConcurrent from settings during
      // createTask - this is purely a documentation regression proving the
      // architectural separation between core (store) and engine (semaphore).
      await store.updateSettings({ maxConcurrent: 0 });

      const longDescription = "a".repeat(201);
      const mockOnSummarize = vi.fn().mockResolvedValue("AI Title From Saturation Test");

      // Create task with summarization enabled
      const task = await store.createTask(
        { description: longDescription },
        { onSummarize: mockOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // CRITICAL ASSERTIONS:
      // 1. Task was created immediately (synchronous return)
      expect(task.id).toMatch(/^FN-\d+$/);
      expect(task.title).toBeUndefined(); // Not set synchronously

      // 2. onSummarize was called (async but independent of maxConcurrent)
      expect(mockOnSummarize).toHaveBeenCalledWith(longDescription);

      // 3. Wait for async summarization and verify title was set
      await vi.waitFor(async () => {
        const updatedTask = await store.getTask(task.id);
        expect(updatedTask.title).toBe("AI Title From Saturation Test");
      });

      // Reset maxConcurrent to normal value
      await store.updateSettings({ maxConcurrent: 2 });
    });

    it("task creation succeeds when onSummarize is blocked by slow callback (proving no semaphore dependency)", async () => {
      // Simulate a slow/stalled onSummarize callback to prove there's no
      // semaphore that would block task creation. The core store has no
      // dependency on any concurrency limiter.
      const slowOnSummarize = vi.fn().mockImplementation(
        async () => new Promise<string>(() => {}),
      );

      const taskPromise = store.createTask(
        { description: "a".repeat(201) },
        { onSummarize: slowOnSummarize, settings: { autoSummarizeTitles: true } }
      );

      // Task creation MUST complete quickly (before slowOnSummarize resolves)
      const task = await taskPromise;
      expect(task.id).toMatch(/^FN-\d+$/);

      // Verify slowOnSummarize was initiated (async microtask)
      expect(slowOnSummarize).toHaveBeenCalled();

      // The slow callback is still pending (would take 1000ms to resolve)
      // but task creation already succeeded - proving no blocking dependency
      const freshTask = await store.getTask(task.id);
      expect(freshTask.id).toBe(task.id);
      // Title not yet set because onSummarize is still pending
    });
  });


  describe("distributed task-id allocator seam", () => {
    it("commits allocator reservations for createTask, duplicateTask, and refineTask", async () => {
      const created = await store.createTask({ description: "created with allocator" });
      const duplicate = await store.duplicateTask(created.id);

      await store.moveTask(created.id, "todo");
      await store.moveTask(created.id, "in-progress");
      await store.moveTask(created.id, "in-review");
      await store.moveTask(created.id, "done");
      const refined = await store.refineTask(created.id, "refine this");

      const reservationRows = store
        .getDatabase()
        .prepare("SELECT taskId, status FROM distributed_task_id_reservations WHERE taskId IN (?, ?, ?) ORDER BY taskId")
        .all(created.id, duplicate.id, refined.id) as Array<{ taskId: string; status: string }>;

      expect(reservationRows).toEqual([
        { taskId: created.id, status: "committed" },
        { taskId: duplicate.id, status: "committed" },
        { taskId: refined.id, status: "committed" },
      ]);
    });

    it("keeps IDs collision-free across mixed store and direct reservation creates", async () => {
      // Regression for FN-4053: before unifying local allocation, store.createTask()
      // used config.nextId while direct distributed reservations advanced
      // distributed_task_id_state. Interleaving both paths could reuse IDs.
      const first = await store.createTask({ description: "first via store" });

      const allocator = store.getDistributedTaskIdAllocator();
      const reservation = await allocator.reserveDistributedTaskId({ prefix: "FN", nodeId: "node-a" });
      const second = await store.createTaskWithReservedId(
        { description: "second via direct reservation" },
        { taskId: reservation.taskId },
      );
      await allocator.commitDistributedTaskIdReservation({
        reservationId: reservation.reservationId,
        nodeId: "node-a",
      });

      const third = await store.createTask({ description: "third via store" });

      expect(first.id).toBe("FN-001");
      expect(second.id).toBe("FN-002");
      expect(third.id).toBe("FN-003");
      expect(third.id).not.toBe(second.id);
    });

    it("returns a stable allocator instance", () => {
      const first = store.getDistributedTaskIdAllocator();
      const second = store.getDistributedTaskIdAllocator();
      expect(first).toBe(second);
    });

    it("createTaskWithReservedId creates using provided id", async () => {
      const created = await store.createTaskWithReservedId(
        { description: "replicated task", nodeId: "node-b" },
        { taskId: "FN-9001" },
      );

      expect(created.id).toBe("FN-9001");
      expect(created.nodeId).toBe("node-b");
      const detail = await store.getTask("FN-9001");
      expect(detail.prompt).toBe("# FN-9001\n\nreplicated task\n");
    });

    it("createTaskWithReservedId rejects duplicates and self-dependencies", async () => {
      await store.createTaskWithReservedId({ description: "first" }, { taskId: "FN-9003" });

      await expect(
        store.createTaskWithReservedId({ description: "duplicate" }, { taskId: "FN-9003" }),
      ).rejects.toThrow("Task ID already exists: FN-9003");

      let error: unknown;
      try {
        await store.createTaskWithReservedId(
          { description: "self dep", dependencies: ["FN-9004"] },
          { taskId: "FN-9004" },
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(DependencyCycleError);
      expect(error).toMatchObject({
        taskId: "FN-9004",
        cyclePath: ["FN-9004", "FN-9004"],
      });
    });

    it("applyReplicatedTaskCreate does not auto-apply default workflow steps", async () => {
      const workflowStep = await store.createWorkflowStep({
        name: "Default step",
        description: "auto",
        enabled: true,
        defaultOn: true,
      });

      const payload = {
        replicationVersion: 1 as const,
        reservationId: "res-default-step",
        taskId: "FN-9010",
        sourceNodeId: "node-a",
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
        prompt: "# FN-9010\n\ncluster create\n",
        input: {
          description: "cluster create",
          column: "triage" as const,
        },
      };

      const result = await store.applyReplicatedTaskCreate(payload);
      expect(result.applied).toBe(true);
      expect(result.task.enabledWorkflowSteps).toBeUndefined();
      expect(workflowStep.defaultOn).toBe(true);
    });

    it("applyReplicatedTaskCreate is idempotent and detects collisions", async () => {
      const payload = {
        replicationVersion: 1 as const,
        reservationId: "res-1",
        taskId: "FN-9002",
        sourceNodeId: "node-a",
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
        prompt: "# FN-9002\n\ncluster create\n",
        input: {
          description: "cluster create",
          column: "triage" as const,
          nodeId: "node-c",
        },
      };

      const first = await store.applyReplicatedTaskCreate(payload);
      expect(first.applied).toBe(true);
      const second = await store.applyReplicatedTaskCreate(payload);
      expect(second.applied).toBe(false);
      expect(second.task.id).toBe("FN-9002");

      await expect(
        store.applyReplicatedTaskCreate({
          ...payload,
          input: { ...payload.input, description: "different" },
        }),
      ).rejects.toThrow("Replicated task payload collision");
    });
  });


});
