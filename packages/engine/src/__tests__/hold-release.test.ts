// @vitest-environment node
//
// HOLD/RELEASE SWEEP SUITE (U6).
//
// Exercises the generalized scheduler sweep (`hold-release.ts`) against a REAL
// TaskStore so the in-txn capacity check (KTD-10) actually arbitrates races:
//   - two holds, one slot → exactly one releases; other retries next sweep
//   - timer release fires at its deadline under fake timers (no real sleeps)
//   - manual release only on the explicit promote call
//   - capacity release respects mid-transitionPending cards (in-txn authority)
//   - cross-workflow dependency complete-flag unblocks + dual-accept diff logged
//   - sweep release into a full column rejected by the in-txn check despite
//     moveSource:"scheduler" bypassing trait guards (capacity is not a guard)
//   - reservation-first: semaphore exhausted → no commit, card stays held
//   - paused / recovery-backoff tasks skipped exactly as the legacy scheduler

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getBuiltinWorkflow, resolveColumnFlags, TaskStore, type Task, type WorkflowIr } from "@fusion/core";
import {
  runHoldReleaseSweep,
  promoteHeldTask,
  releaseHeldTaskByEvent,
  type HoldReleaseDeps,
  type SlotReservation,
} from "../hold-release.js";

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "ignore" });
}

/** Directly set a task's stored column (test setup helper — bypasses adjacency
 *  validation so a card can be placed at an arbitrary workflow column). */
function setColumn(store: TaskStore, taskId: string, column: string): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare('UPDATE tasks SET "column" = ?, "columnMovedAt" = ? WHERE id = ?').run(
    column,
    new Date().toISOString(),
    taskId,
  );
}

/** Directly set a task's workflow selection row (bypasses step compilation). */
function setSelection(store: TaskStore, taskId: string, workflowId: string): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare(
    `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
     VALUES (?, ?, '[]', ?)
     ON CONFLICT(taskId) DO UPDATE SET workflowId = excluded.workflowId, updatedAt = excluded.updatedAt`,
  ).run(taskId, workflowId, new Date().toISOString());
}

/** Write a transitionPending marker directly (simulating a crash mid-transition). */
function setTransitionPending(store: TaskStore, taskId: string, toColumn: string): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare("UPDATE tasks SET transitionPending = ? WHERE id = ?").run(
    JSON.stringify({ toColumn, hooksRemaining: ["default-workflow:postCommit"], startedAt: Date.now() }),
    taskId,
  );
}

const noReserveDeps: HoldReleaseDeps = { now: () => Date.now() };
const LINEAR_BUILTIN_WORKFLOW_IDS = [
  "builtin:compound-engineering",
  "builtin:quick-fix",
  "builtin:review-heavy",
  "builtin:design",
] as const;

function pureV1CustomWorkflowIr(): WorkflowIr {
  return {
    version: "v1",
    name: "pure-v1-custom",
    nodes: [
      { id: "start", kind: "start" },
      { id: "execute", kind: "prompt", config: { seam: "execute", prompt: "Do the work" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "execute", condition: "success" },
      { from: "execute", to: "end", condition: "success" },
      { from: "execute", to: "end", condition: "failure" },
    ],
  } as WorkflowIr;
}

function authoredV2CapacityWorkflowIr(): WorkflowIr {
  return {
    version: "v2",
    name: "authored-v2-capacity-workflow",
    columns: [
      { id: "todo", name: "todo", traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }] },
      { id: "in-progress", name: "in-progress", traits: [{ trait: "wip", config: { limit: "settings.maxConcurrent" } }, { trait: "abort-on-exit" }, { trait: "timing" }] },
      { id: "in-review", name: "in-review", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute", prompt: "Do the work" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "execute", condition: "success" },
      { from: "execute", to: "end", condition: "success" },
      { from: "execute", to: "end", condition: "failure" },
    ],
  } as WorkflowIr;
}

describe("hold-release sweep (U6)", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "u6-hold-release-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m init");
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
    await store.init();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  afterEach(() => {
    try { store?.close(); } catch { /* ignore */ }
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // A held card in the DEFAULT workflow: a task resting in `todo`
  // (hold release: capacity), which releases into `in-progress` (wip).
  async function seedTodoCard(): Promise<string> {
    const task = await store.createTask({ description: "card" });
    setColumn(store, task.id, "todo");
    return task.id;
  }

  it("releases default and linear built-in workflow todo cards into in-progress", async () => {
    await store.updateSettings({ maxConcurrent: 10 } as Parameters<typeof store.updateSettings>[0]);
    const defaultWorkflowTask = await seedTodoCard();
    const selectedTasks: string[] = [];

    for (const workflowId of LINEAR_BUILTIN_WORKFLOW_IDS) {
      const builtin = getBuiltinWorkflow(workflowId);
      if (!builtin?.ir || builtin.ir.version !== "v2") throw new Error(`missing v2 built-in ${workflowId}`);
      const todo = builtin.ir.columns.find((column) => column.id === "todo");
      expect(todo).toBeDefined();
      expect(resolveColumnFlags(todo!).hold).toBe(true);
    }

    // Pre-FN-7190, linear() synthesized trait-less default columns, so isHeldTask()
    // returned false here and these selected built-in tasks were silently skipped forever.
    for (const workflowId of LINEAR_BUILTIN_WORKFLOW_IDS) {
      const task = await store.createTask({ description: `card ${workflowId}` });
      setSelection(store, task.id, workflowId);
      setColumn(store, task.id, "todo");
      selectedTasks.push(task.id);
    }

    const result = await runHoldReleaseSweep(store, noReserveDeps);
    expect(result.released).toEqual(expect.arrayContaining([defaultWorkflowTask, ...selectedTasks]));

    for (const taskId of [defaultWorkflowTask, ...selectedTasks]) {
      expect((await store.getTask(taskId))?.column).toBe("in-progress");
    }
  });

  it("documents custom v1 stranding and proves the authored v2 capacity-column remedy", async () => {
    await store.updateSettings({ maxConcurrent: 10 } as Parameters<typeof store.updateSettings>[0]);
    const defaultWorkflowTask = await seedTodoCard();

    const v1Def = await store.createWorkflowDefinition({ name: "pure v1 custom", ir: pureV1CustomWorkflowIr() });
    const v1Task = await store.createTask({ description: "pure-v1 custom card" });
    setSelection(store, v1Task.id, v1Def.id);
    setColumn(store, v1Task.id, "todo");

    const v2Def = await store.createWorkflowDefinition({ name: "authored v2 capacity", ir: authoredV2CapacityWorkflowIr() });
    const v2Task = await store.createTask({ description: "authored-v2 custom card" });
    setSelection(store, v2Task.id, v2Def.id);
    setColumn(store, v2Task.id, "todo");

    /*
     * FNXC:Workflows 2026-06-28-09:17:
     * The migration contract documented in docs/workflow-editor.md is behavioral: pure-v1 custom workflows stay rollback-compatible and are not held, while authored-v2 workflows that put hold(capacity) on todo are released by the sole post-cutover dispatcher.
     */
    const result = await runHoldReleaseSweep(store, noReserveDeps);

    expect(result.released).toEqual(expect.arrayContaining([defaultWorkflowTask, v2Task.id]));
    expect(result.released).not.toContain(v1Task.id);
    expect((await store.getTask(defaultWorkflowTask))?.column).toBe("in-progress");
    expect((await store.getTask(v2Task.id))?.column).toBe("in-progress");
    expect((await store.getTask(v1Task.id))?.column).toBe("todo");
  });

  it("ignores stale workflowColumns=false and still releases held default-workflow cards", async () => {
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: false } });
    const id = await seedTodoCard();
    const result = await runHoldReleaseSweep(store, noReserveDeps);
    expect(result.released).toEqual([id]);
    expect((await store.getTask(id))?.column).toBe("in-progress");
  });

  it("does not let unrelated moved events disable the current task's eventless release fallback", async () => {
    const held = {
      id: "FN-777",
      title: "Held",
      description: "",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    let onMoved: ((data: { task: Task; to: string }) => void) | undefined;
    const release = vi.fn();
    const fakeStore = {
      getSettings: vi.fn(async () => ({
        maxConcurrent: 4,
        experimentalFeatures: { workflowColumns: true },
      })),
      listTasks: vi.fn(async () => [held]),
      moveTask: vi.fn(async () => {
        onMoved?.({ task: { ...held, id: "FN-OTHER" }, to: "in-progress" });
        held.column = "in-progress";
        return held;
      }),
      getTaskWorkflowSelection: vi.fn(() => null),
      on: vi.fn((_event: string, listener: (data: { task: Task; to: string }) => void) => {
        onMoved = listener;
      }),
      off: vi.fn(),
    } as unknown as TaskStore;

    const result = await runHoldReleaseSweep(fakeStore, {
      now: () => Date.now(),
      reserveSlot: () => ({ release }),
    });

    expect(result.released).toEqual(["FN-777"]);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases reservations when an eventless move returns no task row", async () => {
    const held = {
      id: "FN-778",
      title: "Held void",
      description: "",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    const release = vi.fn();
    const fakeStore = {
      getSettings: vi.fn(async () => ({
        maxConcurrent: 4,
        experimentalFeatures: { workflowColumns: true },
      })),
      listTasks: vi.fn(async () => [held]),
      moveTask: vi.fn(async () => undefined),
      getTaskWorkflowSelection: vi.fn(() => null),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TaskStore;

    const result = await runHoldReleaseSweep(fakeStore, {
      now: () => Date.now(),
      reserveSlot: () => ({ release }),
    });

    expect(result.released).toEqual([]);
    expect(result.held).toEqual([{ taskId: "FN-778", reason: "move-rejected-or-no-slot" }]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("two holds, one slot: exactly one releases; the other releases next sweep after the slot frees", async () => {
    await store.updateSettings({ maxConcurrent: 1 } as Parameters<typeof store.updateSettings>[0]);
    const a = await seedTodoCard();
    const b = await seedTodoCard();

    const r1 = await runHoldReleaseSweep(store, noReserveDeps);
    expect(r1.released.length).toBe(1);
    const released = r1.released[0];
    const stillHeld = released === a ? b : a;
    expect((await store.getTask(released))?.column).toBe("in-progress");
    expect((await store.getTask(stillHeld))?.column).toBe("todo");

    // Free the slot by moving the released card out of in-progress.
    await store.moveTask(released, "in-review", { moveSource: "engine", allowDirectInReviewMove: true });
    const r2 = await runHoldReleaseSweep(store, noReserveDeps);
    expect(r2.released).toContain(stillHeld);
    expect((await store.getTask(stillHeld))?.column).toBe("in-progress");
  });

  it("FN-1415: two concurrent sweeps, one held card + one slot → exactly one release commits; loser's reservation is released", async () => {
    // The scheduler can tick again before a slow sweep finishes. The in-txn
    // capacity check (KTD-10) serializes the COMMIT, but we must also prove the
    // reservation side effects across racing sweeps don't double-release or leak:
    // the winning sweep moves the card, the loser's reservation is released, and
    // the held card lands in exactly one downstream slot.
    await store.updateSettings({ maxConcurrent: 1 } as Parameters<typeof store.updateSettings>[0]);
    const held = await seedTodoCard();

    // Fake reservations: each reserveSlot hands out a distinct reservation whose
    // release() we observe. Both racing sweeps see a free slot in the snapshot
    // pre-check and reserve; only one move can commit (maxConcurrent: 1), so the
    // loser must release its reservation.
    let reserveCount = 0;
    let releaseCount = 0;
    const deps: HoldReleaseDeps = {
      now: () => Date.now(),
      reserveSlot: (): SlotReservation | null => {
        reserveCount += 1;
        return { release: () => { releaseCount += 1; } };
      },
    };

    const [r1, r2] = await Promise.all([
      runHoldReleaseSweep(store, deps),
      runHoldReleaseSweep(store, deps),
    ]);

    // The single held card was released into the single slot. Both sweeps may
    // report it as released (the second sweep re-moves the already-released card
    // to the SAME target — an idempotent same-column move the in-txn capacity
    // check permits, since the card is itself the lone occupant). What must hold:
    expect(r1.released.concat(r2.released)).toContain(held);
    // (a) Single occupancy: the card lands in exactly one downstream slot, and is
    //     the only occupant of in-progress (no double-occupancy / slot leak).
    expect((await store.getTask(held))?.column).toBe("in-progress");
    const inProgress = (await store.listTasks({ includeArchived: false })).filter((t) => t.column === "in-progress");
    expect(inProgress.map((t) => t.id)).toEqual([held]);

    // (b) Reservation accounting across the racing sweeps.
    //
    // Both sweeps read the same snapshot, both pass the pre-check, and both
    // reserve a slot (reserveCount === 2). The winning sweep commits the move;
    // the losing sweep, after acquiring its reservation, re-reads the card's
    // current column inside `issueRelease`, sees it already at the target (the
    // winner moved it), and releases its reservation without issuing a redundant
    // same-column move. The safety invariant therefore holds: at most one live
    // reservation backs the single occupant.
    expect(reserveCount).toBe(2);
    // The loser releases its reservation, so the net live reservations is exactly
    // one (the winner's), backing the single in-progress occupant — no leak.
    expect(releaseCount).toBe(1);
    expect(reserveCount - releaseCount).toBe(1);
  });

  it("sweep release into a full column is rejected by the in-txn check (capacity is not a guard, scheduler bypasses guards)", async () => {
    await store.updateSettings({ maxConcurrent: 1 } as Parameters<typeof store.updateSettings>[0]);
    const occupant = await store.createTask({ description: "occupant" });
    setColumn(store, occupant.id, "in-progress");
    const held = await seedTodoCard();

    const result = await runHoldReleaseSweep(store, noReserveDeps);
    expect(result.released).not.toContain(held);
    expect((await store.getTask(held))?.column).toBe("todo");
  });

  it("capacity release respects cards mid-transitionPending (they hold the slot from commit time)", async () => {
    await store.updateSettings({ maxConcurrent: 1 } as Parameters<typeof store.updateSettings>[0]);
    // Occupant has committed into in-progress AND is mid-transitionPending — it
    // holds the slot; the in-txn count must include it.
    const occupant = await store.createTask({ description: "occupant" });
    setColumn(store, occupant.id, "in-progress");
    setTransitionPending(store, occupant.id, "in-progress");
    const held = await seedTodoCard();

    const result = await runHoldReleaseSweep(store, noReserveDeps);
    expect((await store.getTask(held))?.column).toBe("todo");
    expect(result.released).not.toContain(held);
  });

  it("paused and recovery-backoff tasks are skipped exactly as the legacy scheduler", async () => {
    await store.updateSettings({ maxConcurrent: 5 } as Parameters<typeof store.updateSettings>[0]);
    const paused = await seedTodoCard();
    await store.updateTask(paused, { paused: true });
    const backoff = await seedTodoCard();
    await store.updateTask(backoff, { nextRecoveryAt: new Date(Date.now() + 60_000).toISOString() });

    const result = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(result.released).not.toContain(paused);
    expect(result.released).not.toContain(backoff);
    expect((await store.getTask(paused))?.column).toBe("todo");
    expect((await store.getTask(backoff))?.column).toBe("todo");
  });

  it("reservation-first: semaphore exhausted → no commit, card stays held", async () => {
    await store.updateSettings({ maxConcurrent: 5 } as Parameters<typeof store.updateSettings>[0]);
    const held = await seedTodoCard();
    // reserveSlot returns null (semaphore exhausted) for a processing-column
    // release — the move must never be issued.
    const deps: HoldReleaseDeps = {
      now: () => Date.now(),
      reserveSlot: (): SlotReservation | null => null,
    };
    const result = await runHoldReleaseSweep(store, deps);
    expect(result.released).not.toContain(held);
    expect((await store.getTask(held))?.column).toBe("todo");
  });

  it("reservation is RELEASED when the move rejects on capacity", async () => {
    await store.updateSettings({ maxConcurrent: 1 } as Parameters<typeof store.updateSettings>[0]);
    const occupant = await store.createTask({ description: "occupant" });
    setColumn(store, occupant.id, "in-progress");
    const held = await seedTodoCard();

    const releases: number[] = [];
    let reserveCount = 0;
    const deps: HoldReleaseDeps = {
      now: () => Date.now(),
      reserveSlot: (): SlotReservation | null => {
        reserveCount += 1;
        return { release: () => releases.push(1) };
      },
    };
    const result = await runHoldReleaseSweep(store, deps);
    expect(result.released).not.toContain(held);
    // A reservation was taken (downstream pre-check passed since maxConcurrent
    // read-through is evaluated against the snapshot) then released on the
    // in-txn capacity rejection. If the pre-check already gated, reserveCount
    // may be 0; if it reserved, it must have released exactly once.
    if (reserveCount > 0) expect(releases.length).toBe(reserveCount);
  });
});

// ── Timer / manual / external-event holds (custom workflows) ──────────────────

/** A custom workflow whose middle column is a hold with the given release kind.
 *  Columns: c-intake (intake) → c-hold (hold) → c-run (wip) → c-done (complete). */
function customHoldWorkflowIr(release: string, holdConfig: Record<string, unknown> = {}): WorkflowIr {
  return {
    version: "v2",
    name: "custom-hold",
    columns: [
      { id: "c-intake", name: "Intake", traits: [{ trait: "intake" }] },
      { id: "c-hold", name: "Hold", traits: [{ trait: "hold", config: { release, ...holdConfig } }] },
      { id: "c-run", name: "Run", traits: [{ trait: "wip", config: { limit: 5 } }] },
      { id: "c-done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "c-intake" },
      { id: "end", kind: "end", column: "c-done" },
    ],
    edges: [{ from: "start", to: "end" }],
  } as WorkflowIr;
}

describe("hold-release sweep — timer / manual / external-event (U6)", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "u6-hold-kinds-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m init");
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
    await store.init();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  afterEach(() => {
    try { store?.close(); } catch { /* ignore */ }
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  async function seedCustomHold(release: string, holdConfig: Record<string, unknown> = {}): Promise<string> {
    const def = await store.createWorkflowDefinition({ name: `wf-${release}`, ir: customHoldWorkflowIr(release, holdConfig) });
    const task = await store.createTask({ description: `hold-${release}` });
    setSelection(store, task.id, def.id);
    setColumn(store, task.id, "c-hold");
    return task.id;
  }

  it("timer release fires at the deadline under fake timers (no real sleeps)", async () => {
    vi.useFakeTimers();
    const base = Date.now();
    const id = await seedCustomHold("timer", { durationMs: 10_000 });
    // Re-stamp columnMovedAt to the fake-clock base so the deadline is base+10s.
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
    db.prepare('UPDATE tasks SET "columnMovedAt" = ? WHERE id = ?').run(new Date(base).toISOString(), id);

    // Before the deadline: not released.
    const before = await runHoldReleaseSweep(store, { now: () => base + 5_000 });
    expect(before.released).not.toContain(id);
    expect((await store.getTask(id))?.column).toBe("c-hold");

    // At/after the deadline: released into the downstream run column.
    const after = await runHoldReleaseSweep(store, { now: () => base + 10_000 });
    expect(after.released).toContain(id);
    expect((await store.getTask(id))?.column).toBe("c-run");
  });

  it("manual hold: the sweep never auto-releases; an explicit promote does", async () => {
    const id = await seedCustomHold("manual");
    const swept = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(swept.released).not.toContain(id);
    expect((await store.getTask(id))?.column).toBe("c-hold");

    const promoted = await promoteHeldTask(store, id);
    expect(promoted.released).toBe(true);
    expect(promoted.toColumn).toBe("c-run");
    expect((await store.getTask(id))?.column).toBe("c-run");
  });

  it("external-event hold: the sweep never auto-releases; an event release does; a stray event on a manual hold is a no-op", async () => {
    const eventId = await seedCustomHold("external-event");
    const swept = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(swept.released).not.toContain(eventId);

    const released = await releaseHeldTaskByEvent(store, eventId, "webhook:approved");
    expect(released.released).toBe(true);
    expect((await store.getTask(eventId))?.column).toBe("c-run");

    // A manual hold is NOT releasable by an external event.
    const manualId = await seedCustomHold("manual");
    const stray = await releaseHeldTaskByEvent(store, manualId, "webhook:approved");
    expect(stray.released).toBe(false);
    expect((await store.getTask(manualId))?.column).toBe("c-hold");
  });
});

// ── Dependency gating (KTD-5 + FN-5719 dual-accept) ───────────────────────────

/** A custom workflow with a hold(dependency) column. */
function dependencyHoldWorkflowIr(): WorkflowIr {
  return {
    version: "v2",
    name: "dep-hold",
    columns: [
      { id: "d-intake", name: "Intake", traits: [{ trait: "intake" }] },
      { id: "d-hold", name: "Hold", traits: [{ trait: "hold", config: { release: "dependency" } }] },
      { id: "d-run", name: "Run", traits: [{ trait: "wip", config: { limit: 5 } }] },
      { id: "d-done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "d-intake" },
      { id: "end", kind: "end", column: "d-done" },
    ],
    edges: [{ from: "start", to: "end" }],
  } as WorkflowIr;
}

/** A custom "producer" workflow whose terminal column carries the complete flag
 *  under a NON-legacy column id (so the complete-flag path differs from the
 *  legacy done/in-review/archived signal — used for the dual-accept diff). */
function completeFlagWorkflowIr(): WorkflowIr {
  return {
    version: "v2",
    name: "producer",
    columns: [
      { id: "p-intake", name: "Intake", traits: [{ trait: "intake" }] },
      { id: "p-finished", name: "Finished", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "p-intake" },
      { id: "end", kind: "end", column: "p-finished" },
    ],
    edges: [{ from: "start", to: "end" }],
  } as WorkflowIr;
}

describe("hold-release sweep — dependency gating (KTD-5)", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "u6-dep-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m init");
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
    await store.init();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  afterEach(() => {
    try { store?.close(); } catch { /* ignore */ }
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("a dependency in another workflow's complete-flagged column unblocks the dependent; dual-accept logs a diff on disagreement", async () => {
    const auditSpy = vi.spyOn(store, "recordRunAuditEvent");

    const producerDef = await store.createWorkflowDefinition({ name: "producer", ir: completeFlagWorkflowIr() });
    const dep = await store.createTask({ description: "producer task" });
    setSelection(store, dep.id, producerDef.id);
    // Producer NOT yet complete → dependent stays held.
    setColumn(store, dep.id, "p-intake");

    const depHoldDef = await store.createWorkflowDefinition({ name: "dep-hold", ir: dependencyHoldWorkflowIr() });
    const dependent = await store.createTask({ description: "dependent", dependencies: [dep.id] });
    setSelection(store, dependent.id, depHoldDef.id);
    setColumn(store, dependent.id, "d-hold");

    const r1 = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(r1.released).not.toContain(dependent.id);
    expect((await store.getTask(dependent.id))?.column).toBe("d-hold");

    // Move the producer into its complete-flagged column (NON-legacy id).
    setColumn(store, dep.id, "p-finished");
    auditSpy.mockClear();

    const r2 = await runHoldReleaseSweep(store, { now: () => Date.now() });
    expect(r2.released).toContain(dependent.id);
    expect((await store.getTask(dependent.id))?.column).toBe("d-run");

    // Dual-accept disagreement: the complete-flag says satisfied, but the legacy
    // signal (column p-finished is NOT done/in-review/archived, no marker) says
    // NOT satisfied → an audit-diff event was logged.
    const diffLogged = auditSpy.mock.calls.some(
      (call) => (call[0] as { mutationType?: string })?.mutationType === "merge:dependency-parity-diff",
    );
    expect(diffLogged).toBe(true);
  });
});
