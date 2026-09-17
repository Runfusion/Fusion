import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAiRestoreTask,
  performTaskRevert,
  performTaskRevertRestore,
  resolveTaskRevertRestoreCommits,
  RESTORE_OF_METADATA_KEY,
} from "../execution/task-revert.js";
import type { Task } from "@fusion/core";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-901",
    lineageId: "FN-901",
    description: "",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    ...overrides,
  } as Task;
}

/*
FN-416 cases (l)-(p): real-git coverage for the restore-the-revert service. A reverted card's only
resolution path is this restore, so its guard rails (column, autoMerge, workspace) and its rollback
invariant (HEAD unchanged on conflict) are asserted against a real repository, not a mock.
*/
describeIfGit("task-revert restore real-git scenarios", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoFixture() {
    const repo = mkdtempSync(join(tmpdir(), "fn-416-restore-"));
    dirs.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    git(repo, "git config commit.gpgsign false");
    writeFileSync(join(repo, "foo.ts"), "line1\n");
    git(repo, "git add foo.ts && git commit -m 'init'");
    return repo;
  }

  /** Lands a FN-901 change, then reverts it through the production revert path. */
  async function landedThenReverted(repo: string): Promise<{ landedSha: string; revertSha: string }> {
    writeFileSync(join(repo, "foo.ts"), "line1\nfeature-a\n");
    git(repo, "git add foo.ts && git commit -m 'feat(FN-901): add feature a'");
    const landedSha = git(repo, "git rev-parse HEAD");

    const result = await performTaskRevert({
      task: makeTask({ mergeDetails: { commitSha: landedSha } }),
      worktreePath: repo,
      baseBranch: "main",
    });
    expect("clean" in result && result.clean).toBe(true);
    const revertSha = "revertCommitSha" in result ? String(result.revertCommitSha) : "";
    expect(revertSha).not.toBe("");
    return { landedSha, revertSha };
  }

  it("case (l): a clean restore creates a restore() commit and brings the content back", async () => {
    const repo = repoFixture();
    const { revertSha } = await landedThenReverted(repo);
    expect(readFileSync(join(repo, "foo.ts"), "utf-8")).toBe("line1\n");

    const restored = await performTaskRevertRestore({
      task: makeTask({ sourceMetadata: { revertedAt: "2026-09-01T00:00:00.000Z", revertedCommitSha: revertSha } }),
      worktreePath: repo,
      baseBranch: "main",
    });

    expect(restored).toMatchObject({ mode: "git", clean: true });
    expect("restoreCommitSha" in restored && restored.restoreCommitSha).toBeTruthy();
    expect(readFileSync(join(repo, "foo.ts"), "utf-8")).toBe("line1\nfeature-a\n");
    const subject = git(repo, "git log -1 --format=%s");
    expect(subject.startsWith("restore(FN-901): ")).toBe(true);
    expect(git(repo, "git log -1 --format=%B")).toContain("Fusion-Task-Id: FN-901");
    expect(git(repo, "git status --porcelain")).toBe("");
  });

  it("case (l2): the revert commit is resolvable by history scan when no marker sha is recorded", async () => {
    const repo = repoFixture();
    const { revertSha } = await landedThenReverted(repo);

    const resolved = await resolveTaskRevertRestoreCommits(makeTask({ sourceMetadata: { revertedAt: "x" } }), {
      worktreePath: repo,
    });
    expect(resolved).toMatchObject({ supported: true, source: "scan" });
    if (resolved.supported) expect(resolved.shas).toEqual([revertSha]);
  });

  it("case (l3): an unresolvable revert commit is an explicit unsupported reason", async () => {
    const repo = repoFixture();
    const resolved = await resolveTaskRevertRestoreCommits(makeTask({ sourceMetadata: { revertedAt: "x" } }), {
      worktreePath: repo,
    });
    expect(resolved).toEqual({ supported: false, reason: "no-revert-commit-resolved" });
  });

  it("case (m): an already-restored task reports alreadyRestored without an empty commit", async () => {
    const repo = repoFixture();
    const { revertSha } = await landedThenReverted(repo);
    const task = makeTask({ sourceMetadata: { revertedAt: "2026-09-01T00:00:00.000Z", revertedCommitSha: revertSha } });

    const first = await performTaskRevertRestore({ task, worktreePath: repo, baseBranch: "main" });
    expect("restoreCommitSha" in first).toBe(true);
    const headAfterFirst = git(repo, "git rev-parse HEAD");

    const second = await performTaskRevertRestore({ task, worktreePath: repo, baseBranch: "main" });
    expect(second).toEqual({ mode: "git", clean: true, alreadyRestored: true });
    expect(git(repo, "git rev-parse HEAD")).toBe(headAfterFirst);
  });

  it("case (n): a conflicting restore leaves HEAD and the tree untouched", async () => {
    const repo = repoFixture();
    const { revertSha } = await landedThenReverted(repo);
    // A later task rewrites the same region the restore would touch.
    writeFileSync(join(repo, "foo.ts"), "line1-rewritten-by-a-later-task\n");
    git(repo, "git commit -am 'feat(FN-902): rewrite line1'");
    const headBefore = git(repo, "git rev-parse HEAD");

    const result = await performTaskRevertRestore({
      task: makeTask({ sourceMetadata: { revertedAt: "2026-09-01T00:00:00.000Z", revertedCommitSha: revertSha } }),
      worktreePath: repo,
      baseBranch: "main",
    });

    expect(result).toMatchObject({ mode: "git", clean: false });
    expect("conflicts" in result && (result.conflicts?.length ?? 0) > 0).toBe(true);
    expect(git(repo, "git rev-parse HEAD")).toBe(headBefore);
    expect(git(repo, "git status --porcelain")).toBe("");
  });

  it("case (o): autoMerge disabled refuses with needsHuman and writes no commit", async () => {
    const repo = repoFixture();
    const { revertSha } = await landedThenReverted(repo);
    const headBefore = git(repo, "git rev-parse HEAD");

    const result = await performTaskRevertRestore({
      task: makeTask({ autoMerge: false, sourceMetadata: { revertedAt: "2026-09-01T00:00:00.000Z", revertedCommitSha: revertSha } }),
      worktreePath: repo,
      baseBranch: "main",
      effectiveAutoMerge: false,
    });

    expect(result).toMatchObject({ mode: "git", needsHuman: true });
    expect(git(repo, "git rev-parse HEAD")).toBe(headBefore);
  });

  it("case (o2): a task outside the resolved Complete lanes refuses with needsHuman", async () => {
    const repo = repoFixture();
    const { revertSha } = await landedThenReverted(repo);
    const headBefore = git(repo, "git rev-parse HEAD");

    const result = await performTaskRevertRestore({
      task: makeTask({ column: "shipped", sourceMetadata: { revertedCommitSha: revertSha } }),
      revertableColumns: new Set(["done"]),
      worktreePath: repo,
      baseBranch: "main",
    });

    expect(result).toMatchObject({ mode: "git", needsHuman: true });
    expect(git(repo, "git rev-parse HEAD")).toBe(headBefore);
  });

  it("case (p): a workspace task is unsupported and writes nothing", async () => {
    const repo = repoFixture();
    const { revertSha } = await landedThenReverted(repo);
    const headBefore = git(repo, "git rev-parse HEAD");

    const result = await performTaskRevertRestore({
      task: makeTask({
        sourceMetadata: { revertedCommitSha: revertSha },
        workspaceWorktrees: { "repo-a": { path: "/tmp/a", branch: "fusion/fn-901" } },
      } as Partial<Task>),
      worktreePath: repo,
      baseBranch: "main",
    });

    expect(result).toMatchObject({ mode: "git", unsupported: true });
    expect(git(repo, "git rev-parse HEAD")).toBe(headBefore);
  });
});

/*
FN-416: the AI fallback for a conflicting restore must be a distinct, idempotent board task whose
marker key is `restoreOf` — an open UNDO task must never suppress a restore task.
*/
describe("createAiRestoreTask", () => {
  const sourceTask = {
    id: "FN-901",
    title: "Add feature a",
    description: "desc",
    prompt: "",
    priority: "normal",
    mergeDetails: { commitSha: "abc", landedFiles: ["foo.ts"] },
    sourceMetadata: { revertedAt: "2026-09-01T00:00:00.000Z", revertedCommitSha: "deadbeef" },
  } as unknown as Task;

  it("creates a restore task stamped with restoreOf and a re-apply mission", async () => {
    const createTask = vi.fn().mockResolvedValue({ id: "FN-950" } as Task);
    const result = await createAiRestoreTask({
      createTask,
      findOpenRestoreTaskForSource: vi.fn().mockResolvedValue(null),
      sourceTask,
      workflowId: "builtin:review-heavy",
    });

    expect(result).toEqual({ mode: "ai", createdTaskId: "FN-950" });
    const input = createTask.mock.calls[0]![0] as { description: string; dependencies: string[]; source: { sourceMetadata: Record<string, string> }; workflowId?: string };
    expect(input.source.sourceMetadata[RESTORE_OF_METADATA_KEY]).toBe("FN-901");
    expect(input.dependencies).toEqual([]);
    expect(input.workflowId).toBe("builtin:review-heavy");
    expect(input.description).toContain("RE-APPLIES");
    expect(input.description).toContain("restore(FN-901): <short summary>");
    expect(input.description).toContain("deadbeef");
  });

  it("returns the already-open restore task instead of creating a duplicate", async () => {
    const createTask = vi.fn();
    const result = await createAiRestoreTask({
      createTask,
      findOpenRestoreTaskForSource: vi.fn().mockResolvedValue({ id: "FN-949" } as Task),
      sourceTask,
    });

    expect(result).toEqual({ mode: "ai", createdTaskId: "FN-949", alreadyOpen: true });
    expect(createTask).not.toHaveBeenCalled();
  });
});
