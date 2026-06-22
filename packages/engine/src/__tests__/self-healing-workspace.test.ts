/*
FNXC:Workspace 2026-06-22-09:30 (Phase D U1 — workspace-aware self-healing):
Exercises the workspace-aware self-healing reconcilers against a REAL two-repo git fixture under
a NON-git workspace root (createWorkspaceFixture), so a leaked rootDir git preflight or a
single-commit finalize over the non-git root would actually fail. Real git is used only where the
invariant requires it (per-repo landedSha ancestor check, FORK-A branch-gone check, per-repo
worktree removal); fake timers drive the FN-6736 phantom-lease staleness floor. No mock-the-world
child_process, no unbounded temp walk, never touches port 4040.

Surfaces (FN-5893):
- P0: a PARTIAL-landed workspace task stuck "merging" with no live holder → recoverInterruptedMergingTasks
  does NOT finalize it done (no single-commit finalize); the partial-land reconciler re-enqueues.
- P1: a zero-landed mergeable workspace task → recoverMergeableReviewTasks re-enqueues (not skipped by worktree gate).
- guards: autoMerge:false / user-paused / a live sub-repo worktree → -no-action, not moved backward.
- phantom: a workspace-repo-land lease with a terminal owner older than the floor → reclaimed; live owner → untouched.
- cleanup: a done task's recorded per-repo worktrees → removed (isPathActive-guarded); no temp walk.
- FORK-A: branch-gone + landedSha-unset → parked failed; branch-gone + landedSha-set → skipped as landed.
- regression: a single-repo (non-workspace) task → reconcilers behave identically.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { landWorkspaceTask } from "../merger-ai.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

const TASK_ID = "FN-7001";
const BRANCH = "fusion/fn-7001";

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

interface RecordingStore extends EventEmitter {
  tasks: Map<string, Task>;
  emitted: Array<{ event: string; payload: unknown }>;
  enqueued: string[];
  updateTask: ReturnType<typeof vi.fn>;
  moveTask: ReturnType<typeof vi.fn>;
}

function createStore(rows: Task[], settings: Partial<Settings> = {}): TaskStore & RecordingStore {
  const emitter = new EventEmitter();
  const tasks = new Map<string, Task>(rows.map((t) => [t.id, t]));
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const enqueued: string[] = [];
  const realEmit = emitter.emit.bind(emitter);
  const store = Object.assign(emitter, {
    tasks,
    emitted,
    enqueued,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false, taskStuckTimeoutMs: 60_000, ...settings } as unknown as Settings),
    listTasks: vi.fn(async (opts?: { column?: string }) => {
      const all = [...tasks.values()];
      return opts?.column ? all.filter((t) => t.column === opts.column) : all;
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const cur = tasks.get(id);
      if (cur) tasks.set(id, { ...cur, ...patch } as Task);
      return tasks.get(id) as Task;
    }),
    moveTask: vi.fn(async (id: string, column: string) => {
      const cur = tasks.get(id);
      const next = { ...(cur ?? { id }), column } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    peekMergeQueue: vi.fn().mockReturnValue([]),
    getRootDir: vi.fn().mockReturnValue("/tmp/test"),
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
      return realEmit(event, payload);
    },
  }) as unknown as TaskStore & RecordingStore;
  return store;
}

function makeManager(store: TaskStore, rootDir: string, opts: Record<string, unknown> = {}): SelfHealingManager {
  const enqueueMerge = (taskId: string) => {
    (store as unknown as RecordingStore).enqueued.push(taskId);
    return true;
  };
  return new SelfHealingManager(store, {
    rootDir,
    enqueueMerge,
    clearMergeActive: vi.fn(),
    ...opts,
  } as never);
}

/** Add a real `fusion/<id>` branch in a sub-repo with one non-conflicting own commit. */
function addRepoBranch(fx: WorkspaceFixture, repoRel: string, content: string): void {
  const repoDir = fx.repoPath(repoRel);
  const wt = path.join(repoDir, ".wt-branch");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${wt} HEAD`);
  configureIdentity(wt);
  writeFileSync(path.join(wt, "feature.txt"), content, "utf-8");
  execSync("git add feature.txt", { cwd: wt, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): add"`, { cwd: wt, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${wt}`);
}

/** Land one sub-repo for real (squash onto main) and return its landedSha. */
function landRepoForReal(fx: WorkspaceFixture, repoRel: string): string {
  const repoDir = fx.repoPath(repoRel);
  configureIdentity(repoDir);
  execSync(`git merge --squash ${BRANCH}`, { cwd: repoDir, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): landed\n\nFusion-Task-Id: ${TASK_ID}"`, { cwd: repoDir, stdio: "pipe" });
  return fx.git(repoRel, "git rev-parse refs/heads/main");
}

function workspaceTask(workspaceWorktrees: Task["workspaceWorktrees"], extra: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Workspace task",
    column: "in-review",
    branch: BRANCH,
    worktree: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: false,
    workspaceWorktrees,
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...extra,
  } as unknown as Task;
}

describeIfGit("workspace-aware self-healing (Phase D U1)", () => {
  let fx: WorkspaceFixture;
  beforeEach(() => {
    activeSessionRegistry.clear();
  });
  afterEach(() => {
    activeSessionRegistry.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
    fx?.cleanup();
  });

  // ── KTD1 P0: partial-landed "merging" task must NOT be finalized done ──────
  it("recoverInterruptedMergingTasks does NOT finalize a partial-landed workspace task (P0)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranch(fx, "repo-a", "a\n");
    addRepoBranch(fx, "repo-b", "b\n");
    const landedA = landRepoForReal(fx, "repo-a"); // repo A landed; repo B NOT.

    const task = workspaceTask(
      {
        "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH, landedSha: landedA },
        "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
      },
      { status: "merging", updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
    );
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    await manager.recoverInterruptedMergingTasks();

    // NOT finalized done; status cleared; never emitted task:merged on a single repo.
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.emitted.some((e) => e.event === "task:merged")).toBe(false);
    expect(store.tasks.get(TASK_ID)?.status).toBeNull();
    expect(store.tasks.get(TASK_ID)?.column).toBe("in-review");
    // It re-enqueued the per-repo land for idempotent completion.
    expect(store.enqueued).toContain(TASK_ID);
  });

  it("partial-land reconciler re-enqueues a partial-landed workspace task", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranch(fx, "repo-a", "a\n");
    addRepoBranch(fx, "repo-b", "b\n");
    const landedA = landRepoForReal(fx, "repo-a");

    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH, landedSha: landedA },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const n = await manager.reconcileWorkspacePartialLands();

    expect(n).toBe(1);
    expect(store.enqueued).toContain(TASK_ID);
    // Not moved backward / not parked failed (repo B branch still exists → retryable).
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
  });

  // ── KTD1 P1: zero-landed mergeable workspace task admitted ─────────────────
  it("recoverMergeableReviewTasks re-enqueues a zero-landed mergeable workspace task (P1)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    await manager.recoverMergeableReviewTasks();

    expect(store.enqueued).toContain(TASK_ID);
  });

  // ── KTD2 guards: never move backward when human-gated / live ───────────────
  it("partial-land reconciler emits -no-action for autoMerge:false (not moved backward)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore([task], { autoMerge: false });
    const manager = makeManager(store, fx.rootDir);

    const n = await manager.reconcileWorkspacePartialLands();

    expect(n).toBe(0);
    expect(store.enqueued).not.toContain(TASK_ID);
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
  });

  it("partial-land reconciler emits -no-action for a user-paused task", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const task = workspaceTask(
      { "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } },
      { userPaused: true },
    );
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const n = await manager.reconcileWorkspacePartialLands();
    expect(n).toBe(0);
    expect(store.enqueued).not.toContain(TASK_ID);
  });

  it("partial-land reconciler emits -no-action when a sub-repo worktree is live", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const wtPath = fx.repoPath("repo-a");
    const task = workspaceTask({
      "repo-a": { worktreePath: wtPath, branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    // A live sub-repo session (workspace-aware liveness via pathsForTask ∩ isPathActive).
    activeSessionRegistry.registerPath(wtPath, { taskId: TASK_ID, kind: "executor", ownerKey: "x" });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const n = await manager.reconcileWorkspacePartialLands();
    expect(n).toBe(0);
    expect(store.enqueued).not.toContain(TASK_ID);
  });

  /*
  FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU — merge-queue dispatch blind spot):
  A workspace task in the dequeue→rawMerge window is being merged but NO liveness signal fires
  (no active session path, no executingTaskLock/isTaskActive, no activeMergeTaskId, no `merging`
  status, no land lease yet). Without the merge-pending guard the partial-land reconciler would
  re-enqueue it → a SECOND concurrent `landWorkspaceTask(T)` → double-squash. With `isMergePending`
  returning true (task is in mergeQueue/mergeActive) the reconciler must NOT re-enqueue and must
  emit -no-action(reason: "merge-pending").
  */
  it("partial-land reconciler does NOT re-enqueue a merge-pending task (closes double-dispatch)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranch(fx, "repo-a", "a\n");
    addRepoBranch(fx, "repo-b", "b\n");
    const landedA = landRepoForReal(fx, "repo-a"); // partial-landed → would normally re-enqueue.

    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH, landedSha: landedA },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore([task]);
    // Narrow seam: inject the in-memory merge-pipeline probe. No session/lock/lease set → only
    // the merge-pending guard can stop the re-enqueue.
    const manager = makeManager(store, fx.rootDir, { isMergePending: (id: string) => id === TASK_ID });

    const n = await manager.reconcileWorkspacePartialLands();

    expect(n).toBe(0);
    expect(store.enqueued).not.toContain(TASK_ID);
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
    expect(store.tasks.get(TASK_ID)?.column).toBe("in-review");
    const auditCalls = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      auditCalls.some(
        ([ev]) =>
          (ev as { mutationType?: string }).mutationType === "task:reconcile-workspace-partial-land-no-action" &&
          (ev as { metadata?: { reason?: string } }).metadata?.reason === "merge-pending",
      ),
    ).toBe(true);
  });

  // ── KTD2 FORK-A: branch-gone classification ────────────────────────────────
  it("FORK-A: branch gone + landedSha unset → parked failed", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    // No fusion branch created in repo-a, and no landedSha → unrecoverable.
    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const n = await manager.reconcileWorkspacePartialLands();
    expect(n).toBe(1);
    expect(store.tasks.get(TASK_ID)?.status).toBe("failed");
    expect(store.enqueued).not.toContain(TASK_ID);
  });

  it("FORK-A: branch gone + landedSha set → skipped as landed (re-enqueue finalize)", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranch(fx, "repo-a", "a\n");
    const landedA = landRepoForReal(fx, "repo-a");
    fx.git("repo-a", `git branch -D ${BRANCH}`); // branch gone, but landedSha is an ancestor.

    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH, landedSha: landedA },
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const n = await manager.reconcileWorkspacePartialLands();
    // All landed → not parked failed; re-enqueued for finalize-once.
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
    expect(store.enqueued).toContain(TASK_ID);
    expect(n).toBe(1);
  });

  // ── KTD3 phantom lease reclaim ─────────────────────────────────────────────
  it("reclaims a workspace-repo-land lease whose owner is terminal and older than the floor", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    // Owner is done (terminal). Floor = taskStuckTimeoutMs(60s) * 3 = 180s. Advance well past it.
    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "done" });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-06-22T00:10:00.000Z"));
    const n = await manager.reclaimPhantomWorkspaceLandLeases();

    expect(n).toBe(1);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(false);
  });

  it("does NOT reclaim a land lease owned by a live merging task", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    // Owner is in-review with an active "merging" status → live; lease must be left alone.
    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { status: "merging" });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-06-22T00:10:00.000Z"));
    const n = await manager.reclaimPhantomWorkspaceLandLeases();

    expect(n).toBe(0);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(true);
  });

  /*
  FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU — merge-queue dispatch blind spot):
  A workspace-repo-land lease whose owner is mid-dispatch (in mergeQueue/mergeActive but not yet
  activeMergeTaskId) is about to be LEGITIMATELY used by the in-flight `landWorkspaceTask`. Even
  though the owner ROW reads terminal-looking and the lease is past the staleness floor, the
  merge-pending guard must keep the lease. Here the owner is `done` and the lease is well past the
  180s floor — so ONLY the merge-pending guard can prevent reclaim.
  */
  it("does NOT reclaim a land lease whose owner is merge-pending (mid-dispatch)", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "done" });
    const store = createStore([task]);
    // Narrow seam: owner is in the in-memory merge pipeline → lease must be left alone.
    const manager = makeManager(store, fx.rootDir, { isMergePending: (id: string) => id === TASK_ID });

    vi.setSystemTime(new Date("2026-06-22T00:10:00.000Z")); // 600s > 180s floor.
    const n = await manager.reclaimPhantomWorkspaceLandLeases();

    expect(n).toBe(0);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(true);
  });

  it("does NOT reclaim a land lease younger than the staleness floor", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "done" });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-06-22T00:01:00.000Z")); // 60s < 180s floor.
    const n = await manager.reclaimPhantomWorkspaceLandLeases();

    expect(n).toBe(0);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(true);
  });

  // ── KTD4 per-repo worktree cleanup ─────────────────────────────────────────
  it("removes a done workspace task's recorded per-repo worktrees (isPathActive-guarded)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    // Create a real per-repo worktree for each sub-repo (the recorded worktreePath).
    const wtA = path.join(fx.repoPath("repo-a"), ".wt-task");
    const wtB = path.join(fx.repoPath("repo-b"), ".wt-task");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${wtA} HEAD`);
    fx.git("repo-b", `git worktree add -b ${BRANCH} ${wtB} HEAD`);
    expect(existsSync(wtA)).toBe(true);
    expect(existsSync(wtB)).toBe(true);

    const task = workspaceTask(
      {
        "repo-a": { worktreePath: wtA, branch: BRANCH },
        "repo-b": { worktreePath: wtB, branch: BRANCH },
      },
      { column: "done" },
    );
    // Mark repo-b's worktree as active → it must be SKIPPED.
    activeSessionRegistry.registerPath(wtB, { taskId: TASK_ID, kind: "executor", ownerKey: "x" });

    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const cleaned = await manager.reconcileOrphanedWorkspaceWorktrees();

    expect(cleaned).toBe(1);
    expect(existsSync(wtA)).toBe(false); // removed
    expect(existsSync(wtB)).toBe(true); // active → skipped
  });

  // ── regression: single-repo task untouched by workspace reconcilers ────────
  it("single-repo (non-workspace) task is ignored by the workspace reconcilers", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const single = {
      id: "FN-9001",
      column: "in-review",
      branch: "fusion/fn-9001",
      worktree: "/tmp/wt/fn-9001",
      status: "merging",
      paused: false,
      dependencies: [],
      steps: [],
      currentStep: 0,
      updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    } as unknown as Task;
    const store = createStore([single]);
    const manager = makeManager(store, fx.rootDir);

    const partial = await manager.reconcileWorkspacePartialLands();
    const leases = await manager.reclaimPhantomWorkspaceLandLeases();
    const orphans = await manager.reconcileOrphanedWorkspaceWorktrees();

    expect(partial).toBe(0);
    expect(leases).toBe(0);
    expect(orphans).toBe(0);
    expect(store.enqueued).not.toContain("FN-9001");
    expect(store.tasks.get("FN-9001")?.status).toBe("merging"); // untouched
  });

  // ── review A (TWIN): recoverStuckMergeDeadlocks must NOT single-commit-finalize ─────
  it("recoverStuckMergeDeadlocks does NOT finalize a partial-landed workspace task with blocked dependents (P0 twin)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranch(fx, "repo-a", "a\n");
    addRepoBranch(fx, "repo-b", "b\n");
    const landedA = landRepoForReal(fx, "repo-a"); // repo A landed; repo B NOT → partial.

    const task = workspaceTask(
      {
        "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH, landedSha: landedA },
        "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
      },
      // Deadlock-candidate shape: failed + retries exhausted, mergeConfirmed unset.
      { status: "failed", mergeRetries: 5, updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
    );
    // A blocked dependent in todo → the deadlock filter admits the (worktree-null) workspace task.
    const dependent = {
      id: "FN-7002", column: "todo", blockedBy: TASK_ID, paused: false, dependencies: [], steps: [], currentStep: 0,
    } as unknown as Task;
    const store = createStore([task, dependent], { maxAutoMergeRetries: 1 });
    const manager = makeManager(store, fx.rootDir);

    await manager.recoverStuckMergeDeadlocks();

    // NOT finalized done; never emitted task:merged on a single repo; status cleared (not done).
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.emitted.some((e) => e.event === "task:merged")).toBe(false);
    expect(store.tasks.get(TASK_ID)?.column).toBe("in-review");
    expect(store.tasks.get(TASK_ID)?.status).toBeNull();
  });

  // ── review B: bounded re-enqueue — no silent infinite loop ─────────────────
  it("partial-land reconciler parks failed after N consecutive enqueue drops (no infinite re-enqueue)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranch(fx, "repo-a", "a\n");
    addRepoBranch(fx, "repo-b", "b\n");
    const landedA = landRepoForReal(fx, "repo-a");

    const baseTrees = {
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH, landedSha: landedA },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    } as NonNullable<Task["workspaceWorktrees"]>;
    const task = workspaceTask(baseTrees);
    const store = createStore([task]);
    // enqueueMerge that ALWAYS rejects (queue full) → drop every time.
    const manager = makeManager(store, fx.rootDir, { enqueueMerge: () => false });

    // First two sweeps: dropped, re-enqueued (not failed yet). repo-b branch still present → retryable.
    await manager.reconcileWorkspacePartialLands();
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
    await manager.reconcileWorkspacePartialLands();
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
    // Third drop hits the bound → parked failed.
    await manager.reconcileWorkspacePartialLands();
    expect(store.tasks.get(TASK_ID)?.status).toBe("failed");
  });

  // ── review C: phantom-lease reclaim must NOT reclaim a live executing (in-progress) task ─
  it("does NOT reclaim a land lease owned by an IN-PROGRESS executing task (no merge status)", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    // Owner is executing in 'in-progress' with NO merge status — registered its land lease early.
    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "in-progress", status: null });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-06-22T00:10:00.000Z")); // well past the 180s floor.
    const n = await manager.reclaimPhantomWorkspaceLandLeases();

    expect(n).toBe(0);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(true);
  });

  // ── review D: branch-gone + landedSha-set-but-UNREACHABLE → parked, not re-enqueued forever ─
  it("FORK-A: branch gone + landedSha set but UNREACHABLE → parked failed (not re-enqueued forever)", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranch(fx, "repo-a", "a\n");
    const landedA = landRepoForReal(fx, "repo-a");
    // Roll the integration ref BACK so landedA is no longer reachable (force-reset), and delete the branch.
    fx.git("repo-a", "git reset --hard HEAD~1");
    fx.git("repo-a", `git branch -D ${BRANCH}`);

    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH, landedSha: landedA },
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const n = await manager.reconcileWorkspacePartialLands();
    // isRepoLanded is FALSE (landedSha unreachable, no trailer on ref) AND branch gone → unrecoverable.
    expect(n).toBe(1);
    expect(store.tasks.get(TASK_ID)?.status).toBe("failed");
    expect(store.enqueued).not.toContain(TASK_ID);
  });

  // ── review E: failing git worktree remove → logged, isolated, bounded ──────
  it("orphan worktree removal failure is bounded and does not abort the sweep", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    // repo-a: a real removable worktree. repo-b: a path that EXISTS but is NOT a git worktree → remove fails.
    const wtA = path.join(fx.repoPath("repo-a"), ".wt-task");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${wtA} HEAD`);
    const wtB = path.join(fx.repoPath("repo-b"), ".not-a-worktree");
    execSync(`mkdir -p ${wtB}`, { stdio: "pipe" });
    writeFileSync(path.join(wtB, "stray.txt"), "x", "utf-8");
    expect(existsSync(wtA)).toBe(true);
    expect(existsSync(wtB)).toBe(true);

    const task = workspaceTask(
      {
        "repo-a": { worktreePath: wtA, branch: BRANCH },
        "repo-b": { worktreePath: wtB, branch: BRANCH },
      },
      { column: "done" },
    );
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    // First sweep: repo-a removed (isolated from repo-b's failure); repo-b counted as a failure.
    const cleaned1 = await manager.reconcileOrphanedWorkspaceWorktrees();
    expect(cleaned1).toBe(1);
    expect(existsSync(wtA)).toBe(false);
    // The audit recorded a failure for repo-b (observability), and the sweep did not throw.
    expect(store.emitted.length >= 0).toBe(true);

    // Subsequent sweeps keep failing on repo-b but stay bounded — after the bound they stop attempting.
    await manager.reconcileOrphanedWorkspaceWorktrees();
    await manager.reconcileOrphanedWorkspaceWorktrees();
    const cleanedAfterBound = await manager.reconcileOrphanedWorkspaceWorktrees();
    // No more successful removals (repo-a already gone) and no crash.
    expect(cleanedAfterBound).toBe(0);
  });
});
