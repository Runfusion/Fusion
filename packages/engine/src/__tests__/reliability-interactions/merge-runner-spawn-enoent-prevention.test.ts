import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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
import { activeSessionRegistry, executingTaskLock } from "../../agents/active-session-registry.js";
import { aiMergeTask } from "../../merger.js";
/*
FNXC:PgMigrationQuarantine 2026-07-18-04:10:
VAL-REMOVAL-005 reliability fixtures use PostgreSQL AsyncDataLayer storage. Read
run audits through getRunAuditEventsAsync so each assertion observes committed
backend events rather than the removed synchronous SQLite read surface.
*/
import { git, hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

async function setupReuseMergeFixture(opts: {
  taskId: string;
  fileName: string;
  fileContent: string;
  skipEnqueue?: boolean;
}): Promise<{
  rootDir: string;
  store: Awaited<ReturnType<typeof makeReliabilityFixture>>["store"];
  taskId: string;
  branch: string;
  fixture: Awaited<ReturnType<typeof makeReliabilityFixture>>;
  worktreeRoot: string;
  worktreePath: string;
}> {
  const fixture = await makeReliabilityFixture({
    taskId: opts.taskId,
    settings: {
      baseBranch: "master",
      mergeIntegrationWorktree: "reuse-task-worktree",
      worktreeRebaseRemote: "origin",
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
  await fixture.writeAndCommit(opts.fileName, opts.fileContent, `feat: add ${opts.taskId} merge content`);
  await fixture.checkout("master");

  await mkdir(worktreeRoot, { recursive: true });
  git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
  await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
  if (!opts.skipEnqueue) {
    await store.enqueueMergeQueue(task.id);
  }

  return { rootDir, store, taskId: task.id, branch, fixture, worktreeRoot, worktreePath };
}

async function cleanupFixture(fixture: Awaited<ReturnType<typeof makeReliabilityFixture>>, worktreeRoot: string): Promise<void> {
  await fixture.cleanup();
  await rm(worktreeRoot, RM);
}

describe("FN-6278 reliability interactions: merge runner cwd preflight", () => {
  beforeEach(() => {
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
  });

  it.skipIf(!hasGit || !hasPg)("FN-6817: roots the shared reliability fixture under the Vitest worker root", async () => {
    const previousWorkerRoot = process.env.FUSION_TEST_WORKER_ROOT;
    const workerRoot = await mkdtemp(join(tmpdir(), "fn-6817-worker-root-"));
    process.env.FUSION_TEST_WORKER_ROOT = workerRoot;
    let fixture: Awaited<ReturnType<typeof makeReliabilityFixture>> | undefined;

    try {
      fixture = await makeReliabilityFixture({ taskId: "FN-6817-RI-WORKER-ROOT" });
      const worktreeRoot = `${fixture.rootDir}-worktrees`;
      await mkdir(worktreeRoot, { recursive: true });

      expect(fixture.rootDir.startsWith(`${workerRoot}${sep}`)).toBe(true);
      expect(worktreeRoot.startsWith(`${workerRoot}${sep}`)).toBe(true);
      expect(git(fixture.rootDir, "git rev-parse --is-inside-work-tree")).toBe("true");

      await fixture.cleanup();
      fixture = undefined;
      expect(existsSync(worktreeRoot)).toBe(false);
    } finally {
      if (fixture) await fixture.cleanup();
      if (previousWorkerRoot === undefined) {
        delete process.env.FUSION_TEST_WORKER_ROOT;
      } else {
        process.env.FUSION_TEST_WORKER_ROOT = previousWorkerRoot;
      }
      await rm(workerRoot, RM);
    }
  });

  it.skipIf(!hasGit || !hasPg)("reacquires before spawning git when the reuse worktree cwd vanished", async () => {
    const { fixture, rootDir, store, taskId, branch, worktreeRoot, worktreePath } = await setupReuseMergeFixture({
      taskId: "FN-6278-RI-VANISHED",
      fileName: "packages/engine/src/fn-6278-ri-vanished.ts",
      fileContent: "export const vanishedReuseWorktree = true;\n",
    });

    try {
      // Leave the git worktree registration stale but remove the filesystem cwd.
      // Before FN-6278, the first merge-runner git spawn using this cwd threw
      // `spawn git ENOENT` and could park the task failed after retry exhaustion.
      await rm(worktreePath, RM);

      const result = await aiMergeTask(store, rootDir, taskId);
      const taskAfter = await store.getTask(taskId);
      const audits = await store.getRunAuditEventsAsync({ taskId });
      const auditTypes = audits.map((event) => event.mutationType);

      expect(result.merged).toBe(true);
      expect(taskAfter?.column).toBe("done");
      expect(taskAfter?.status ?? null).toBeNull();
      expect(taskAfter?.error ?? null).not.toBe("spawn git ENOENT");
      expect(taskAfter?.mergeRetries ?? 0).not.toBeGreaterThanOrEqual(3);
      expect(auditTypes).toContain("merge:reuse-worktree-fresh-acquire");
      expect(auditTypes).toContain("merge:reuse-worktree-fresh-acquired");
      expect(auditTypes).toContain("merge:reuse-fallback-new-worktree");
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).not.toContain("MergeNonConflictFailure");

      const freshAcquire = audits.find((event) => event.mutationType === "merge:reuse-worktree-fresh-acquire");
      expect(freshAcquire?.metadata).toMatchObject({
        taskId,
        reason: "unusable-task-worktree",
        expectedBranch: branch,
        priorWorktreePath: worktreePath,
        diagnostics: {
          requestedMode: "reuse-task-worktree",
          classification: expect.objectContaining({ classification: "missing" }),
        },
      });
      const acquired = audits.find((event) => event.mutationType === "merge:reuse-handoff-acquired");
      expect(acquired?.target).toBe(worktreePath);
      expect(git(rootDir, "git ls-files")).toContain("packages/engine/src/fn-6278-ri-vanished.ts");
    } finally {
      await cleanupFixture(fixture, worktreeRoot);
    }
  }, 60_000);

  it.skipIf(!hasGit || !hasPg)("reacquires before spawning git when the reuse worktree is present but de-registered", async () => {
    const { fixture, rootDir, store, taskId, branch, worktreeRoot, worktreePath } = await setupReuseMergeFixture({
      taskId: "FN-6278-RI-UNREGISTERED",
      fileName: "packages/engine/src/fn-6278-ri-unregistered.ts",
      fileContent: "export const unregisteredReuseWorktree = true;\n",
    });
    const unregisteredPath = join(worktreeRoot, "present-but-unregistered");

    try {
      // Remove the valid linked worktree, then point the task at a different
      // present directory that has git metadata but is not in `git worktree list`.
      // This drives the distinct `classification: unregistered` preflight branch.
      git(rootDir, `git worktree remove --force ${JSON.stringify(worktreePath)}`);
      await mkdir(unregisteredPath, { recursive: true });
      await writeFile(join(unregisteredPath, ".git"), "gitdir: /tmp/fusion-unregistered-placeholder\n", "utf-8");
      await store.updateTask(taskId, { worktree: unregisteredPath, branch } as any);

      const result = await aiMergeTask(store, rootDir, taskId);
      const taskAfter = await store.getTask(taskId);
      const audits = await store.getRunAuditEventsAsync({ taskId });
      const auditTypes = audits.map((event) => event.mutationType);

      expect(result.merged).toBe(true);
      expect(taskAfter?.column).toBe("done");
      expect(taskAfter?.status ?? null).toBeNull();
      expect(taskAfter?.error ?? null).not.toBe("spawn git ENOENT");
      expect(taskAfter?.mergeRetries ?? 0).not.toBeGreaterThanOrEqual(3);
      expect(auditTypes).toContain("merge:reuse-worktree-fresh-acquire");
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      const freshAcquire = audits.find((event) => event.mutationType === "merge:reuse-worktree-fresh-acquire");
      expect(freshAcquire?.metadata).toMatchObject({
        taskId,
        reason: "unusable-task-worktree",
        expectedBranch: branch,
        priorWorktreePath: unregisteredPath,
        diagnostics: {
          requestedMode: "reuse-task-worktree",
          classification: expect.objectContaining({ classification: "unregistered" }),
        },
      });
      expect(git(rootDir, "git ls-files")).toContain("packages/engine/src/fn-6278-ri-unregistered.ts");
    } finally {
      await cleanupFixture(fixture, worktreeRoot);
    }
  }, 60_000);

  it.skipIf(!hasGit || !hasPg)("leaves a healthy reuse worktree on the normal handoff path", async () => {
    const { fixture, rootDir, store, taskId, worktreeRoot, worktreePath } = await setupReuseMergeFixture({
      taskId: "FN-6278-RI-HEALTHY",
      fileName: "packages/engine/src/fn-6278-ri-healthy.ts",
      fileContent: "export const healthyReuseWorktree = true;\n",
    });

    try {
      const result = await aiMergeTask(store, rootDir, taskId);
      const taskAfter = await store.getTask(taskId);
      const audits = await store.getRunAuditEventsAsync({ taskId });
      const auditTypes = audits.map((event) => event.mutationType);

      expect(result.merged).toBe(true);
      expect(taskAfter?.column).toBe("done");
      expect(taskAfter?.mergeRetries ?? 0).not.toBeGreaterThanOrEqual(3);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).not.toContain("merge:reuse-worktree-fresh-acquire");
      expect(auditTypes).not.toContain("merge:reuse-fallback-new-worktree");
      const acquired = audits.find((event) => event.mutationType === "merge:reuse-handoff-acquired");
      expect(acquired?.target).toBe(worktreePath);
    } finally {
      await cleanupFixture(fixture, worktreeRoot);
    }
  }, 60_000);

  it.skipIf(!hasGit || !hasPg)("still surfaces genuine handoff failures after a healthy cwd preflight", async () => {
    const { fixture, rootDir, store, taskId, worktreeRoot, worktreePath } = await setupReuseMergeFixture({
      taskId: "FN-6278-RI-ACTIVE-BINDING",
      fileName: "packages/engine/src/fn-6278-ri-active-binding.ts",
      fileContent: "export const nonRecoverableHandoffFailure = true;\n",
    });
    activeSessionRegistry.registerPath(worktreePath, { taskId: "FN-OTHER", kind: "executor", ownerKey: "FN-OTHER" });

    try {
      await expect(aiMergeTask(store, rootDir, taskId)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "active-session-binding",
      });
      const taskAfter = await store.getTask(taskId);
      const audits = await store.getRunAuditEventsAsync({ taskId });
      const auditTypes = audits.map((event) => event.mutationType);

      expect(taskAfter?.column).toBe("in-review");
      expect(taskAfter?.status ?? null).not.toBe("failed");
      expect(taskAfter?.error ?? null).not.toBe("spawn git ENOENT");
      expect(auditTypes).toContain("merge:reuse-handoff-refused");
      expect(auditTypes).not.toContain("merge:reuse-worktree-fresh-acquire");
      const refused = audits.find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "active-session-binding" });
    } finally {
      await cleanupFixture(fixture, worktreeRoot);
    }
  }, 60_000);
});
