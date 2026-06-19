import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { DEFAULT_SETTINGS, TaskStore, type Settings } from "@fusion/core";
import { cleanupAiMergeWorktree, resolveAiMergeRoot, runAiMerge } from "../../merger-ai.js";
import { activeSessionRegistry } from "../../active-session-registry.js";
import { hasGit } from "./_helpers.js";
import type { RunAuditor } from "../../run-audit.js";

const tracked = new Set<string>();
const taskIds = new Set<string>();
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

afterAll(() => {
  for (const taskId of taskIds) removeTmpAiMergeDirs(taskId);
  for (const dir of tracked) {
    try {
      rmSync(dir, RM);
    } catch {
      // best effort cleanup
    }
  }
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function aiMergePrefix(taskId: string): string {
  return `fusion-ai-merge-${taskId.toLowerCase()}-`;
}

function tmpAiMergeDirs(taskId: string): string[] {
  const prefix = aiMergePrefix(taskId);
  return readdirSync(tmpdir())
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(tmpdir(), entry));
}

function localAiMergeDirs(rootDir: string, taskId: string): string[] {
  const root = resolveAiMergeRoot(rootDir);
  const prefix = aiMergePrefix(taskId);
  return readdirSync(root)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(root, entry));
}

function removeTmpAiMergeDirs(taskId: string): void {
  for (const dir of tmpAiMergeDirs(taskId)) {
    try {
      rmSync(dir, RM);
    } catch {
      // best effort cleanup
    }
  }
}

function expectNoAiMergeWorktrees(rootDir: string, taskId: string): void {
  expect(tmpAiMergeDirs(taskId), `legacy tmpdir entries for ${taskId}`).toEqual([]);
  expect(localAiMergeDirs(rootDir, taskId), `repo-local AI merge entries for ${taskId}`).toEqual([]);
  const worktrees = git(rootDir, "worktree list --porcelain");
  expect(worktrees).not.toContain(aiMergePrefix(taskId));
}

function makeAge(path: string, ageMs: number): void {
  const old = new Date(Date.now() - ageMs);
  utimesSync(path, old, old);
}

function realMergeAgent(branch: string) {
  return vi.fn(async (cwd: string) => {
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

async function createFixture(label: string) {
  const rootDir = mkdtempSync(join(tmpdir(), `fusion-ai-merge-cleanup-${label.toLowerCase()}-`));
  tracked.add(rootDir);
  git(rootDir, "init -q -b main");
  git(rootDir, 'config user.email "test@example.com"');
  git(rootDir, 'config user.name "Test User"');
  writeFileSync(join(rootDir, "README.md"), `# ${label}\n`);
  git(rootDir, "add README.md");
  git(rootDir, 'commit -q -m "chore: init"');

  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    autoMerge: true,
    includeTaskIdInCommit: true,
    commitAuthorEnabled: false,
    merger: { ...(DEFAULT_SETTINGS.merger ?? {}), mode: "ai", maxReviewPasses: 1 },
  } as Settings;
  await store.updateSettings(settings);

  const created = await store.createTask({
    title: label,
    description: "AI merge worktree cleanup fixture",
    column: "in-review",
    baseBranch: "main",
    prompt: "## File Scope\n- packages/engine/src/**\n",
  } as any);
  const branch = `fusion/${created.id.toLowerCase()}`;
  await store.updateTask(created.id, {
    column: "in-review",
    branch,
    baseBranch: "main",
    steps: [{ title: "ready", status: "done" }],
    status: null,
  } as any);
  taskIds.add(created.id);
  removeTmpAiMergeDirs(created.id);

  return {
    rootDir,
    store,
    taskId: created.id,
    branch,
    cleanup: async () => {
      removeTmpAiMergeDirs(created.id);
      for (const dir of localAiMergeDirs(rootDir, created.id)) rmSync(dir, RM);
      store.close();
      rmSync(rootDir, RM);
      tracked.delete(rootDir);
    },
  };
}

function commitTaskBranch(rootDir: string, branch: string, filename: string, contents: string): void {
  git(rootDir, `checkout -q -b ${branch}`);
  writeFileSync(join(rootDir, filename), contents);
  git(rootDir, `add ${filename}`);
  git(rootDir, `commit -q -m "feat: ${filename}"`);
  git(rootDir, "checkout -q main");
}

function makeAudit() {
  const events: any[] = [];
  const audit: RunAuditor = {
    git: vi.fn(async (event: any) => { events.push(event); }),
    database: vi.fn(async () => undefined),
    filesystem: vi.fn(async () => undefined),
    sandbox: vi.fn(async () => undefined),
  };
  return { audit, events };
}

describe("FN-6220 AI-merge worktree cleanup lifecycle (real git)", () => {
  it.skipIf(!hasGit)("removes temp worktree after a successful AI land", async () => {
    const fixture = await createFixture("success");
    const { rootDir, store, taskId, branch, cleanup } = fixture;

    try {
      commitTaskBranch(rootDir, branch, "feature.txt", "feature work\n");

      const result = await runAiMerge(store, rootDir, taskId, { manual: true, allowDirtyLocalCheckoutSync: true }, {
        mergeAgent: realMergeAgent(branch),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });

      expect(result).toMatchObject({ ok: true, merged: true });
      expectNoAiMergeWorktrees(rootDir, taskId);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it.skipIf(!hasGit)("removes temp worktree after an empty no-op AI merge", async () => {
    const fixture = await createFixture("noop");
    const { rootDir, store, taskId, branch, cleanup } = fixture;

    try {
      git(rootDir, `checkout -q -b ${branch}`);
      git(rootDir, "checkout -q main");

      const result = await runAiMerge(store, rootDir, taskId, { manual: true, allowDirtyLocalCheckoutSync: true }, {
        mergeAgent: vi.fn(async () => {
          // Leave HEAD at the integration tip so mergeAndReview returns null.
        }),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });

      expect(result).toMatchObject({ ok: true, noOp: true, merged: false });
      expectNoAiMergeWorktrees(rootDir, taskId);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it.skipIf(!hasGit)("cleans each temp worktree before retrying after a concurrent advance", async () => {
    const fixture = await createFixture("concurrent");
    const { rootDir, store, taskId, branch, cleanup } = fixture;

    try {
      commitTaskBranch(rootDir, branch, "feature.txt", "feature work\n");
      git(rootDir, "checkout -q -b parking main");
      let attempts = 0;
      const mergeRoots: string[] = [];
      const mergeAgent = vi.fn(async (cwd: string) => {
        attempts++;
        mergeRoots.push(cwd);
        execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
        execSync("git add -A", { cwd, stdio: "pipe" });
        execSync(`git commit -q -m "squash: feature attempt ${attempts}"`, { cwd, stdio: "pipe" });
        if (attempts === 1) {
          const mainBefore = git(rootDir, "rev-parse refs/heads/main");
          const concurrentSha = git(rootDir, 'commit-tree refs/heads/main^{tree} -p refs/heads/main -m "chore: concurrent advance"');
          git(rootDir, `update-ref refs/heads/main ${concurrentSha} ${mainBefore}`);
        }
      });

      const result = await runAiMerge(store, rootDir, taskId, { manual: true, allowDirtyLocalCheckoutSync: true }, {
        mergeAgent,
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });

      expect(result).toMatchObject({ ok: true, merged: true });
      expect(attempts).toBe(2);
      expect(mergeRoots).toHaveLength(2);
      expect(mergeRoots.every((dir) => !existsSync(dir))).toBe(true);
      expectNoAiMergeWorktrees(rootDir, taskId);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it.skipIf(!hasGit)("removes temp worktree when the merge agent throws", async () => {
    const fixture = await createFixture("throws");
    const { rootDir, store, taskId, branch, cleanup } = fixture;

    try {
      commitTaskBranch(rootDir, branch, "feature.txt", "feature work\n");

      await expect(runAiMerge(store, rootDir, taskId, { manual: true, allowDirtyLocalCheckoutSync: true }, {
        mergeAgent: vi.fn(async () => { throw new Error("simulated merge failure"); }),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      })).rejects.toThrow("simulated merge failure");

      expectNoAiMergeWorktrees(rootDir, taskId);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it.skipIf(!hasGit)("removes the clean-room directory when active-session registration throws", async () => {
    const fixture = await createFixture("register-throws");
    const { rootDir, store, taskId, branch, cleanup } = fixture;
    const originalRegisterPath = activeSessionRegistry.registerPath.bind(activeSessionRegistry);

    try {
      commitTaskBranch(rootDir, branch, "feature.txt", "feature work\n");
      /*
       * FNXC:AIMerge 2026-06-14-16:47:
       * Reproduce the create→register window deterministically: after `mkdtemp` creates a `fusion-ai-merge-*` clean room, force active-session registration to throw before `git worktree add`. The lifecycle invariant is that cleanup still removes the directory and leaves no git worktree registration for the task prefix.
       */
      vi.spyOn(activeSessionRegistry, "registerPath").mockImplementation((pathToRegister, metadata) => {
        if (String(pathToRegister).includes(aiMergePrefix(taskId))) {
          throw new Error("simulated active-session registration failure");
        }
        return originalRegisterPath(pathToRegister, metadata);
      });

      await expect(runAiMerge(store, rootDir, taskId, { manual: true, allowDirtyLocalCheckoutSync: true }, {
        mergeAgent: realMergeAgent(branch),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      })).rejects.toThrow("simulated active-session registration failure");

      expectNoAiMergeWorktrees(rootDir, taskId);
    } finally {
      vi.restoreAllMocks();
      await cleanup();
    }
  }, 20_000);

  it.skipIf(!hasGit)("pre-merge prune removes an FN-6207-style directory whose git registration is already gone", async () => {
    const fixture = await createFixture("orphan-dir");
    const { rootDir, store, taskId, branch, cleanup } = fixture;

    try {
      commitTaskBranch(rootDir, branch, "feature.txt", "feature work\n");
      const orphanRoot = resolveAiMergeRoot(rootDir);
      mkdirSync(orphanRoot, { recursive: true });
      const orphanDir = mkdtempSync(join(orphanRoot, aiMergePrefix(taskId)));
      makeAge(orphanDir, 11 * 60_000);
      expect(existsSync(orphanDir)).toBe(true);

      await runAiMerge(store, rootDir, taskId, { manual: true, allowDirtyLocalCheckoutSync: true }, {
        mergeAgent: realMergeAgent(branch),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });

      expect(existsSync(orphanDir)).toBe(false);
      expectNoAiMergeWorktrees(rootDir, taskId);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it.skipIf(!hasGit)("cleanup prunes a dangling git registration whose directory is already gone", async () => {
    const fixture = await createFixture("dangling-registration");
    const { rootDir, taskId, cleanup } = fixture;
    const { audit } = makeAudit();
    const logs: string[] = [];

    try {
      const staleRoot = mkdtempSync(join(tmpdir(), aiMergePrefix(taskId)));
      rmSync(staleRoot, RM);
      git(rootDir, `worktree add --detach ${staleRoot} main`);
      rmSync(staleRoot, RM);
      expect(git(rootDir, "worktree list --porcelain")).toContain(staleRoot);

      await cleanupAiMergeWorktree({
        taskId,
        mergeRoot: staleRoot,
        projectRootDir: rootDir,
        worktreeAdded: true,
        audit,
        log: vi.fn(async (message: string) => { logs.push(message); }),
      });

      expect(existsSync(staleRoot)).toBe(false);
      expectNoAiMergeWorktrees(rootDir, taskId);
      expect(logs.join("\n")).not.toContain("filesystem rm failed");
    } finally {
      await cleanup();
    }
  }, 20_000);
});
