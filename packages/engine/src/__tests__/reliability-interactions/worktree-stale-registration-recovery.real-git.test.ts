import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeWorktreeBackend } from "../../worktree/worktree-backend.js";
import { WorktreePool } from "../../worktree/worktree-pool.js";
import { git, hasGit } from "./_helpers.js";

describe.skipIf(!hasGit)("reliability interactions: worktree stale registration recovery", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function setupRepo() {
    const root = await mkdtemp(join(tmpdir(), "fusion-stale-registration-"));
    roots.push(root);
    git(root, "git init -b main");
    git(root, 'git config user.email "test@example.com"');
    git(root, 'git config user.name "Test User"');
    await writeFile(join(root, "README.md"), "# repo\n", "utf-8");
    git(root, "git add README.md");
    git(root, 'git commit -m "init"');
    return root;
  }

  it("recovers missing-but-registered worktree via prune and retries add", async () => {
    const root = await setupRepo();
    const worktreePath = join(root, ".worktrees", "fn-test-1");
    const backendAuditEvents: string[] = [];

    git(root, `git worktree add -b feature ${JSON.stringify(worktreePath)}`);
    await rm(worktreePath, { recursive: true, force: true });

    const backend = new NativeWorktreeBackend({
      audit: {
        git: async (event) => {
          backendAuditEvents.push(event.type);
        },
      },
    });

    const result = await backend.create({
      rootDir: root,
      taskId: "FN-TEST-1",
      worktreePath,
      branch: "fusion/fn-test-1",
      startPoint: "main",
    });

    expect(result).toEqual({ path: worktreePath, branch: "fusion/fn-test-1" });
    expect(backendAuditEvents).toContain("worktree:stale-registration-detected");
    expect(backendAuditEvents).toContain("worktree:stale-registration-recovered");

    const porcelain = git(root, "git worktree list --porcelain");
    const resolvedWorktreePath = await realpath(worktreePath);
    expect(porcelain).toContain(`worktree ${resolvedWorktreePath}`);
  });

  it("recovered path composes with FN-4954 pool acquire/release contract", async () => {
    const root = await setupRepo();
    const worktreePath = join(root, ".worktrees", "fn-test-2");

    git(root, `git worktree add -b feature ${JSON.stringify(worktreePath)}`);
    await rm(worktreePath, { recursive: true, force: true });

    const backend = new NativeWorktreeBackend();
    await backend.create({
      rootDir: root,
      taskId: "FN-TEST-2",
      worktreePath,
      branch: "fusion/fn-test-2",
      startPoint: "main",
    });

    const pool = new WorktreePool();
    pool.release(worktreePath, "FN-TEST-2");
    const acquired = pool.acquire("FN-TEST-3");

    expect(acquired).toBe(worktreePath);
    expect(pool.getLeasedPaths().get(worktreePath)).toBe("FN-TEST-3");
  });
});
