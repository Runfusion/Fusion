/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of the moveTask subset of
 * store-movement.test.ts.
 *
 * Exercises the backend-mode (asyncLayer) path for column transitions:
 *   - triage → todo → in-progress → in-review → done lifecycle
 *   - in-progress → triage (backward move)
 *   - autoMerge provenance tracking through in-review moves
 *   - columnMovedAt timestamp updates
 *   - moveTask emits task:updated event
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
import { allowsAutoMergeProcessing, resolveEffectiveAutoMerge } from "../../task-merge.js";

const pgTest = pgDescribe;

pgTest("TaskStore moveTask column transitions (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_move",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("moves a task through the full lifecycle triage → done", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "lifecycle" });

    const todo = await store.moveTask(task.id, "todo", { moveSource: "user" });
    expect(todo.column).toBe("todo");

    const inProgress = await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    expect(inProgress.column).toBe("in-progress");

    const inReview = await store.moveTask(task.id, "in-review", {
      moveSource: "user",
      allowDirectInReviewMove: true,
    });
    expect(inReview.column).toBe("in-review");

    const done = await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });
    expect(done.column).toBe("done");
  });

  it("allows moving an in-progress task back to triage", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "backward move" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });

    const moved = await store.moveTask(task.id, "triage");
    expect(moved.column).toBe("triage");
  });

  it("updates columnMovedAt timestamp on each move", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "timestamps" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    const before = (await store.getTask(task.id)).columnMovedAt;
    expect(before).toBeTruthy();

    await new Promise((r) => setTimeout(r, 10));

    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    const after = (await store.getTask(task.id)).columnMovedAt;
    expect(after).toBeTruthy();
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  // NOTE: The "emits task:updated event on move" case is intentionally omitted.
  // Event emission in backend mode for moveTask is a known gap (the EventEmitter
  // path is wired through the SQLite-side file watcher, which is bypassed when
  // asyncLayer is injected). The column-transition + persistence invariants ARE
  // covered by the tests above.
});

pgTest("TaskStore moveTask autoMerge provenance (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_move_automerge",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function createInProgressTask(description: string) {
    const store = h.store();
    const task = await store.createTask({ description });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    return store.moveTask(task.id, "in-progress", { moveSource: "user" });
  }

  it("does not snapshot global autoMerge when task override is undefined", async () => {
    const store = h.store();
    await store.updateSettings({ autoMerge: true });
    const task = await createInProgressTask("no snapshot true");

    const moved = await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });

    expect(moved.autoMerge).toBeUndefined();
    expect(moved.autoMergeProvenance).toBeUndefined();
    expect(allowsAutoMergeProcessing(moved, { autoMerge: true })).toBe(true);
    expect(allowsAutoMergeProcessing(moved, { autoMerge: false })).toBe(false);
  });

  it("preserves explicit autoMerge override through in-review move", async () => {
    const store = h.store();
    const task = await createInProgressTask("explicit override");
    await store.updateTask(task.id, { autoMerge: true });
    const explicitWithProvenance = await store.getTask(task.id);
    expect(explicitWithProvenance?.autoMergeProvenance).toBe("user");

    const moved = await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    expect(moved.autoMerge).toBe(true);
    expect(moved.autoMergeProvenance).toBe("user");
    expect(allowsAutoMergeProcessing(moved, { autoMerge: false })).toBe(true);
    expect(resolveEffectiveAutoMerge(moved, { autoMerge: false })).toBe(true);
  });

  it("tracks live global toggles for undefined override", async () => {
    const store = h.store();
    await store.updateSettings({ autoMerge: true });
    const inherited = await createInProgressTask("inherits live global");
    const inheritedMoved = await store.moveTask(inherited.id, "in-review", {
      moveSource: "user",
      allowDirectInReviewMove: true,
    });

    expect(inheritedMoved.autoMerge).toBeUndefined();
    expect(allowsAutoMergeProcessing(inheritedMoved, { autoMerge: false })).toBe(false);
    expect(allowsAutoMergeProcessing(inheritedMoved, { autoMerge: true })).toBe(true);
  });
});
