import type { Task } from "@fusion/core";
import { describe, expect, it } from "vitest";

import {
  deleteTaskResetBranches,
  planTaskResetBranchCleanup,
  type TaskResetBranchCleanupInput,
} from "../worktree/reset-branch-cleanup.js";

const repoA = "/workspace/a";
const repoB = "/workspace/b";

type Harness = {
  input: TaskResetBranchCleanupInput;
  calls: string[];
  refs: Map<string, Set<string>>;
};

function task(overrides: Partial<Task> = {}): Pick<Task, "id" | "branch" | "branchContext"> {
  return { id: "FN-232", branch: "fusion/fn-232", ...overrides } as Task;
}

function harness(options: {
  task?: Pick<Task, "id" | "branch" | "branchContext">;
  refs?: Record<string, string[]>;
  recorded?: Record<string, string[]>;
  registered?: Record<string, Array<{ branch: string; worktreePath: string }>>;
  ownedWorktreePaths?: string[];
  deleteFails?: string[];
  deleteLeavesPresent?: string[];
  verificationFails?: string[];
} = {}): Harness {
  const refs = new Map(Object.entries(options.refs ?? { [repoA]: ["fusion/fn-232"] }).map(([repo, branches]) => [repo, new Set(branches)]));
  const calls: string[] = [];
  const deleteFails = new Set(options.deleteFails ?? []);
  const deleteLeavesPresent = new Set(options.deleteLeavesPresent ?? []);
  const verificationFails = new Set(options.verificationFails ?? []);
  const probeCounts = new Map<string, number>();
  const recorded = options.recorded ?? Object.fromEntries([...refs].map(([repo]) => [repo, ["fusion/fn-232"]]));
  const input: TaskResetBranchCleanupInput = {
    task: options.task ?? task(),
    targets: Object.entries(recorded).map(([repoRootDir, recordedBranches]) => ({ repoRootDir, recordedBranches })),
    ownedWorktreePaths: options.ownedWorktreePaths,
    getRegisteredBranches: async (repo) => options.registered?.[repo] ?? [],
    runGit: async (command, runOptions) => {
      calls.push(`${runOptions.cwd}:${command}`);
      const repoRefs = refs.get(runOptions.cwd) ?? new Set<string>();
      if (command.startsWith("git for-each-ref")) {
        return { stdout: [...repoRefs].filter((branch) => branch === "fusion/fn-232" || branch.startsWith("fusion/fn-232-")).join("\n") };
      }
      const branch = command.match(/refs\/heads\/([^']+)'?$/u)?.[1]
        ?? command.match(/git branch -D '([^']+)'/u)?.[1];
      if (!branch) throw new Error(`Unexpected git command: ${command}`);
      if (command.startsWith("git rev-parse")) {
        const probeKey = `${runOptions.cwd}:${branch}`;
        const probeCount = (probeCounts.get(probeKey) ?? 0) + 1;
        probeCounts.set(probeKey, probeCount);
        if (probeCount > 1 && (verificationFails.has(probeKey) || verificationFails.has(branch))) {
          throw Object.assign(new Error(`permission denied while verifying ${branch}`), { code: 128 });
        }
        if (!repoRefs.has(branch)) throw Object.assign(new Error(`missing ${branch}`), { code: 1 });
        return { stdout: `${branch}\n` };
      }
      if (deleteFails.has(`${runOptions.cwd}:${branch}`) || deleteFails.has(branch)) throw new Error(`cannot delete ${branch}`);
      if (!deleteLeavesPresent.has(`${runOptions.cwd}:${branch}`) && !deleteLeavesPresent.has(branch)) repoRefs.delete(branch);
      return { stdout: `Deleted branch ${branch}\n` };
    },
  };
  return { input, calls, refs };
}

describe("task reset branch cleanup", () => {
  it("deletes a recorded branch", async () => {
    const state = harness();
    expect(await deleteTaskResetBranches(state.input)).toEqual({
      deleted: [{ repoRootDir: repoA, branch: "fusion/fn-232" }], retained: [], blocked: [],
    });
    expect(state.refs.get(repoA)).not.toContain("fusion/fn-232");
  });

  it("enumerates the canonical namespace when no branch is recorded", async () => {
    const state = harness({ recorded: { [repoA]: [] } });
    expect((await deleteTaskResetBranches(state.input)).deleted).toEqual([{ repoRootDir: repoA, branch: "fusion/fn-232" }]);
  });

  it("deletes foreach step branches alongside the working branch", async () => {
    const state = harness({ refs: { [repoA]: ["fusion/fn-232", "fusion/fn-232-step-0", "fusion/fn-232-step-1"] } });
    expect((await deleteTaskResetBranches(state.input)).deleted.map(({ branch }) => branch)).toEqual([
      "fusion/fn-232", "fusion/fn-232-step-0", "fusion/fn-232-step-1",
    ]);
  });

  it("deletes a branch once when recorded and enumerated", async () => {
    const state = harness();
    await deleteTaskResetBranches(state.input);
    expect(state.calls.filter((call) => call.includes("git branch -D 'fusion/fn-232'"))).toHaveLength(1);
  });

  it("treats an absent branch as a no-op", async () => {
    const state = harness({ refs: { [repoA]: [] }, recorded: { [repoA]: ["fusion/fn-232"] } });
    expect(await deleteTaskResetBranches(state.input)).toEqual({ deleted: [], retained: [], blocked: [] });
  });

  it("retains an operator-supplied branch without blocking", async () => {
    const branch = "fusion/fn-232";
    const state = harness({ task: task({ branchContext: { branchOverride: { by: "operator", at: "2026-08-28T00:00:00.000Z", branch } } }) });
    expect(await deleteTaskResetBranches(state.input)).toEqual({
      deleted: [], retained: [{ repoRootDir: repoA, branch, reason: "operator-supplied" }], blocked: [],
    });
  });

  it("retains a shared merge target while deleting the member branch", async () => {
    const mergeTarget = "fusion/fn-232-group";
    const state = harness({
      task: task({ branchContext: { assignmentMode: "shared", mergeTargetBranch: mergeTarget } }),
      refs: { [repoA]: ["fusion/fn-232", mergeTarget] },
      recorded: { [repoA]: ["fusion/fn-232", mergeTarget] },
    });
    expect(await deleteTaskResetBranches(state.input)).toEqual({
      deleted: [{ repoRootDir: repoA, branch: "fusion/fn-232" }],
      retained: [{ repoRootDir: repoA, branch: mergeTarget, reason: "merge-target" }],
      blocked: [],
    });
  });

  it("blocks a task branch held by a foreign registered worktree", async () => {
    const holderWorktreePath = "/foreign/holder";
    const state = harness({ registered: { [repoA]: [{ branch: "fusion/fn-232", worktreePath: holderWorktreePath }] } });
    expect(await deleteTaskResetBranches(state.input)).toEqual({
      deleted: [], retained: [], blocked: [{ repoRootDir: repoA, branch: "fusion/fn-232", reason: "checked-out", holderWorktreePath }],
    });
  });

  it("classifies a registered Reset target as deletable instead of checked out", async () => {
    const owned = "/workspace/.worktrees/fn-232";
    const registered = { [repoA]: [{ branch: "fusion/fn-232", worktreePath: owned }] };
    const ownedState = harness({ registered, ownedWorktreePaths: [owned] });
    expect((await planTaskResetBranchCleanup(ownedState.input)).blocked).toEqual([]);
    expect((await deleteTaskResetBranches(ownedState.input)).deleted).toHaveLength(1);

    const foreignState = harness({ registered });
    expect((await planTaskResetBranchCleanup(foreignState.input)).blocked).toEqual([
      { repoRootDir: repoA, branch: "fusion/fn-232", reason: "checked-out", holderWorktreePath: owned },
    ]);
  });

  it("blocks when the primary checkout holds the branch", async () => {
    const state = harness({ registered: { [repoA]: [{ branch: "fusion/fn-232", worktreePath: repoA }] } });
    expect((await planTaskResetBranchCleanup(state.input)).blocked).toEqual([
      { repoRootDir: repoA, branch: "fusion/fn-232", reason: "checked-out", holderWorktreePath: repoA },
    ]);
  });

  it("records delete-failed when git rejects deletion", async () => {
    const state = harness({ deleteFails: ["fusion/fn-232"] });
    expect((await deleteTaskResetBranches(state.input)).blocked).toEqual([
      expect.objectContaining({ repoRootDir: repoA, branch: "fusion/fn-232", reason: "delete-failed", detail: "cannot delete fusion/fn-232" }),
    ]);
  });

  it("records still-present when a deleted branch continues to resolve", async () => {
    const state = harness({ deleteLeavesPresent: ["fusion/fn-232"] });
    expect((await deleteTaskResetBranches(state.input)).blocked).toEqual([
      expect.objectContaining({ repoRootDir: repoA, branch: "fusion/fn-232", reason: "still-present" }),
    ]);
  });

  it("blocks when post-delete absence verification fails", async () => {
    const state = harness({ verificationFails: ["fusion/fn-232"] });
    expect(await deleteTaskResetBranches(state.input)).toEqual({
      deleted: [],
      retained: [],
      blocked: [{
        repoRootDir: repoA,
        branch: "fusion/fn-232",
        reason: "still-present",
        detail: "Unable to verify branch absence after deletion: permission denied while verifying fusion/fn-232",
      }],
    });
  });

  it("continues to a second repository when the first blocks", async () => {
    const state = harness({
      refs: { [repoA]: ["fusion/fn-232"], [repoB]: ["fusion/fn-232"] },
      registered: { [repoA]: [{ branch: "fusion/fn-232", worktreePath: "/foreign/holder" }] },
    });
    const outcome = await deleteTaskResetBranches(state.input);
    expect(outcome.blocked).toHaveLength(1);
    expect(outcome.deleted).toEqual([{ repoRootDir: repoB, branch: "fusion/fn-232" }]);
  });

  it("plans without invoking branch deletion", async () => {
    const state = harness();
    const outcome = await planTaskResetBranchCleanup(state.input);
    expect(outcome).toEqual({ deleted: [], retained: [], blocked: [] });
    expect(state.calls.some((call) => call.includes("git branch -D"))).toBe(false);
  });
});
