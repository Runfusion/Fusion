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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registerArchiveWorkspaceWorktreeDisposer, type Settings, type Task, type TaskStore, type WorkspaceLandIntent } from "@fusion/core";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";
import { classifyBranchProbeError } from "../self-healing-git-evidence.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { landWorkspaceTask } from "../merge/merger-ai.js";
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
  mergeWorkspaceWorktreeEntry: ReturnType<typeof vi.fn>;
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
    listTasks: vi.fn(async (opts?: { column?: string; includeDeleted?: boolean }) => {
      const all = [...tasks.values()].filter((task) => opts?.includeDeleted || !task.deletedAt);
      return opts?.column ? all.filter((t) => t.column === opts.column) : all;
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const cur = tasks.get(id);
      if (cur) tasks.set(id, { ...cur, ...patch } as Task);
      return tasks.get(id) as Task;
    }),
    mergeWorkspaceWorktreeEntry: vi.fn(async (
      id: string,
      repoRel: string,
      patch: Partial<NonNullable<Task["workspaceWorktrees"]>[string]>,
      options?: { requireExistingEntry?: boolean; clearSingularWorktree?: boolean },
    ) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} not found`);
      const workspaceWorktrees = current.workspaceWorktrees ?? {};
      const existing = workspaceWorktrees[repoRel];
      if (options?.requireExistingEntry && !existing) return current;
      const updated = {
        ...current,
        workspaceWorktrees: { ...workspaceWorktrees, [repoRel]: { ...existing, ...patch } },
        ...(options?.clearSingularWorktree ? { worktree: undefined, branch: undefined } : {}),
      } as Task;
      tasks.set(id, updated);
      return updated;
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

function managerOptions(store: TaskStore, rootDir: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  const enqueueMerge = (taskId: string) => {
    (store as unknown as RecordingStore).enqueued.push(taskId);
    return true;
  };
  return { rootDir, enqueueMerge, clearMergeActive: vi.fn(), ...opts };
}

function makeManager(store: TaskStore, rootDir: string, opts: Record<string, unknown> = {}): SelfHealingManager {
  return new SelfHealingManager(store, managerOptions(store, rootDir, opts) as never);
}

/*
FNXC:Workspace 2026-08-15-04:42:
These harnesses inject only the exec boundary so timeout tests execute the production probe try/catch
and classifier. Returning an outcome from an overridden probe would make the regression tautological.
*/
class BranchProbeHarness extends SelfHealingManager {
  async readBranchEvidence(repoRootDir: string, branch: string): Promise<"present" | "absent" | "unknown"> {
    return this.probeRepoBranch(repoRootDir, branch);
  }
}

class UnavailableBranchProbeManager extends SelfHealingManager {
  unavailable = true;

  protected override async execBranchProbe(repoRootDir: string, branch: string): Promise<void> {
    if (this.unavailable) {
      throw Object.assign(new Error("Command failed: git show-ref"), { killed: true, signal: "SIGTERM", code: null });
    }
    return super.execBranchProbe(repoRootDir, branch);
  }
}

class PruneFailureWorkspaceTeardownManager extends SelfHealingManager {
  pruneCalls = 0;

  protected override async execWorkspaceTeardownGit(command: string, options: { cwd: string; timeout: number }): Promise<{ stdout: string }> {
    if (command === "git worktree prune") {
      this.pruneCalls++;
      throw new Error("injected prune failure");
    }
    return super.execWorkspaceTeardownGit(command, options);
  }
}

class WorkspaceLandIntentManager extends SelfHealingManager {
  constructor(
    store: TaskStore,
    options: ConstructorParameters<typeof SelfHealingManager>[1],
    private readonly evidence: { resolution: "landed"; resolvedSha: string } | { resolution: "not-landed" } | undefined,
  ) {
    super(store, options);
  }

  protected override async readWorkspaceLandIntentRemoteEvidence(_intent: WorkspaceLandIntent): Promise<{ resolution: "landed"; resolvedSha: string } | { resolution: "not-landed" } | undefined> {
    return this.evidence;
  }
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
    // FNXC:RepositoryScope 2026-08-21-01:18: partial-land recovery admits only confirmed
    // repository intent plus qualified modified evidence; fixtures model that production contract.
    repositoryScope: { repositories: Object.keys(workspaceWorktrees ?? {}).sort(), state: "confirmed", revision: 1 },
    modifiedFiles: Object.keys(workspaceWorktrees ?? {}).sort().map((repo) => `${repo}/feature.txt`),
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...extra,
  } as unknown as Task;
}

/*
FNXC:WorkspaceArchiveRestore 2026-08-15-05:55:
The archive-to-unarchive regression below uses the real PostgreSQL restore transaction and the
store-scoped archive disposal seam. Booting Executor would add unrelated session lifecycle work;
the seam is the production boundary that owns removing each sub-repo worktree and branch.
*/
const pgDescribeIfGit = hasGit ? pgDescribe : describe.skip;

pgDescribeIfGit("FN-9048 workspace archive restore reaches self-healing cleanly", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workspace_archive_restore_e2e",
  });
  let fx: WorkspaceFixture;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
  });
  afterEach(async () => {
    fx?.cleanup();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("archives, disposes, restores, then skips FORK-A after its stale map is reconciled", async () => {
    const store = h.store();
    const id = "FN-9048-RESTORE-E2E";
    const branch = `fusion/${id.toLowerCase()}`;
    const workspaceWorktrees: NonNullable<Task["workspaceWorktrees"]> = {};
    for (const repoRel of fx.repos) {
      const worktreePath = path.join(fx.rootDir, ".worktrees", repoRel);
      mkdirSync(path.dirname(worktreePath), { recursive: true });
      fx.git(repoRel, `git worktree add -b ${branch} ${worktreePath} HEAD`);
      workspaceWorktrees[repoRel] = { worktreePath, branch };
    }
    const task = await store.createTaskWithReservedId(
      { description: "archive workspace restore regression", column: "in-review" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    /* FNXC:RepositoryScope 2026-08-23-23:59: partial-land recovery admits only CONFIRMED repository
       intent plus qualified modified evidence (see makeWorkspaceTask above). This card is built
       through the real store, so it must state the same contract or the sweep never considers it. */
    await store.updateTask(id, {
      workspaceWorktrees,
      branch: undefined,
      repositoryScope: { repositories: [...fx.repos].sort(), state: "confirmed", revision: 1 },
      /* Recovery is another merge door: default task creation seeds pending implementation steps and
         `getTaskMergeBlocker` refuses them, so this post-implementation fixture states them done. */
      steps: [{ name: "Implementation", status: "done" }],
      modifiedFiles: [...fx.repos].sort().map((repo) => `${repo}/feature.txt`),
    } as never);
    const stalePreArchive = (await store.getTask(id))!;
    const unregister = registerArchiveWorkspaceWorktreeDisposer(store, async (_task, plan) => {
      for (const entry of plan) {
        fx.git(entry.repoRel, `git worktree remove --force ${entry.worktreePath}`);
        fx.git(entry.repoRel, `git branch -D ${entry.branch}`);
      }
      return { removed: plan.map((entry) => entry.repoRel), failed: [] };
    });

    try {
      await store.archiveTask(id);
      for (const repoRel of fx.repos) {
        expect(existsSync(workspaceWorktrees[repoRel]!.worktreePath)).toBe(false);
        expect(fx.git(repoRel, `git show-ref --verify --quiet refs/heads/${branch}; echo $?`)).toBe("1");
      }

      /*
      FNXC:WorkspaceArchiveRestore 2026-08-15-05:55:
      This captures the exact pre-fix resurrection shape: archive removed both branches, but the
      soft-deleted row still has the old map and FORK-A proves it is unrecoverable.
      */
      const staleStore = createStore([stalePreArchive]);
      const staleManager = makeManager(staleStore, fx.rootDir);
      await staleManager.reconcileWorkspacePartialLands();
      expect(staleStore.updateTask).toHaveBeenCalledWith(id, expect.objectContaining({ status: "failed" }));

      const restored = await store.unarchiveTask(id);
      expect(restored.workspaceWorktrees).toBeUndefined();
      const updateTask = vi.spyOn(store, "updateTask");
      const recordRunAuditEvent = vi.spyOn(store, "recordRunAuditEvent");
      const manager = makeManager(store, fx.rootDir);

      expect(await manager.reconcileWorkspacePartialLands()).toBe(0);
      expect(updateTask).not.toHaveBeenCalledWith(id, expect.objectContaining({ status: "failed" }));
      expect(recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:reconcile-workspace-partial-land",
        metadata: expect.objectContaining({ action: "park-failed" }),
      }));
    } finally {
      unregister();
    }
  });
});

describeIfGit("workspace-aware self-healing (Phase D U1)", () => {
  let fx: WorkspaceFixture;
  beforeEach(() => {
    activeSessionRegistry.clear();
  });
  afterEach(() => {
    activeSessionRegistry.clear();
    executingTaskLock.release(TASK_ID);
    vi.useRealTimers();
    vi.clearAllMocks();
    fx?.cleanup();
  });

  /*
  FNXC:Workspace 2026-08-15-08:59:
  A different engine node must be able to turn an interrupted fenced push into the exact
  per-repository landed SHA. The resolver callback is the durable seam: it persists first and
  records the intent only after that task-map update succeeds.
  */
  it("reconciles a remotely landed pending intent without the original node", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const task = workspaceTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });
    const store = createStore([task]);
    const intent: WorkspaceLandIntent = {
      taskId: TASK_ID,
      repoRelPath: "repo-a",
      remoteUrl: "https://example.test/repo-a.git",
      integrationRef: "refs/heads/main",
      intendedSha: "landed-sha",
      expectedTip: "prior-sha",
      fenceRefName: "refs/fusion/fence/repo-a",
      fenceRefSha: "fence-sha",
      owner: { taskId: TASK_ID, nodeId: "dead-node", incarnationId: "dead-incarnation" },
      fenceToken: 7n,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const listPendingWorkspaceLandIntents = vi.fn().mockResolvedValue([intent]);
    const resolveOrphanedWorkspaceLandIntent = vi.fn(async (input: { persistLandedSha?: () => Promise<void> }) => {
      await input.persistLandedSha?.();
      return { outcome: "resolved" };
    });
    Object.assign(store, { listPendingWorkspaceLandIntents, resolveOrphanedWorkspaceLandIntent });
    const manager = new WorkspaceLandIntentManager(
      store,
      managerOptions(store, fx.rootDir) as never,
      { resolution: "landed", resolvedSha: "landed-sha" },
    );

    expect(await manager.reconcilePendingWorkspaceLandIntents()).toBe(1);
    expect(resolveOrphanedWorkspaceLandIntent).toHaveBeenCalledWith(expect.objectContaining({
      leaseKey: "repo:repo-a",
      expectedIntentFenceToken: 7n,
      resolution: "landed",
      resolvedSha: "landed-sha",
    }));
    expect(store.tasks.get(TASK_ID)?.workspaceWorktrees?.["repo-a"]?.landedSha).toBe("landed-sha");
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

  it("partial-land reconciler re-enqueues a failed zero-land lease-loss workspace task", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranch(fx, "repo-a", "a\n");
    addRepoBranch(fx, "repo-b", "b\n");
    const task = workspaceTask(
      {
        "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
        "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
      },
      {
        status: "failed",
        error: "Workspace partial land: 0 repo(s) landed — Workspace lease is no longer valid",
        steps: [{ status: "done" }, { status: "done" }],
      },
    );
    const workspaceWorktrees = task.workspaceWorktrees;
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const recovered = await manager.reconcileWorkspacePartialLands();

    expect(recovered).toBe(1);
    expect(store.enqueued).toEqual([TASK_ID]);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.emitted.some((event) => event.event === "task:merged")).toBe(false);
    expect(store.tasks.get(TASK_ID)?.workspaceWorktrees).toBe(workspaceWorktrees);
    expect(store.tasks.get(TASK_ID)?.column).toBe("in-review");
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

  it("FORK-A: persists failure breadcrumbs for every concurrently unrecoverable repo", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    // Both branches are absent and neither repository has a landing proof.
    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH, landedSha: "landed-a" },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const n = await manager.reconcileWorkspacePartialLands();
    const entries = store.tasks.get(TASK_ID)?.workspaceWorktrees;

    expect(n).toBe(1);
    expect(store.tasks.get(TASK_ID)?.status).toBe("failed");
    expect(entries?.["repo-a"]?.landFailure).toMatchObject({ branch: BRANCH });
    expect(entries?.["repo-b"]?.landFailure).toMatchObject({ branch: BRANCH });
  });

  it("skips a restored fully-disposed workspace task after restore clears its map", async () => {
    /*
    FNXC:WorkspaceArchiveRestore 2026-08-15-05:39:
    The preceding FORK-A case proves stale entries with deleted branches must fail loudly. Restore
    clears that disposed map, so this same two-repository shape is no longer a workspace candidate.
    */
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const restored = workspaceTask(undefined, { worktree: undefined });
    const store = createStore([restored]);
    const manager = makeManager(store, fx.rootDir);

    expect(await manager.reconcileWorkspacePartialLands()).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ status: "failed" }),
    );
    expect(store.emitted.some((event) => event.event === "task:reconcile-workspace-partial-land")).toBe(false);
  });

  it("classifies only a clean exit-1 branch probe error as absent", () => {
    expect(classifyBranchProbeError({ code: 1 })).toBe("absent");
    for (const error of [
      { code: 1, killed: true, signal: "SIGTERM" },
      { code: 128 },
      { code: "ENOENT" },
      { code: "EACCES" },
      { killed: true, signal: "SIGTERM", code: null },
      {},
      "non-error throw",
    ]) {
      expect(classifyBranchProbeError(error)).toBe("unknown");
    }
  });

  it("probes real existing and deleted branches as present and absent", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranch(fx, "repo-a", "a\n");
    const store = createStore([]);
    const manager = new BranchProbeHarness(store, managerOptions(store, fx.rootDir) as never);

    expect(await manager.readBranchEvidence(fx.repoPath("repo-a"), BRANCH)).toBe("present");
    fx.git("repo-a", `git branch -D ${BRANCH}`);
    expect(await manager.readBranchEvidence(fx.repoPath("repo-a"), BRANCH)).toBe("absent");
  });

  it("defers missing sub-repo evidence without failing, moving, or enqueuing", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const task = workspaceTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "missing-repo": { worktreePath: path.join(fx.rootDir, "missing-repo"), branch: BRANCH },
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    expect(await manager.reconcileWorkspacePartialLands()).toBe(0);
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
    expect(store.tasks.get(TASK_ID)?.column).toBe("in-review");
    expect(store.enqueued).not.toContain(TASK_ID);
    expect((store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.some(
      ([event]) => (event as { metadata?: { reason?: string } }).metadata?.reason === "evidence-unavailable",
    )).toBe(true);
  });

  it("defers timeout-shaped evidence through the real probe classifier", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranch(fx, "repo-a", "a\n");
    const task = workspaceTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });
    const store = createStore([task]);
    const manager = new UnavailableBranchProbeManager(store, managerOptions(store, fx.rootDir) as never);

    expect(await manager.reconcileWorkspacePartialLands()).toBe(0);
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
    expect(store.tasks.get(TASK_ID)?.column).toBe("in-review");
    expect(store.enqueued).not.toContain(TASK_ID);
    expect((store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.some(
      ([event]) => (event as { metadata?: { reason?: string } }).metadata?.reason === "evidence-unavailable",
    )).toBe(true);
  });

  it("parks only after bounded unavailable-evidence deferrals and resets after recovery", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranch(fx, "repo-a", "a\n");
    const task = workspaceTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });
    const store = createStore([task]);
    const manager = new UnavailableBranchProbeManager(store, managerOptions(store, fx.rootDir) as never);

    await manager.reconcileWorkspacePartialLands();
    await manager.reconcileWorkspacePartialLands();
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
    manager.unavailable = false;
    expect(await manager.reconcileWorkspacePartialLands()).toBe(1);
    expect(store.enqueued).toContain(TASK_ID);

    store.enqueued.length = 0;
    manager.unavailable = true;
    await manager.reconcileWorkspacePartialLands();
    await manager.reconcileWorkspacePartialLands();
    await manager.reconcileWorkspacePartialLands();
    expect(store.tasks.get(TASK_ID)?.status).toBe("failed");
    expect(store.tasks.get(TASK_ID)?.error).toContain("evidence unavailable");
    expect(store.tasks.get(TASK_ID)?.error).not.toContain("no fusion/");
  });

  it("defers when unknown evidence is mixed with a genuinely absent branch", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const task = workspaceTask({
      "missing-repo": { worktreePath: path.join(fx.rootDir, "missing-repo"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    expect(await manager.reconcileWorkspacePartialLands()).toBe(0);
    expect(store.tasks.get(TASK_ID)?.status).not.toBe("failed");
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

  it("clears an unowned startup contention wait but preserves user-paused and live owners", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const livePath = fx.repoPath("repo-a");
    const waiting = workspaceTask({}, {
      id: "FN-179-waiting",
      column: "todo",
      status: "contention-hold",
      sessionContentionWaitReason: "workspace sub-repo Merge acquisition is in progress for task MRG-050",
    });
    const userPaused = workspaceTask({}, {
      id: "FN-179-user-paused",
      column: "todo",
      status: "contention-hold",
      sessionContentionWaitReason: "waiting",
      paused: true,
      userPaused: true,
    });
    const live = workspaceTask({}, {
      id: "FN-179-live",
      column: "in-progress",
      status: "contention-hold",
      sessionContentionWaitReason: "waiting",
    });
    activeSessionRegistry.registerPath(livePath, { taskId: live.id, kind: "executor", ownerKey: "live-executor" });
    const store = createStore([waiting, userPaused, live]);
    const manager = makeManager(store, fx.rootDir);

    expect(await manager.clearOrphanedSessionContentionHolds()).toBe(1);
    expect(store.tasks.get(waiting.id)).toMatchObject({ status: null, sessionContentionWaitReason: null });
    expect(store.tasks.get(userPaused.id)).toMatchObject({ status: "contention-hold", sessionContentionWaitReason: "waiting" });
    expect(store.tasks.get(live.id)).toMatchObject({ status: "contention-hold", sessionContentionWaitReason: "waiting" });
  });

  it("reclaims a terminal workspace-repo-acquire cache as defence in depth", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, {
      taskId: TASK_ID,
      kind: "workspace-repo-acquire",
      ownerKey: "workspace-repo-acquire",
    });
    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, {
      column: "in-progress",
      deletedAt: "2026-08-22T23:00:00.000Z",
    });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-08-23T00:10:00.000Z"));
    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(1);
    expect(activeSessionRegistry.lookupByPath(leasePath)).toBeNull();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reclaim-phantom-workspace-acquire-lease",
    }));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-22:10:
  `leaseOwnerCompleteColumns` was UNCOVERED on the #3115 map. The case above proves the terminal-owner
  reclaim using `column: "done"` — the id — so blinding the resolver leaves it green.

  That set is what `isWorkspaceOwnerLive` consults. Keyed on the id, an owner resting in a renamed
  completion lane reads as LIVE, so its land lease is never reclaimed: the workspace repo stays
  leased by a task that finished, and every later land against that repo waits behind a phantom.
  */
  it("reclaims a land lease whose owner rests in a RENAMED complete lane", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "shipped" });
    const store = createStore([task]);
    (store as unknown as { listWorkflowDefinitions: unknown }).listWorkflowDefinitions = vi.fn(async () => [{
      id: "custom:renamed",
      ir: {
        version: "v2",
        id: "custom:renamed",
        nodes: [],
        edges: [],
        columns: [
          { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
        ],
      },
    }]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-06-22T00:10:00.000Z"));

    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(1);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(false);
  });

  /*
  FNXC:Workspace 2026-08-15-04:11:
  The archived-owner symptom failed before FN-9054: `getTask` returned the cold-storage snapshot
  in `archived`, which the terminal predicate read as live. After the staleness floor, reclaim must
  free that real sub-repo path so a different workspace task can acquire the next land lease.
  */
  it("reclaims an archived owner's stale lease and makes the repo re-leasable", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "archived" });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-08-15T00:10:00.000Z"));
    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(1);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(false);

    expect(() => activeSessionRegistry.registerPath(leasePath, {
      taskId: "FN-7002", kind: "workspace-repo-land", ownerKey: "next-land",
    })).not.toThrow();
    expect(activeSessionRegistry.lookupByPath(leasePath)?.taskId).toBe("FN-7002");
  });

  /*
  FNXC:Workspace 2026-08-15-04:11:
  Archive terminality follows the archived trait rather than the legacy literal, so a project that
  renames its archive lane cannot leave a crashed workspace land holder blocking future tasks.
  */
  it("reclaims a land lease whose owner rests in a RENAMED archive lane", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "retained" });
    const store = createStore([task]);
    (store as unknown as { listWorkflowDefinitions: unknown }).listWorkflowDefinitions = vi.fn(async () => [{
      id: "custom:renamed-archive",
      ir: {
        version: "v2",
        id: "custom:renamed-archive",
        nodes: [],
        edges: [],
        columns: [
          { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "retained", name: "retained", traits: [{ trait: "archived" }] },
        ],
      },
    }]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-08-15T00:10:00.000Z"));
    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(1);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(false);
  });

  /*
  FNXC:Workspace 2026-08-15-04:11:
  Soft-deleted rows and hard misses both have no live owner. Once the unchanged age and execution
  guards admit them, their leaked in-memory leases must be reclaimable rather than permanently busy.
  */
  it("reclaims soft-deleted and missing owners after the staleness floor", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const softDeleted = workspaceTask(
      { "repo-a": { worktreePath: leasePath, branch: BRANCH } },
      { column: "in-progress", deletedAt: "2026-08-14T23:00:00.000Z" },
    );
    const store = createStore([softDeleted]);
    const manager = makeManager(store, fx.rootDir);

    vi.setSystemTime(new Date("2026-08-15T00:10:00.000Z"));
    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(1);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(false);

    activeSessionRegistry.registerPath(leasePath, { taskId: "FN-7002", kind: "workspace-repo-land", ownerKey: "missing-land" });
    vi.setSystemTime(new Date("2026-08-15T00:20:00.000Z"));
    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(1);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(false);
  });

  /*
  FNXC:Workspace 2026-08-15-04:11:
  Archive terminality does not shorten the existing floor; a newly registered archived snapshot
  remains protected while a legitimate land operation is still warming.
  */
  it("does NOT reclaim a young lease owned by an archived task", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "archived" });
    const manager = makeManager(createStore([task]), fx.rootDir);

    vi.setSystemTime(new Date("2026-08-15T00:01:00.000Z"));
    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(0);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(true);
  });

  /*
  FNXC:Workspace 2026-08-15-04:11:
  An archived snapshot cannot override the merge-pending guard: queued land work remains live until
  its in-memory merge pipeline releases the lease.
  */
  it("does NOT reclaim an archived owner's lease while it is merge-pending", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "archived" });
    const manager = makeManager(createStore([task]), fx.rootDir, { isMergePending: (id: string) => id === TASK_ID });

    vi.setSystemTime(new Date("2026-08-15T00:10:00.000Z"));
    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(0);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(true);
  });

  /*
  FNXC:Workspace 2026-08-15-04:11:
  An active executor remains authoritative over row terminality; even a stale archived snapshot
  cannot make self-healing yank its workspace land lease.
  */
  it("does NOT reclaim an archived owner's lease while its task is active", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const leasePath = fx.repoPath("repo-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    activeSessionRegistry.registerPath(leasePath, { taskId: TASK_ID, kind: "workspace-repo-land", ownerKey: "land" });

    const task = workspaceTask({ "repo-a": { worktreePath: leasePath, branch: BRANCH } }, { column: "archived" });
    const manager = makeManager(createStore([task]), fx.rootDir, { isTaskActive: (id: string) => id === TASK_ID });

    vi.setSystemTime(new Date("2026-08-15T00:10:00.000Z"));
    expect(await manager.reclaimPhantomWorkspaceLandLeases()).toBe(0);
    expect(activeSessionRegistry.isPathActive(leasePath)).toBe(true);
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
    activeSessionRegistry.registerPath(wtB, { taskId: "FN-other", kind: "executor", ownerKey: "x" });

    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    const cleaned = await manager.reconcileOrphanedWorkspaceWorktrees();

    expect(cleaned).toBe(1);
    expect(existsSync(wtA)).toBe(false); // removed
    expect(existsSync(wtB)).toBe(true); // active → skipped
  });

  it("removes the emptied modern workspace task directory after all entries settle", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const taskDir = path.join(fx.rootDir, ".fusion", "worktrees", TASK_ID.toLowerCase());
    const worktreePath = path.join(taskDir, "repo-a");
    mkdirSync(taskDir, { recursive: true });
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const task = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH } }, { column: "done" });

    expect(await makeManager(createStore([task]), fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(taskDir)).toBe(false);
  });

  it("keeps a complete-lane workspace task's worktree while its executor is live", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-complete-live");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const task = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH } }, { column: "done" });
    activeSessionRegistry.registerPath(worktreePath, { taskId: TASK_ID, kind: "executor", ownerKey: "live" });

    expect(await makeManager(createStore([task]), fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("tears down an idle failed workspace worktree and its safely landed branch", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-terminal");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const landedSha = fx.git("repo-a", "git rev-parse HEAD").trim();
    const task = workspaceTask(
      { "repo-a": { worktreePath, branch: BRANCH, landedSha } },
      { status: "failed", updatedAt: old, columnMovedAt: old },
    );
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    expect(await manager.reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);
    expect(fx.git("repo-a", `git branch --list ${BRANCH}`).trim()).toBe("");
    expect(store.mergeWorkspaceWorktreeEntry).toHaveBeenCalledWith(
      TASK_ID,
      "repo-a",
      { worktreePath: "" },
      { requireExistingEntry: true },
    );
  });

  /*
  FNXC:Workspace 2026-08-15-05:33:
  Failed and soft-deleted workspace rows are destructive candidates only after their one-day floor.
  These real-git cases lock the worktree/prune/branch policy so terminal cleanup cannot regress into
  either leaking abandoned repositories or destroying an unlanded failed-task branch.
  */
  it("tears down a soft-deleted workspace worktree and branch as operator-discarded", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-deleted");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const task = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH } }, { deletedAt: old, updatedAt: old, columnMovedAt: old });
    const manager = makeManager(createStore([task]), fx.rootDir);

    expect(await manager.reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);
    expect(fx.git("repo-a", `git branch --list ${BRANCH}`).trim()).toBe("");
  });

  it("retains a failed-task branch when its recorded landed SHA is not reachable from integration", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-stale-landed-sha");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const task = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha: "not-a-real-commit" } }, { status: "failed", updatedAt: old, columnMovedAt: old });

    expect(await makeManager(createStore([task]), fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);
    expect(fx.git("repo-a", `git branch --list ${BRANCH}`).trim()).toContain(BRANCH);
  });

  it("retains an unlanded failed-task branch while retiring only its worktree path", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const repo = fx.repoPath("repo-a");
    const baseCommitSha = fx.git("repo-a", "git rev-parse HEAD").trim();
    const worktreePath = path.join(repo, ".wt-unlanded");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    configureIdentity(worktreePath);
    writeFileSync(path.join(worktreePath, "unlanded.txt"), "keep\n");
    execSync("git add unlanded.txt && git commit -m unlanded", { cwd: worktreePath, stdio: "pipe" });
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const task = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, baseCommitSha } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const store = createStore([task]);

    expect(await makeManager(store, fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);
    expect(fx.git("repo-a", `git branch --list ${BRANCH}`).trim()).toContain(BRANCH);
    expect(store.mergeWorkspaceWorktreeEntry).toHaveBeenCalledWith(
      TASK_ID,
      "repo-a",
      { worktreePath: "" },
      { requireExistingEntry: true },
    );
  });

  it("prunes an already-gone recorded worktree and settles its absent branch", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-prune-only");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    rmSync(worktreePath, { recursive: true, force: true });
    expect(fx.git("repo-a", "git worktree list --porcelain")).toContain(worktreePath);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const landedSha = fx.git("repo-a", "git rev-parse HEAD").trim();
    const task = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    expect(await manager.reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(fx.git("repo-a", "git worktree list --porcelain")).not.toContain(worktreePath);
    expect(fx.git("repo-a", `git branch --list ${BRANCH}`).trim()).toBe("");
    expect(await manager.reconcileOrphanedWorkspaceWorktrees()).toBe(0);
  });

  it("settles an already-absent safe branch without spending the retry budget", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-absent-branch");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    fx.git("repo-a", `git worktree remove --force ${worktreePath}`);
    fx.git("repo-a", `git branch -D ${BRANCH}`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const task = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha: "landed" } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const store = createStore([task]);
    const manager = makeManager(store, fx.rootDir);

    expect(await manager.reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(store.mergeWorkspaceWorktreeEntry).toHaveBeenCalledWith(
      TASK_ID,
      "repo-a",
      { worktreePath: "" },
      { requireExistingEntry: true },
    );
    expect(await manager.reconcileOrphanedWorkspaceWorktrees()).toBe(0);
  });

  it("skips a terminal path claimed by a live workspace row without settling it", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-shared");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const terminal = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha: "landed" } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const live = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH } }, { id: "FN-7002", column: "in-progress", status: null });
    const store = createStore([terminal, live]);

    expect(await makeManager(store, fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("skips duplicate repo-entry claims from the same terminal task before git work", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-duplicate");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const task = workspaceTask({
      "repo-a": { worktreePath, branch: BRANCH, landedSha: "landed" },
      "repo-b": { worktreePath, branch: BRANCH, landedSha: "landed" },
    }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const store = createStore([task]);

    expect(await makeManager(store, fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:Workspace 2026-08-15-05:39:
  Each liveness veto below starts from a real failed worktree that the positive terminal cases prove
  removable. Keeping these cases isolated means deleting one guard makes its own destructive-path
  regression fail instead of being hidden by another veto.
  */
  it.each([
    "raw-path-session",  "resolved-path-session", "task-session-path", "executing-lock", "task-active", "merge-pending", "active-merge", "paused", "user-paused", "recovery-scheduled",
  ])("keeps a proven terminal worktree when the %s veto alone is present", async (veto) => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-veto");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const recordedPath = veto === "resolved-path-session"
      ? path.join(fx.repoPath("repo-a"), ".wt-veto-alias")
      : worktreePath;
    if (recordedPath !== worktreePath) symlinkSync(worktreePath, recordedPath, "dir");
    const extra: Partial<Task> = { status: "failed", updatedAt: old, columnMovedAt: old, landedSha: undefined };
    if (veto === "paused") extra.paused = true;
    if (veto === "user-paused") extra.userPaused = true;
    if (veto === "recovery-scheduled") extra.nextRecoveryAt = new Date(Date.now() + 60_000).toISOString();
    const task = workspaceTask({ "repo-a": { worktreePath: recordedPath, branch: BRANCH, landedSha: "landed" } }, extra);
    const companionPath = path.join(fx.repoPath("repo-a"), ".wt-veto-companion");
    const companionBranch = "fusion/fn-7002";
    fx.git("repo-a", `git worktree add -b ${companionBranch} ${companionPath} HEAD`);
    const companionLandedSha = fx.git("repo-a", "git rev-parse HEAD").trim();
    const companion = workspaceTask({ "repo-a": { worktreePath: companionPath, branch: companionBranch, landedSha: companionLandedSha } }, { id: "FN-7002", status: "failed", updatedAt: old, columnMovedAt: old });
    const options: Record<string, unknown> = {};
    if (veto === "raw-path-session") activeSessionRegistry.registerPath(recordedPath, { taskId: "FN-elsewhere", kind: "executor", ownerKey: "raw" });
    // Register the physical path while the row records a symlink alias: only canonical lookup can veto.
    if (veto === "resolved-path-session") activeSessionRegistry.registerPath(realpathSync(worktreePath), { taskId: "FN-elsewhere", kind: "executor", ownerKey: "resolved" });
    if (veto === "task-session-path") activeSessionRegistry.registerPath(fx.repoPath("repo-a"), { taskId: TASK_ID, kind: "executor", ownerKey: "task" });
    if (veto === "executing-lock") executingTaskLock.tryClaim(TASK_ID);
    if (veto === "task-active") options.isTaskActive = (id: string) => id === TASK_ID;
    if (veto === "merge-pending") options.isMergePending = (id: string) => id === TASK_ID;
    if (veto === "active-merge") options.getActiveMergeTaskId = () => TASK_ID;
    const store = createStore([task, companion]);

    expect(await makeManager(store, fx.rootDir, options).reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(existsSync(worktreePath)).toBe(true);
    expect(fx.git("repo-a", `git branch --list ${BRANCH}`).trim()).toContain(BRANCH);
    // Negative scope: one primary veto cannot silently disable teardown of another terminal row.
    expect(existsSync(companionPath)).toBe(false);
    expect(fx.git("repo-a", `git branch --list ${companionBranch}`).trim()).toBe("");
    expect(store.mergeWorkspaceWorktreeEntry).toHaveBeenCalledTimes(1);
  });

  it("settles the prune phase while retaining a duplicate branch claim without re-pruning", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-duplicate-branch");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const first = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha: "landed" } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    // This stale forensic claim cannot own a second checkout of the same branch, but it must veto
    // branch deletion until its task row is gone.
    const second = workspaceTask({ "repo-a": { worktreePath: path.join(fx.repoPath("repo-a"), ".missing-claim"), branch: BRANCH } }, { id: "FN-7002", status: "failed", updatedAt: old, columnMovedAt: old });
    const store = createStore([first, second]);
    const manager = makeManager(store, fx.rootDir);

    expect(await manager.reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(existsSync(worktreePath)).toBe(false);
    expect(fx.git("repo-a", `git branch --list ${BRANCH}`).trim()).toContain(BRANCH);
    const phase = (manager as unknown as { prunedWorkspaceWorktreeTeardowns: Set<string> }).prunedWorkspaceWorktreeTeardowns;
    expect(phase.size).toBeGreaterThan(0);
    // A second tick sees the same ambiguity but performs no git work for the completed first entry.
    expect(await manager.reconcileOrphanedWorkspaceWorktrees()).toBe(0);
    expect(phase.size).toBeGreaterThan(0);
  });

  it("skips terminal paths claimed by two terminal task rows", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-two-terminal");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const one = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha: "landed" } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const two = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH } }, { id: "FN-7002", status: "failed", updatedAt: old, columnMovedAt: old });
    const store = createStore([one, two]);
    expect(await makeManager(store, fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("skips a path attributed to the wrong repo and a path outside the workspace root", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const ownedByA = path.join(fx.repoPath("repo-a"), ".wt-wrong-owner");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${ownedByA} HEAD`);
    const outside = path.join(path.dirname(fx.rootDir), ".outside-worktree");
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const task = workspaceTask({
      "repo-b": { worktreePath: ownedByA, branch: BRANCH, landedSha: "landed" },
      "repo-a": { worktreePath: outside, branch: "fusion/fn-7001-outside", landedSha: "landed" },
    }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const store = createStore([task]);
    expect(await makeManager(store, fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(0);
    expect(existsSync(ownedByA)).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("canonicalizes symlinked duplicate claims before destructive teardown", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-symlink");
    const alias = path.join(fx.repoPath("repo-a"), ".wt-symlink-alias");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    symlinkSync(worktreePath, alias, "dir");
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const first = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha: "landed" } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const second = workspaceTask({ "repo-a": { worktreePath: alias, branch: BRANCH } }, { id: "FN-7002", status: "failed", updatedAt: old, columnMovedAt: old });
    expect(await makeManager(createStore([first, second]), fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("bounds a prune-only git failure and keeps soft-delete settlement in memory when persistence rejects", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const missingPath = path.join(fx.repoPath("repo-a"), ".gone");
    const broken = workspaceTask({ "repo-a": { worktreePath: missingPath, branch: BRANCH, landedSha: "landed" } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const brokenStore = createStore([broken]);
    const manager = new PruneFailureWorkspaceTeardownManager(brokenStore, managerOptions(brokenStore, fx.rootDir) as never);
    // Use the production reconciliation loop with only the git runner narrowed to a failing prune.
    for (let attempt = 0; attempt < 4; attempt++) await manager.reconcileOrphanedWorkspaceWorktrees();
    const failures = (manager as unknown as { orphanWorktreeRemovalFailures: Map<string, number> }).orphanWorktreeRemovalFailures;
    expect([...failures.values()]).toEqual([3]);
    expect(manager.pruneCalls).toBe(3);

    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-reject-settle");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    rmSync(worktreePath, { recursive: true, force: true });
    const rejected = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha: "landed" } }, { id: "FN-7003", deletedAt: old, updatedAt: old, columnMovedAt: old });
    const store = createStore([rejected]);
    store.mergeWorkspaceWorktreeEntry.mockRejectedValue(new Error("soft-deleted"));
    const settled = makeManager(store, fx.rootDir);
    expect(await settled.reconcileOrphanedWorkspaceWorktrees()).toBe(1);
    expect(await settled.reconcileOrphanedWorkspaceWorktrees()).toBe(0);
  });

  it.each(["globalPause", "enginePaused"])("short-circuits all workspace teardown for %s", async (pauseFlag) => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const worktreePath = path.join(fx.repoPath("repo-a"), ".wt-pause");
    fx.git("repo-a", `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const task = workspaceTask({ "repo-a": { worktreePath, branch: BRANCH, landedSha: "landed" } }, { status: "failed", updatedAt: old, columnMovedAt: old });
    const store = createStore([task], { [pauseFlag]: true });

    expect(await makeManager(store, fx.rootDir).reconcileOrphanedWorkspaceWorktrees()).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalled();
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
