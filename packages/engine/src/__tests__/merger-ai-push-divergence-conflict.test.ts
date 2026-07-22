/*
FNXC:MergePush 2026-07-22-18:35:
GitHub issue Tchori-Labs/Fusion#5 requires a real-git conflicting-divergence regression: the resolver stages only, Fusion owns `git rebase --continue`, and aborts after staging must remain visible and recoverable without changing the finalized-task contract.
*/
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const createResolvedAgentSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-session-helpers.js")>();
  return {
    ...actual,
    createResolvedAgentSession: createResolvedAgentSessionMock,
  };
});
vi.mock("../pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi.js")>();
  return {
    ...actual,
    promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> | void }, prompt: string) => {
      await session.prompt(prompt);
    }),
  };
});

import { pushAfterMergeToRemote, runAiMerge } from "../merger-ai.js";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const tracked = new Set<string>();
afterAll(() => {
  for (const dir of tracked) {
    try { rmSync(dir, RM); } catch { /* best effort */ }
  }
});
beforeEach(() => createResolvedAgentSessionMock.mockReset());

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
}

function hasRef(cwd: string, ref: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet ${ref}`, { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function initRepoWithRemote(): { dir: string; originDir: string } {
  const root = mkdtempSync(join(tmpdir(), "fusion-ai-merge-push-conflict-"));
  tracked.add(root);
  const originDir = join(root, "origin.git");
  const dir = join(root, "work");
  execSync(`git init -q --bare "${originDir}"`);
  execSync(`git init -q -b main "${dir}"`);
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name t");
  writeFileSync(join(dir, "shared.txt"), "base\n");
  git(dir, "add -A");
  git(dir, "commit -q -m base");
  git(dir, `remote add origin "${originDir}"`);
  git(dir, "push -q origin main");

  git(dir, "checkout -q -b fusion/kb-002");
  writeFileSync(join(dir, "shared.txt"), "task side\n");
  git(dir, "add -A");
  git(dir, "commit -q -m 'feat: task side'");
  git(dir, "checkout -q main");
  return { dir, originDir };
}

function advanceOriginConflicting(originDir: string): void {
  const clone = mkdtempSync(join(tmpdir(), "fusion-ai-merge-push-conflict-other-"));
  tracked.add(clone);
  execSync(`git clone -q "${originDir}" "${clone}"`);
  git(clone, "config user.email o@o.o");
  git(clone, "config user.name o");
  writeFileSync(join(clone, "shared.txt"), "remote side\n");
  git(clone, "add -A");
  git(clone, "commit -q -m 'remote: conflicting side'");
  git(clone, "push -q origin main");
}

function makeStore() {
  const task: Record<string, unknown> = {
    id: "KB-002",
    column: "in-review",
    status: null,
    branch: "fusion/kb-002",
    worktree: null,
    title: "preserve approved merge",
    steps: [],
  };
  const logs: Array<{ message: string; action?: string }> = [];
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 1 }, pushAfterMerge: true })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    emit: vi.fn(),
    logEntry: vi.fn(async (_id: string, message: string, action?: string) => { logs.push({ message, action }); }),
    appendAgentLog: vi.fn(async (_id: string, message: string) => { logs.push({ message }); }),
    getBranchGroup: vi.fn(() => null),
    recordRunAuditEvent: vi.fn(),
  };
  return { store: store as never, storeMocks: store, task, logs };
}

function realMergeAgent(branch: string) {
  return vi.fn(async (cwd: string) => {
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: task side"', { cwd, stdio: "pipe" });
  });
}

const approveReviewer = () => vi.fn(async () => "REVIEW_VERDICT: approve");

function installStagingResolver(options?: { abortController?: AbortController; resolutions?: string[] }): void {
  let resolutionIndex = 0;
  createResolvedAgentSessionMock.mockImplementation(async (sessionOptions: { cwd: string }) => ({
    session: {
      prompt: vi.fn(async () => {
        const resolution = options?.resolutions?.[resolutionIndex] ?? "remote side\ntask side\n";
        resolutionIndex += 1;
        writeFileSync(join(sessionOptions.cwd, "shared.txt"), resolution);
        execSync("git add shared.txt", { cwd: sessionOptions.cwd, stdio: "pipe" });
        options?.abortController?.abort();
      }),
      dispose: vi.fn(),
      getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0 } })),
    },
  }));
}

function installUnresolvedResolver(): void {
  createResolvedAgentSessionMock.mockImplementation(async () => ({
    session: {
      prompt: vi.fn(async () => undefined),
      dispose: vi.fn(),
      getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0 } })),
    },
  }));
}

function expectNoRebaseWorktree(repoDir: string): void {
  const worktrees = git(repoDir, "worktree list --porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  for (const worktree of worktrees) {
    expect(existsSync(join(worktree, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(join(worktree, ".git", "rebase-apply"))).toBe(false);
  }
}

describe("runAiMerge push-after-merge conflicting divergence", () => {
  it("continues a resolver-staged rebase and pushes the converged refs", async () => {
    const { dir, originDir } = initRepoWithRemote();
    advanceOriginConflicting(originDir);
    const { store, storeMocks } = makeStore();
    installStagingResolver();

    const result = await runAiMerge(store, dir, "KB-002", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/kb-002"),
      reviewAgent: approveReviewer(),
    });

    expect(result.pushedToRemote).toBe(true);
    const originMain = git(originDir, "rev-parse main");
    expect(git(dir, "rev-parse main")).toBe(originMain);
    expect(git(dir, "show main:shared.txt")).toBe("remote side\ntask side");
    expect(git(dir, "log --pretty=%s main")).toContain("remote: conflicting side");
    expect(hasRef(originDir, "refs/heads/fusion/kb-002-stranded")).toBe(false);
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:recovery-branch",
      metadata: expect.objectContaining({ outcome: "success" }),
    }));
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:recovery-branch",
      metadata: expect.objectContaining({ outcome: "deleted" }),
    }));
    expectNoRebaseWorktree(dir);
  });

  it("continues through sequential conflicts from multiple local-only commits", async () => {
    const { dir, originDir } = initRepoWithRemote();
    git(dir, "checkout -q fusion/kb-002");
    writeFileSync(join(dir, "shared.txt"), "task final\n");
    git(dir, "add -A");
    git(dir, "commit -q -m 'feat: task final'");
    git(dir, "checkout -q main");
    git(dir, "cherry-pick fusion/kb-002~1 fusion/kb-002");
    advanceOriginConflicting(originDir);
    const { store } = makeStore();
    const auditGit = vi.fn(async () => undefined);
    installStagingResolver({ resolutions: ["remote side\ntask side\n", "remote side\ntask final\n"] });

    const result = await pushAfterMergeToRemote({
      store,
      projectRootDir: dir,
      taskId: "KB-002",
      settings: { pushAfterMerge: true } as never,
      integrationBranch: "main",
      audit: { git: auditGit } as never,
      log: vi.fn(async () => undefined),
    });

    expect(result.pushed).toBe(true);
    expect(createResolvedAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(git(originDir, "rev-parse main")).toBe(git(dir, "rev-parse main"));
    expect(git(dir, "show main:shared.txt")).toBe("remote side\ntask final");
    expectNoRebaseWorktree(dir);
  });

  it("surfaces an unresolvable conflict and retains its recovery branch", async () => {
    const { dir, originDir } = initRepoWithRemote();
    advanceOriginConflicting(originDir);
    const { store, storeMocks, task, logs } = makeStore();
    installUnresolvedResolver();

    const result = await runAiMerge(store, dir, "KB-002", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/kb-002"),
      reviewAgent: approveReviewer(),
    });

    expect(task.column).toBe("done");
    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toContain("Unresolved rebase conflicts remain");
    expect(logs.some((entry) => entry.action === "PushToRemoteFailed")).toBe(true);
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:origin",
      metadata: expect.objectContaining({ outcome: "failed" }),
    }));
    expect(git(originDir, "rev-parse refs/heads/fusion/kb-002-stranded")).toBe(git(dir, "rev-parse main"));
    expectNoRebaseWorktree(dir);
  });

  it("surfaces an abort after the resolver stages conflicts", async () => {
    const { dir, originDir } = initRepoWithRemote();
    advanceOriginConflicting(originDir);
    git(originDir, "update-ref refs/heads/fusion/kb-002-stranded refs/heads/main");
    const priorRecoverySha = git(originDir, "rev-parse refs/heads/fusion/kb-002-stranded");
    const { store, storeMocks, task, logs } = makeStore();
    const abortController = new AbortController();
    installStagingResolver({ abortController });

    const result = await runAiMerge(store, dir, "KB-002", { manual: true, signal: abortController.signal }, {
      mergeAgent: realMergeAgent("fusion/kb-002"),
      reviewAgent: approveReviewer(),
    });

    expect(task.column).toBe("done");
    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toContain("aborted by shutdown signal");
    expect(logs.some((entry) => entry.action === "PushToRemoteFailed")).toBe(true);
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:origin",
      metadata: expect.objectContaining({ outcome: "aborted" }),
    }));
    expect(git(originDir, "rev-parse refs/heads/fusion/kb-002-stranded")).not.toBe(priorRecoverySha);
    expect(git(originDir, "rev-parse refs/heads/fusion/kb-002-stranded")).toBe(git(dir, "rev-parse main"));
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:recovery-branch",
      metadata: expect.objectContaining({ outcome: "success", recoveryBranch: "fusion/kb-002-stranded" }),
    }));
    expectNoRebaseWorktree(dir);
  });
});
