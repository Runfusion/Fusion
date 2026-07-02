/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of the comments subset of store-comments.test.ts.
 *
 * Exercises the backend-mode (asyncLayer) path for:
 *   - addTaskComment / updateTaskComment / deleteTaskComment (CRUD)
 *   - addComment (steering comment + refinement task creation on done tasks)
 *   - addSteeringComment (writes to both comments and steeringComments)
 *   - comment deduplication across read-write cycles (FN-5xxx invariant)
 *
 * The original SQLite test remains until SQLite is fully removed; this PG
 * twin is auto-skipped in CI without PostgreSQL (pgDescribe).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore comments CRUD (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_comments",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("adds a task comment to a task", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "comment target" });
    const updated = await store.addTaskComment(task.id, "Please review this", "alice");

    expect(updated.comments).toHaveLength(1);
    expect(updated.comments![0].text).toBe("Please review this");
    expect(updated.comments![0].author).toBe("alice");
    expect(updated.comments![0].id).toBeDefined();
    expect(updated.comments![0].createdAt).toBeDefined();
    expect(updated.comments![0].updatedAt).toBeDefined();
  });

  it("updates an existing task comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "update comment" });
    const added = await store.addTaskComment(task.id, "First draft", "alice");
    const commentId = added.comments![0].id;

    const updated = await store.updateTaskComment(task.id, commentId, "Updated draft");

    expect(updated.comments).toHaveLength(1);
    expect(updated.comments![0].text).toBe("Updated draft");
    expect(updated.comments![0].updatedAt).toBeDefined();
  });

  it("deletes a task comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "delete comment" });
    const added = await store.addTaskComment(task.id, "Disposable", "alice");
    const commentId = added.comments![0].id;

    const updated = await store.deleteTaskComment(task.id, commentId);

    expect(updated.comments).toBeUndefined();
  });

  it("throws when updating a missing task comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "missing update" });

    await expect(store.updateTaskComment(task.id, "missing", "Nope")).rejects.toThrow(
      `Comment missing not found on task ${task.id}`,
    );
  });

  it("throws when deleting a missing task comment", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "missing delete" });

    await expect(store.deleteTaskComment(task.id, "missing")).rejects.toThrow(
      `Comment missing not found on task ${task.id}`,
    );
  });

  it("persists all comments in unified comments field", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "unified" });
    await store.addTaskComment(task.id, "General note", "alice");
    await store.addComment(task.id, "Execution note");

    const reopened = await store.getTask(task.id);
    expect(reopened.comments).toHaveLength(2);
    expect(reopened.comments![0].text).toBe("General note");
    expect(reopened.comments![1].text).toBe("Execution note");
  });
});

pgTest("TaskStore addComment steering + refinement (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_steering",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("adds a steering comment and persists it", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "steering target" });
    const updated = await store.addComment(task.id, "Please handle the edge case");

    expect(updated.comments).toHaveLength(1);
    expect(updated.comments![0].text).toBe("Please handle the edge case");
    expect(updated.comments![0].author).toBe("user");
    expect(updated.comments![0].id).toBeDefined();
    expect(updated.comments![0].createdAt).toBeDefined();
  });

  it("appends multiple comments in order", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "order" });
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
    const store = h.store();
    const task = await store.createTask({ description: "unique ids" });
    const updated1 = await store.addComment(task.id, "Comment 1");
    const updated2 = await store.addComment(task.id, "Comment 2");

    const id1 = updated1.comments![0].id;
    const id2 = updated2.comments![1].id;
    expect(id1).not.toBe(id2);
  });

  it("does not create refinement when steering comment added to non-done task", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "non-done" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });

    const allTasksBefore = await store.listTasks();

    await store.addComment(task.id, "Some feedback");

    const allTasksAfter = await store.listTasks();
    expect(allTasksAfter).toHaveLength(allTasksBefore.length);
  });

  // NOTE: The "creates refinement task when steering comment added to done
  // task" and "does not create refinement for agent-authored comments" cases
  // are intentionally omitted from this PG twin. The refineTask() backend-mode
  // path is a known gap (it relies on PROMPT.md filesystem parsing + reserved-id
  // creation that has partial backend wiring). The SQLite test covers that path;
  // this PG twin covers the comment CRUD + persistence invariants that ARE
  // fully wired in backend mode.
});

pgTest("TaskStore addSteeringComment (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_add_steering",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("writes to both comments and steeringComments", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "steering both" });

    const updated = await store.addSteeringComment(task.id, "Focus on error handling");

    expect(updated.comments).toBeDefined();
    expect(updated.comments!.some((c) => c.text === "Focus on error handling")).toBe(true);

    expect(updated.steeringComments).toBeDefined();
    expect(updated.steeringComments!.some((c) => c.text === "Focus on error handling")).toBe(true);
  });

  it("steeringComments persist through round-trip", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "persist steering" });

    await store.addSteeringComment(task.id, "Focus on error handling");

    const fetched = await store.getTask(task.id);
    expect(fetched.steeringComments).toBeDefined();
    expect(fetched.steeringComments!).toHaveLength(1);
    expect(fetched.steeringComments![0].text).toBe("Focus on error handling");
  });

  it("steering comments do not duplicate in comments across read-write cycle", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "no dup" });

    await store.addSteeringComment(task.id, "Focus on error handling");

    const read1 = await store.getTask(task.id);
    expect(read1.comments).toHaveLength(1);
    expect(read1.steeringComments).toHaveLength(1);

    await store.updateTask(task.id, { status: "planning" });

    const read2 = await store.getTask(task.id);
    expect(read2.comments).toHaveLength(1);
    expect(read2.comments![0].text).toBe("Focus on error handling");
  });

  it("no duplication accumulation over multiple read-write cycles", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "multi-cycle" });

    await store.addSteeringComment(task.id, "Comment A");
    await store.addSteeringComment(task.id, "Comment B");

    for (let i = 0; i < 5; i++) {
      const fetched = await store.getTask(task.id);
      expect(fetched.comments).toHaveLength(2);
      expect(fetched.steeringComments).toHaveLength(2);
      await store.updateTask(task.id, { status: "planning" });
    }

    const final = await store.getTask(task.id);
    expect(final.comments).toHaveLength(2);
    expect(final.comments!.map((c) => c.text).sort()).toEqual(["Comment A", "Comment B"]);
  });
});
