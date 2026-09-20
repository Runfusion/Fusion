import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

/*
Surface enumeration: this covers the engine reconciliation seam shared by `fn task reconcile`
(manual) and the self-healing absent-branch sweep (automatic). No desktop/mobile UI applies.
*/

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9304",
    title: "Reconcile me",
    description: "",
    column: "in-review",
    branch: "fusion/fn-9304",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    mergeDetails: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Task;
}

function storeWithTask(task: Task, settings: Partial<Settings> = {}) {
  const tasks = new Map<string, Task>([[task.id, task]]);
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const next = { ...tasks.get(id)!, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const updateTaskAtomic = vi.fn(async (id: string, updater: (current: Task) => Partial<Task> | null) => {
    const current = tasks.get(id)!;
    const patch = updater(current);
    if (!patch) return null;
    const next = { ...current, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const moveTask = vi.fn(async (id: string, column: string) => {
    const next = { ...tasks.get(id)!, column } as Task;
    tasks.set(id, next);
    return next;
  });
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask,
    updateTaskAtomic,
    moveTask,
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
  return { store, tasks, updateTask, updateTaskAtomic, moveTask };
}

/** Builds a manager with the git-evidence and worktree-cleanup seams stubbed so only the
 *  eligibility-fence / CAS logic in `reconcileLandedReviewTask` itself is under test. */
function managerWithStubs(
  store: TaskStore,
  overrides: {
    isBranchTipMisboundToTask?: unknown;
    hasUnlandedTaskOwnedContent?: unknown;
    isTaskActive?: (taskId: string) => boolean;
  } = {},
) {
  const manager = new SelfHealingManager(store, { rootDir: "/repo", isTaskActive: overrides.isTaskActive });
  Object.assign(manager, {
    isBranchTipMisboundToTask:
      overrides.isBranchTipMisboundToTask ??
      vi.fn(async () => ({ misbound: false, branchMissing: true, branchTip: "", landed: { sha: "abc123", strategy: "trailer" } })),
    hasUnlandedTaskOwnedContent: overrides.hasUnlandedTaskOwnedContent ?? vi.fn(async () => false),
    resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main" })),
    recordSelfHealingBranchGroupMemberLanding: vi.fn(async () => undefined),
    moveToCompleteLaneAfterLandedCleanup: vi.fn(async (task: Task, completeLane: string) => ({ ...task, column: completeLane })),
    emitTaskMerged: vi.fn(),
    reconcileCompletedTask: vi.fn(async () => undefined),
  });
  return manager;
}

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const itIfGit = hasGit ? it : it.skip;

function git(repo: string, command: string): void {
  execSync(command, { cwd: repo, stdio: "pipe" });
}

describe("SelfHealingManager.reconcileLandedReviewTask", () => {
  it("reconciles a proven landed branch and finalizes the card", async () => {
    const { store, tasks } = storeWithTask(baseTask());
    const manager = managerWithStubs(store);

    const result = await manager.reconcileLandedReviewTask("FN-9304", { source: "manual" });

    expect(result).toMatchObject({ outcome: "reconciled", sha: "abc123", strategy: "trailer", baseBranch: "main" });
    expect(tasks.get("FN-9304")).toMatchObject({ mergeDetails: { mergeConfirmed: true, commitSha: "abc123" }, branch: null });
  });

  it("reports already-complete without re-mutating a confirmed card", async () => {
    const { store, updateTaskAtomic } = storeWithTask(baseTask({ mergeDetails: { mergeConfirmed: true, commitSha: "zzz" } }));
    const manager = managerWithStubs(store);

    const result = await manager.reconcileLandedReviewTask("FN-9304", { source: "manual" });

    expect(result).toEqual({ outcome: "already-complete" });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("reconciles a present branch after all task-owned content is proven landed", async () => {
    const { store } = storeWithTask(baseTask());
    const manager = managerWithStubs(store, {
      isBranchTipMisboundToTask: vi.fn(async () => ({ misbound: false, branchMissing: false, branchTip: "abc", landed: { sha: "abc123", strategy: "trailer" } })),
      hasUnlandedTaskOwnedContent: vi.fn(async () => false),
    });

    await expect(manager.reconcileLandedReviewTask("FN-9304", { source: "manual" })).resolves.toMatchObject({
      outcome: "reconciled",
      sha: "abc123",
    });
  });

  itIfGit("treats a still-present externally squashed branch as landed but retains a later owned suffix", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-9317-squash-"));
    try {
      git(repo, "git init -b main");
      git(repo, 'git config user.email "test@example.com"');
      git(repo, 'git config user.name "Test"');
      git(repo, "git commit --allow-empty -m init");
      git(repo, "git checkout -b fusion/fn-9317");
      writeFileSync(path.join(repo, "landed.txt"), "landed\n");
      git(repo, "git add landed.txt && git commit -m 'feat(FN-9317): landed content' -m 'Fusion-Task-Id: FN-9317'");
      git(repo, "git checkout main");
      git(repo, "git merge --squash fusion/fn-9317");
      git(repo, "git commit -m 'external squash landing'");

      const manager = new SelfHealingManager({} as TaskStore, { rootDir: repo }) as unknown as {
        hasUnlandedTaskOwnedContent: (input: { branch: string; baseBranch: string; taskId: string }) => Promise<boolean>;
      };
      await expect(manager.hasUnlandedTaskOwnedContent({
        branch: "fusion/fn-9317",
        baseBranch: "main",
        taskId: "FN-9317",
      })).resolves.toBe(false);

      git(repo, "git checkout fusion/fn-9317");
      writeFileSync(path.join(repo, "suffix.txt"), "unlanded\n");
      git(repo, "git add suffix.txt && git commit -m 'feat(FN-9317): unlanded suffix' -m 'Fusion-Task-Id: FN-9317'");
      await expect(manager.hasUnlandedTaskOwnedContent({
        branch: "fusion/fn-9317",
        baseBranch: "main",
        taskId: "FN-9317",
      })).resolves.toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a present branch with task-owned unlanded content", async () => {
    const { store } = storeWithTask(baseTask());
    const manager = managerWithStubs(store, {
      isBranchTipMisboundToTask: vi.fn(async () => ({ misbound: false, branchMissing: false, branchTip: "abc", landed: { sha: "abc123", strategy: "trailer" } })),
      hasUnlandedTaskOwnedContent: vi.fn(async () => true),
    });

    await expect(manager.reconcileLandedReviewTask("FN-9304", { source: "manual" })).resolves.toEqual({
      outcome: "ineligible",
      reason: "branch-has-unlanded-content",
    });
  });

  it.each([
    ["pending", [{ workflowStepId: "code-review", phase: "pre-merge", status: "pending" }]],
    ["failed", [{ workflowStepId: "code-review", phase: "pre-merge", status: "failed" }]],
    ["missing", []],
  ])("refuses externally landed work without a current required review approval: %s", async (_state, workflowStepResults) => {
    const guardedTask = baseTask({
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: workflowStepResults as Task["workflowStepResults"],
    });
    const { store, updateTaskAtomic } = storeWithTask(guardedTask);
    (store as unknown as { getTaskWorkflowSelection: ReturnType<typeof vi.fn> }).getTaskWorkflowSelection = vi.fn(() => ({
      workflowId: "builtin:coding",
      stepIds: ["code-review"],
    }));
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask("FN-9304", { source: "manual" })).resolves.toEqual({
      outcome: "ineligible",
      reason: "workflow-approval-blocked",
    });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("never fabricates an approval: no ownership-anchored commit means not-landed", async () => {
    const { store } = storeWithTask(baseTask());
    const manager = managerWithStubs(store, {
      isBranchTipMisboundToTask: vi.fn(async () => ({ misbound: false, branchMissing: true, branchTip: "", landed: null })),
    });

    await expect(manager.reconcileLandedReviewTask("FN-9304", { source: "manual" })).resolves.toEqual({
      outcome: "not-landed",
      baseBranch: "main",
    });
  });

  it.each([
    ["paused", baseTask({ paused: true })],
    ["user-paused", baseTask({ userPaused: true })],
    ["executing", baseTask({ status: "executing" })],
    ["merge-active status", baseTask({ status: "merging" as Task["status"] })],
  ])("refuses an ineligible card: %s", async (_label, task) => {
    const { store, updateTaskAtomic } = storeWithTask(task);
    const manager = managerWithStubs(store);

    const result = await manager.reconcileLandedReviewTask("FN-9304", { source: "manual" });

    expect(result.outcome).toBe("ineligible");
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("refuses a card whose checkout lease was renewed recently (still live)", async () => {
    const { store, updateTaskAtomic } = storeWithTask(
      baseTask({ checkoutRunId: "run-1", checkoutLeaseRenewedAt: new Date().toISOString() }),
    );
    const manager = managerWithStubs(store);

    const result = await manager.reconcileLandedReviewTask("FN-9304", { source: "manual" });

    expect(result).toEqual({ outcome: "ineligible", reason: "checkout-leased" });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("respects the in-process liveness fence via isTaskActive", async () => {
    const { store, updateTaskAtomic } = storeWithTask(baseTask());
    const manager = managerWithStubs(store, { isTaskActive: () => true });

    const result = await manager.reconcileLandedReviewTask("FN-9304", { source: "manual" });

    expect(result).toEqual({ outcome: "ineligible", reason: "executing" });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("reports raced when the card changes between the fence check and the CAS write", async () => {
    const { store, tasks } = storeWithTask(baseTask());
    const manager = managerWithStubs(store);
    const original = store.updateTaskAtomic!.bind(store);
    (store as unknown as { updateTaskAtomic: typeof original }).updateTaskAtomic = vi.fn(async (id: string, updater: (current: Task) => Partial<Task> | null) => {
      // Simulate a concurrent write landing between the eligibility read and the CAS commit.
      tasks.set(id, { ...tasks.get(id)!, paused: true } as Task);
      return original(id, updater);
    });

    const result = await manager.reconcileLandedReviewTask("FN-9304", { source: "manual" });

    expect(result).toEqual({ outcome: "raced", reason: "task-state-changed" });
  });

  it("requires auto-merge eligibility only when requested", async () => {
    const { store, updateTaskAtomic } = storeWithTask(baseTask(), { autoMerge: false });
    const manager = managerWithStubs(store);

    const blocked = await manager.reconcileLandedReviewTask("FN-9304", { source: "self-healing", requireAutoMergeEligible: true });
    expect(blocked).toEqual({ outcome: "ineligible", reason: "auto-merge-off" });
    expect(updateTaskAtomic).not.toHaveBeenCalled();

    const allowed = await manager.reconcileLandedReviewTask("FN-9304", { source: "manual", requireAutoMergeEligible: false });
    expect(allowed.outcome).toBe("reconciled");
  });
});
