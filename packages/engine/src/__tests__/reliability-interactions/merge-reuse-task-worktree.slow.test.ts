import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../pi.js", () => ({
  createFnAgent: vi.fn(async () => ({
    prompt: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  })),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<unknown> }, prompt: string) => {
    await session.prompt(prompt);
  }),
  compactSessionContext: vi.fn(),
}));

import type { Settings } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../../active-session-registry.js";
import { aiMergeTask } from "../../merger.js";
import { createFnAgent } from "../../pi.js";
import { git, hasGit, makeReliabilityFixture, type ReliabilityFixture } from "./_helpers.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

/**
 * Shared setup for the reuse-task-worktree handoff scenarios. Every test in
 * this suite was ~50 lines of identical fixture boilerplate; this consolidates
 * the common path. Pass `extraSettings` for variants and use the returned
 * handles to layer test-specific state on top.
 */
async function setupReuseHandoff(opts: {
  taskId: string;
  fileName?: string;
  fileContent?: string;
  commitMessage?: string;
  /** Skip `git worktree add`. Used by tests that exercise the missing-worktree path. */
  skipWorktreeAdd?: boolean;
  /**
   * Override `task.worktree`. `undefined` writes the standard worktreePath.
   * `null` skips the update entirely. A string sets that exact value.
   */
  worktreeOverride?: string | null;
  /** Skip `store.enqueueMergeQueue` (used by tests that craft custom queue rows). */
  skipEnqueue?: boolean;
  /** Pass `--allow-empty` so the branch has 1 own commit but zero net diff. */
  emptyOwnDiff?: boolean;
  extraSettings?: Partial<Settings>;
}): Promise<{
  fixture: ReliabilityFixture;
  rootDir: string;
  store: ReliabilityFixture["store"];
  task: ReliabilityFixture["task"];
  branch: string;
  worktreeRoot: string;
  worktreePath: string;
}> {
  const fixture = await makeReliabilityFixture({
    taskId: opts.taskId,
    settings: {
      baseBranch: "master",
      mergeIntegrationWorktree: "reuse-task-worktree",
      ...opts.extraSettings,
    } as Partial<Settings>,
  });
  const { rootDir, store, task } = fixture;
  const actualTask = await store.getTask(task.id);
  const branch = `fusion/${actualTask!.id.toLowerCase()}`;
  const worktreeRoot = `${rootDir}-worktrees`;
  const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

  git(rootDir, "git branch -m main master");
  const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
  await store.updateTask(task.id, {
    baseBranch: "master",
    branch,
    steps: completedSteps,
    currentStep: completedSteps.length,
  } as any);
  await fixture.createBranch(branch);

  if (opts.emptyOwnDiff) {
    git(rootDir, `git commit --allow-empty -m 'test(${actualTask!.id}): verification-only handoff'`);
  } else {
    const fileName = opts.fileName ?? `packages/engine/src/${opts.taskId.toLowerCase()}.ts`;
    const fileContent = opts.fileContent ?? "export const value = 1;\n";
    const commitMessage = opts.commitMessage ?? `feat: add ${opts.taskId} merge content`;
    await fixture.writeAndCommit(fileName, fileContent, commitMessage);
  }
  await fixture.checkout("master");

  if (!opts.skipWorktreeAdd) {
    await mkdir(worktreeRoot, { recursive: true });
    git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
  }
  if (opts.worktreeOverride !== null) {
    const path = opts.worktreeOverride ?? worktreePath;
    await store.updateTask(task.id, { worktree: path, branch } as any);
  }
  if (!opts.skipEnqueue) {
    store.enqueueMergeQueue(task.id);
  }

  return { fixture, rootDir, store, task, branch, worktreeRoot, worktreePath };
}

describe("FN-5279 reliability interactions: merge reuse task worktree", () => {
  beforeEach(() => {
    mockedCreateFnAgent.mockClear();
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
  });

  it.skipIf(!hasGit)("happy path merges from a reused task worktree and applies the squash to the project root's integration branch", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5279-RI-HAPPY",
      fileName: "packages/engine/src/fn-5279-ri-happy.ts",
      fileContent: "export const value = 1;\n",
      commitMessage: "feat: add reuse merge content",
      extraSettings: { worktreeRebaseRemote: "origin" } as Partial<Settings>,
    });

    try {
      const rootHeadBefore = git(rootDir, "git rev-parse HEAD");

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");

      const audits = store.getRunAuditEvents({ taskId: task.id });
      const auditTypes = audits.map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).toContain("merge:reuse-handoff-released");
      const acquired = audits.find((event) => event.mutationType === "merge:reuse-handoff-acquired");
      expect(acquired?.metadata).toMatchObject({ integrationRemote: "origin", integrationBranch: "master" });

      // Step 5c (FN-5279 reuse mode) advances the project root's integration
      // branch to the new squash commit so changes actually land on master.
      expect(auditTypes).toContain("merge:integration-ref-advance");
      const advanced = audits.find((event) => event.mutationType === "merge:integration-ref-advance");
      expect(advanced?.metadata).toMatchObject({ advanceMode: "update-ref", succeeded: true });
      expect(git(rootDir, "git rev-parse HEAD")).not.toBe(rootHeadBefore);
      // 4c31e885b (engine auto-sync) keeps the project root's working tree
      // in step with the advanced ref, so the new file is a tracked, clean
      // path at HEAD rather than appearing as a dirty/untracked entry. Verify
      // landing via `git ls-files` (commit-reachable) instead of `git status`.
      const rootLsFilesAfter = git(rootDir, "git ls-files");
      expect(rootLsFilesAfter).toContain("packages/engine/src/fn-5279-ri-happy.ts");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("dirty reused worktree is autostashed so the merge can proceed", async () => {
    const { fixture, rootDir, store, task, worktreePath } = await setupReuseHandoff({
      taskId: "FN-5279-RI-DIRTY",
      fileName: "packages/engine/src/fn-5279-ri-dirty.ts",
      fileContent: "export const dirty = true;\n",
      commitMessage: "feat: add dirty merge content",
    });
    git(worktreePath, "sh -c 'printf dirty > DIRTY.txt'");

    try {
      await aiMergeTask(store, rootDir, task.id).catch(() => undefined);
      const autostash = store.getRunAuditEvents({ taskId: task.id })
        .find((event) => event.mutationType === "merge:reuse-handoff-autostash");
      expect(autostash?.metadata).toMatchObject({ worktreePath });
      expect(typeof autostash?.metadata?.stashSha).toBe("string");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("active session binding refuses handoff until the worktree is released", async () => {
    const { fixture, rootDir, store, task, worktreePath } = await setupReuseHandoff({
      taskId: "FN-5279-RI-ACTIVE",
      fileName: "packages/engine/src/fn-5279-ri-active.ts",
      fileContent: "export const active = true;\n",
      commitMessage: "feat: add active merge content",
    });
    activeSessionRegistry.registerPath(worktreePath, { taskId: task.id, kind: "executor", ownerKey: task.id });
    executingTaskLock.tryClaim(task.id);

    try {
      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "active-session-binding",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "active-session-binding" });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("branch/worktree mapping mismatches refuse handoff", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5279-RI-MISMATCH",
      fileName: "packages/engine/src/fn-5279-ri-mismatch.ts",
      fileContent: "export const mismatch = true;\n",
      commitMessage: "feat: add mismatch merge content",
    });
    // Drift the task.branch away from the actual branch on disk to trigger the mapping refusal.
    await store.updateTask(task.id, { branch: "fusion/fn-other" } as any);

    try {
      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "branch-worktree-mapping",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "branch-worktree-mapping" });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("missing merge queue lease refuses handoff with target-not-queued diagnostics", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5279-RI-NO-LEASE",
      fileName: "packages/engine/src/fn-5279-ri-no-lease.ts",
      fileContent: "export const noLease = true;\n",
      commitMessage: "feat: add no-lease merge content",
      skipEnqueue: true,
    });
    store.enqueueMergeQueue(task.id, { now: "2026-05-19T00:00:00.000Z" });
    store.getDatabase().prepare("UPDATE mergeQueue SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ? WHERE taskId = ?").run(
      "worker-other",
      "2026-05-19T00:01:00.000Z",
      "2099-05-19T00:10:00.000Z",
      task.id,
    );

    try {
      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "lease-handoff-failed",
        reason: "target-not-queued",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({
        gate: "lease-handoff-failed",
        reason: "target-not-queued",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5353: aiMergeTask succeeds without pre-enqueue by self-enqueueing before handoff", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5353-RI-SELF-ENQUEUE",
      fileName: "packages/engine/src/fn-5353-ri-self-enqueue.ts",
      fileContent: "export const selfEnqueue = true;\n",
      commitMessage: "feat: add self enqueue merge content",
    });
    store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(task.id);

    try {
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5353: cross-task queue entries remain untouched when aiMergeTask self-enqueues target", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5353-RI-TARGET-A",
      fileName: "packages/engine/src/fn-5353-ri-target-not-queued.ts",
      fileContent: "export const targetNotQueued = true;\n",
      commitMessage: "feat: add target not queued reproduction",
      skipEnqueue: true,
    });

    try {
      const other = await store.createTask({ description: "queue head other", priority: "normal" });
      await store.moveTask(other.id, "todo");
      await store.moveTask(other.id, "in-progress");
      await store.handoffToReview(other.id, {
        ownerAgentId: "agent-1",
        evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
      });
      store.enqueueMergeQueue(other.id, { now: "2026-05-19T00:00:00.000Z" });
      store.getDatabase().prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(task.id);

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");

      const otherRow = store.getDatabase().prepare("SELECT taskId, leasedBy FROM mergeQueue WHERE taskId = ?").get(other.id) as {
        taskId: string;
        leasedBy: string | null;
      };
      expect(otherRow.taskId).toBe(other.id);
      expect(otherRow.leasedBy).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5353: reuse handoff rejects project-root worktree misconfiguration", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5353-RI-PROJECT-ROOT-WORKTREE",
      fileName: "packages/engine/src/fn-5353-ri-project-root.ts",
      fileContent: "export const projectRootReuse = true;\n",
      commitMessage: "feat: add project root misconfiguration content",
      skipWorktreeAdd: true,
      worktreeOverride: undefined, // placeholder, real value set below
    });
    // Point task.worktree at the project root to trigger the misconfig refusal.
    await store.updateTask(task.id, { worktree: rootDir } as any);

    try {
      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "reuse-misconfigured",
        reason: "worktree-equals-project-root",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5353: missing task.worktree reacquires a reusable worktree before handoff gates", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5353-RI-MISSING-WORKTREE-HANDOFF",
      fileName: "packages/engine/src/fn-5353-ri-missing-worktree-handoff.ts",
      fileContent: "export const missingHandoff = true;\n",
      commitMessage: "feat: add missing worktree handoff content",
      skipWorktreeAdd: true,
      worktreeOverride: null,
    });
    await store.updateTask(task.id, { worktree: null } as any);

    try {
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const audits = store.getRunAuditEvents({ taskId: task.id });
      const auditTypes = audits.map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-fallback-new-worktree");
      expect(auditTypes).not.toContain("merge:reuse-handoff-refused");
      const refused = audits.find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect((refused?.metadata as { reason?: string } | undefined)?.reason).not.toBe("worktree-equals-project-root");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5363: queue-head pollution by non-in-review tasks does not block target reuse handoff", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5363-RI-POLLUTED",
      fileName: "packages/engine/src/fn-5363-ri-polluted.ts",
      fileContent: "export const polluted = true;\n",
      commitMessage: "feat: add polluted queue merge content",
      skipEnqueue: true,
      extraSettings: { worktreeRebaseRemote: "origin" } as Partial<Settings>,
    });
    store.enqueueMergeQueue(task.id, { now: "2026-05-19T00:00:02.000Z" });

    const todoTask = await store.createTask({ description: "polluter todo", priority: "normal" });
    await store.moveTask(todoTask.id, "todo");
    const inProgressTask = await store.createTask({ description: "polluter progress", priority: "normal" });
    await store.moveTask(inProgressTask.id, "todo");
    await store.moveTask(inProgressTask.id, "in-progress");

    store.getDatabase().prepare("INSERT INTO mergeQueue (taskId, enqueuedAt, priority, attemptCount) VALUES (?, ?, ?, 0)").run(todoTask.id, "2026-05-19T00:00:00.000Z", "normal");
    store.getDatabase().prepare("INSERT INTO mergeQueue (taskId, enqueuedAt, priority, attemptCount) VALUES (?, ?, ?, 0)").run(inProgressTask.id, "2026-05-19T00:00:01.000Z", "normal");
    store.getDatabase().prepare("UPDATE mergeQueue SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ? WHERE taskId = ?").run(
      "merger-reuse-handoff",
      "2026-05-19T00:10:00.000Z",
      "2099-05-19T00:20:00.000Z",
      todoTask.id,
    );

    try {
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      expect(store.getDatabase().prepare("SELECT leasedBy FROM mergeQueue WHERE taskId = ?").get(task.id)).toBeUndefined();
      expect(store.getDatabase().prepare("SELECT taskId FROM mergeQueue WHERE taskId IN (?, ?)").all(todoTask.id, inProgressTask.id)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5363: target row leased by another worker refuses with target-not-queued diagnostics", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5363-RI-NO-LEASE-TARGET",
      fileName: "packages/engine/src/fn-5363-ri-no-lease-target.ts",
      fileContent: "export const noLeaseTarget = true;\n",
      commitMessage: "feat: add leased target merge content",
    });
    // Replay the in-review handoff so the task.column/state matches the pre-merge geometry.
    const completedSteps = ((await store.getTask(task.id))?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
    });
    // handoffToReview resets task.steps; restore completion so the merge gate
    // doesn't refuse with "task has incomplete steps".
    await store.updateTask(task.id, { steps: completedSteps, currentStep: completedSteps.length } as any);
    store.getDatabase().prepare("UPDATE mergeQueue SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ? WHERE taskId = ?").run(
      "worker-other",
      "2026-05-19T00:01:00.000Z",
      "2099-05-19T00:10:00.000Z",
      task.id,
    );

    try {
      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "lease-handoff-failed",
        reason: "target-not-queued",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ reason: "target-not-queued" });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("FN-5444: moving task out of in-review during live lease preserves row until release cleanup", async () => {
    const { fixture, store, task } = await setupReuseHandoff({
      taskId: "FN-5444-RI-COLUMN-EXIT-LIVE-LEASE",
      fileName: "packages/engine/src/fn-5444-ri-column-exit.ts",
      fileContent: "export const exitLease = true;\n",
      commitMessage: "feat: add FN-5444 column exit lease coverage",
      skipWorktreeAdd: true,
      worktreeOverride: null,
    });

    try {
      const lease = store.acquireMergeQueueLease("merger-reuse-handoff", {
        targetTaskId: task.id,
        leaseDurationMs: 60_000,
        now: "2099-05-19T00:00:10.000Z",
      });
      expect(lease?.taskId).toBe(task.id);

      await store.moveTask(task.id, "todo");
      expect(store.peekMergeQueue().some((entry) => entry.taskId === task.id)).toBe(true);

      const staleLeaseAudit = store.getRunAuditEvents({ taskId: task.id, mutationType: "mergeQueue:stale-lease-on-column-exit" });
      expect(staleLeaseAudit).toHaveLength(1);
      expect(staleLeaseAudit[0].metadata).toMatchObject({
        taskId: task.id,
        previousColumn: "in-review",
        nextColumn: "todo",
        leasedBy: "merger-reuse-handoff",
      });
      expect(typeof staleLeaseAudit[0].metadata?.leaseExpiresAt).toBe("string");

      store.releaseMergeQueueLease(task.id, "merger-reuse-handoff", { kind: "success" });
      expect(store.peekMergeQueue().some((entry) => entry.taskId === task.id)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("already-landed branch auto-finalizes from the reused worktree path", async () => {
    const { fixture, rootDir, store, task, branch } = await setupReuseHandoff({
      taskId: "FN-5279-RI-ALREADY-LANDED",
      fileName: "packages/engine/src/fn-5279-ri-already-landed.ts",
      fileContent: "export const landed = true;\n",
      commitMessage: "feat: add already-landed merge content",
      skipWorktreeAdd: true,
      worktreeOverride: null,
      skipEnqueue: true,
    });
    // Fast-forward master to the branch tip (the "already landed" scenario)
    // before recreating the worktree mapping and queue lease.
    git(rootDir, `git merge --ff-only ${JSON.stringify(branch)}`);
    const worktreeRoot = `${rootDir}-worktrees`;
    const worktreePath = join(worktreeRoot, task.id.toLowerCase());
    await mkdir(worktreeRoot, { recursive: true });
    git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
    await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
    store.enqueueMergeQueue(task.id);

    try {
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect(result.mergeConfirmed).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).toContain("merge:reuse-handoff-released");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("Layer 3 conflict resolution sessions run from the reused worktree", async () => {
    const { fixture, rootDir, store, task, branch, worktreePath } = await setupReuseHandoff({
      taskId: "FN-5279-RI-LAYER3",
      fileName: "packages/engine/src/fn-5279-ri-layer3.ts",
      fileContent: "export const value = 'branch';\n",
      commitMessage: "feat: branch conflict content",
      skipWorktreeAdd: true,
      worktreeOverride: null,
      skipEnqueue: true,
      extraSettings: { mergeConflictStrategy: "smart-prefer-main" } as Partial<Settings>,
    });
    // Inject a conflicting commit on master at the same path, then create the
    // worktree and queue entry now that the conflict geometry is in place.
    await store.updateTask(task.id, {
      prompt: "## File Scope\n- packages/engine/src/**\n",
    } as any);
    git(rootDir, "mkdir -p packages/engine/src");
    git(rootDir, "sh -c \"printf \\\"export const value = 'main';\\n\\\" > packages/engine/src/fn-5279-ri-layer3.ts\"");
    git(rootDir, "git add packages/engine/src/fn-5279-ri-layer3.ts");
    git(rootDir, "git commit -m 'feat: main conflict content'");
    const worktreeRoot = `${rootDir}-worktrees`;
    await mkdir(worktreeRoot, { recursive: true });
    git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
    await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
    store.enqueueMergeQueue(task.id);

    try {
      await aiMergeTask(store, rootDir, task.id);
      expect(
        mockedCreateFnAgent.mock.calls.some(([input]) => (input as any)?.cwd === worktreePath),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("reacquires a fresh task worktree when reuse is requested without a task worktree", async () => {
    const { fixture, rootDir, store, task, branch } = await setupReuseHandoff({
      taskId: "FN-5353-RI-MISSING-WORKTREE",
      fileName: "packages/engine/src/fn-5353-ri-missing-worktree.ts",
      fileContent: "export const fallback = true;\n",
      commitMessage: "feat: add fallback merge content",
      skipWorktreeAdd: true,
      worktreeOverride: null,
    });
    await store.updateTask(task.id, { worktree: null } as any);

    try {
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const audits = store.getRunAuditEvents({ taskId: task.id });
      const auditTypes = audits.map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-fallback-new-worktree");
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).not.toContain("merge:reuse-fallback-cwd-main");
      expect(auditTypes).not.toContain("merge:reuse-fallback-cwd-integration-branch");
      expect(auditTypes).not.toContain("merge:cwd-integration-fallback-removed");
      const fallback = audits.find((event) => event.mutationType === "merge:reuse-fallback-new-worktree");
      expect(fallback?.metadata).toMatchObject({
        reason: "missing-task-worktree",
        source: "fresh",
      });

      const freshAcquire = audits.find((event) => event.mutationType === "merge:reuse-worktree-fresh-acquire");
      expect(freshAcquire?.metadata).toMatchObject({
        taskId: task.id,
        reason: "missing-task-worktree",
        expectedBranch: branch,
      });

      const freshAcquired = audits.find((event) => event.mutationType === "merge:reuse-worktree-fresh-acquired");
      expect(freshAcquired?.metadata).toMatchObject({
        taskId: task.id,
        reason: "missing-task-worktree",
        branch,
        priorWorktreePath: null,
      });
      const freshAcquiredWorktreePath = (freshAcquired?.metadata as Record<string, unknown> | undefined)?.worktreePath;
      expect(typeof freshAcquiredWorktreePath).toBe("string");
      expect(freshAcquiredWorktreePath).toBe((fallback?.metadata as Record<string, unknown> | undefined)?.worktreePath);

      const orderedFreshAcquireIndex = audits.findIndex(
        (event) =>
          event.mutationType === "merge:reuse-worktree-fresh-acquire" &&
          (event.metadata as Record<string, unknown> | undefined)?.reason === "missing-task-worktree",
      );
      const orderedFreshAcquiredIndex = audits.findIndex(
        (event) =>
          event.mutationType === "merge:reuse-worktree-fresh-acquired" &&
          (event.metadata as Record<string, unknown> | undefined)?.reason === "missing-task-worktree",
      );
      const orderedFallbackIndex = audits.findIndex(
        (event) =>
          event.mutationType === "merge:reuse-fallback-new-worktree" &&
          (event.metadata as Record<string, unknown> | undefined)?.reason === "missing-task-worktree",
      );
      expect(orderedFreshAcquireIndex).toBeGreaterThanOrEqual(0);
      expect(orderedFreshAcquiredIndex).toBeGreaterThanOrEqual(0);
      expect(orderedFallbackIndex).toBeGreaterThanOrEqual(0);
      // getRunAuditEvents() returns newest-first (timestamp DESC, rowid DESC).
      expect(orderedFallbackIndex).toBeLessThan(orderedFreshAcquiredIndex);
      expect(orderedFreshAcquiredIndex).toBeLessThan(orderedFreshAcquireIndex);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("cwd-main legacy alias is normalized to cwd-integration-branch and stays on the opt-in path with no reuse handoff events", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5279-RI-CWD-MAIN",
      fileName: "packages/engine/src/fn-5279-ri-cwd-main.ts",
      fileContent: "export const legacy = true;\n",
      commitMessage: "feat: add cwd-main merge content",
      skipWorktreeAdd: true,
      worktreeOverride: null,
      skipEnqueue: true,
      extraSettings: { mergeIntegrationWorktree: "cwd-main" as const } as Partial<Settings>,
    });

    try {
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes.filter((type) => type.startsWith("merge:reuse-handoff"))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("worktrunk-enabled reuse mode still acquires reuse handoff", async () => {
    const { fixture, rootDir, store, task } = await setupReuseHandoff({
      taskId: "FN-5279-RI-WORKTRUNK",
      fileName: "packages/engine/src/fn-5279-ri-worktrunk.ts",
      fileContent: "export const deferred = true;\n",
      commitMessage: "feat: add worktrunk merge content",
      extraSettings: { worktrunk: { enabled: true } as any } as Partial<Settings>,
    });

    try {
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-deferred-to-worktrunk");
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it.skipIf(!hasGit)("autoMerge off remains inert and emits no reuse handoff events", async () => {
    // This case never calls aiMergeTask — it just verifies that turning autoMerge
    // off keeps the task in `in-review` with no reuse-handoff fanout. We use a
    // minimal manual setup because the standard helper writes content commits
    // and enqueues the merge queue, both of which would be misleading here.
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-AUTO-OFF",
      settings: {
        autoMerge: false,
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as Partial<Settings>,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());
      git(rootDir, "git branch -m main master");
      await fixture.createBranch(branch);
      await fixture.checkout("master");
      await store.updateTask(task.id, { baseBranch: "master", worktree: worktreePath, branch } as any);
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);

      const latest = await store.getTask(task.id);
      expect(latest?.column).toBe("in-review");
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes.filter((type) => type.startsWith("merge:reuse-handoff"))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  // FN-5345/FN-5377 regression backstop.
  //
  // A verification-only task that committed `--allow-empty` produced a branch
  // with own-commit-count >= 1 but zero net tree change vs merge-base. Combined
  // with drifted worktree<->branch mapping, the reuse-handoff gate would refuse
  // with `registered-branch-mismatch` and the task would escalate to
  // `merge-deadlock-detected: verified content not on main` after FN-4999
  // completion-handoff-limbo recovery exhausts. The early empty-own-diff
  // fast-path must finalize this BEFORE any reuse-handoff acquisition runs.
  it.skipIf(!hasGit)(
    "FN-5345: empty-own-diff branch auto-finalizes via early fast-path without acquiring reuse handoff",
    async () => {
      const { fixture, rootDir, store, task, worktreeRoot } = await setupReuseHandoff({
        taskId: "FN-5279-RI-EMPTY-OWN-DIFF",
        emptyOwnDiff: true,
        skipWorktreeAdd: true,
        worktreeOverride: join(`${"placeholder"}`, "drifted-missing-path"), // overridden below
      });
      // Point the task at a drifted/missing worktree path so the reuse-handoff
      // gate would normally refuse with FN-5083 branch-registration drift.
      await store.updateTask(task.id, { worktree: join(worktreeRoot, "drifted-missing-path") } as any);

      try {
        const result = await aiMergeTask(store, rootDir, task.id);

        expect(result.merged).toBe(true);
        expect(result.noOp).toBe(true);
        expect(result.mergeConfirmed).toBe(true);
        expect((await store.getTask(task.id))?.column).toBe("done");

        const audits = store.getRunAuditEvents({ taskId: task.id });
        const auditTypes = audits.map((event) => event.mutationType);

        // Early fast-path must short-circuit BEFORE any reuse-handoff event.
        expect(auditTypes).not.toContain("merge:reuse-handoff-acquired");
        expect(auditTypes).not.toContain("merge:reuse-handoff-refused");
        expect(auditTypes).not.toContain("merge:reuse-fallback-new-worktree");

        const finalize = audits.find(
          (event) =>
            event.mutationType === "task:auto-recover-finalize-already-on-main"
            && (event.metadata as any)?.reason === "empty-own-diff-early-fast-path",
        );
        expect(finalize).toBeDefined();
        expect((finalize?.metadata as any)?.aheadCount).toBeGreaterThanOrEqual(1);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  // FN-5345/FN-5377 backstop variant: reproduce the actual production wedge
  // geometry where `fusion/<id>` is registered to TWO worktrees simultaneously
  // (e.g. faint-creek + hazy-quail in the FN-5345 incident). The early
  // fast-path runs against projectRootDir and is immune to the worktree drift.
  it.skipIf(!hasGit)(
    "FN-5345: empty-own-diff fast-path fires even when branch is registered to two worktrees",
    async () => {
      const { fixture, rootDir, store, task, branch, worktreeRoot } = await setupReuseHandoff({
        taskId: "FN-5279-RI-DOUBLE-REG",
        emptyOwnDiff: true,
        skipWorktreeAdd: true,
        worktreeOverride: null,
      });
      const pathA = join(worktreeRoot, `${task.id.toLowerCase()}-a`);
      const pathB = join(worktreeRoot, `${task.id.toLowerCase()}-b`);

      // Register branch at pathA then force-register at pathB — the FN-5345
      // two-worktrees-one-branch state.
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(pathA)} ${JSON.stringify(branch)}`);
      git(rootDir, `git worktree add -f ${JSON.stringify(pathB)} ${JSON.stringify(branch)}`);

      await store.updateTask(task.id, { worktree: pathA, branch } as any);
      store.enqueueMergeQueue(task.id);

      try {
        const result = await aiMergeTask(store, rootDir, task.id);

        expect(result.merged).toBe(true);
        expect(result.noOp).toBe(true);
        expect(result.mergeConfirmed).toBe(true);
        expect((await store.getTask(task.id))?.column).toBe("done");

        const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
        expect(auditTypes).not.toContain("merge:reuse-handoff-acquired");
        expect(auditTypes).not.toContain("merge:reuse-handoff-refused");
        expect(auditTypes).toContain("task:auto-recover-finalize-already-on-main");
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  // FN-5345/FN-5377 cleanup-safety backstop: the fast-path's worktree removal
  // MUST preserve a worktree that has uncommitted tracked changes.
  it.skipIf(!hasGit)(
    "FN-5345: empty-own-diff fast-path preserves worktrees with uncommitted tracked changes",
    async () => {
      const { fixture, rootDir, store, task, worktreePath } = await setupReuseHandoff({
        taskId: "FN-5279-RI-DIRTY-PRESERVE",
        emptyOwnDiff: true,
      });
      // README.md is created by the fixture as a tracked file. Modify it to
      // produce tracked-dirty status inside the worktree.
      await writeFile(join(worktreePath, "README.md"), "agent scratch: uncommitted edits\n");

      try {
        const result = await aiMergeTask(store, rootDir, task.id);
        expect(result.merged).toBe(true);
        expect(result.noOp).toBe(true);

        // Critical: the worktree must NOT be removed because it has tracked
        // uncommitted changes. result.worktreeRemoved reflects that.
        expect(result.worktreeRemoved).toBe(false);
        expect(existsSync(worktreePath)).toBe(true);
        expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  // FN-5345/FN-5377 cleanup-noise backstop: untracked junk (.DS_Store, swap
  // files) must NOT block fast-path cleanup. Only tracked dirt does.
  it.skipIf(!hasGit)(
    "FN-5345: empty-own-diff fast-path cleans up worktrees with only untracked noise",
    async () => {
      const { fixture, rootDir, store, task, worktreePath } = await setupReuseHandoff({
        taskId: "FN-5279-RI-UNTRACKED-OK",
        emptyOwnDiff: true,
      });
      await writeFile(join(worktreePath, ".DS_Store"), "binary junk\n");
      await writeFile(join(worktreePath, "editor.swp"), "swap file\n");

      try {
        const result = await aiMergeTask(store, rootDir, task.id);
        expect(result.merged).toBe(true);
        expect(result.noOp).toBe(true);
        // Untracked-only is treated as clean — cleanup proceeds.
        expect(result.worktreeRemoved).toBe(true);
        expect(existsSync(worktreePath)).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );
});
