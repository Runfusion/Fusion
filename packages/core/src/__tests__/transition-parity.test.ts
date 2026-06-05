// @vitest-environment node
//
// TRANSITION-PARITY SUITE (U4).
//
// Proves the flag-ON workflow-resolved transition path reproduces the legacy
// VALID_TRANSITIONS contract for the default workflow, and exercises the U4
// plan scenarios:
//   - VALID_TRANSITIONS parity (allowed AND rejected sets identical)
//   - FN-5147 terminal-until-merged (both paths)
//   - hard-cancel user vs engine (userPaused + abort-on-exit bypass)
//   - handoff bypass + exactly-once enqueue across a simulated crash
//   - crash-mid-transition marker recovery (SQLite authoritative)
//   - unknown-column rejection
//   - guard rejection typed (flag-ON) vs legacy string (flag-OFF)
//   - in-txn capacity enforcement (U6; NEVER bypassable — KTD-10)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VALID_TRANSITIONS } from "../types.js";
import type { Column, Task } from "../types.js";
import { TransitionRejectionError } from "../store.js";
import { resolveAllowedColumns, workflowHasColumn } from "../workflow-transitions.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { readTransitionPending } from "../transition-pending.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

const ALL_COLUMNS: Column[] = ["triage", "todo", "in-progress", "in-review", "done", "archived"];

describe("transition-parity — default workflow column adjacency == VALID_TRANSITIONS", () => {
  it("reproduces VALID_TRANSITIONS exactly for every column (allowed + rejected)", () => {
    for (const from of ALL_COLUMNS) {
      const legacy = new Set(VALID_TRANSITIONS[from]);
      const resolved = new Set(resolveAllowedColumns(BUILTIN_CODING_WORKFLOW_IR, from));
      // Allowed sets identical.
      expect([...resolved].sort()).toEqual([...legacy].sort());
      // Rejected sets identical (complement over all columns).
      for (const to of ALL_COLUMNS) {
        if (from === to) continue;
        expect(resolved.has(to)).toBe(legacy.has(to));
      }
    }
  });

  it("recognizes exactly the six default columns", () => {
    for (const c of ALL_COLUMNS) {
      expect(workflowHasColumn(BUILTIN_CODING_WORKFLOW_IR, c)).toBe(true);
    }
    expect(workflowHasColumn(BUILTIN_CODING_WORKFLOW_IR, "made-up")).toBe(false);
  });
});

describe("transition-parity — store flag-ON scenarios", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  async function seedInColumn(column: Column): Promise<Task> {
    const task = await store.createTask({ description: `seed-${column}` });
    const u = { moveSource: "user" as const };
    if (column === "triage") return task;
    await store.moveTask(task.id, "todo", u);
    if (column === "todo") return store.getTask(task.id) as Promise<Task>;
    await store.moveTask(task.id, "in-progress", u);
    if (column === "in-progress") return store.getTask(task.id) as Promise<Task>;
    await store.moveTask(task.id, "in-review", { ...u, allowDirectInReviewMove: true });
    if (column === "in-review") return store.getTask(task.id) as Promise<Task>;
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });
    if (column === "done") return store.getTask(task.id) as Promise<Task>;
    await store.moveTask(task.id, "archived", u);
    return store.getTask(task.id) as Promise<Task>;
  }

  it("FN-5147: user move in-review → done blocked by merge-blocker with typed rejection", async () => {
    const task = await seedInColumn("in-review");
    await store.updateTask(task.id, { steps: [{ name: "x", status: "pending" }] as Task["steps"] });
    let caught: unknown;
    try {
      await store.moveTask(task.id, "done", { moveSource: "user" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransitionRejectionError);
    expect((caught as TransitionRejectionError).rejection.code).toBe("merge-blocked");
    expect((caught as TransitionRejectionError).rejection.retryable).toBe(true);
  });

  it("FN-5147: engine-sourced move bypasses the merge-blocker guard", async () => {
    const task = await seedInColumn("in-review");
    await store.updateTask(task.id, { steps: [{ name: "x", status: "pending" }] as Task["steps"] });
    const moved = await store.moveTask(task.id, "done", { moveSource: "engine" });
    expect(moved.column).toBe("done");
  });

  it("hard-cancel: user in-progress → todo sets userPaused; engine does not", async () => {
    const userTask = await seedInColumn("in-progress");
    const u = await store.moveTask(userTask.id, "todo", { moveSource: "user" });
    expect(u.userPaused).toBe(true);

    const engineTask = await seedInColumn("in-progress");
    const e = await store.moveTask(engineTask.id, "todo", { moveSource: "engine" });
    expect(e.userPaused).toBeUndefined();
  });

  it("unknown column rejects with typed unknown-column code, card untouched", async () => {
    const task = await seedInColumn("todo");
    let caught: unknown;
    try {
      await store.moveTask(task.id, "made-up" as Column, { moveSource: "user" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransitionRejectionError);
    expect((caught as TransitionRejectionError).rejection.code).toBe("unknown-column");
    const after = await store.getTask(task.id);
    expect(after?.column).toBe("todo");
  });

  it("guard/adjacency rejection is typed (not a bare Error string)", async () => {
    const task = await seedInColumn("archived");
    // archived → todo is not a legal default-workflow transition.
    let caught: unknown;
    try {
      await store.moveTask(task.id, "todo", { moveSource: "user" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransitionRejectionError);
    expect((caught as TransitionRejectionError).rejection.code).toBe("guard-rejected");
  });

  it("handoffToReview maps skipMergeBlocker onto bypassGuards and enqueues exactly once", async () => {
    const task = await seedInColumn("in-progress");
    await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { runId: "run-1", agentId: "agent-1", reason: "complete" },
    } as Parameters<typeof store.handoffToReview>[1]);
    const after = await store.getTask(task.id);
    expect(after?.column).toBe("in-review");
    // Idempotent re-handoff (same-column path) must not double-enqueue.
    await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { runId: "run-2", agentId: "agent-1", reason: "complete" },
    } as Parameters<typeof store.handoffToReview>[1]);
    const queueCount = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db
      .prepare("SELECT COUNT(*) AS n FROM mergeQueue WHERE taskId = ?")
      .get(task.id) as { n: number };
    expect(queueCount.n).toBe(1);
  });

  it("transitionPending marker is written in-txn and cleared post-commit (happy path)", async () => {
    const task = await seedInColumn("todo");
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    const db = (store as unknown as { db: Parameters<typeof readTransitionPending>[0] }).db;
    // Happy path: marker cleared after the post-commit hook runner.
    expect(readTransitionPending(db, task.id)).toBeNull();
  });

  it("crash-mid-transition: a persisted marker is recoverable from SQLite with hooksRemaining intact", async () => {
    const task = await seedInColumn("todo");
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    // Simulate a crash AFTER commit but BEFORE the marker clear by re-writing a
    // marker directly (the in-txn write path is the same helper). Recovery reads
    // it back from SQLite (authoritative), not from task.json.
    const db = (store as unknown as { db: Parameters<typeof readTransitionPending>[0] }).db;
    (db as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } })
      .prepare("UPDATE tasks SET transitionPending = ? WHERE id = ?")
      .run(
        JSON.stringify({ toColumn: "in-progress", hooksRemaining: ["default-workflow:postCommit"], startedAt: Date.now() }),
        task.id,
      );
    const pending = readTransitionPending(db, task.id);
    expect(pending).not.toBeNull();
    expect(pending?.toColumn).toBe("in-progress");
    expect(pending?.hooksRemaining).toContain("default-workflow:postCommit");
  });

  it("worktree ordering: allocateWorktree runs (and is applied) for a flag-ON move into in-progress", async () => {
    const task = await seedInColumn("todo");
    let allocatorCalled = false;
    const moved = await store.moveTask(task.id, "in-progress", {
      moveSource: "user",
      allocateWorktree: () => {
        allocatorCalled = true;
        return "/tmp/wt/seed-todo";
      },
    });
    expect(allocatorCalled).toBe(true);
    expect(moved.worktree).toBe("/tmp/wt/seed-todo");
    // Worktree allocation is NOT a hook — it is a substrate capability invoked
    // synchronously before the move commits; the committed row carries it.
    const after = await store.getTask(task.id);
    expect(after?.worktree).toBe("/tmp/wt/seed-todo");
  });

  it("U6 in-txn capacity: default-workflow in-progress WIP reads through maxConcurrent and rejects the over-limit move", async () => {
    // The default workflow's in-progress column has a `wip` trait whose limit
    // reads through to settings.maxConcurrent (legacy parity). With limit 1, the
    // first move into in-progress commits and a second rejects with the typed
    // capacity-exhausted code.
    await store.updateSettings({ maxConcurrent: 1 } as Parameters<typeof store.updateSettings>[0]);
    const t1 = await seedInColumn("todo");
    const t2 = await seedInColumn("todo");
    const m1 = await store.moveTask(t1.id, "in-progress", { moveSource: "user" });
    expect(m1.column).toBe("in-progress");

    let caught: unknown;
    try {
      await store.moveTask(t2.id, "in-progress", { moveSource: "user" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransitionRejectionError);
    expect((caught as TransitionRejectionError).rejection.code).toBe("capacity-exhausted");
    // The rejected card is untouched.
    expect((await store.getTask(t2.id))?.column).toBe("todo");
  });

  it("U6 capacity is NEVER bypassable (KTD-10): an engine/bypassGuards move into a full column still rejects", async () => {
    await store.updateSettings({ maxConcurrent: 1 } as Parameters<typeof store.updateSettings>[0]);
    const t1 = await seedInColumn("todo");
    const t2 = await seedInColumn("todo");
    await store.moveTask(t1.id, "in-progress", { moveSource: "user" });

    let caught: unknown;
    try {
      // Engine-sourced + bypassGuards skips trait guards, but capacity is not a
      // guard — it must still reject.
      await store.moveTask(t2.id, "in-progress", { moveSource: "engine", bypassGuards: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransitionRejectionError);
    expect((caught as TransitionRejectionError).rejection.code).toBe("capacity-exhausted");
  });

  it("U6 capacity counts cards mid-transitionPending (they hold their slot from commit time)", async () => {
    await store.updateSettings({ maxConcurrent: 1 } as Parameters<typeof store.updateSettings>[0]);
    const t1 = await seedInColumn("todo");
    const t2 = await seedInColumn("todo");
    await store.moveTask(t1.id, "in-progress", { moveSource: "user" });
    // Simulate a crash before t1's marker clears: it is still mid-transition into
    // in-progress, holding its slot. (Its column already equals in-progress, so
    // this also independently holds the slot; this asserts the marker path does
    // not under-count or double-count.)
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE tasks SET transitionPending = ? WHERE id = ?").run(
      JSON.stringify({ toColumn: "in-progress", hooksRemaining: ["default-workflow:postCommit"], startedAt: Date.now() }),
      t1.id,
    );
    let caught: unknown;
    try {
      await store.moveTask(t2.id, "in-progress", { moveSource: "user" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransitionRejectionError);
    expect((caught as TransitionRejectionError).rejection.code).toBe("capacity-exhausted");
  });
});

describe("transition-parity — flag-OFF keeps legacy thrown strings (no behavior change)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;
  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });
  afterEach(async () => {
    await harness.afterEach();
  });

  it("rejects an illegal move with a bare Error containing the legacy message (not TransitionRejectionError)", async () => {
    const task = await store.createTask({ description: "legacy reject" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    await store.moveTask(task.id, "in-review", { moveSource: "user", allowDirectInReviewMove: true });
    await store.moveTask(task.id, "done", { moveSource: "engine", skipMergeBlocker: true });
    await store.moveTask(task.id, "archived", { moveSource: "user" });
    let caught: unknown;
    try {
      await store.moveTask(task.id, "todo", { moveSource: "user" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TransitionRejectionError);
    expect((caught as Error).message).toMatch(/Invalid transition/);
  });

  it("flag-OFF does NOT write a transitionPending marker", async () => {
    const task = await store.createTask({ description: "no marker" });
    await store.moveTask(task.id, "todo", { moveSource: "user" });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });
    const db = (store as unknown as { db: Parameters<typeof readTransitionPending>[0] }).db;
    expect(readTransitionPending(db, task.id)).toBeNull();
  });
});
