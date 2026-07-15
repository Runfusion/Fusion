import { mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

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

import { aiMergeTask } from "../../merger.js";
import { WorktreePool } from "../../worktree-pool.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { git, hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

describe("FN-4954 reliability interactions: merger pooled release ordering", () => {
  it.skipIf(!hasGit || !hasPg)("detaches and clears task pointers before pooled release exposes the path", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-4954-RI-A",
      task: { steps: [] as any[] },
      settings: { recycleWorktrees: true, mergeIntegrationWorktree: "cwd-main" as const },
    });

    try {
      const { rootDir, store, task } = fixture;
      const seededTask = await store.getTask(task.id);
      const completedSteps = (seededTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      const branch = task.branch ?? `fusion/${task.id.toLowerCase()}`;
      const worktreePath = join(rootDir, ".worktrees", "fn-4954-ri-a");

      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-4954-ri-a.txt", "race guard\n", "feat: add merge content");
      await fixture.checkout("main");

      await mkdir(join(rootDir, ".worktrees"), { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { branch, worktree: worktreePath });
      await store.moveTask(task.id, "in-review");
      await store.enqueueMergeQueue(task.id);

      const pool = new WorktreePool();
      const result = await aiMergeTask(store, rootDir, task.id, { pool });
      expect(result.merged).toBe(true);
      expect(result.worktreeRemoved).toBe(false);
      expect(pool.size).toBe(1);

      const acquired = pool.acquire("FN-4954-RI-B");
      expect(acquired).toBe(worktreePath);

      expect(() => execSync("git symbolic-ref --quiet HEAD", {
        cwd: worktreePath,
        stdio: "pipe",
        encoding: "utf-8",
      })).toThrow();

      const mergedTask = await store.getTask(task.id);
      expect(mergedTask?.worktree ?? null).toBeNull();
      expect(mergedTask?.branch ?? null).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
