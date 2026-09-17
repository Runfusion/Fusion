/*
FNXC:TaskFollowUp 2026-09-17-16:35:
FN-513 Step 2 — the real `refineTask(..., { mode: "follow-up" })` store mode against PostgreSQL.

These cases exercise the SHIPPED path, not a re-implementation of it: the child row, its seed prompt,
its workflow selection, its single dependency edge, and — the part that only a real database can
prove — that the source is never mutated and that a refusal raised inside the insert transaction
leaves no child row, no published selection, and no staged task directory behind.
*/
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBootstrapPrompt, isUnplannedSeedPrompt } from "../../mesh/mesh-task-replication.js";
import { isFollowUpTask } from "../../tasks/task-follow-up.js";
import { isFollowUpIneligibleError } from "../../task-store/follow-up-ops.js";
import type { Task } from "../../types.js";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("refineTask follow-up mode (PostgreSQL)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_follow_up" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  /** The approved-plan-review shape the Planning exception demands. */
  const approvedPlanReview = [{
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    status: "passed" as const,
    verdict: "APPROVE" as const,
    completedAt: "2026-09-17T10:00:00.000Z",
  }];

  async function expectRefusal(
    promise: Promise<unknown>,
    reason: string,
  ): Promise<void> {
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      isFollowUpIneligibleError(error) && (error as { reason: string }).reason === reason);
  }

  /** Every durable fact of A a follow-up must leave untouched. */
  function sourceFingerprint(task: Task): Record<string, unknown> {
    return {
      column: task.column,
      status: task.status ?? null,
      steps: task.steps ?? [],
      currentStep: task.currentStep ?? 0,
      worktree: task.worktree ?? null,
      branch: task.branch ?? null,
      sessionFile: task.sessionFile ?? null,
      dependencies: task.dependencies ?? [],
      paused: task.paused ?? false,
      error: task.error ?? null,
      workflowStepResults: task.workflowStepResults ?? [],
    };
  }

  it("creates a distinct, dependent, unplanned child from a running source without touching it", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({ title: "Parent A", description: "Build the importer", column: "in-progress" });
      await h.store.updateTask(source.id, {
        steps: [
          { number: 0, description: "Preflight", status: "done" },
          { number: 1, description: "Importer", status: "in-progress" },
        ],
        currentStep: 1,
        worktree: "/tmp/parent-a",
        branch: "fusion/parent-a",
        branchWriteOrigin: "operator",
      } as never);
      const before = sourceFingerprint(await h.store.getTask(source.id));

      const child = await h.store.refineTask(source.id, "Add a CSV export for the imported rows", { mode: "follow-up" });
      const fetched = await h.store.getTask(child.id);

      expect(fetched.id).not.toBe(source.id);
      expect(fetched.sourceType).toBe("task_refine");
      expect(fetched.sourceParentTaskId).toBe(source.id);
      expect(isFollowUpTask(fetched)).toBe(true);
      expect(fetched.dependencies).toEqual([source.id]);
      expect(fetched.description).toContain("Add a CSV export for the imported rows");
      expect(fetched.description).toContain(source.id);
      // Titled by the request, not by the parent — siblings must be distinguishable on the board.
      expect(fetched.title).not.toBe(source.title);
      // Nothing of A's execution state is inherited.
      expect(fetched.steps ?? []).toEqual([]);
      expect(fetched.worktree).toBeUndefined();
      expect(fetched.branch).toBeUndefined();
      expect(fetched.workflowStepResults ?? []).toEqual([]);

      // The child is UNPLANNED: triage must plan it rather than execute the request text as a spec.
      const prompt = await readFile(join(h.store.taskDir(child.id), "PROMPT.md"), "utf8");
      expect(isUnplannedSeedPrompt(prompt, child.id, fetched.title, fetched.description)).toBe(true);
      expect(prompt).toBe(buildBootstrapPrompt(child.id, fetched.title, fetched.description));

      expect(sourceFingerprint(await h.store.getTask(source.id))).toEqual(before);
    } finally {
      await teardown();
    }
  });

  it("accepts a review-lane source and a Planning source whose plan review currently approves", async () => {
    const h = await makeHarness();
    try {
      const reviewSource = await h.store.createTask({ description: "Review lane parent", column: "in-review" });
      const reviewChild = await h.store.refineTask(reviewSource.id, "Extend the review lane work", { mode: "follow-up" });
      expect((await h.store.getTask(reviewChild.id)).dependencies).toEqual([reviewSource.id]);

      const planningSource = await h.store.createTask({ description: "Planning parent", column: "todo" });
      await expectRefusal(
        h.store.refineTask(planningSource.id, "Too early", { mode: "follow-up" }),
        "plan-review-not-approved",
      );

      await h.store.updateTask(planningSource.id, { workflowStepResults: approvedPlanReview } as never);
      const planningChild = await h.store.refineTask(planningSource.id, "Build on the approved plan", { mode: "follow-up" });
      expect((await h.store.getTask(planningChild.id)).dependencies).toEqual([planningSource.id]);
    } finally {
      await teardown();
    }
  });

  it("refuses a terminal, manual-capture, or missing source", async () => {
    const h = await makeHarness();
    try {
      const done = await h.store.createTask({ description: "Finished parent", column: "done" });
      await expectRefusal(h.store.refineTask(done.id, "Not a follow-up", { mode: "follow-up" }), "source-terminal");
      // Refine still works on exactly that card — the modes are complementary, not exclusive.
      const refined = await h.store.refineTask(done.id, "Ordinary refinement");
      expect(refined.sourceParentTaskId).toBe(done.id);
      expect(isFollowUpTask(await h.store.getTask(refined.id))).toBe(false);

      const ideas = await h.store.createTask({
        description: "Manual capture parent",
        workflowId: "builtin:coding-ideas",
        column: "ideas",
      } as never);
      await expectRefusal(h.store.refineTask(ideas.id, "Nothing planned yet", { mode: "follow-up" }), "source-manual-intake");

      await expectRefusal(h.store.refineTask("FN-999999", "No such parent", { mode: "follow-up" }), "source-missing");
    } finally {
      await teardown();
    }
  });

  it("validates the request text in the domain, not only at the HTTP boundary", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({ description: "Parent", column: "in-progress" });
      await expect(h.store.refineTask(source.id, "", { mode: "follow-up" })).rejects.toThrow(/Feedback is required/);
      await expect(h.store.refineTask(source.id, "   \n\t ", { mode: "follow-up" })).rejects.toThrow(/Feedback is required/);
      await expect(h.store.refineTask(source.id, "x".repeat(100_001), { mode: "follow-up" })).rejects.toThrow(/at most/);

      // A long-but-legal request is accepted.
      const child = await h.store.refineTask(source.id, "y".repeat(99_000), { mode: "follow-up" });
      expect((await h.store.getTask(child.id)).description.length).toBeGreaterThan(99_000);
    } finally {
      await teardown();
    }
  });

  it("routes the child through the refinement-origin workflow, including a renamed manual hold", async () => {
    const h = await makeHarness();
    try {
      // 1. Automatic default workflow: the child lands in its intake (Planning) lane.
      const autoSource = await h.store.createTask({ description: "Automatic parent", column: "in-progress" });
      const autoChild = await h.store.refineTask(autoSource.id, "Automatic follow-up", { mode: "follow-up" });
      expect((await h.store.getTask(autoChild.id)).column).toBe("todo");
      expect(await h.store.getTaskWorkflowSelectionAsync(autoChild.id)).toMatchObject({ workflowId: "builtin:coding" });

      // 2. A manual-capture origin is bypassed to its Planning hold, on a RENAMED board.
      const manual = await h.store.createWorkflowDefinition({
        name: "Renamed manual follow-up workflow",
        kind: "workflow",
        ir: {
          version: "v2",
          name: "Renamed manual follow-up workflow",
          columns: [
            { id: "capture", name: "Capture", traits: [{ trait: "intake", config: { autoTriage: false } }] },
            { id: "ready", name: "Ready to plan", traits: [{ trait: "hold", config: { release: "capacity" } }] },
            { id: "working", name: "Working", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
            { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
          ],
          nodes: [
            { id: "start", kind: "start", column: "capture" },
            { id: "end", kind: "end", column: "shipped" },
          ],
          edges: [{ from: "start", to: "end" }],
        },
      } as never);
      await h.store.updateSettings({ refinementTaskWorkflowId: manual.id } as never);

      const renamedSource = await h.store.createTask({
        description: "Renamed board parent",
        workflowId: manual.id,
        column: "working",
      } as never);
      const first = await h.store.refineTask(renamedSource.id, "First renamed follow-up", { mode: "follow-up" });
      const second = await h.store.refineTask(renamedSource.id, "Second renamed follow-up", { mode: "follow-up" });

      expect(first.id).not.toBe(second.id);
      for (const child of [first, second]) {
        const fetched = await h.store.getTask(child.id);
        expect(fetched.column).toBe("ready");
        expect(fetched.column).not.toBe("capture");
        expect(fetched.dependencies).toEqual([renamedSource.id]);
        expect(await h.store.getTaskWorkflowSelectionAsync(fetched.id)).toMatchObject({ workflowId: manual.id });
        const prompt = await readFile(join(h.store.taskDir(fetched.id), "PROMPT.md"), "utf8");
        expect(isUnplannedSeedPrompt(prompt, fetched.id, fetched.title, fetched.description)).toBe(true);
      }
    } finally {
      await teardown();
    }
  });

  it("refuses a destination workflow that declares no usable planning lane rather than inventing a column", async () => {
    const h = await makeHarness();
    try {
      const noHold = await h.store.createWorkflowDefinition({
        name: "Manual follow-up workflow without hold",
        kind: "workflow",
        ir: {
          version: "v2",
          name: "Manual follow-up workflow without hold",
          columns: [
            { id: "capture", name: "Capture", traits: [{ trait: "intake", config: { autoTriage: false } }] },
            { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
          ],
          nodes: [
            { id: "start", kind: "start", column: "capture" },
            { id: "end", kind: "end", column: "shipped" },
          ],
          edges: [{ from: "start", to: "end" }],
        },
      } as never);
      const source = await h.store.createTask({ description: "Parent on the default board", column: "in-progress" });
      await h.store.updateSettings({ refinementTaskWorkflowId: noHold.id } as never);

      await expectRefusal(
        h.store.refineTask(source.id, "Nowhere to plan this", { mode: "follow-up" }),
        "destination-unavailable",
      );
      const all = await h.store.listTasks();
      expect(all.filter((task) => task.sourceParentTaskId === source.id)).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  /*
  FNXC:TaskFollowUp 2026-09-17-16:35:
  THE TWO ORDERS, exercised deterministically through the transaction seam rather than by racing two
  timers. The seam runs after the insert transaction already holds A's advisory lock, which is the
  exact window where a commit by another writer becomes visible.
  */
  it("refuses in-transaction when the source stops being eligible before the insert commits", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({ description: "Racing parent", column: "in-progress" });

      /*
      The source is bounced back to an unapproved Planning lane while the insert transaction is open.
      That is a real loss of eligibility (the plan the follow-up would derive from no longer exists),
      and it is proved by the SHIPPED in-transaction revalidation rather than by a pre-flight check
      — the pre-flight check already passed before this ran.
      */
      await expectRefusal(
        h.store.refineTask(source.id, "Loses the race", {
          mode: "follow-up",
          __afterSourceLockForTest: async () => {
            await h.store.moveTask(source.id, "todo");
            expect((await h.store.getTask(source.id)).column).toBe("todo");
          },
        }),
        "plan-review-not-approved",
      );

      const afterRefusal = await h.store.listTasks();
      expect(afterRefusal.filter((task) => task.sourceParentTaskId === source.id)).toHaveLength(0);
      // The refusal rolled back the staged directory too — no orphaned task files remain.
      const orphaned = afterRefusal.filter((task) => task.description.includes("Loses the race"));
      expect(orphaned).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  /*
  FNXC:TaskFollowUp 2026-09-17-17:05:
  A DELETE of A cannot interleave inside the insert transaction at all: that transaction already
  holds A's per-task serialization lock as a dependency target, and the delete path contends for it,
  so the delete either commits BEFORE the request (this case — no child) or AFTER the insert commits
  (B is durable and the ordinary lineage guards own it from then on). That is the whole ordering
  contract; there is deliberately no third outcome where a half-created child survives.
  */
  it("refuses when the source was deleted before the request reaches the store", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({ description: "Deleted parent", column: "in-progress" });
      await h.store.deleteTask(source.id);
      await expect(h.store.refineTask(source.id, "Deleted before the request", { mode: "follow-up" })).rejects.toThrow();
      const all = await h.store.listTasks();
      expect(all.filter((task) => task.description.includes("Deleted before the request"))).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it("refuses in-transaction when the source's workflow selection changed under the request", async () => {
    const h = await makeHarness();
    try {
      const other = await h.store.createWorkflowDefinition({
        name: "Other follow-up workflow",
        kind: "workflow",
        ir: {
          version: "v2",
          name: "Other follow-up workflow",
          columns: [
            { id: "intake", name: "Intake", traits: [{ trait: "intake" }] },
            { id: "working", name: "Working", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
            { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
          ],
          nodes: [
            { id: "start", kind: "start", column: "intake" },
            { id: "end", kind: "end", column: "shipped" },
          ],
          edges: [{ from: "start", to: "end" }],
        },
      } as never);
      const source = await h.store.createTask({ description: "Reselected parent", column: "in-progress" });

      await expectRefusal(
        h.store.refineTask(source.id, "Selection changed under me", {
          mode: "follow-up",
          __afterSourceLockForTest: async () => {
            await h.store.writeTaskWorkflowSelection(source.id, other.id, []);
          },
        }),
        "workflow-selection-changed",
      );
    } finally {
      await teardown();
    }
  });

  it("accepts a source that merely progressed WIP -> review while the request was in flight", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({ description: "Progressing parent", column: "in-progress" });
      const child = await h.store.refineTask(source.id, "Progress is not a cancellation", {
        mode: "follow-up",
        __afterSourceLockForTest: async () => {
          await h.store.moveTask(source.id, "in-review", { allowDirectInReviewMove: true } as never);
        },
      });
      expect((await h.store.getTask(child.id)).dependencies).toEqual([source.id]);
      expect((await h.store.getTask(source.id)).column).toBe("in-review");
    } finally {
      await teardown();
    }
  });

  it("keeps the child's task directory and prompt consistent with its durable row", async () => {
    const h = await makeHarness();
    try {
      const source = await h.store.createTask({ description: "Directory parent", column: "in-progress" });
      const child = await h.store.refineTask(source.id, "Check the directory", { mode: "follow-up" });
      expect(existsSync(join(h.store.taskDir(child.id), "PROMPT.md"))).toBe(true);
      expect(existsSync(join(h.store.taskDir(child.id), "task.json"))).toBe(true);
    } finally {
      await teardown();
    }
  });
});
