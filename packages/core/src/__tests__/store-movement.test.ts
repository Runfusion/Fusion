import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";

import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { TaskStore, TaskHasDependentsError, TransitionRejectionError } from "../store.js";
import { TASK_DONE_BYPASS_BLOCKER_MESSAGE, allowsAutoMergeProcessing, resolveEffectiveAutoMerge } from "../task-merge.js";
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

  describe("listTasks startup memo invalidation", () => {
    it("returns fresh slim task state after moveTask writes task json", async () => {
      const task = await store.createTask({ description: "memo invalidation after move" });
      await store.moveTask(task.id, "todo");

      const beforeMove = await store.listTasks({ slim: true, includeArchived: false, startupMemo: true });
      expect(beforeMove.find((listed) => listed.id === task.id)?.column).toBe("todo");

      await store.moveTask(task.id, "in-progress");

      const afterMove = await store.listTasks({ slim: true, includeArchived: false, startupMemo: true });
      expect(afterMove.find((listed) => listed.id === task.id)?.column).toBe("in-progress");
    });
  });

  describe("moveTask — in-progress to triage", () => {
    it("allows moving an in-progress task to triage", async () => {
      const task = await store.createTask({ description: "test in-progress to triage" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.column).toBe("triage");
    });
  });

  describe("moveTask — maxWorktrees hard active-worktree cap", () => {
    async function createActiveHolder(index: number): Promise<Task> {
      const task = await store.createTask({ description: `active holder ${index}` });
      await store.moveTask(task.id, "todo");
      return store.moveTask(task.id, "in-progress", {
        moveSource: "scheduler",
        allocateWorktree: () => `/tmp/fn-7373-holder-${index}`,
      });
    }

    it("rejects a fifth allocated in-progress move when maxWorktrees is 4 and maxConcurrent is higher", async () => {
      await store.updateSettings({ maxWorktrees: 4, maxConcurrent: 10 });
      for (let i = 0; i < 4; i += 1) {
        await createActiveHolder(i);
      }
      const fifth = await store.createTask({ description: "fifth holder" });
      await store.moveTask(fifth.id, "todo");

      await expect(store.moveTask(fifth.id, "in-progress", {
        moveSource: "scheduler",
        allocateWorktree: () => "/tmp/fn-7373-holder-5",
      })).rejects.toMatchObject({
        rejection: expect.objectContaining({ code: "capacity-exhausted", retryable: true }),
      } satisfies Partial<TransitionRejectionError>);

      const active = (await store.listTasks({ includeArchived: false })).filter((task) => task.column === "in-progress");
      expect(active).toHaveLength(4);
      expect((await store.getTask(fifth.id))?.column).toBe("todo");
    });

    it("serializes racing allocated moves so only one final maxWorktrees slot is committed", async () => {
      await store.updateSettings({ maxWorktrees: 4, maxConcurrent: 10 });
      for (let i = 0; i < 3; i += 1) {
        await createActiveHolder(i);
      }
      const contenders = await Promise.all([
        store.createTask({ description: "race contender a" }),
        store.createTask({ description: "race contender b" }),
      ]);
      for (const contender of contenders) {
        await store.moveTask(contender.id, "todo");
      }

      const results = await Promise.allSettled(contenders.map((contender, index) =>
        store.moveTask(contender.id, "in-progress", {
          moveSource: "scheduler",
          allocateWorktree: () => `/tmp/fn-7373-race-${index}`,
        }),
      ));

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const active = (await store.listTasks({ includeArchived: false })).filter((task) => task.column === "in-progress");
      expect(active).toHaveLength(4);
      const activeContenders = contenders.filter((contender) => active.some((task) => task.id === contender.id));
      expect(activeContenders).toHaveLength(1);
    });

    it("does not count idle in-review worktrees against maxWorktrees active allocation", async () => {
      await store.updateSettings({ maxWorktrees: 1, maxConcurrent: 10 });
      for (let i = 0; i < 3; i += 1) {
        const reviewing = await createActiveHolder(i);
        await store.moveTask(reviewing.id, "in-review", { moveSource: "engine", allowDirectInReviewMove: true });
        await store.updateTask(reviewing.id, { worktree: `/tmp/fn-7373-review-${i}` });
      }
      const next = await store.createTask({ description: "next active holder" });
      await store.moveTask(next.id, "todo");

      const moved = await store.moveTask(next.id, "in-progress", {
        moveSource: "scheduler",
        allocateWorktree: () => "/tmp/fn-7373-next-active",
      });

      expect(moved.column).toBe("in-progress");
      expect(moved.worktree).toBe("/tmp/fn-7373-next-active");
      expect((await store.listTasks({ includeArchived: false })).filter((task) => task.column === "in-progress")).toHaveLength(1);
    });
  });

  describe("moveTask — autoMerge follows live settings on in-review", () => {
    async function createInProgressTask(description: string): Promise<Task> {
      const task = await store.createTask({ description });
      await store.moveTask(task.id, "todo");
      return store.moveTask(task.id, "in-progress");
    }

    it("does not snapshot global autoMerge=true when task override is undefined", async () => {
      await store.updateSettings({ autoMerge: true });
      const task = await createInProgressTask("no snapshot true");

      const moved = await store.moveTask(task.id, "in-review");

      expect(moved.autoMerge).toBeUndefined();
      expect(moved.autoMergeProvenance).toBeUndefined();
      expect(allowsAutoMergeProcessing(moved, { autoMerge: true })).toBe(true);
      expect(allowsAutoMergeProcessing(moved, { autoMerge: false })).toBe(false);
    });

    it("does not snapshot global autoMerge=false when task override is undefined", async () => {
      await store.updateSettings({ autoMerge: false });
      const task = await createInProgressTask("no snapshot false");

      const moved = await store.moveTask(task.id, "in-review");

      expect(moved.autoMerge).toBeUndefined();
      expect(moved.autoMergeProvenance).toBeUndefined();
      expect(resolveEffectiveAutoMerge(moved, { autoMerge: false })).toBe(false);
      expect(resolveEffectiveAutoMerge(moved, { autoMerge: true })).toBe(true);
    });

    it("tracks live global toggles for undefined while preserving explicit overrides", async () => {
      await store.updateSettings({ autoMerge: true });
      const inherited = await createInProgressTask("inherits live global");
      const inheritedMoved = await store.moveTask(inherited.id, "in-review");

      expect(inheritedMoved.autoMerge).toBeUndefined();
      expect(inheritedMoved.autoMergeProvenance).toBeUndefined();
      expect(allowsAutoMergeProcessing(inheritedMoved, { autoMerge: false })).toBe(false);
      expect(allowsAutoMergeProcessing(inheritedMoved, { autoMerge: true })).toBe(true);

      const explicitTrue = await createInProgressTask("explicit true override");
      await store.updateTask(explicitTrue.id, { autoMerge: true });
      const explicitTrueWithProvenance = await store.getTask(explicitTrue.id);
      expect(explicitTrueWithProvenance?.autoMergeProvenance).toBe("user");
      const explicitTrueMoved = await store.moveTask(explicitTrue.id, "in-review");
      expect(explicitTrueMoved.autoMerge).toBe(true);
      expect(explicitTrueMoved.autoMergeProvenance).toBe("user");
      expect(allowsAutoMergeProcessing(explicitTrueMoved, { autoMerge: false })).toBe(true);
      expect(resolveEffectiveAutoMerge(explicitTrueMoved, { autoMerge: false })).toBe(true);

      const explicitFalse = await createInProgressTask("explicit false override");
      await store.updateTask(explicitFalse.id, { autoMerge: false });
      const explicitFalseWithProvenance = await store.getTask(explicitFalse.id);
      expect(explicitFalseWithProvenance?.autoMergeProvenance).toBe("user");
      const explicitFalseMoved = await store.moveTask(explicitFalse.id, "in-review");
      expect(explicitFalseMoved.autoMerge).toBe(false);
      expect(explicitFalseMoved.autoMergeProvenance).toBe("user");
      expect(allowsAutoMergeProcessing(explicitFalseMoved, { autoMerge: false })).toBe(false);
      expect(resolveEffectiveAutoMerge(explicitFalseMoved, { autoMerge: false })).toBe(false);
      expect(resolveEffectiveAutoMerge(explicitFalseMoved, { autoMerge: true })).toBe(false);

      await store.updateTask(explicitFalse.id, { autoMerge: null });
      const cleared = await store.getTask(explicitFalse.id);
      expect(cleared?.autoMerge).toBeUndefined();
      expect(cleared?.autoMergeProvenance).toBeUndefined();
    });
  });

  describe("moveTask — resets steps when moving back to todo/triage", () => {
    async function setMixedStepStatuses(taskId: string): Promise<void> {
      await store.updateStep(taskId, 0, "done");
      await store.updateStep(taskId, 1, "in-progress");
      await store.updateStep(taskId, 2, "pending");
    }

    it("resets all steps to pending and currentStep to 0 when moving from in-progress to todo", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateTask(task.id, { currentStep: 2 });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("resets all steps to pending and currentStep to 0 when moving from in-progress to triage", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateTask(task.id, { currentStep: 1 });

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("preserves step progress when moving in-progress → todo with preserveResumeState option", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateTask(task.id, { currentStep: 2 });

      const moved = await store.moveTask(task.id, "todo", { preserveResumeState: true });

      expect(moved.steps[0].status).toBe("done");
      expect(moved.steps[1].status).toBe("in-progress");
      expect(moved.steps[2].status).toBe("pending");
      expect(moved.currentStep).toBe(2);
    });

    it("preserves step progress and currentStep when moving in-progress → todo with preserveProgress", async () => {
      const task = await createTaskWithSteps();
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Checkbox keep

## Steps

### Step 0: Preflight

- [x] Done thing

### Step 1: Implement

- [ ] Pending thing

### Step 2: Verify

- [ ] Pending thing
`,
      );

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateTask(task.id, {
        currentStep: 2,
        worktree: "/tmp/worktree",
        executionStartedAt: new Date().toISOString(),
        executionCompletedAt: new Date().toISOString(),
      });

      const moved = await store.moveTask(task.id, "todo", { preserveProgress: true });
      const prompt = await readFile(join(dir, "PROMPT.md"), "utf-8");

      expect(moved.steps[0].status).toBe("done");
      expect(moved.steps[1].status).toBe("in-progress");
      expect(moved.currentStep).toBe(2);
      expect(moved.worktree).toBeUndefined();
      expect(moved.executionStartedAt).toBeUndefined();
      expect(moved.executionCompletedAt).toBeUndefined();
      expect(prompt).toContain("- [x] Done thing");
    });

    it("still resets when preserveProgress is true but all steps are pending", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      await store.updateStep(task.id, 0, "pending");
      await store.updateStep(task.id, 1, "pending");
      await store.updateTask(task.id, { currentStep: 2 });

      const moved = await store.moveTask(task.id, "todo", { preserveProgress: true });

      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("preserves steps for in-review → todo and done → todo with preserveProgress", async () => {
      const fromReview = await createTaskWithSteps();
      await store.moveTask(fromReview.id, "todo");
      await store.moveTask(fromReview.id, "in-progress");
      await setMixedStepStatuses(fromReview.id);
      await store.moveTask(fromReview.id, "in-review");
      await store.updateTask(fromReview.id, { currentStep: 1, executionStartedAt: new Date().toISOString() });

      const reviewMoved = await store.moveTask(fromReview.id, "todo", { preserveProgress: true });
      expect(reviewMoved.steps[0].status).toBe("done");
      expect(reviewMoved.steps[1].status).toBe("in-progress");
      expect(reviewMoved.currentStep).toBe(1);
      expect(reviewMoved.executionStartedAt).toBeUndefined();

      const fromDone = await createTaskWithSteps();
      await store.moveTask(fromDone.id, "todo");
      await store.moveTask(fromDone.id, "in-progress");
      await setMixedStepStatuses(fromDone.id);
      await store.updateStep(fromDone.id, 1, "done");
      await store.updateStep(fromDone.id, 2, "done");
      await store.moveTask(fromDone.id, "in-review");
      await store.moveTask(fromDone.id, "done");
      await store.updateTask(fromDone.id, { currentStep: 2, executionStartedAt: new Date().toISOString() });

      const doneMoved = await store.moveTask(fromDone.id, "todo", { preserveProgress: true });
      expect(doneMoved.steps[0].status).toBe("done");
      expect(doneMoved.steps[1].status).toBe("done");
      expect(doneMoved.currentStep).toBe(2);
      expect(doneMoved.executionStartedAt).toBeUndefined();
    });

    it("preserveResumeState keeps step progress and timing but always releases the worktree", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await setMixedStepStatuses(task.id);
      const startedAt = new Date().toISOString();
      await store.updateTask(task.id, {
        currentStep: 2,
        worktree: "/tmp/worktree",
        branch: "fusion/fn-test",
        executionStartedAt: startedAt,
        executionCompletedAt: new Date().toISOString(),
      });

      const moved = await store.moveTask(task.id, "todo", {
        preserveProgress: true,
        preserveResumeState: true,
      });

      expect(moved.steps[0].status).toBe("done");
      expect(moved.steps[1].status).toBe("in-progress");
      expect(moved.currentStep).toBe(2);
      // Worktree is always released on requeue so the directory can be
      // reused by another task; the branch stays so progress is kept.
      expect(moved.worktree).toBeUndefined();
      expect(moved.branch).toBe("fusion/fn-test");
      expect(moved.executionStartedAt).toBe(startedAt);
      expect(moved.executionCompletedAt).toBeUndefined();

      // Round-trip: when the task is re-promoted to in-progress with a
      // fresh allocator, the branch reference must survive the requeue
      // so the executor can reattach to it via createFromExistingBranch
      // and resume the in-flight changes. Guards against regressions in
      // the in-review → todo full-reset path leaking into other paths.
      const repromoted = await store.moveTask(task.id, "in-progress", {
        allocateWorktree: () => "/tmp/worktree-fresh",
      });
      expect(repromoted.branch).toBe("fusion/fn-test");
      expect(repromoted.worktree).toBe("/tmp/worktree-fresh");
    });

    it("preserveWorktree keeps the directory across an internal bounce", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, { worktree: "/tmp/wt-bounce" });

      const moved = await store.moveTask(task.id, "todo", {
        preserveResumeState: true,
        preserveWorktree: true,
      });

      // The bounce path keeps the same checkout assigned so listeners
      // never observe an interim worktree=null state and self-healing
      // can't reclaim the directory as idle.
      expect(moved.worktree).toBe("/tmp/wt-bounce");
    });

    it("allocateWorktree assigns a path under the cross-task lock and avoids names already in use", async () => {
      const a = await createTaskWithSteps();
      const b = await createTaskWithSteps();
      await store.moveTask(a.id, "todo");
      await store.moveTask(a.id, "in-progress");
      await store.updateTask(a.id, { worktree: "/tmp/.worktrees/eager-daisy" });
      await store.moveTask(b.id, "todo");

      const seenReserved: Set<string>[] = [];
      const moved = await store.moveTask(b.id, "in-progress", {
        allocateWorktree: (reservedNames) => {
          seenReserved.push(new Set(reservedNames));
          // Caller picks a name; if it collides with reservedNames the
          // caller is responsible for choosing a different one. Here we
          // assert the reservedNames snapshot reflects task A's
          // assignment, then return a non-colliding path.
          return "/tmp/.worktrees/swift-falcon";
        },
      });

      expect(seenReserved).toHaveLength(1);
      expect(seenReserved[0].has("eager-daisy")).toBe(true);
      // The allocator's task itself must not appear in reservedNames —
      // a task should never be told to avoid its own current name.
      expect(seenReserved[0].has("swift-falcon")).toBe(false);
      expect(moved.worktree).toBe("/tmp/.worktrees/swift-falcon");
    });

    it("resets steps when moving from in-review to todo", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      const withSteps = await store.getTask(task.id);
      await store.updateTask(task.id, {
        steps: withSteps.steps.map((step) => ({ ...step, status: "done" })),
        currentStep: 2,
      });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("resets steps when moving from done to todo", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      const withDoneSteps = await store.getTask(task.id);
      await store.updateTask(task.id, {
        steps: withDoneSteps.steps.map((step) => ({ ...step, status: "done" })),
        currentStep: 2,
      });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("resets steps when moving from done to triage", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      const withDoneSteps = await store.getTask(task.id);
      await store.updateTask(task.id, {
        steps: withDoneSteps.steps.map((step) => ({ ...step, status: "done" })),
        currentStep: 2,
      });

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.steps.every((step) => step.status === "pending")).toBe(true);
      expect(moved.currentStep).toBe(0);
    });

    it("does not reset steps when moving from todo to triage", async () => {
      const task = await createTaskWithSteps();
      await store.moveTask(task.id, "todo");
      await store.updateStep(task.id, 0, "done");

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.steps[0]?.status).toBe("done");
    });

    it("resets PROMPT.md checkboxes when moving from in-progress to todo", async () => {
      const task = await createTaskWithSteps();
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Checkbox reset

## Steps

### Step 0: Preflight

- [x] Done thing

### Step 1: Implement

- [x] Done thing
`,
      );

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "todo");

      const prompt = await readFile(join(dir, "PROMPT.md"), "utf-8");
      expect(prompt).not.toContain("- [x]");
      expect(prompt).toContain("- [ ] Done thing");
    });

    it("is a no-op when steps array is empty", async () => {
      const task = await store.createTask({ description: "no steps reset" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.moveTask(task.id, "todo")).resolves.toMatchObject({ id: task.id, column: "todo" });
    });

    it("treats same-column moves as a no-op", async () => {
      const task = await store.createTask({ description: "same column no-op", column: "todo" });

      await expect(store.moveTask(task.id, "todo")).resolves.toMatchObject({ id: task.id, column: "todo" });
    });
  });


  describe("moveTask — clears transient fields when leaving in-progress", () => {
    it("clears status, error, worktree, and blockedBy when moving from in-progress to todo", async () => {
      const task = await store.createTask({ description: "test clear fields" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Simulate a failed state
      await store.updateTask(task.id, {
        status: "failed",
        error: "Something went wrong",
        worktree: "test-worktree",
        blockedBy: "FN-001"
      });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.column).toBe("todo");
      expect(moved.status).toBeUndefined();
      expect(moved.error).toBeUndefined();
      expect(moved.worktree).toBeUndefined();
      expect(moved.blockedBy).toBeUndefined();
    });

    it("clears status, error, worktree, and blockedBy when moving from in-progress to triage", async () => {
      const task = await store.createTask({ description: "test clear fields to triage" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Simulate a failed state
      await store.updateTask(task.id, {
        status: "failed",
        error: "Something went wrong",
        worktree: "test-worktree",
        blockedBy: "FN-001"
      });

      const moved = await store.moveTask(task.id, "triage");
      expect(moved.column).toBe("triage");
      expect(moved.status).toBeUndefined();
      expect(moved.error).toBeUndefined();
      expect(moved.worktree).toBeUndefined();
      expect(moved.blockedBy).toBeUndefined();
    });

    it("preserves status when moving from todo to in-progress", async () => {
      const task = await store.createTask({ description: "test preserve status", column: "todo" });

      // Set a custom status before moving to in-progress
      await store.updateTask(task.id, { status: "planning" });

      const moved = await store.moveTask(task.id, "in-progress");
      expect(moved.column).toBe("in-progress");
      expect(moved.status).toBe("planning");
    });

    it("does not clear status when moving between non-in-progress columns", async () => {
      const task = await store.createTask({ description: "test non-in-progress move" });
      // Task starts in triage

      // Set a custom status
      await store.updateTask(task.id, { status: "custom-status" });

      // Move from triage to todo
      const moved = await store.moveTask(task.id, "todo");
      expect(moved.column).toBe("todo");
      expect(moved.status).toBe("custom-status");
    });

    it("clears status, error, worktree, and blockedBy when moving from in-progress to done", async () => {
      const task = await store.createTask({ description: "test clear fields to done" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Simulate transient state that should not block completion
      await store.updateTask(task.id, {
        status: "custom-status",
        error: "Transient note",
        worktree: "test-worktree",
        blockedBy: "FN-001"
      });

      // Must go through in-review to reach done
      await store.moveTask(task.id, "in-review");
      const moved = await store.moveTask(task.id, "done");
      expect(moved.column).toBe("done");
      expect(moved.status).toBeUndefined();
      expect(moved.error).toBeUndefined();
      expect(moved.worktree).toBeUndefined();
      expect(moved.blockedBy).toBeUndefined();
    });

    it("clears recovery fields when moving to done (FN-985 regression)", async () => {
      const task = await store.createTask({ description: "test recovery fields" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Set recovery metadata via updateTask
      await store.updateTask(task.id, {
        recoveryRetryCount: 3,
        nextRecoveryAt: new Date(Date.now() + 86400000).toISOString(),
      });

      await store.moveTask(task.id, "in-review");
      const moved = await store.moveTask(task.id, "done");
      expect(moved.column).toBe("done");
      expect(moved.recoveryRetryCount).toBeUndefined();
      expect(moved.nextRecoveryAt).toBeUndefined();
    });

    it("treats repeated done finalization as an idempotent no-op", async () => {
      const task = await store.createTask({ description: "test repeated done finalization" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      const done = await store.moveTask(task.id, "done");

      const repeated = await store.moveTask(task.id, "done");

      expect(repeated.column).toBe("done");
      expect(repeated.updatedAt).toBe(done.updatedAt);
    });

    it("normalizes stale completion fields on repeated done finalization", async () => {
      const task = await store.createTask({ description: "test repeated dirty done finalization" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.updateTask(task.id, {
        status: "failed",
        error: "stale failure",
        blockedBy: "FN-000",
        worktree: "/tmp/fusion-stale-worktree",
        recoveryRetryCount: 2,
        nextRecoveryAt: new Date(Date.now() + 86400000).toISOString(),
      });

      const repeated = await store.moveTask(task.id, "done");

      expect(repeated.column).toBe("done");
      expect(repeated.status).toBeUndefined();
      expect(repeated.error).toBeUndefined();
      expect(repeated.blockedBy).toBeUndefined();
      expect(repeated.worktree).toBeUndefined();
      expect(repeated.recoveryRetryCount).toBeUndefined();
      expect(repeated.nextRecoveryAt).toBeUndefined();
    });

    it("blocks moving failed in-review tasks to done", async () => {
      const task = await store.createTask({ description: "test block failed review task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, {
        status: "failed",
        error: "Workflow step failed",
      });

      await store.moveTask(task.id, "in-review");

      await expect(store.moveTask(task.id, "done")).rejects.toThrow(
        "Cannot move",
      );
    });

    it("blocks moving in-review tasks with incomplete steps to done", async () => {
      const task = await store.createTask({ description: "test block incomplete review task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, { prompt: "## Steps\n### Step 0: First\n### Step 1: Second" });
      await store.updateStep(task.id, 0, "done");
      await store.updateStep(task.id, 1, "in-progress");

      await store.moveTask(task.id, "in-review");

      await expect(store.moveTask(task.id, "done")).rejects.toThrow(
        "task has incomplete steps",
      );
    });

    it("blocks workflow task done bypass without merge proof", async () => {
      const task = await store.createTask({ description: "test workflow done bypass guard", workflowId: "builtin:coding" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      await expect(store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true }))
        .rejects.toThrow(TASK_DONE_BYPASS_BLOCKER_MESSAGE);

      const events = store.getRunAuditEvents({ taskId: task.id, mutationType: "task:finalize-unproven-blocked" });
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toMatchObject({
        from: "in-review",
        to: "done",
        reason: TASK_DONE_BYPASS_BLOCKER_MESSAGE,
        workflowId: "builtin:coding",
      });
    });

    it("allows workflow task done bypass with merge proof", async () => {
      const task = await store.createTask({ description: "test workflow done bypass proof", workflowId: "builtin:coding" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      const moved = await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });

      expect(moved.column).toBe("done");
    });

    it("allows explicit no-commits workflow task done bypass", async () => {
      const task = await store.createTask({
        description: "test workflow done bypass no commits",
        workflowId: "builtin:coding",
        noCommitsExpected: true,
      });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      const moved = await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });

      expect(moved.column).toBe("done");
    });

    it("blocks default workflow work-item done bypass without explicit selection", async () => {
      const task = await store.createTask({ description: "test default workflow work item done bypass guard" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      store.upsertWorkflowWorkItem({
        taskId: task.id,
        runId: "run-default-workflow",
        nodeId: "merge-attempt",
        kind: "merge",
      });

      await expect(store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true }))
        .rejects.toThrow(TASK_DONE_BYPASS_BLOCKER_MESSAGE);
    });

    it("allows reopening done tasks back to todo", async () => {
      const task = await store.createTask({ description: "test reopen done task to todo" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      const reopened = await store.moveTask(task.id, "todo");
      expect(reopened.column).toBe("todo");
    });

    it("allows reopening done tasks back to triage and clears transient execution state", async () => {
      const task = await store.createTask({ description: "test reopen done task to triage" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.updateTask(task.id, {
        status: "failed",
        error: "stale completion error",
        worktree: "stale-worktree",
        blockedBy: "FN-123",
        workflowStepResults: [{
          workflowStepId: "wf-1",
          workflowStepName: "Workflow step 1",
          status: "passed",
          startedAt: new Date().toISOString(),
        }],
      });

      const reopened = await store.moveTask(task.id, "triage");
      expect(reopened.column).toBe("triage");
      expect(reopened.status).toBeUndefined();
      expect(reopened.error).toBeUndefined();
      expect(reopened.worktree).toBeUndefined();
      expect(reopened.blockedBy).toBeUndefined();
      expect(reopened.workflowStepResults).toBeUndefined();
    });

    it("allows retrying in-review tasks back to todo and clears transient fields", async () => {
      const task = await store.createTask({ description: "test retry in-review task to todo" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: "completed",
        error: "stale error",
        worktree: "stale-worktree",
        blockedBy: "FN-456",
        branch: "fn/stale-branch",
        baseBranch: "main",
        baseCommitSha: "abc123",
        summary: "stale summary from prior attempt",
        recoveryRetryCount: 2,
        nextRecoveryAt: new Date().toISOString(),
        workflowStepResults: [{
          workflowStepId: "wf-1",
          workflowStepName: "Workflow step 1",
          status: "passed",
          startedAt: new Date().toISOString(),
        }],
      });

      const retried = await store.moveTask(task.id, "todo");
      expect(retried.column).toBe("todo");
      expect(retried.status).toBeUndefined();
      expect(retried.error).toBeUndefined();
      expect(retried.worktree).toBeUndefined();
      expect(retried.blockedBy).toBeUndefined();
      expect(retried.workflowStepResults).toBeUndefined();
      // Full reset: prior branch/summary/recovery state discarded so the next
      // run starts from scratch.
      expect(retried.branch).toBeUndefined();
      expect(retried.baseBranch).toBe("main");
      expect(retried.executionStartBranch).toBeUndefined();
      expect(retried.baseCommitSha).toBeUndefined();
      expect(retried.summary).toBeUndefined();
      expect(retried.recoveryRetryCount).toBeUndefined();
      expect(retried.nextRecoveryAt).toBeUndefined();
    });

    it("allows respec'ing in-review tasks back to triage and clears transient fields", async () => {
      const task = await store.createTask({ description: "test respec in-review task to triage" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, {
        status: "completed",
        error: "stale error",
        worktree: "stale-worktree",
        blockedBy: "FN-456",
        branch: "fn/stale-branch",
        baseBranch: "main",
        baseCommitSha: "abc123",
        summary: "stale summary from prior attempt",
        recoveryRetryCount: 2,
        nextRecoveryAt: new Date().toISOString(),
        workflowStepResults: [{
          workflowStepId: "wf-1",
          workflowStepName: "Workflow step 1",
          status: "passed",
          startedAt: new Date().toISOString(),
        }],
      });

      const respec = await store.moveTask(task.id, "triage");
      expect(respec.column).toBe("triage");
      expect(respec.status).toBeUndefined();
      expect(respec.error).toBeUndefined();
      expect(respec.worktree).toBeUndefined();
      expect(respec.blockedBy).toBeUndefined();
      expect(respec.workflowStepResults).toBeUndefined();
      expect(respec.branch).toBeUndefined();
      expect(respec.baseBranch).toBe("main");
      expect(respec.executionStartBranch).toBeUndefined();
      expect(respec.baseCommitSha).toBeUndefined();
      expect(respec.summary).toBeUndefined();
      expect(respec.recoveryRetryCount).toBeUndefined();
      expect(respec.nextRecoveryAt).toBeUndefined();
    });

    // FN-3964 regression: reopen transitions must clear paused state
    it("clears paused and pausedByAgentId when reopening in-progress+paused task to todo", async () => {
      const task = await store.createTask({ description: "test reopen clears paused" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      // Simulate a paused task (e.g., from a stuck/retry flow)
      await store.updateTask(task.id, {
        paused: true,
        pausedByAgentId: "agent-test-001",
        status: "failed",
        error: "Something went wrong",
      });

      const moved = await store.moveTask(task.id, "todo");
      expect(moved.column).toBe("todo");
      expect(moved.paused).toBeUndefined();
      expect(moved.pausedByAgentId).toBeUndefined();
      expect(moved.status).toBeUndefined();
      expect(moved.error).toBeUndefined();
    });

    it("clears paused and pausedByAgentId when reopening done+paused task to triage", async () => {
      const task = await store.createTask({ description: "test reopen done to triage clears paused" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");

      // Simulate stale paused state on a done task
      await store.updateTask(task.id, {
        paused: true,
        pausedByAgentId: "agent-test-002",
      });

      const reopened = await store.moveTask(task.id, "triage");
      expect(reopened.column).toBe("triage");
      expect(reopened.paused).toBeUndefined();
      expect(reopened.pausedByAgentId).toBeUndefined();
    });

    it("clears paused when reopening in-review task to todo", async () => {
      const task = await store.createTask({ description: "test reopen in-review to todo clears paused" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      // Simulate paused state during review
      await store.updateTask(task.id, {
        paused: true,
        pausedByAgentId: "agent-test-003",
        status: "failed",
        error: "Review failed",
      });

      const retried = await store.moveTask(task.id, "todo");
      expect(retried.column).toBe("todo");
      expect(retried.paused).toBeUndefined();
      expect(retried.pausedByAgentId).toBeUndefined();
    });
  });


  describe("columnMovedAt", () => {
    it("createTask sets columnMovedAt", async () => {
      const before = new Date().toISOString();
      const task = await store.createTask({ description: "test columnMovedAt" });
      const after = new Date().toISOString();
      expect(task.columnMovedAt).toBeDefined();
      expect(task.columnMovedAt! >= before).toBe(true);
      expect(task.columnMovedAt! <= after).toBe(true);
    });

    it("moveTask sets columnMovedAt to a recent ISO timestamp", async () => {
      const task = await store.createTask({ description: "move test", column: "triage" });
      const originalMovedAt = task.columnMovedAt;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));

      const before = new Date().toISOString();
      const moved = await store.moveTask(task.id, "todo");
      const after = new Date().toISOString();

      expect(moved.columnMovedAt).toBeDefined();
      expect(moved.columnMovedAt! >= before).toBe(true);
      expect(moved.columnMovedAt! <= after).toBe(true);
      expect(moved.columnMovedAt).not.toBe(originalMovedAt);
    });

    it("updateTask does NOT change columnMovedAt", async () => {
      const task = await store.createTask({ description: "no change test" });
      const originalMovedAt = task.columnMovedAt;

      await new Promise((r) => setTimeout(r, 10));

      const updated = await store.updateTask(task.id, { title: "new title" });
      expect(updated.columnMovedAt).toBe(originalMovedAt);
    });
  });


  describe("VALID_TRANSITIONS — invalid archived transitions via moveTask", () => {
    it("moveTask from archived → in-progress should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.moveTask(task.id, "in-progress")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → triage should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.moveTask(task.id, "triage")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → todo should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.moveTask(task.id, "todo")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from archived → in-review should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, false);

      await expect(store.moveTask(task.id, "in-review")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from triage → archived should succeed", async () => {
      const task = await store.createTask({ description: "Test task" });
      // Task starts in triage

      await store.moveTask(task.id, "archived");
      const updated = await store.getTask(task.id);
      expect(updated.column).toBe("archived");
    });

    it("moveTask from todo → archived should succeed", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");

      await store.moveTask(task.id, "archived");
      const updated = await store.getTask(task.id);
      expect(updated.column).toBe("archived");
    });

    it("moveTask from in-progress → archived should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");

      await expect(store.moveTask(task.id, "archived")).rejects.toThrow("Invalid transition");
    });

    it("moveTask from in-review → archived should fail", async () => {
      const task = await store.createTask({ description: "Test task" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");

      await expect(store.moveTask(task.id, "archived")).rejects.toThrow("Invalid transition");
    });
});

  // FNXC:AutoMergeLifecycle 2026-07-07-12:00: Signature 1 (FN-7641 / NEXT-010) regression —
  // a proven-merge recoveryRehome move from a legacy source column to `done` must succeed
  // instead of throwing "Invalid transition: 'todo' -> 'done'". Covers every legacy source
  // column the CAS/queue-retry paths can leave a landed task parked in (todo, in-progress,
  // triage), while confirming normal (non-recovery) moves still reject illegal adjacency.
  describe("moveTask — legacy proven-merge recoveryRehome to done (FN-7641)", () => {
    it("RED-FIRST: reproduces the original 'todo -> done' invalid-transition symptom without recoveryRehome", async () => {
      const task = await store.createTask({ description: "repro NEXT-010 without recovery flag" });
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      await expect(store.moveTask(task.id, "done")).rejects.toThrow(
        "Invalid transition: 'todo' → 'done'",
      );
    });

    it("allows a legacy todo -> done recoveryRehome move for a proven-merge task (non-workflow)", async () => {
      const task = await store.createTask({ description: "NEXT-010 workspace merge finalize repro" });
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      const moved = await store.moveTask(task.id, "done", {
        recoveryRehome: true,
        preserveProgress: true,
      });

      expect(moved.column).toBe("done");
    });

    it("allows a legacy in-progress -> done recoveryRehome move for a proven-merge task", async () => {
      const task = await store.createTask({ description: "NEXT-010 in-progress recovery repro" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      const moved = await store.moveTask(task.id, "done", {
        recoveryRehome: true,
        preserveProgress: true,
      });

      expect(moved.column).toBe("done");
    });

    it("allows a legacy triage -> done recoveryRehome move for a proven-merge task", async () => {
      const task = await store.createTask({ description: "NEXT-010 triage recovery repro" });
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      const moved = await store.moveTask(task.id, "done", {
        recoveryRehome: true,
        preserveProgress: true,
      });

      expect(moved.column).toBe("done");
    });

    it("still allows the normal in-review -> done recovery path unchanged", async () => {
      const task = await store.createTask({ description: "normal in-review recovery unaffected" });
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "in-review");
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      const moved = await store.moveTask(task.id, "done", {
        recoveryRehome: true,
        preserveProgress: true,
      });

      expect(moved.column).toBe("done");
    });

    it("does NOT relax adjacency for a normal (non-recovery) todo -> done move", async () => {
      const task = await store.createTask({ description: "non-recovery move must still reject" });
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      await expect(store.moveTask(task.id, "done")).rejects.toThrow("Invalid transition");
    });

    it("allows a legacy todo -> done recoveryRehome move for a custom-workflow task", async () => {
      const task = await store.createTask({
        description: "NEXT-010 custom workflow recovery repro",
        workflowId: "builtin:coding",
      });
      await store.moveTask(task.id, "todo");
      await store.updateTask(task.id, { mergeDetails: { mergeConfirmed: true } });

      const moved = await store.moveTask(task.id, "done", {
        recoveryRehome: true,
        preserveProgress: true,
      });

      expect(moved.column).toBe("done");
    });
  });

});
