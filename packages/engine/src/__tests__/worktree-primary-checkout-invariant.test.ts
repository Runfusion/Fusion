import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function canonicalPath(path: string): string {
  return normalize(realpathSync(path));
}

function registeredWorktrees(rootDir: string): Array<{ path: string; branch?: string }> {
  return git(rootDir, ["worktree", "list", "--porcelain"])
    .split(/\r?\n(?=worktree )/)
    .filter(Boolean)
    .map((record) => {
      const fields = new Map(record.split("\n").map((line) => {
        const separator = line.indexOf(" ");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      return { path: canonicalPath(fields.get("worktree")!), branch: fields.get("branch") };
    });
}

function createExecutor(rootDir: string): TaskExecutor {
  const store = {
    on: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      commitMsgHookEnabled: false,
      worktreeRebaseBeforeMerge: false,
    }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  };
  return new TaskExecutor(store as any, rootDir);
}

const executorSource = readFileSync(fileURLToPath(new URL("../executor.ts", import.meta.url)), "utf8");
const acquisitionSource = readFileSync(fileURLToPath(new URL("../worktree-acquisition.ts", import.meta.url)), "utf8");
const mergerSource = readFileSync(fileURLToPath(new URL("../merger.ts", import.meta.url)), "utf8");

function sourceRegion(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source-scan start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source-scan end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("TaskExecutor primary-checkout worktree invariant", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
  });

  it("creates and reuses task branches in distinct worktrees while primary main remains unchanged", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-worktree-invariant-"));
    tempRoots.push(rootDir);
    git(rootDir, ["init", "--initial-branch=main"]);
    git(rootDir, ["config", "user.name", "Fusion Test"]);
    git(rootDir, ["config", "user.email", "fusion-test@example.test"]);
    await writeFile(join(rootDir, "README.md"), "fixture\n");
    git(rootDir, ["add", "README.md"]);
    git(rootDir, ["commit", "-m", "initial commit"]);

    const executor = createExecutor(rootDir);
    const createWorktree = (executor as any).createWorktree.bind(executor) as (
      branch: string,
      path: string,
      taskId: string,
      startPoint?: string,
    ) => Promise<{ path: string; branch: string }>;

    const cases = [
      { name: "fresh", branch: "fusion/fn-8370-fresh", setup: async (_path: string) => {} },
      { name: "unregistered", branch: "fusion/fn-8370-unregistered", setup: async (path: string) => mkdir(path) },
      { name: "registered-reuse", branch: "fusion/fn-8370-reuse", setup: async (_path: string) => {} },
    ];

    for (const { name, branch, setup } of cases) {
      const worktreePath = join(rootDir, ".worktrees", name);
      await setup(worktreePath);
      const created = await createWorktree(branch, worktreePath, `FN-8370-${name}`, "main");

      expect(canonicalPath(created.path)).toBe(canonicalPath(worktreePath));
      expect(created.branch).toBe(branch);
      expect(git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

      const registration = registeredWorktrees(rootDir).find(({ path }) => path === canonicalPath(worktreePath));
      expect(registration).toEqual({ path: canonicalPath(worktreePath), branch: `refs/heads/${branch}` });
      expect(canonicalPath(worktreePath)).not.toBe(canonicalPath(rootDir));

      if (name === "registered-reuse") {
        const reused = await createWorktree(branch, worktreePath, "FN-8370-reuse", "main");
        expect(canonicalPath(reused.path)).toBe(canonicalPath(worktreePath));
        expect(git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
        expect(registeredWorktrees(rootDir).filter(({ path }) => path === canonicalPath(worktreePath))).toHaveLength(1);
      }
    }
  });

  it("guards every task-worktree creation or acquisition surface against primary-checkout branch switches", () => {
    /*
    FNXC:Worktrees 2026-07-19-15:47:
    This source guard complements the real-git test above. It must fail if a task-worktree creation or
    acquisition surface reintroduces `git checkout`/`git switch` against the project root to select a
    task branch. Merger's later integration-target checkout is deliberately outside the reacquire slice.
    */
    const executorCreation = sourceRegion(executorSource, "private async createWorktree(", "private async cleanupConflictingWorktree(");
    const acquisition = sourceRegion(acquisitionSource, "const createWorktreeImpl = createWorktree", "const logConfiguredCopyFileResults");
    const mergerReacquire = sourceRegion(mergerSource, "const reacquireReuseIntegrationWorktree = async", "// 3b. Ensure rootDir is based on the resolved integration target before merging.");

    expect(executorCreation).toContain("git worktree add");
    expect(acquisition).toContain("backend.create(");
    expect(mergerReacquire).toContain("git worktree add -f");

    const rootCheckoutSwitch = /execAsync\(\s*`git\s+(?:checkout|switch)(?:\s+(?:-b|-c))?\b/;
    for (const [surface, source] of [
      ["TaskExecutor.createWorktree", executorCreation],
      ["acquireTaskWorktree createWorktreeImpl", acquisition],
      ["merger reacquire callback", mergerReacquire],
    ] as const) {
      expect(source, `${surface} must not select a task branch in the primary checkout`).not.toMatch(rootCheckoutSwitch);
    }
  });
});
