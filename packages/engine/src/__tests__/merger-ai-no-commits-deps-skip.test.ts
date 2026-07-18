/*
FNXC:MergeNoCommits 2026-07-17-12:00:
No-commits tasks (audit, documentation, decision-only) have no code changes to install or build.
The clean-room dependency sync must be skipped entirely to avoid "pnpm: command not found" failures
when pnpm is not resolvable in the engine process environment. We drive the REAL landOneRepo against
a REAL git fixture with injected agents (the squash is a plain `git merge --squash`, no AI), and
MOCK installWorktreeDependencies so we can assert call counts without real/slow/networked npm runs
(FN-5048).
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task, TaskStore } from "@fusion/core";

vi.mock("../merge-dependency-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge-dependency-sync.js")>();
  return { ...actual, installWorktreeDependencies: vi.fn() };
});

import { installWorktreeDependencies } from "../merge-dependency-sync.js";
import { landOneRepo } from "../merger-ai.js";
import { createRunAuditor, generateSyntheticRunId } from "../run-audit.js";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function hasGitInstall(): boolean {
  try {
    execSync("git --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const describeIfGit = hasGitInstall() ? describe : describe.skip;
const TASK_ID = "RUFU-018";
const BRANCH = "fusion/rufu-018";

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

interface RepoFixture {
  rootDir: string;
  mainSha: string;
  cleanup(): void;
}

/** Create a single real git repo with an initial commit on main, then a branch
 *  with one commit. Returns the fixture. */
function createRepoFixture(withChanges: boolean): RepoFixture {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "fusion-no-commits-"));
  execSync("git init -b main", { cwd: rootDir, stdio: "pipe" });
  configureIdentity(rootDir);
  writeFileSync(path.join(rootDir, "README.md"), "# Test\n", "utf-8");
  execSync("git add README.md && git commit -m 'init'", { cwd: rootDir, stdio: "pipe" });

  // Create the task branch
  execSync(`git checkout -b ${BRANCH}`, { cwd: rootDir, stdio: "pipe" });
  if (withChanges) {
    writeFileSync(path.join(rootDir, "feature.txt"), "feature work\n", "utf-8");
    execSync("git add feature.txt && git commit -m 'feat: add feature'", { cwd: rootDir, stdio: "pipe" });
  } else {
    // Commit that adds no code (e.g. a readme-only doc change), so the branch is ahead
    writeFileSync(path.join(rootDir, "README.md"), "# Test\n\nUpdated\n", "utf-8");
    execSync("git add README.md && git commit -m 'docs: update readme'", { cwd: rootDir, stdio: "pipe" });
  }
  const mainSha = execSync("git rev-parse main", { cwd: rootDir, encoding: "utf-8" }).trim();
  execSync("git checkout main", { cwd: rootDir, stdio: "pipe" });

  return {
    rootDir,
    mainSha,
    cleanup: () => { try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createStore(): TaskStore & { logs: string[] } {
  const emitter = new EventEmitter();
  const logs: string[] = [];
  return Object.assign(emitter, {
    logs,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn((_id: string, message: string) => { logs.push(message); return Promise.resolve(undefined); }),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({
      id: TASK_ID, column: "in-review", branch: BRANCH,
      comments: [], steeringComments: [], steps: [], log: [],
    }),
    moveTask: vi.fn().mockResolvedValue({ id: TASK_ID, column: "done" } as Task),
    upsertTaskCommitAssociation: vi.fn().mockResolvedValue(undefined),
    accumulateTokenUsage: vi.fn().mockResolvedValue(undefined),
  }) as unknown as TaskStore & { logs: string[] };
}

// ---------------------------------------------------------------------------
// Injected agents (plain git merge, no AI)
// ---------------------------------------------------------------------------

const squashMergeAgent = async (cwd: string): Promise<void> => {
  configureIdentity(cwd);
  execSync(`git merge --squash ${BRANCH}`, { cwd, stdio: "pipe" });
  const staged = execSync("git diff --cached --name-only", { cwd, encoding: "utf-8" }).trim();
  if (staged.length === 0) return;
  execSync(`git commit -m "${BRANCH}: squashed"`, { cwd, stdio: "pipe" });
};
const approveReviewAgent = async (): Promise<string> => "REVIEW_VERDICT: approve";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfGit("landOneRepo no-commits dep-sync skip", () => {
  let fx: RepoFixture;
  let store: TaskStore & { logs: string[] };
  let audit: ReturnType<typeof createRunAuditor>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    fx?.cleanup();
  });

  it("skips installWorktreeDependencies entirely when noCommitsExpected: true", async () => {
    fx = createRepoFixture(true); // branch has actual changes
    store = createStore();
    audit = createRunAuditor(store, {
      runId: generateSyntheticRunId("ai-merge", TASK_ID),
      agentId: "merger",
      taskId: TASK_ID,
      phase: "merge",
    });

    const result = await landOneRepo(fx.rootDir, BRANCH, "main", {
      taskId: TASK_ID,
      settings: { autoMerge: false } as never,
      audit,
      log: async () => undefined,
      setStatus: async () => undefined,
      maxPasses: 1,
      mergeAgent: squashMergeAgent,
      reviewAgent: approveReviewAgent,
      stashResolveAgent: async () => undefined,
      includeTaskId: true,
      trailers: [],
      store,
      noCommitsExpected: true,
    });

    // Dep sync was never called
    expect(vi.mocked(installWorktreeDependencies)).not.toHaveBeenCalled();
    // The land still succeeds
    expect(result.outcome).toBe("landed");
  });

  it("still calls installWorktreeDependencies when noCommitsExpected is false", async () => {
    fx = createRepoFixture(true); // branch has actual changes
    store = createStore();
    audit = createRunAuditor(store, {
      runId: generateSyntheticRunId("ai-merge", TASK_ID),
      agentId: "merger",
      taskId: TASK_ID,
      phase: "merge",
    });

    const result = await landOneRepo(fx.rootDir, BRANCH, "main", {
      taskId: TASK_ID,
      settings: { autoMerge: false } as never,
      audit,
      log: async () => undefined,
      setStatus: async () => undefined,
      maxPasses: 1,
      mergeAgent: squashMergeAgent,
      reviewAgent: approveReviewAgent,
      stashResolveAgent: async () => undefined,
      includeTaskId: true,
      trailers: [],
      store,
      // noCommitsExpected intentionally omitted (defaults to undefined → false)
    });

    // Dep sync WAS called
    expect(vi.mocked(installWorktreeDependencies)).toHaveBeenCalled();
    // The land still succeeds
    expect(result.outcome).toBe("landed");
  });

  it("still calls installWorktreeDependencies when noCommitsExpected is explicitly false", async () => {
    fx = createRepoFixture(true); // branch has actual changes
    store = createStore();
    audit = createRunAuditor(store, {
      runId: generateSyntheticRunId("ai-merge", TASK_ID),
      agentId: "merger",
      taskId: TASK_ID,
      phase: "merge",
    });

    const result = await landOneRepo(fx.rootDir, BRANCH, "main", {
      taskId: TASK_ID,
      settings: { autoMerge: false } as never,
      audit,
      log: async () => undefined,
      setStatus: async () => undefined,
      maxPasses: 1,
      mergeAgent: squashMergeAgent,
      reviewAgent: approveReviewAgent,
      stashResolveAgent: async () => undefined,
      includeTaskId: true,
      trailers: [],
      store,
      noCommitsExpected: false,
    });

    // Dep sync WAS called
    expect(vi.mocked(installWorktreeDependencies)).toHaveBeenCalled();
    expect(result.outcome).toBe("landed");
  });

  it("lands successfully with noCommitsExpected: true and actual changes", async () => {
    fx = createRepoFixture(true); // branch has actual file changes
    store = createStore();
    audit = createRunAuditor(store, {
      runId: generateSyntheticRunId("ai-merge", TASK_ID),
      agentId: "merger",
      taskId: TASK_ID,
      phase: "merge",
    });

    const result = await landOneRepo(fx.rootDir, BRANCH, "main", {
      taskId: TASK_ID,
      settings: { autoMerge: false } as never,
      audit,
      log: async () => undefined,
      setStatus: async () => undefined,
      maxPasses: 1,
      mergeAgent: squashMergeAgent,
      reviewAgent: approveReviewAgent,
      stashResolveAgent: async () => undefined,
      includeTaskId: true,
      trailers: [],
      store,
      noCommitsExpected: true,
    });

    expect(result.outcome).toBe("landed");
    expect(vi.mocked(installWorktreeDependencies)).not.toHaveBeenCalled();
  });
});
