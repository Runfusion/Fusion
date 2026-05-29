import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  runAiMerge,
  landSquash,
  parseReviewVerdict,
  buildMergeSystemPrompt,
  buildReviewSystemPrompt,
  REVIEW_VERDICT_MARKER,
  AiMergeBlockedError,
} from "../merger-ai.js";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const tracked = new Set<string>();
afterAll(() => {
  for (const d of tracked) {
    try { rmSync(d, RM); } catch { /* best effort */ }
  }
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
}

/** A repo on `main` with one base commit + a task branch carrying one change. */
function initRepoWithBranch(opts: { branch: string; conflict?: boolean } = { branch: "fusion/fn-1" }): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fusion-ai-merge-test-"));
  tracked.add(dir);
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name t");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A");
  git(dir, "commit -q -m base");

  git(dir, `checkout -q -b ${opts.branch}`);
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  if (opts.conflict) writeFileSync(join(dir, "base.txt"), "base\nbranch-change\n");
  git(dir, "add -A");
  git(dir, "commit -q -m 'feat: work'");

  git(dir, "checkout -q main");
  if (opts.conflict) {
    writeFileSync(join(dir, "base.txt"), "base\nmain-change\n");
    git(dir, "add -A");
    git(dir, "commit -q -m 'main: divergent'");
  }
  return { dir };
}

function makeStore(_dir: string, taskOverrides: Record<string, unknown> = {}, settingsOverrides: Record<string, unknown> = {}) {
  const task: any = {
    id: "FN-1",
    column: "in-review",
    status: null,
    branch: "fusion/fn-1",
    worktree: null,
    title: "do the thing",
    steps: [],
    baseBranch: undefined,
    ...taskOverrides,
  };
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const logs: string[] = [];
  const store: any = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 1 }, ...settingsOverrides })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }),
    logEntry: vi.fn(async (_id: string, m: string) => { logs.push(m); }),
    appendAgentLog: vi.fn(async (_id: string, m: string) => { logs.push(m); }),
  };
  return { store, task, emitted, logs };
}

// A merge agent that actually performs the squash merge with git.
function realMergeAgent(branch: string) {
  return vi.fn(async (cwd: string) => {
    try {
      execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    } catch {
      // conflict — resolve by taking the branch side, then continue
      execSync("git checkout --theirs . || true", { cwd, stdio: "pipe", shell: "/bin/bash" } as any);
      execSync("git add -A", { cwd, stdio: "pipe" });
    }
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

describe("parseReviewVerdict", () => {
  it("approves cleanly", () => {
    expect(parseReviewVerdict("ok\nREVIEW_VERDICT: approve")).toEqual({ verdict: "approve", reasons: [] });
  });
  it("rejects with blocking severity by default", () => {
    expect(parseReviewVerdict("REVIEW_VERDICT: reject\n- dropped a hunk")).toEqual({
      verdict: "reject", severity: "blocking", reasons: ["dropped a hunk"],
    });
  });
  it("parses advisory severity and drops the SEVERITY line from reasons", () => {
    expect(parseReviewVerdict("REVIEW_VERDICT: reject\nSEVERITY: advisory\n- nit")).toEqual({
      verdict: "reject", severity: "advisory", reasons: ["nit"],
    });
  });
  it("fails safe to blocking on empty/garbled output", () => {
    expect(parseReviewVerdict("").severity).toBe("blocking");
    expect(parseReviewVerdict("looks fine ship it").verdict).toBe("reject");
  });
  it("system prompts mention read-only review + the verdict marker", () => {
    expect(buildReviewSystemPrompt()).toContain(REVIEW_VERDICT_MARKER);
    expect(buildReviewSystemPrompt().toLowerCase()).toContain("read-only");
    expect(buildMergeSystemPrompt().toLowerCase()).toContain("conflict");
  });

  it("merge system prompt enforces new-breakage verification + uses the editable merger prompt", () => {
    expect(buildMergeSystemPrompt().toLowerCase()).toContain("type-check");
    expect(buildMergeSystemPrompt()).toMatch(/new failure/i);
    // A custom 'merger' role prompt is incorporated as the base, while the hard
    // rules (verification + trailers) are still appended.
    const cfg = {
      templates: [{ id: "custom-merger", role: "merger", name: "Custom", prompt: "CUSTOM MERGER PERSONA" }],
      roleAssignments: { merger: "custom-merger" },
    } as any;
    const p = buildMergeSystemPrompt(cfg);
    expect(p).toContain("CUSTOM MERGER PERSONA");
    expect(p).toContain("Verify before committing");
  });
});

describe("runAiMerge", () => {
  it("merges a clean branch, advances main, and finalizes the task", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store, emitted } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBeTruthy();
    const mainAfter = git(dir, "rev-parse main");
    expect(mainAfter).not.toBe(mainBefore);
    // The squash landed the feature file.
    expect(existsSync(join(dir, "feature.txt"))).toBe(true);
    // The landed commit carries the board-association trailer AND its subject
    // starts with the task id, even though the (mock) merge agent committed
    // "squash: feature" without either — ensureCommitTaskMetadata adds both.
    const landedMsg = git(dir, "log -1 --pretty=%B main");
    expect(landedMsg).toContain("Fusion-Task-Id: FN-1");
    expect(git(dir, "log -1 --pretty=%s main")).toMatch(/^FN-1: /);
    // Task moved to done + event emitted.
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done");
    expect(emitted.some((e) => e.event === "task:merged")).toBe(true);
  });

  it("includes the lineage trailer when the task has a lineageId", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, { lineageId: "lin-abc123" });

    await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    const msg = git(dir, "log -1 --pretty=%B main");
    expect(msg).toContain("Fusion-Task-Id: FN-1");
    expect(msg).toContain("lin-abc123"); // canonical lineage trailer
  });

  it("hard-fails (no advance) on a blocking veto past the budget", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: reject\nSEVERITY: blocking\n- dropped a hunk"),
    })).rejects.toBeInstanceOf(AiMergeBlockedError);

    // Integration branch must NOT have advanced.
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });

  it("lands an advisory veto past the budget (no human)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: reject\nSEVERITY: advisory\n- naming nit"),
    });

    expect(result.merged).toBe(true);
    expect(git(dir, "rev-parse main")).not.toBe(mainBefore);
  });

  it("finalizes as a no-op when the branch has no net changes", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    // Make the branch identical to main (no net change) by merging it into main first.
    git(dir, "merge -q fusion/fn-1");
    const { store } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      // Empty merge: --squash reports up-to-date; leave HEAD unchanged.
      mergeAgent: vi.fn(async () => { /* nothing to do */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.noOp).toBe(true);
    expect(result.merged).toBe(false);
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });

  it("fails loudly when an executed, never-merged task has no branch (possible lost work)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    // branch points at a ref that doesn't exist; task was executed (baseCommitSha) and never merged.
    const { store } = makeStore(dir, { branch: "fusion/ghost", baseCommitSha: "0123456789abcdef" });

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(), reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    })).rejects.toThrow(/work appears lost/);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("finalizes as a no-op when an already-merged task's branch is gone (re-process)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, { branch: "fusion/ghost", baseCommitSha: "0123456789abcdef", mergeDetails: { mergeConfirmed: true } });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(), reviewAgent: vi.fn(),
    });
    expect(result.noOp).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done");
  });

  it("finalizes as a no-op when a never-executed task has no branch", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, { branch: "fusion/ghost" }); // no baseCommitSha → never executed

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(), reviewAgent: vi.fn(),
    });
    expect(result.noOp).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done");
  });

  it("throws a clear error when the task's target branch has no local ref", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, { baseBranch: "release/9.9" }); // never created locally

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    })).rejects.toThrow(/no local ref/);
  });

  it("only merges/advances the task's own target branch, leaving a default-branch checkout untouched", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    // Create a separate target branch the task should merge into.
    git(dir, "branch release");
    const releaseBefore = git(dir, "rev-parse release");
    const mainBefore = git(dir, "rev-parse main");
    // Stay checked out on main (NOT the task's target) → local sync must skip.
    const { store } = makeStore(dir, { baseBranch: "release" });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(true);
    // release advanced, main did not.
    expect(git(dir, "rev-parse release")).not.toBe(releaseBefore);
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });
});

describe("landSquash (advance + local-checkout sync)", () => {
  function auditStub() { return { git: vi.fn(async () => {}) } as any; }

  /** Build a squash commit that descends from the current main tip, leaving
   *  main checked out and clean AT the tip. Returns { tipSha, squashSha }. */
  function makeDescendantSquash(dir: string, mutate: () => void): { tipSha: string; squashSha: string } {
    const tipSha = git(dir, "rev-parse main");
    git(dir, "checkout -q -b squash-tmp");
    mutate();
    git(dir, "add -A");
    git(dir, "commit -q -m squash");
    const squashSha = git(dir, "rev-parse HEAD");
    git(dir, "checkout -q main"); // back on target, clean, at tipSha
    return { tipSha, squashSha };
  }

  it("fast-forwards a clean checkout on the target branch (advances ref + worktree)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { tipSha, squashSha } = makeDescendantSquash(dir, () => writeFileSync(join(dir, "landed.txt"), "landed\n"));

    const res = await landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit: auditStub() });
    expect(res).toEqual({ outcome: "advanced", localSync: "ff" });
    expect(git(dir, "rev-parse main")).toBe(squashSha);
    expect(existsSync(join(dir, "landed.txt"))).toBe(true);
  });

  it("advances the ref but does not touch a checkout on a different branch", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const tipSha = git(dir, "rev-parse main");
    git(dir, "checkout -q -b squash-tmp");
    writeFileSync(join(dir, "landed.txt"), "landed\n");
    git(dir, "add -A");
    git(dir, "commit -q -m squash");
    const squashSha = git(dir, "rev-parse HEAD");
    git(dir, "checkout -q -b somewhere-else main"); // NOT the target branch

    const res = await landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit: auditStub() });
    expect(res.outcome).toBe("advanced");
    expect(res.localSync).toBe("skipped-other-branch");
    expect(git(dir, "rev-parse main")).toBe(squashSha); // ref advanced via update-ref
    // The user's checkout (somewhere-else) is untouched.
    expect(git(dir, "rev-parse --abbrev-ref HEAD")).toBe("somewhere-else");
  });

  it("stashes dirty edits, fast-forwards, and restores them", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { tipSha, squashSha } = makeDescendantSquash(dir, () => writeFileSync(join(dir, "landed.txt"), "landed\n"));
    writeFileSync(join(dir, "mydraft.txt"), "local draft\n"); // dirty, non-conflicting

    const res = await landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit: auditStub() });
    expect(res.localSync).toBe("stash-ff-restore");
    expect(existsSync(join(dir, "landed.txt"))).toBe(true);
    expect(readFileSync(join(dir, "mydraft.txt"), "utf-8")).toContain("local draft");
  });

  it("invokes the AI resolver when restoring the stash conflicts, then lands resolved", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { tipSha, squashSha } = makeDescendantSquash(dir, () => writeFileSync(join(dir, "base.txt"), "base\nlanded-upstream\n"));
    writeFileSync(join(dir, "base.txt"), "base\nmy-local-edit\n"); // dirty edit on the same line → restore conflict

    const resolver = vi.fn(async (cwd: string) => {
      writeFileSync(join(cwd, "base.txt"), "base\nmy-local-edit\n");
      execSync("git add -A", { cwd, stdio: "pipe" });
    });

    const res = await landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit: auditStub(), resolveConflicts: resolver });
    expect(resolver).toHaveBeenCalled();
    expect(res.localSync).toBe("stash-ff-airesolved");
    expect(git(dir, "rev-parse main")).toBe(squashSha);
  });
});
