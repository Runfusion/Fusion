import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager, landedReviewReconcileLogMarker } from "../self-healing.js";
import { MAX_POST_MERGE_GATE_RESEED_ATTEMPTS, postMergeGateReseedLogMarker } from "../merge/post-merge-gate-reseed.js";

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
    listTasks: vi.fn(async (filter?: { column?: string }) =>
      [...tasks.values()].filter((task) => !filter?.column || task.column === filter.column)),
    updateTask,
    updateTaskAtomic,
    moveTask,
    /*
    FNXC:UnrunPostMergeGateRecovery 2026-10-07-12:38 (RUFU-306):
    The real `logEntry` APPENDS to the durable log, and RUFU-306's once-per-reason dedup reads that log back.
    A no-op fake would make every pass look unrecorded, which is the pre-RUFU-502 bug the reseed budget had
    to be fixed for, so the append is part of the fixture contract. `updatedAt` is deliberately NOT bumped:
    this file's CAS tests pin `expectedUpdatedAt`, and the refusal marker is written on paths that never
    reach a CAS, so the clock stays out of the assertion.
    */
    logEntry: vi.fn(async (id: string, action: string) => {
      const current = tasks.get(id);
      if (!current) return;
      tasks.set(id, { ...current, log: [...(current.log ?? []), { action }] } as Task);
    }),
    moveTaskIf: vi.fn(async (id: string, column: string, predicate: (task: Task) => boolean | Promise<boolean>) => {
      const current = tasks.get(id)!;
      if (!await predicate(current)) return { moved: false, task: current };
      const next = { ...current, column } as Task;
      tasks.set(id, next);
      return { moved: true, task: next };
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
  return { store, tasks, updateTask, updateTaskAtomic, moveTask };
}

/** Every durable line this file's refusal marker could have written, for silence/duplication assertions. */
function reconcileRefusalLines(task: Task | undefined): string[] {
  return (task?.log ?? [])
    .map((entry) => (typeof entry.action === "string" ? entry.action : ""))
    .filter((line) => line.includes("[landed-review reconcile:"));
}

/** A merge-confirmed card whose required post-merge gate is stuck unapproved → `post-merge-evidence-pending`. */
function pendingEvidenceTask(id = "RUFU-306"): Task {
  return baseTask({
    id,
    autoMerge: true,
    mergeDetails: { mergeConfirmed: true },
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "pending" }],
  });
}

function withPostMergeSelection(store: TaskStore & EventEmitter): TaskStore & EventEmitter {
  return Object.assign(store, {
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
    listWorkflowWorkItemsForTask: vi.fn(async () => [{ id: "wi-active", state: "running" }]),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded: false, reason: "active-continuation" })),
  });
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

  it("reports confirmed review work as awaiting finalization, not already complete", async () => {
    const { store, updateTaskAtomic } = storeWithTask(baseTask({ mergeDetails: { mergeConfirmed: true, commitSha: "zzz" } }));
    const manager = managerWithStubs(store);

    const result = await manager.reconcileLandedReviewTask("FN-9304", { source: "manual" });

    expect(result).toEqual({ outcome: "ineligible", reason: "awaiting-finalization" });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("resumes an absent confirmed-merge gate after manual landing without moving or remerging", async () => {
    const task = baseTask({
      id: "FN-9368", updatedAt: "2026-10-01T06:36:00.000Z", autoMerge: false,
      mergeDetails: { mergeConfirmed: true, commitSha: "280fa38" },
      enabledWorkflowSteps: ["post-merge-verification"], workflowStepResults: [],
    });
    const { store, moveTask } = storeWithTask(task);
    const continuations: unknown[] = [];
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      listWorkflowWorkItemsForTask: vi.fn(async () => continuations),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input) => {
        if (continuations.length > 0) return { seeded: false, reason: "active-continuation" };
        continuations.push(input);
        return { seeded: true, workItemId: "post-merge" };
      }),
    });
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "resumed", gateId: "post-merge-verification", attempt: expect.any(Number),
    });
    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "raced", reason: "post-merge-continuation-not-idle",
    });
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({ nodeId: "post-merge-verification", sourceColumn: "in-review", targetColumn: "in-review" });
    expect(moveTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:PostMergeRecovery 2026-10-09-13:04 (RUFU-611):
  The rejected-evidence arm. A card whose post-merge gate reported and was refused used to be answered with
  `post-merge-evidence-pending` and never reached the resume seam, so the operator had no lever at all while
  the hourly self-reseed kept failing at attempt=0. This is the shape measured on production: 12 cards in this
  exact state. The recheck is still bounded by the idle-continuation fence, so one retry cannot queue a second.
  */
  it("rechecks rejected post-merge evidence on an explicit manual reconcile instead of refusing it", async () => {
    const task = baseTask({
      id: "FN-611", updatedAt: "2026-10-09T13:04:00.000Z", autoMerge: true,
      mergeDetails: { mergeConfirmed: true, commitSha: "5999ba4" },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{
        workflowStepId: "post-merge-verification",
        phase: "post-merge",
        status: "failed",
        output: "Pending step result had no live session or lease; marked failed by self-healing (FN-8492).",
      }],
    });
    const { store, moveTask } = storeWithTask(task);
    const continuations: unknown[] = [];
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      listWorkflowWorkItemsForTask: vi.fn(async () => continuations),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input) => {
        if (continuations.length > 0) return { seeded: false, reason: "active-continuation" };
        continuations.push(input);
        return { seeded: true, workItemId: "post-merge" };
      }),
    });
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "resumed", gateId: "post-merge-verification", attempt: expect.any(Number),
    });
    // A second explicit retry cannot stack a second run on the same gate.
    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "raced", reason: "post-merge-continuation-not-idle",
    });
    expect(continuations).toHaveLength(1);
    expect(moveTask).not.toHaveBeenCalled();
  });
  it("sweep resumes a proven manual landing once and finalizes only after durable post-merge approval", async () => {
    const task = baseTask({
      id: "FN-9520", autoMerge: false,
      mergeDetails: { mergeConfirmed: true, commitSha: "landed9520" },
      enabledWorkflowSteps: ["post-merge-verification"], workflowStepResults: [],
    });
    const { store, tasks, moveTask } = storeWithTask(task);
    const continuations: unknown[] = [];
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      listWorkflowWorkItemsForTask: vi.fn(async () => continuations),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input) => {
        if (continuations.length > 0) return { seeded: false, reason: "active-continuation" };
        continuations.push(input);
        return { seeded: true, workItemId: "post-merge" };
      }),
    });
    const manager = managerWithStubs(store);
    Object.assign(manager, {
      isCommitReachableFromBranch: vi.fn(async () => true),
      resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main" })),
    });

    await expect(manager.recoverMergedReviewTasks()).resolves.toBe(0);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({ nodeId: "post-merge-verification", sourceColumn: "in-review", targetColumn: "in-review" });
    expect(moveTask).not.toHaveBeenCalled();

    tasks.set(task.id, {
      ...tasks.get(task.id)!,
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "passed", verdict: "APPROVE" }],
    });
    continuations.length = 0;

    await expect(manager.recoverMergedReviewTasks()).resolves.toBe(1);
    expect(tasks.get(task.id)).toMatchObject({ column: "done", autoMerge: false });
    expect(moveTask).not.toHaveBeenCalled();
  });

  it.each(["paused", "user-paused"] as const)("sweep leaves a paused proven manual landing untouched (%s)", async (pauseKind) => {
    const task = baseTask({
      id: `FN-9520-${pauseKind}`,
      autoMerge: false,
      ...(pauseKind === "paused" ? { paused: true } : { userPaused: true }),
      mergeDetails: { mergeConfirmed: true, commitSha: "landed9520" },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "passed", verdict: "APPROVE" }],
    });
    const { store, tasks } = storeWithTask(task);
    const manager = managerWithStubs(store);
    Object.assign(manager, {
      isCommitReachableFromBranch: vi.fn(async () => true),
      resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main" })),
    });

    await expect(manager.recoverMergedReviewTasks()).resolves.toBe(0);
    expect(tasks.get(task.id)).toMatchObject({ column: "in-review", autoMerge: false });
  });
  it.each(["pending", "skipped"] as const)("leaves confirmed %s post-merge evidence blocked", async (status) => {
    const task = baseTask({
      autoMerge: true, mergeDetails: { mergeConfirmed: true }, enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status, verdict: "REVISE" }],
    });
    const { store } = storeWithTask(task);
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(),
    });
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "ineligible", reason: "post-merge-evidence-pending",
    });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it("does not resume archived skipped post-merge evidence during manual landed reconciliation", async () => {
    const task = baseTask({
      autoMerge: true, mergeDetails: { mergeConfirmed: true }, enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{
        workflowStepId: "post-merge-verification",
        status: "skipped",
        remediationArchivedAt: "2026-10-04T03:11:56Z",
        remediationArchivedFromStatus: "failed",
      }],
    });
    const { store, moveTask, tasks } = storeWithTask(task);
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(),
    });
    const manager = managerWithStubs(store);
    const evidence = structuredClone(task.workflowStepResults);

    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "ineligible", reason: "post-merge-evidence-pending",
    });
    expect(tasks.get(task.id)).toMatchObject({ column: "in-review", workflowStepResults: evidence });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:PostMergeCiRepository 2026-10-11-04:10 (RUFU-375, Code Review finding P0):
  RUFU-375 makes a new refusal reachable — "CI repository not configured" — and it recorded a `skipped` row that
  this fence read as a decision the card had already lost: `blocked` is neither re-seedable nor finalizable, so an
  operator who obeyed the refusal, set the setting, and pressed Retry could not reach the gate again. RUFU-348's
  twelve waived cards were the same dead-end with a different cause. The pair below is both halves of the fix:
  an honest not-run carrier is re-seedable through this SAME fence, and an audited waiver is not.
  */
  it("resumes a landed card whose post-merge gate refused to run for an honest not-run cause", async () => {
    const task = baseTask({
      autoMerge: true, mergeDetails: { mergeConfirmed: true }, enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{
        workflowStepId: "post-merge-verification",
        phase: "post-merge",
        status: "skipped",
        notRunReason: "ci-repository-unresolved",
      }],
    });
    const { store, moveTask } = storeWithTask(task);
    const continuations: unknown[] = [];
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      listWorkflowWorkItemsForTask: vi.fn(async () => continuations),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input) => {
        if (continuations.length > 0) return { seeded: false, reason: "active-continuation" };
        continuations.push(input);
        return { seeded: true, workItemId: "post-merge" };
      }),
    });
    const manager = managerWithStubs(store);

    // Same resumed shape and same bounded attempt the never-written class pins: the operator's Retry now reaches
    // a gate that can succeed, and the re-run replaces this row instead of stacking a second one.
    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "resumed", gateId: "post-merge-verification", attempt: 1,
    });
    expect(continuations).toHaveLength(1);
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("does not re-run a not-run row an operator already waived", async () => {
    const task = baseTask({
      autoMerge: true, mergeDetails: { mergeConfirmed: true }, enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{
        workflowStepId: "post-merge-verification",
        phase: "post-merge",
        status: "skipped",
        notRunReason: "ci-repository-unresolved",
        bypassedBy: "dashboard-operator",
        bypassedAt: "2026-10-11T04:00:00.000Z",
        bypassReason: "no hosted CI runs on this project",
      }],
    });
    const { store } = storeWithTask(task);
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(),
    });
    const manager = managerWithStubs(store);

    // RUFU-408: the audited waiver IS the evidence, so nothing is owed. This arm answers a card that owes
    // nothing with `awaiting-finalization` — its sentence for "no gate to hand back" — and the load-bearing
    // half of this assertion is that no re-seed happens: a human decision is never re-run over.
    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "ineligible", reason: "awaiting-finalization",
    });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
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

/*
FNXC:UnrunPostMergeGateRecovery 2026-10-07-12:38 (RUFU-306):
The durable refusal marker. Three review lanes could run against the same landed card and leave nothing an
operator could read: the sweep's run-audit rows hide behind a synthetic run id that resolves through a durable
agent's heartbeat run (a route the dashboard and CLI do not expose), `fn task reconcile` wrote only to stdout,
and the audit convention forbids the blocker sentence in metadata anyway. These cases pin the one durable
surface — the card's own task log — and its two policies: the reason in the line IS the returned reason, and
the automatic lane may not spam it.
*/
describe("reconcileLandedReviewTask durable refusal marker", () => {
  it("names the returned reason and the gate id in the durable refusal line", async () => {
    const task = pendingEvidenceTask();
    const { store, tasks } = storeWithTask(task);
    withPostMergeSelection(store);
    const manager = managerWithStubs(store);

    const result = await manager.reconcileLandedReviewTask(task.id, { source: "manual" });

    expect(result).toEqual({ outcome: "ineligible", reason: "post-merge-evidence-pending" });
    const lines = reconcileRefusalLines(tasks.get(task.id));
    expect(lines).toHaveLength(1);
    // The marker's reason is exactly the reason the caller got, so the two can never disagree.
    expect(lines[0]!.startsWith(`${landedReviewReconcileLogMarker("post-merge-evidence-pending")} `)).toBe(true);
    expect(lines[0]!).toContain("post-merge-verification");
  });

  it("records the resume-seam refusal reason, not the raw seam reason", async () => {
    const task = baseTask({
      id: "RUFU-306B",
      autoMerge: true,
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    });
    const { store, tasks } = storeWithTask(task);
    withPostMergeSelection(store);
    const manager = managerWithStubs(store);

    const result = await manager.reconcileLandedReviewTask(task.id, { source: "manual" });

    expect(result).toEqual({ outcome: "raced", reason: "post-merge-continuation-not-idle" });
    const lines = reconcileRefusalLines(tasks.get(task.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`${landedReviewReconcileLogMarker("post-merge-continuation-not-idle")} `)).toBe(true);
    expect(lines[0]!).toContain("post-merge-verification");
  });

  it("records `awaiting finalization` with no gate clause when no gate is identifiable", async () => {
    const { store, tasks } = storeWithTask(baseTask({ mergeDetails: { mergeConfirmed: true, commitSha: "zzz" } }));
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask("FN-9304", { source: "manual" }))
      .resolves.toEqual({ outcome: "ineligible", reason: "awaiting-finalization" });

    const lines = reconcileRefusalLines(tasks.get("FN-9304"));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`${landedReviewReconcileLogMarker("awaiting-finalization")} `)).toBe(true);
    expect(lines[0]!).not.toContain("for gate");
  });

  it("writes no refusal marker for a refusal that was never made", async () => {
    const held = [
      baseTask({ id: "RUFU-306-PAUSED", paused: true }),
      baseTask({ id: "RUFU-306-LEASED", checkoutRunId: "run-1", checkoutLeaseRenewedAt: new Date().toISOString() }),
    ];
    for (const task of held) {
      const { store, tasks } = storeWithTask(task);
      const manager = managerWithStubs(store);

      const result = await manager.reconcileLandedReviewTask(task.id, { source: "manual" });

      expect(result.outcome).toBe("ineligible");
      expect(reconcileRefusalLines(tasks.get(task.id))).toEqual([]);
    }
  });

  it("records a refusal of an unmerged card nowhere — the marker belongs to the merged lane alone", async () => {
    const guarded = baseTask({
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", status: "failed" } as never],
    });
    const { store, tasks } = storeWithTask(guarded);
    (store as unknown as { getTaskWorkflowSelection: ReturnType<typeof vi.fn> }).getTaskWorkflowSelection = vi.fn(() => ({
      workflowId: "builtin:coding", stepIds: ["code-review"],
    }));
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask("FN-9304", { source: "manual" }))
      .resolves.toEqual({ outcome: "ineligible", reason: "workflow-approval-blocked" });

    expect(reconcileRefusalLines(tasks.get("FN-9304"))).toEqual([]);
  });

  it("keeps the successful outcomes silent: a resume and an awaiting-finalization pass write no refusal", async () => {
    const task = baseTask({
      id: "RUFU-306-SEEDED",
      autoMerge: true,
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    });
    const { store, tasks } = storeWithTask(task);
    const continuations: unknown[] = [];
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      listWorkflowWorkItemsForTask: vi.fn(async () => continuations),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input) => {
        if (continuations.length > 0) return { seeded: false, reason: "active-continuation" };
        continuations.push(input);
        return { seeded: true, workItemId: "post-merge" };
      }),
    });
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toMatchObject({
      outcome: "resumed", gateId: "post-merge-verification",
    });
    expect(reconcileRefusalLines(tasks.get(task.id))).toEqual([]);

    // Second pass: the card is no longer idle, so THIS pass is a refusal and is the first marker.
    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" })).resolves.toEqual({
      outcome: "raced", reason: "post-merge-continuation-not-idle",
    });
    const afterRefusal = reconcileRefusalLines(tasks.get(task.id));
    expect(afterRefusal).toHaveLength(1);
    // The reseed seam's own success marker is a different sentence and is not the refusal marker.
    expect(afterRefusal[0]!).toContain(landedReviewReconcileLogMarker("post-merge-continuation-not-idle"));
  });

  it("writes every refusal for an explicit manual reconcile — a human asking twice is two events", async () => {
    const task = pendingEvidenceTask("RUFU-306-MANUAL");
    const { store, tasks } = storeWithTask(task);
    withPostMergeSelection(store);
    const manager = managerWithStubs(store);

    for (let pass = 0; pass < 3; pass += 1) {
      await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" }))
        .resolves.toEqual({ outcome: "ineligible", reason: "post-merge-evidence-pending" });
    }

    expect(reconcileRefusalLines(tasks.get(task.id))).toHaveLength(3);
  });

  it("writes each distinct refusal reason once for the automatic sweep, but never another reason's", async () => {
    const task = pendingEvidenceTask("RUFU-306-SWEEP");
    const { store, tasks } = storeWithTask(task);
    withPostMergeSelection(store);
    const manager = managerWithStubs(store);

    for (let pass = 0; pass < 4; pass += 1) {
      await expect(manager.reconcileLandedReviewTask(task.id, { source: "self-healing", requireAutoMergeEligible: true }))
        .resolves.toEqual({ outcome: "ineligible", reason: "post-merge-evidence-pending" });
    }

    const lines = reconcileRefusalLines(tasks.get(task.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toContain("source: self-healing");

    // A fifth pass over the same unchanged refusal still adds nothing: one line per (card, reason).
    await manager.reconcileLandedReviewTask(task.id, { source: "self-healing", requireAutoMergeEligible: true });
    expect(reconcileRefusalLines(tasks.get(task.id))).toHaveLength(1);
  });

  it("lets a rejected durable write change nothing about the reported refusal", async () => {
    const task = pendingEvidenceTask("RUFU-306-HOSTILE");
    const { store } = storeWithTask(task);
    withPostMergeSelection(store);
    (store as unknown as { logEntry: ReturnType<typeof vi.fn> }).logEntry = vi.fn(async () => { throw new Error("log sink down"); });
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual" }))
      .resolves.toEqual({ outcome: "ineligible", reason: "post-merge-evidence-pending" });
  });

  /*
  FNXC:UnrunPostMergeGateRecovery 2026-10-07-13:05 (RUFU-306):
  Dedup is per (card, reason), not per card: a card whose blocker changes (an operator cleared the stale row,
  a hold appeared, the seed budget ran out afterwards) must not be silenced by its first refusal, while the
  sweep may still never write the same reason twice. The last pass proves both directions at once — the
  first reason returns and reopens nothing.
  */
  it("opens exactly one new line when the refusal reason changes, and never reopens a named reason", async () => {
    const task = pendingEvidenceTask("RUFU-306-DRIFT");
    const { store, tasks } = storeWithTask(task);
    withPostMergeSelection(store);
    const manager = managerWithStubs(store);

    await expect(manager.reconcileLandedReviewTask(task.id, { source: "self-healing", requireAutoMergeEligible: true }))
      .resolves.toEqual({ outcome: "ineligible", reason: "post-merge-evidence-pending" });
    expect(reconcileRefusalLines(tasks.get(task.id))).toHaveLength(1);

    // The stale row is cleared, so the card now owes a SEED that the active continuation refuses.
    tasks.set(task.id, { ...tasks.get(task.id)!, workflowStepResults: [] } as Task);
    await expect(manager.reconcileLandedReviewTask(task.id, { source: "self-healing", requireAutoMergeEligible: true }))
      .resolves.toEqual({ outcome: "raced", reason: "post-merge-continuation-not-idle" });
    expect(reconcileRefusalLines(tasks.get(task.id))).toHaveLength(2);

    for (let pass = 0; pass < 2; pass += 1) {
      await manager.reconcileLandedReviewTask(task.id, { source: "self-healing", requireAutoMergeEligible: true });
    }
    expect(reconcileRefusalLines(tasks.get(task.id))).toHaveLength(2);

    tasks.set(task.id, {
      ...tasks.get(task.id)!,
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "pending" }],
    } as Task);
    await manager.reconcileLandedReviewTask(task.id, { source: "self-healing", requireAutoMergeEligible: true });
    expect(reconcileRefusalLines(tasks.get(task.id))).toHaveLength(2);
  });

  /*
  FNXC:UnrunPostMergeGateRecovery 2026-10-07-13:05 (RUFU-306):
  The hold class is the standing answer an operator reads most ("someone paused it", "auto-merge is off"),
  and the pair below is what keeps the assertion non-vacuous: the identical refusal on a card that was never
  merged must write nothing, because that refusal belongs to the unconfirmed-branch lane. Asserting only the
  merge-confirmed half would also pass if the hold fences never wrote a marker at all.
  */
  it.each(["auto-merge-off", "paused", "user-paused"] as const)(
    "names the hold class on a merge-confirmed card: %s",
    async (reason) => {
      /*
      FNXC:PostMergeCloseout 2026-10-13-07:51 (merge origin/main): the auto-merge arm is now stated as the
      PROJECT setting, which is the signal that means a hold in this fork. A per-card `autoMerge: false` is
      often inherited or engine-authored (FN-6444) and no longer vetoes closeout of a landing already proven
      durable, so the card-level fixture would assert a veto the product deliberately removed. The invariant
      is unchanged: a real auto-merge hold still refuses and still names itself on the card.
      */
      const hold = reason === "paused" ? { paused: true } : reason === "user-paused" ? { userPaused: true } : {};
      const settings = reason === "auto-merge-off" ? { autoMerge: false as const } : {};
      const task = baseTask({ id: `RUFU-306-HOLD-${reason}`, mergeDetails: { mergeConfirmed: true }, ...hold });
      const { store, tasks } = storeWithTask(task, settings);
      const manager = managerWithStubs(store);

      await expect(manager.reconcileLandedReviewTask(task.id, { source: "manual", requireAutoMergeEligible: true }))
        .resolves.toEqual({ outcome: "ineligible", reason });

      const lines = reconcileRefusalLines(tasks.get(task.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]!).toContain(landedReviewReconcileLogMarker(reason));
      // A hold names no gate: the sentence must not invent one.
      expect(lines[0]!).not.toContain("for gate");
    },
  );

  it.each(["auto-merge-off", "paused", "user-paused"] as const)(
    "keeps the same hold refusal silent on a card that was never merged: %s",
    async (reason) => {
      const hold = reason === "paused" ? { paused: true } : reason === "user-paused" ? { userPaused: true } : {};
      const settings = reason === "auto-merge-off" ? { autoMerge: false as const } : {};
      const task = baseTask({ id: `RUFU-306-UNMERGED-${reason}`, mergeDetails: {}, ...hold });
      const { store, tasks } = storeWithTask(task, settings);
      const manager = managerWithStubs(store);

      await expect(manager.reconcileLandedReviewTask(task.id, { source: "self-healing", requireAutoMergeEligible: true }))
        .resolves.toEqual({ outcome: "ineligible", reason });
      expect(reconcileRefusalLines(tasks.get(task.id))).toEqual([]);
    },
  );

  /*
  FNXC:UnrunPostMergeGateRecovery 2026-10-07-13:05 (RUFU-306):
  The spent-budget sentence is the one RUFU-220's operator needed and never got. Three reseed markers in the
  durable log is exactly the shape `countReseedAttempts` reads, so this drives the real budget read through
  the reconcile lane: the refusal names the derived reason and the gate, and the seed itself never happened
  — a counted budget that still seeded would be the wedge this bound exists to prevent.
  */
  it("records the spent rerun budget, the sentence RUFU-220's operator never saw", async () => {
    const task = baseTask({
      id: "RUFU-306-BUDGET",
      autoMerge: true,
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
      log: Array.from({ length: MAX_POST_MERGE_GATE_RESEED_ATTEMPTS }, (_unused, index) => ({
        action: `${postMergeGateReseedLogMarker("post-merge-verification")}; (reseed ${index + 1} of ${MAX_POST_MERGE_GATE_RESEED_ATTEMPTS})`,
      })),
    });
    const { store, tasks } = storeWithTask(task);
    Object.assign(store, {
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["post-merge-verification"] })),
      listWorkflowWorkItemsForTask: vi.fn(async () => []),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded: true, workItemId: "post-merge" })),
    });
    const manager = managerWithStubs(store);

    const probeResult = await manager.reconcileLandedReviewTask(task.id, { source: "self-healing", requireAutoMergeEligible: true });
    console.error("PROBE1 " + JSON.stringify(probeResult) + " logTail=" + JSON.stringify((tasks.get(task.id)?.log ?? []).slice(-1)));
    expect(probeResult).toEqual({ outcome: "raced", reason: "post-merge-resume-rerun-budget-exhausted" });

    expect((store as unknown as { seedWorkspaceCodeReviewContinuationIfIdle: ReturnType<typeof vi.fn> })
      .seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    const lines = reconcileRefusalLines(tasks.get(task.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toContain(landedReviewReconcileLogMarker("post-merge-resume-rerun-budget-exhausted"));
    expect(lines[0]!).toContain("post-merge-verification");
  });
});
