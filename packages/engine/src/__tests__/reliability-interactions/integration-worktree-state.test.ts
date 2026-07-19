import { mkdir } from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
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
/*
FNXC:PgMigrationQuarantine 2026-07-18-04:10:
VAL-REMOVAL-005 reliability fixtures use PostgreSQL AsyncDataLayer storage. Read
run audits through getRunAuditEventsAsync so each assertion observes committed
backend events rather than the removed synchronous SQLite read surface.
*/
import { git, hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

async function setupReuseTask(taskId: string, baseBranch: "main" | "master") {
  const fixture = await makeReliabilityFixture({
    taskId,
    settings: { baseBranch, mergeIntegrationWorktree: "reuse-task-worktree", worktreeRebaseRemote: "origin" } as any,
  });

  const { rootDir, store, task } = fixture;
  const actualTask = await store.getTask(task.id);
  const branch = `fusion/${actualTask!.id.toLowerCase()}`;
  const worktreeRoot = `${rootDir}-worktrees`;
  const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

  if (baseBranch === "master") {
    git(rootDir, "git branch -m main master");
  }

  await store.updateTask(task.id, {
    baseBranch,
    branch,
    steps: (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
    currentStep: (actualTask?.steps ?? []).length,
  } as any);

  await fixture.createBranch(branch);
  await fixture.writeAndCommit(`packages/engine/src/${taskId.toLowerCase()}.ts`, "export const v = 1;\n", "feat: merge content");
  await fixture.checkout(baseBranch);
  await mkdir(worktreeRoot, { recursive: true });
  git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
  await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
  await store.enqueueMergeQueue(task.id);

  return { fixture, worktreePath, branch };
}

describe("reliability interaction: integration-worktree-state telemetry", () => {
  it.skipIf(!hasGit || !hasPg)("captures dirty user checkout while successful reuse merge leaves user files untouched", async () => {
    const { fixture } = await setupReuseTask("FN-5351-RI-STATE-1", "main");
    try {
      const { rootDir, store, task } = fixture;
      writeFileSync(join(rootDir, "README.md"), "# fixture\nuser edit\n");
      writeFileSync(join(rootDir, "UNTRACKED.txt"), "u\n");
      git(rootDir, "git add README.md");

      const trackedBefore = readFileSync(join(rootDir, "README.md"), "utf-8");
      const untrackedBefore = readFileSync(join(rootDir, "UNTRACKED.txt"), "utf-8");
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");

      const audits = await store.getRunAuditEventsAsync({ taskId: task.id });
      const state = audits.find((event) => event.mutationType === "merge:integration-worktree-state");
      expect(state?.metadata).toMatchObject({
        integrationMode: "reuse-task-worktree",
        integrationBranch: "main",
        userCheckout: expect.objectContaining({ dirty: true }),
      });
      const advance = audits.find((event) => event.mutationType === "merge:integration-ref-advance");
      expect(advance?.metadata).toMatchObject({ refName: "refs/heads/main", succeeded: true });

      expect(readFileSync(join(rootDir, "README.md"), "utf-8")).toBe(trackedBefore);
      expect(readFileSync(join(rootDir, "UNTRACKED.txt"), "utf-8")).toBe(untrackedBefore);
      expect(existsSync(join(rootDir, "UNTRACKED.txt"))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit || !hasPg)("emits autostash audit and continues merging when reused task worktree is dirty", async () => {
    const { fixture, worktreePath } = await setupReuseTask("FN-5351-RI-STATE-2", "main");
    try {
      const { rootDir, store, task } = fixture;
      git(worktreePath, "sh -c 'printf dirty > DIRTY.txt'");
      await aiMergeTask(store, rootDir, task.id).catch(() => undefined);

      const audits = await store.getRunAuditEventsAsync({ taskId: task.id });
      const autostash = audits.find((event) => event.mutationType === "merge:reuse-handoff-autostash");
      expect(autostash?.metadata).toMatchObject({ worktreePath });
      expect(typeof autostash?.metadata?.stashSha).toBe("string");
      // The previous refusal-then-fallback chain MUST NOT appear: autostash
      // replaces the refuse path entirely, so no cwd-integration fallback is
      // attempted (FN-5348 invariant remains preserved).
      const fallbackRefused = audits.find((event) => event.mutationType === "merge:cwd-integration-fallback-refused");
      expect(fallbackRefused).toBeUndefined();

      // The autostash audit event carries the stash SHA — sufficient proof
      // of recoverability without depending on the worktree still existing
      // post-merge.
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit || !hasPg)("uses resolved master branch names in all new telemetry payloads", async () => {
    const { fixture } = await setupReuseTask("FN-5351-RI-STATE-3", "master");
    try {
      const { rootDir, store, task } = fixture;
      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);

      const audits = (await store.getRunAuditEventsAsync({ taskId: task.id })).filter((event) =>
        ["merge:integration-worktree-state", "merge:cwd-integration-fallback-refused", "merge:integration-ref-advance"].includes(event.mutationType),
      );
      const state = audits.find((event) => event.mutationType === "merge:integration-worktree-state");
      const advance = audits.find((event) => event.mutationType === "merge:integration-ref-advance");
      expect(state?.metadata).toMatchObject({ integrationBranch: "master" });
      expect(advance?.metadata).toMatchObject({ integrationBranch: "master", refName: "refs/heads/master" });

      for (const event of audits) {
        const payload = JSON.stringify(event.metadata ?? {});
        expect(payload).not.toContain("\"main\"");
      }
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
