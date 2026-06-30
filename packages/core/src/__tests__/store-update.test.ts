import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";

import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { DependencyCycleError, TaskStore, TaskHasDependentsError } from "../store.js";
import { buildResearchDocumentKey, type Task } from "../types.js";
import { createSharedTaskStoreTestHarness, makeTmpDir } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createSharedTaskStoreTestHarness();
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeAll(harness.beforeAll);

  beforeEach(async () => {
    await harness.beforeEach();
    rootDir = harness.rootDir();
    globalDir = harness.globalDir();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(harness.afterAll);

  const createTestTask = () => harness.createTestTask();
  const createTaskWithSteps = () => harness.createTaskWithSteps();
  const deleteTaskDir = (taskId: string) => harness.deleteTaskDir(taskId);
  const createSourceIssueFixture = () => harness.createSourceIssueFixture();
  const insertLogEntryWithTimestamp = (...args: any[]) => (harness as any).insertLogEntryWithTimestamp(...args);

  describe("updateTask — workflow transition notifications", () => {
    it("persists and clears typed workflow transition notification markers", async () => {
      const task = await createTestTask();
      const marker: NonNullable<Task["workflowTransitionNotification"]> = {
        kind: "recovery-requeue",
        column: "todo",
        transitionId: `recovery-requeue:${task.id}:pause-abort-active-work`,
        nodeId: "pause-abort-recovery-router",
        reason: "pause-abort-active-work",
        createdAt: "2026-06-29T20:05:00.000Z",
      };

      const updated = await store.updateTask(task.id, { workflowTransitionNotification: marker });
      expect(updated.workflowTransitionNotification).toEqual(marker);

      const fetched = await store.getTask(task.id);
      expect(fetched?.workflowTransitionNotification).toEqual(marker);

      const limitedDetail = await store.getTask(task.id, { activityLogLimit: 1 });
      expect(limitedDetail?.workflowTransitionNotification).toEqual(marker);

      const cleared = await store.updateTask(task.id, { workflowTransitionNotification: null });
      expect(cleared.workflowTransitionNotification).toBeUndefined();
      expect((await store.getTask(task.id))?.workflowTransitionNotification).toBeUndefined();
    });
  });

  describe("updateTask — dependencies", () => {
    it("adds dependencies to a task with none", async () => {
      const task = await createTestTask();
      expect(task.dependencies).toEqual([]);

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999", "FN-002"] });
      expect(updated.dependencies).toEqual(["KB-999", "FN-002"]);

      // Verify persistence
      const fetched = await store.getTask(task.id);
      expect(fetched.dependencies).toEqual(["KB-999", "FN-002"]);
    });

    it("replaces existing dependencies", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-999"] });
      expect(task.dependencies).toEqual(["KB-999"]);

      const updated = await store.updateTask(task.id, { dependencies: ["FN-002", "FN-003"] });
      expect(updated.dependencies).toEqual(["FN-002", "FN-003"]);
    });

    it("clears dependencies with empty array", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-999"] });
      expect(task.dependencies).toEqual(["KB-999"]);

      const updated = await store.updateTask(task.id, { dependencies: [] });
      expect(updated.dependencies).toEqual([]);
    });

    it("leaves dependencies unchanged when not provided", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-999"] });

      const updated = await store.updateTask(task.id, { title: "New title" });
      expect(updated.dependencies).toEqual(["KB-999"]);
    });
  });


  describe("self-dependency validation", () => {
    const expectSelfLoopError = async (taskId: string, dependencies: string[]) => {
      let error: unknown;
      try {
        await store.updateTask(taskId, { dependencies });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(DependencyCycleError);
      expect(error).toMatchObject({
        name: "DependencyCycleError",
        taskId,
        cyclePath: [taskId, taskId],
      });
    };

    it("createTask should reject self-dependency update with DependencyCycleError", async () => {
      const task = await createTestTask();
      await expectSelfLoopError(task.id, [task.id]);
    });

    it("updateTask should reject mixed self + other deps with self cyclePath first", async () => {
      const task = await createTestTask();
      expect(task.dependencies).toEqual([]);

      await expectSelfLoopError(task.id, [task.id, "FN-002"]);

      // Verify the task was not modified
      const fetched = await store.getTask(task.id);
      expect(fetched.dependencies).toEqual([]);
    });

    it("updateTask should reject existing dep + self with self cyclePath", async () => {
      const task = await store.createTask({ description: "Dep task", dependencies: ["KB-999"] });
      expect(task.dependencies).toEqual(["KB-999"]);

      await expectSelfLoopError(task.id, ["KB-999", task.id]);

      // Verify the task was not modified
      const fetched = await store.getTask(task.id);
      expect(fetched.dependencies).toEqual(["KB-999"]);
    });
  });


  describe("updateTask — auto-move todo to triage on new deps", () => {
    it("moves a todo task to triage when a new dependency is added", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo" });
      expect(task.column).toBe("todo");

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999"] });
      expect(updated.column).toBe("triage");
      expect(updated.status).toBeUndefined();

      // Verify log entry
      expect(updated.log.some((l: any) => l.action.includes("Moved to triage for re-specification"))).toBe(true);

      // Verify persistence
      const fetched = await store.getTask(task.id);
      expect(fetched.column).toBe("triage");
    });

    it("emits task:moved event with { from: 'todo', to: 'triage' }", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo" });
      const events: any[] = [];
      store.on("task:moved", (data: any) => events.push(data));

      await store.updateTask(task.id, { dependencies: ["KB-999"] });

      expect(events).toHaveLength(1);
      expect(events[0].from).toBe("todo");
      expect(events[0].to).toBe("triage");
    });

    it("does NOT move when dependencies are removed from a todo task", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo", dependencies: ["KB-999"] });

      const updated = await store.updateTask(task.id, { dependencies: [] });
      expect(updated.column).toBe("todo");
    });

    it("does NOT move when dependencies are replaced with same set", async () => {
      const task = await store.createTask({ description: "Todo task", column: "todo", dependencies: ["KB-999"] });

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999"] });
      expect(updated.column).toBe("todo");
    });

    it("does NOT move a triage task when dependencies are added", async () => {
      const task = await store.createTask({ description: "Triage task" });
      expect(task.column).toBe("triage");

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999"] });
      expect(updated.column).toBe("triage");
    });

    it("does NOT move an in-progress task when dependencies are added (handled by executor)", async () => {
      const task = await store.createTask({ description: "IP task", column: "todo" });
      await store.moveTask(task.id, "in-progress");

      const updated = await store.updateTask(task.id, { dependencies: ["KB-999"] });
      expect(updated.column).toBe("in-progress");
    });
  });


  describe("updateTask — priority", () => {
    it("does not move triage tasks when only priority is updated", async () => {
      const task = await store.createTask({
        description: "Planning task",
        column: "triage",
        priority: "normal",
      });

      const updated = await store.updateTask(task.id, { priority: "urgent" });
      expect(updated.column).toBe("triage");
      expect(updated.priority).toBe("urgent");
    });
  });

  describe("updateTask — blockedBy", () => {
    it("sets blockedBy to a string value", async () => {
      const task = await store.createTask({ title: "Blocked task", description: "A task" });
      const updated = await store.updateTask(task.id, { blockedBy: "KB-999" });
      expect(updated.blockedBy).toBe("KB-999");
    });

    it("clears blockedBy when set to null", async () => {
      const task = await store.createTask({ title: "Blocked task", description: "A task" });
      await store.updateTask(task.id, { blockedBy: "KB-999" });
      const updated = await store.updateTask(task.id, { blockedBy: null });
      expect(updated.blockedBy).toBeUndefined();
    });
  });


  describe("updateTask — scope override", () => {
    it("persists scopeOverride and scopeOverrideReason via updateTask", async () => {
      const task = await store.createTask({ title: "Scope override task", description: "A task" });

      const updated = await store.updateTask(task.id, {
        scopeOverride: true,
        scopeOverrideReason: "hotfix",
      });

      expect(updated.scopeOverride).toBe(true);
      expect(updated.scopeOverrideReason).toBe("hotfix");

      const fetched = await store.getTask(task.id);
      expect(fetched.scopeOverride).toBe(true);
      expect(fetched.scopeOverrideReason).toBe("hotfix");
    });
  });

  describe("updateTask — assigneeUserId", () => {
    it("sets assigneeUserId via updateTask", async () => {
      const task = await store.createTask({ title: "User task", description: "A task" });
      const updated = await store.updateTask(task.id, { assigneeUserId: "requesting-user" });
      expect(updated.assigneeUserId).toBe("requesting-user");
    });

    it("clears assigneeUserId when set to null", async () => {
      const task = await store.createTask({ title: "User task", description: "A task" });
      await store.updateTask(task.id, { assigneeUserId: "requesting-user" });
      const updated = await store.updateTask(task.id, { assigneeUserId: null });
      expect(updated.assigneeUserId).toBeUndefined();
    });

    it("sets and clears status: awaiting-user-review", async () => {
      const task = await store.createTask({ title: "Review task", description: "A task" });
      const updated = await store.updateTask(task.id, { status: "awaiting-user-review" });
      expect(updated.status).toBe("awaiting-user-review");

      const cleared = await store.updateTask(task.id, { status: null });
      expect(cleared.status).toBeUndefined();
    });
  });

  // ── Task prefix tests ──────────────────────────────────────────



  describe("updateTask — paused", () => {
    it("sets paused via updateTask", async () => {
      const task = await createTestTask();
      const updated = await store.updateTask(task.id, { paused: true });
      expect(updated.paused).toBe(true);
    });

    it("clears paused via updateTask", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, { paused: true });
      const updated = await store.updateTask(task.id, { paused: false });
      expect(updated.paused).toBeUndefined();
    });
  });


  describe("updateTask — model overrides", () => {
    it("sets executor model provider and id via updateTask", async () => {
      const task = await createTestTask();
      const updated = await store.updateTask(task.id, { modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      expect(updated.modelProvider).toBe("anthropic");
      expect(updated.modelId).toBe("claude-sonnet-4-5");
    });

    it("sets validator model provider and id via updateTask", async () => {
      const task = await createTestTask();
      const updated = await store.updateTask(task.id, { validatorModelProvider: "openai", validatorModelId: "gpt-4o" });
      expect(updated.validatorModelProvider).toBe("openai");
      expect(updated.validatorModelId).toBe("gpt-4o");
    });

    it("clears executor model fields via null", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, { modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      const updated = await store.updateTask(task.id, { modelProvider: null, modelId: null });
      expect(updated.modelProvider).toBeUndefined();
      expect(updated.modelId).toBeUndefined();
    });

    it("clears validator model fields via null", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, { validatorModelProvider: "openai", validatorModelId: "gpt-4o" });
      const updated = await store.updateTask(task.id, { validatorModelProvider: null, validatorModelId: null });
      expect(updated.validatorModelProvider).toBeUndefined();
      expect(updated.validatorModelId).toBeUndefined();
    });

    it("sets only executor model without affecting validator model", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, { validatorModelProvider: "openai", validatorModelId: "gpt-4o" });
      const updated = await store.updateTask(task.id, { modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
      expect(updated.modelProvider).toBe("anthropic");
      expect(updated.modelId).toBe("claude-sonnet-4-5");
      expect(updated.validatorModelProvider).toBe("openai");
      expect(updated.validatorModelId).toBe("gpt-4o");
    });

    it("preserves model fields when updating unrelated fields", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        validatorModelProvider: "openai",
        validatorModelId: "gpt-4o",
      });
      const updated = await store.updateTask(task.id, { title: "Updated title" });
      expect(updated.modelProvider).toBe("anthropic");
      expect(updated.modelId).toBe("claude-sonnet-4-5");
      expect(updated.validatorModelProvider).toBe("openai");
      expect(updated.validatorModelId).toBe("gpt-4o");
      expect(updated.title).toBe("Updated title");
    });

    it("does not clobber a real PROMPT.md spec when title changes on a triage task", async () => {
      // Regression: triage finalization called updateTask({title}) while column
      // was still 'triage', and the regen path rewrote PROMPT.md back to the
      // bootstrap stub — shipping empty specs to the executor.
      const task = await createTestTask();
      const realSpec = [
        `# Task: ${task.id} - Some refactor`,
        "",
        "**Created:** 2026-05-02",
        "**Size:** M",
        "",
        "## Mission",
        "",
        "Do the thing.",
        "",
        "## Steps",
        "",
        "- [ ] Step 1",
        "- [ ] Step 2",
        "",
      ].join("\n");
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(join(dir, "PROMPT.md"), realSpec);

      await store.updateTask(task.id, { title: "Some refactor" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toBe(realSpec);
    });

    it("still rewrites the bootstrap stub when title changes on a triage task", async () => {
      const task = await createTestTask();
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      // Confirm createTask seeded the bootstrap stub.
      const initial = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initial.startsWith(`# ${task.id}`)).toBe(true);
      expect(/^##\s/m.test(initial)).toBe(false);

      await store.updateTask(task.id, { title: "New Title" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toBe(`# ${task.id}: New Title\n\n${task.description}\n`);
    });

    it("rewrites a long bootstrap stub when title changes (structural detection, not size-based)", async () => {
      // Regression: a length-based stub detector treated stubs from long
      // descriptions (e.g. imported issue bodies) as real specs, so subsequent
      // edits left the displayed heading stale.
      const longDescription = "Lorem ipsum dolor sit amet. ".repeat(40); // ~1100 bytes
      const created = await store.createTask({ description: longDescription });
      const dir = join(rootDir, ".fusion", "tasks", created.id);
      const initial = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initial.length).toBeGreaterThan(1000);
      expect(/^##\s/m.test(initial)).toBe(false);

      await store.updateTask(created.id, { title: "Now With Title" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toBe(`# ${created.id}: Now With Title\n\n${longDescription}\n`);
    });

    it("rewrites a stub whose description body contains markdown headings or metadata-like text", async () => {
      // Regression: a content-inspecting detector (rejecting any body with
      // `##` headers or `**Created:**` / `**Size:**` markers) misclassified
      // imported GitHub issue bodies as real specs. Detection must compare to
      // the bootstrap wrapper shape, not inspect the description content.
      const importedDescription = [
        "## Repro",
        "",
        "1. Open the dashboard.",
        "2. Click the thing.",
        "",
        "## Expected",
        "",
        "Thing happens.",
        "",
        "**Created:** 2026-04-01 by automation",
        "**Size:** unspecified",
      ].join("\n");
      const created = await store.createTask({ description: importedDescription });
      const dir = join(rootDir, ".fusion", "tasks", created.id);

      await store.updateTask(created.id, { title: "Issue with markdown body" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      // The stub was rewritten — heading reflects the new title and the body
      // is the (markdown-containing) description verbatim.
      expect(onDisk).toBe(`# ${created.id}: Issue with markdown body\n\n${importedDescription}\n`);
    });

    it("survives the triage finalize sequence end-to-end (move-to-todo + title sync)", async () => {
      // Mirrors what TriageProcessor.finalizeApprovedTask does on a real
      // TaskStore: spec lands on disk, non-title metadata is applied with the
      // task still in triage, the task moves to todo, and finally the prompt-
      // declared title is synced. A regression in either the bootstrap stub
      // detector or the real-spec edit path would surface as a corrupted or
      // truncated PROMPT.md after this sequence.
      const created = await store.createTask({
        description: "raw user description containing ## a markdown heading",
      });
      const dir = join(rootDir, ".fusion", "tasks", created.id);
      const realSpec = [
        `# Task: ${created.id} - Refactor the renderer`,
        "",
        "**Created:** 2026-05-02",
        "**Size:** M",
        "",
        "## Review Level: 2 (Plan and Code)",
        "",
        "**Score:** 5/8",
        "",
        "## Mission",
        "",
        "Refactor the renderer to use the new pipeline.",
        "",
        "## Frontend UX Criteria",
        "",
        "- Component must remain accessible at 320px width",
        "",
        "## Steps",
        "",
        "- [ ] Extract pipeline",
        "",
      ].join("\n");
      // Triage agent would have written this via the `write` tool.
      await writeFile(join(dir, "PROMPT.md"), realSpec);

      // Reproduce finalizeApprovedTask's exact sequence:
      // 1. Apply non-title metadata while still in triage.
      await store.updateTask(created.id, { status: null });
      // 2. Move to todo.
      await store.moveTask(created.id, "todo");
      // 3. Sync prompt-declared title.
      await store.updateTask(created.id, { title: "Refactor the renderer" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toContain("## Review Level: 2 (Plan and Code)");
      expect(onDisk).toContain("## Frontend UX Criteria");
      expect(onDisk).toContain("- Component must remain accessible at 320px width");
      expect(onDisk).toContain("## Steps");
      expect(onDisk).toContain("- [ ] Extract pipeline");
      expect(onDisk.split("\n")[0]).toBe(`# Task: ${created.id} - Refactor the renderer`);

      const reloaded = await store.getTask(created.id);
      expect(reloaded.column).toBe("todo");
      expect(reloaded.title).toBe("Refactor the renderer");
    });

    it("preserves Review Level / Frontend UX Criteria sections when title changes on a non-triage task", async () => {
      // Regression: the previous regenerate-from-whitelist path quietly dropped
      // any section not in {Dependencies, Steps, File Scope, Acceptance,
      // Notifications}. Triage emits `## Review Level: N` and may emit
      // `## Frontend UX Criteria`; both must survive a metadata edit.
      const task = await createTestTask();
      await store.moveTask(task.id, "todo");
      const realSpec = [
        `# Task: ${task.id} - Original title`,
        "",
        "**Created:** 2026-05-02",
        "**Size:** M",
        "",
        "## Review Level: 2 (Plan and Code)",
        "",
        "**Score:** 5/8",
        "",
        "## Mission",
        "",
        "Do the thing.",
        "",
        "## Frontend UX Criteria",
        "",
        "- Component must remain accessible at 320px width",
        "",
        "## Steps",
        "",
        "- [ ] Step 1",
        "",
      ].join("\n");
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(join(dir, "PROMPT.md"), realSpec);

      await store.updateTask(task.id, { title: "Renamed task" });

      const onDisk = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(onDisk).toContain("## Review Level: 2 (Plan and Code)");
      expect(onDisk).toContain("## Frontend UX Criteria");
      expect(onDisk).toContain("- Component must remain accessible at 320px width");
      expect(onDisk).toContain("## Steps");
      // Heading is rewritten in the original triage style.
      expect(onDisk.split("\n")[0]).toBe(`# Task: ${task.id} - Renamed task`);
    });

    it("persists sourceIssue on create and reload", async () => {
      const sourceIssue = createSourceIssueFixture();
      const created = await store.createTask({
        description: "Task with source issue",
        sourceIssue,
      });

      expect(created.sourceIssue).toEqual(sourceIssue);

      const reloaded = await store.getTask(created.id);
      expect(reloaded.sourceIssue).toEqual(sourceIssue);
    });

    it("updates and clears sourceIssue via updateTask", async () => {
      const sourceIssue = createSourceIssueFixture();
      const task = await createTestTask();

      const linked = await store.updateTask(task.id, { sourceIssue });
      expect(linked.sourceIssue).toEqual(sourceIssue);

      const reloaded = await store.getTask(task.id);
      expect(reloaded.sourceIssue).toEqual(sourceIssue);

      const cleared = await store.updateTask(task.id, { sourceIssue: null });
      expect(cleared.sourceIssue).toBeUndefined();

      const reloadedAfterClear = await store.getTask(task.id);
      expect(reloadedAfterClear.sourceIssue).toBeUndefined();
    });

    it("preserves sourceIssue through archive and unarchive", async () => {
      const sourceIssue = createSourceIssueFixture();
      const task = await store.createTask({
        description: "Archive source issue preservation",
        sourceIssue,
      });

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.archiveTask(task.id, false);
      const archived = await store.getTask(task.id);
      expect(archived.column).toBe("archived");
      expect(archived.sourceIssue).toEqual(sourceIssue);

      const restored = await store.unarchiveTask(task.id);
      expect(restored.column).toBe("done");
      expect(restored.sourceIssue).toEqual(sourceIssue);
    });

    it("persists review metadata on create, update, and reload", async () => {
      const review: NonNullable<Task["review"]> = {
        mode: "direct",
        source: "reviewer-agent",
        decision: "changes-requested",
        summary: "Address reviewer findings",
        latestRefreshAt: new Date().toISOString(),
        selectedItemIds: ["rvw-1"],
        items: [
          {
            id: "rvw-1",
            source: "reviewer-agent",
            status: "queued",
            summary: "Fix failing assertion",
            body: "Assertion in task detail modal test is stale.",
            reviewer: "reviewer",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };

      const created = await store.createTask({ description: "Task with review metadata" });
      const updated = await store.updateTask(created.id, { review });
      expect(updated.review).toEqual(review);

      const reloaded = await store.getTask(created.id);
      expect(reloaded.review).toEqual(review);

      const cleared = await store.updateTask(created.id, { review: null });
      expect(cleared.review).toBeUndefined();
    });

    it("persists reviewState independently from legacy review", async () => {
      const created = await store.createTask({ description: "Task with review state" });
      const selectedAt = new Date().toISOString();
      const reviewState: NonNullable<Task["reviewState"]> = {
        source: "pull-request",
        summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [], blockingReasons: [], checks: [] },
        items: [{ id: "ri-1", body: "Fix this", author: { login: "octocat" }, createdAt: selectedAt }],
        addressing: [{
          itemId: "ri-1",
          status: "queued",
          selectedAt,
          snapshot: {
            itemId: "ri-1",
            sourceMode: "pull-request",
            source: "pr-review",
            summary: "Fix this",
            body: "Fix this",
            authorLogin: "octocat",
          },
        }],
      };

      await store.updateTask(created.id, { reviewState });
      const reloaded = await store.getTask(created.id);
      expect(reloaded.reviewState).toEqual(reviewState);
      expect(reloaded.review).toBeUndefined();
    });

    it("hydrates legacy addressing records with snapshots", async () => {
      const created = await store.createTask({ description: "Legacy review state" });
      const selectedAt = new Date().toISOString();
      await store.updateTask(created.id, {
        reviewState: {
          source: "reviewer-agent",
          items: [{
            id: "review-1",
            body: "Update tests for regression",
            summary: "Update tests",
            author: { login: "reviewer" },
            createdAt: selectedAt,
            source: "reviewer-agent",
          }],
          addressing: [{ itemId: "review-1", status: "queued", selectedAt }],
        },
      });

      const reloaded = await store.getTask(created.id);
      expect(reloaded.reviewState?.addressing[0].snapshot).toEqual({
        itemId: "review-1",
        sourceMode: "reviewer-agent",
        source: "reviewer-agent",
        summary: "Update tests",
        body: "Update tests for regression",
        authorLogin: "reviewer",
        filePath: undefined,
        threadId: undefined,
        url: undefined,
      });
    });

    it("preserves review metadata through archive and unarchive", async () => {
      const review: NonNullable<Task["review"]> = {
        mode: "pull-request",
        source: "github-pr",
        decision: "pending",
        summary: "PR review feedback",
        latestRefreshAt: new Date().toISOString(),
        selectedItemIds: ["gh-1"],
        items: [
          {
            id: "gh-1",
            source: "github-pr",
            status: "in-progress",
            summary: "Address thread in src/file.ts",
            filePath: "src/file.ts",
            line: 42,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };
      const task = await store.createTask({ description: "Archive review persistence" });
      await store.updateTask(task.id, { review });

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      const archived = await store.getTask(task.id);
      expect(archived.review).toEqual(review);

      const restored = await store.unarchiveTask(task.id);
      expect(restored.review).toEqual(review);
    });

    it("sets and clears mission linkage fields via updateTask", async () => {
      const task = await createTestTask();

      const linked = await store.updateTask(task.id, {
        missionId: "M-123",
        sliceId: "SL-456",
      });
      expect(linked.missionId).toBe("M-123");
      expect(linked.sliceId).toBe("SL-456");

      const reloaded = await store.getTask(task.id);
      expect(reloaded.missionId).toBe("M-123");
      expect(reloaded.sliceId).toBe("SL-456");

      const cleared = await store.updateTask(task.id, {
        missionId: null,
        sliceId: null,
      });
      expect(cleared.missionId).toBeUndefined();
      expect(cleared.sliceId).toBeUndefined();
    });

    it("preserves mission linkage when updating unrelated fields", async () => {
      const task = await createTestTask();
      await store.updateTask(task.id, {
        missionId: "M-789",
        sliceId: "SL-789",
      });

      const updated = await store.updateTask(task.id, { title: "Linked task" });
      expect(updated.title).toBe("Linked task");
      expect(updated.missionId).toBe("M-789");
      expect(updated.sliceId).toBe("SL-789");
    });

    it("sets thinkingLevel via createTask and updateTask", async () => {
      const created = await store.createTask({
        description: "Task with thinking level",
        thinkingLevel: "high",
      });
      expect(created.thinkingLevel).toBe("high");

      const persisted = await store.getTask(created.id);
      expect(persisted.thinkingLevel).toBe("high");

      const updated = await store.updateTask(created.id, { thinkingLevel: "low" });
      expect(updated.thinkingLevel).toBe("low");

      const reloaded = await store.getTask(created.id);
      expect(reloaded.thinkingLevel).toBe("low");
    });

    it("clears thinkingLevel via null in updateTask", async () => {
      const task = await store.createTask({
        description: "Task with thinking level",
        thinkingLevel: "medium",
      });
      expect(task.thinkingLevel).toBe("medium");

      const updated = await store.updateTask(task.id, { thinkingLevel: null });
      expect(updated.thinkingLevel).toBeUndefined();
    });

    it("preserves thinkingLevel when updating unrelated fields", async () => {
      const task = await store.createTask({
        description: "Task with thinking level",
        thinkingLevel: "high",
      });
      const updated = await store.updateTask(task.id, { title: "Updated title" });
      expect(updated.thinkingLevel).toBe("high");
      expect(updated.title).toBe("Updated title");
    });
  });


  describe("title-id drift normalization", () => {
    it("normalizes foreign fn id and appends log entry", async () => {
      const task = await store.createTask({ description: "x" });
      const updated = await store.updateTask(task.id, { title: "Something FN-9999 something" });
      expect(updated.title).toBe("Something something");
      expect(updated.log.some((entry) => entry.action.includes("Title normalized"))).toBe(true);
    });

    it("does not normalize when row id matches token", async () => {
      const task = await store.createTask({ description: "x" });
      const updated = await store.updateTask(task.id, { title: `Something ${task.id} something` });
      expect(updated.title).toBe(`Something ${task.id} something`);
      expect(updated.log.some((entry) => entry.action.includes("Title normalized"))).toBe(false);
    });

    it("clears title when only foreign token is provided", async () => {
      const task = await store.createTask({ description: "x" });
      const updated = await store.updateTask(task.id, { title: "FN-9999" });
      expect(updated.title).toBeUndefined();
    });
  });

  describe("noCommitsExpected persistence", () => {
    it("round-trips noCommitsExpected=true through create and reload", async () => {
      const created = await store.createTask({
        description: "Decision-only task",
        noCommitsExpected: true,
      });

      expect(created.noCommitsExpected).toBe(true);

      const reloaded = await store.getTask(created.id);
      expect(reloaded.noCommitsExpected).toBe(true);
    });

    it("keeps noCommitsExpected undefined when omitted", async () => {
      const created = await store.createTask({ description: "Regular task" });

      expect(created.noCommitsExpected).toBeUndefined();

      const reloaded = await store.getTask(created.id);
      expect(reloaded.noCommitsExpected).toBeUndefined();
    });

    it("updates noCommitsExpected via updateTask", async () => {
      const created = await store.createTask({ description: "Toggle decision-only" });

      const updated = await store.updateTask(created.id, { noCommitsExpected: true });
      expect(updated.noCommitsExpected).toBe(true);

      const reloaded = await store.getTask(created.id);
      expect(reloaded.noCommitsExpected).toBe(true);
    });
  });

  describe("executionMode persistence", () => {
    it("sets executionMode to 'fast' via createTask and persists", async () => {
      const created = await store.createTask({
        description: "Task with fast execution mode",
        executionMode: "fast",
      });
      expect(created.executionMode).toBe("fast");

      const persisted = await store.getTask(created.id);
      expect(persisted.executionMode).toBe("fast");
    });

    it("sets executionMode to 'standard' via createTask and persists", async () => {
      const created = await store.createTask({
        description: "Task with standard execution mode",
        executionMode: "standard",
      });
      expect(created.executionMode).toBe("standard");

      const persisted = await store.getTask(created.id);
      expect(persisted.executionMode).toBe("standard");
    });

    it("persists executionMode as 'standard' by default when not specified", async () => {
      const created = await store.createTask({
        description: "Task without execution mode",
      });
      // The field should be undefined in the Task object (optional field)
      expect(created.executionMode).toBeUndefined();

      const persisted = await store.getTask(created.id);
      // The persisted value should be 'standard' in the database
      expect(persisted.executionMode).toBeUndefined();
    });

    it("updates executionMode via updateTask", async () => {
      const created = await store.createTask({
        description: "Task for execution mode update",
        executionMode: "standard",
      });
      expect(created.executionMode).toBe("standard");

      const updated = await store.updateTask(created.id, { executionMode: "fast" });
      expect(updated.executionMode).toBe("fast");

      const reloaded = await store.getTask(created.id);
      expect(reloaded.executionMode).toBe("fast");
    });

    it("clears executionMode via null in updateTask", async () => {
      const task = await store.createTask({
        description: "Task with execution mode to clear",
        executionMode: "fast",
      });
      expect(task.executionMode).toBe("fast");

      const updated = await store.updateTask(task.id, { executionMode: null });
      expect(updated.executionMode).toBeUndefined();
    });

    it("preserves executionMode when updating unrelated fields", async () => {
      const task = await store.createTask({
        description: "Task with execution mode to preserve",
        executionMode: "fast",
      });
      const updated = await store.updateTask(task.id, { title: "Updated title" });
      expect(updated.executionMode).toBe("fast");
      expect(updated.title).toBe("Updated title");
    });

    it("returns executionMode in listTasks", async () => {
      await store.createTask({ description: "Fast task", executionMode: "fast" });
      await store.createTask({ description: "Unspecified task" });

      const tasks = await store.listTasks();
      const fastTask = tasks.find((t) => t.description === "Fast task");
      const unspecifiedTask = tasks.find((t) => t.description === "Unspecified task");

      expect(fastTask?.executionMode).toBe("fast");
      expect(unspecifiedTask?.executionMode).toBeUndefined();
    });
  });


  describe("updateTask — PROMPT.md regeneration", () => {
    it("regenerates PROMPT.md when title is updated", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial PROMPT.md
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toContain(`# ${task.id}`);
      expect(initialPrompt).toContain("Test task");

      // Update title
      await store.updateTask(task.id, { title: "New Title" });

      // Verify PROMPT.md was regenerated with new title
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain(`# ${task.id}: New Title`);
      expect(updatedPrompt).toContain("Test task"); // Description preserved
    });

    it("regenerates PROMPT.md when description is updated", async () => {
      const task = await store.createTask({ description: "Old description", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial PROMPT.md
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toContain("Old description");

      // Update description
      await store.updateTask(task.id, { description: "New description" });

      // Verify PROMPT.md was regenerated with new description
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain("New description");
    });

    it("preserves existing steps when regenerating PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with steps", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Write custom steps to PROMPT.md
      const customPrompt = `# ${task.id}: Task with steps

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

Task with steps

## Steps

### Step 1: Custom Step

- [ ] Custom action 1
- [ ] Custom action 2

### Step 2: Another Custom Step

- [ ] Another action
`;
      await writeFile(join(dir, "PROMPT.md"), customPrompt);

      // Update title
      await store.updateTask(task.id, { title: "Updated Title" });

      // Verify custom steps are preserved
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain(`# ${task.id}: Updated Title`);
      expect(updatedPrompt).toContain("### Step 1: Custom Step");
      expect(updatedPrompt).toContain("- [ ] Custom action 1");
      expect(updatedPrompt).toContain("### Step 2: Another Custom Step");
      expect(updatedPrompt).toContain("- [ ] Another action");
    });

    it("preserves file scope when regenerating PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with file scope", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Write PROMPT.md with custom file scope
      const customPrompt = `# ${task.id}: Task with file scope

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

Task with file scope

## File Scope

- \`src/store.ts\`
- \`src/db.ts\`
`;
      await writeFile(join(dir, "PROMPT.md"), customPrompt);

      // Update description
      await store.updateTask(task.id, { description: "Updated description" });

      // Verify file scope is preserved
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain("Updated description");
      expect(updatedPrompt).toContain("## File Scope");
      expect(updatedPrompt).toContain("`src/store.ts`");
      expect(updatedPrompt).toContain("`src/db.ts`");
    });

    it("preserves dependencies section when regenerating PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with deps", column: "todo", dependencies: ["KB-001"] });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial PROMPT.md has dependencies
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toContain("## Dependencies");
      expect(initialPrompt).toContain("- **Task:** KB-001");

      // Update title
      await store.updateTask(task.id, { title: "Updated Title" });

      // Verify dependencies section is preserved
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain("## Dependencies");
      expect(updatedPrompt).toContain("- **Task:** KB-001");
    });

    it("preserves acceptance criteria section when regenerating PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with acceptance criteria", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Write PROMPT.md with acceptance criteria
      const customPrompt = `# ${task.id}: Task with acceptance criteria

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

Task with acceptance criteria

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
`;
      await writeFile(join(dir, "PROMPT.md"), customPrompt);

      // Update description
      await store.updateTask(task.id, { description: "Updated description" });

      // Verify acceptance criteria is preserved
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toContain("Updated description");
      expect(updatedPrompt).toContain("## Acceptance Criteria");
      expect(updatedPrompt).toContain("- [ ] Criterion 1");
      expect(updatedPrompt).toContain("- [ ] Criterion 2");
      expect(updatedPrompt).toContain("- [ ] Criterion 3");
    });

    it("updates simple PROMPT.md for triage tasks", async () => {
      const task = await store.createTask({ description: "Triage task", column: "triage" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial simple format
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toBe(`# ${task.id}\n\nTriage task\n`);

      // Update title
      await store.updateTask(task.id, { title: "Updated Title" });

      // Verify simple format is maintained but updated
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toBe(`# ${task.id}: Updated Title\n\nTriage task\n`);
    });

    it("updates description in simple PROMPT.md for triage tasks", async () => {
      const task = await store.createTask({ title: "My Task", description: "Original desc", column: "triage" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Verify initial simple format
      const initialPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(initialPrompt).toBe(`# ${task.id}: My Task\n\nOriginal desc\n`);

      // Update description
      await store.updateTask(task.id, { description: "Updated desc" });

      // Verify simple format is maintained but updated
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toBe(`# ${task.id}: My Task\n\nUpdated desc\n`);
    });

    it("does not regenerate PROMPT.md when explicit prompt is provided", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Update with explicit prompt
      const customPrompt = "# Custom\n\nCustom prompt content";
      await store.updateTask(task.id, { title: "Updated Title", prompt: customPrompt });

      // Verify the explicit prompt was used, not regenerated
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toBe(customPrompt);
    });

    it("does not regenerate PROMPT.md when neither title nor description changes", async () => {
      const task = await store.createTask({ description: "Test task", column: "todo" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      
      // Write custom PROMPT.md
      const customPrompt = `# ${task.id}\n\n**Created:** 2024-01-01\n**Size:** L\n\n## Mission\n\nTest task\n\n## Custom Section\n\nCustom content\n`;
      await writeFile(join(dir, "PROMPT.md"), customPrompt);

      // Update worktree only
      await store.updateTask(task.id, { worktree: "/tmp/worktree" });

      // Verify PROMPT.md was not changed
      const updatedPrompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(updatedPrompt).toBe(customPrompt);
    });
  });


  describe("mergeDetails via updateTask", () => {
    it("can set mergeDetails on a task", async () => {
      const task = await store.createTask({ description: "test merge details" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const mergeDetails = {
        commitSha: "abc123",
        filesChanged: 5,
        insertions: 10,
        deletions: 3,
        mergeCommitMessage: "Merge task",
        mergedAt: new Date().toISOString(),
        mergeConfirmed: true,
      };

      const updated = await store.updateTask(task.id, { mergeDetails });
      expect(updated.mergeDetails).toEqual(mergeDetails);

      // Verify it persists
      const reloaded = await store.getTask(task.id);
      expect(reloaded.mergeDetails).toEqual(mergeDetails);
    });

    it("can clear mergeDetails by passing null", async () => {
      const task = await store.createTask({ description: "test merge details clear" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.updateTask(task.id, {
        mergeDetails: { commitSha: "abc123", mergeConfirmed: true },
      });

      const cleared = await store.updateTask(task.id, { mergeDetails: null });
      expect(cleared.mergeDetails).toBeUndefined();
    });

    it("does not modify mergeDetails when not included in updates", async () => {
      const task = await store.createTask({ description: "test merge details no-op" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      await store.updateTask(task.id, {
        mergeDetails: { commitSha: "def456", mergeConfirmed: true },
      });

      // Update something unrelated
      const updated = await store.updateTask(task.id, { summary: "some summary" });
      expect(updated.mergeDetails).toEqual({ commitSha: "def456", mergeConfirmed: true });
    });
  });

  describe("updateTaskAtomic", () => {
    it("serializes read-merge-write patches against the freshest task snapshot", async () => {
      const task = await store.createTask({ description: "atomic task projection" });
      let releaseFirst: () => void = () => {};
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirstRead: () => void = () => {};
      const firstRead = new Promise<void>((resolve) => {
        markFirstRead = resolve;
      });

      const first = store.updateTaskAtomic(task.id, async (current) => {
        markFirstRead();
        expect(current.modifiedFiles).toBeUndefined();
        await firstCanFinish;
        return {
          modifiedFiles: [...new Set([...(current.modifiedFiles ?? []), "src/a.ts"])].sort(),
          mergeDetails: { ...(current.mergeDetails ?? {}), filesChanged: 1 },
        };
      });

      await firstRead;

      const second = store.updateTaskAtomic(task.id, (current) => ({
        modifiedFiles: [...new Set([...(current.modifiedFiles ?? []), "src/b.ts"])].sort(),
        mergeDetails: { ...(current.mergeDetails ?? {}), insertions: 2 },
      }));

      releaseFirst();
      await Promise.all([first, second]);

      const updated = await store.getTask(task.id);
      expect(updated.modifiedFiles).toEqual(["src/a.ts", "src/b.ts"]);
      expect(updated.mergeDetails).toEqual({ filesChanged: 1, insertions: 2 });
    });
  });


});
