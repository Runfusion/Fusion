/*
FNXC:WorkspaceReviewScope 2026-08-26-09:12:
A workspace Code Review runs the review step ONCE PER SUB-REPOSITORY, against that repository's own
worktree. The scope block it shows the reviewer was captured with the SINGULAR `task.baseCommitSha`,
which does not resolve inside a sub-repository, so the capture returned nothing and the prompt said
"(no modified files detected for this task)".

Measured on a real multi-repo card whose executor had COMMITTED in both repositories: the reviewer
went looking, could not see the committed fixtures inside its own scope, and reported them as never
delivered. A confident, factual rejection produced entirely by a wrong diff base — and one that then
vanished, because prose with no verdict JSON is classified malformed and passes a blocking gate.

This pins the base each reviewer receives. The per-repo value was already recorded and already used
by the evidence capture in `workspace-review-per-repo.ts`; it simply never reached the reviewer.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";

import { reviewWorkspacePerRepo } from "../executor/workspace-review-per-repo.js";

function workspaceTask(): Task {
  return {
    id: "FN-WS-1",
    column: "in-review",
    repositoryScope: { state: "confirmed", revision: 3, repositories: ["repo1", "repo2"] },
    workspaceWorktrees: {
      repo1: { worktreePath: "/tmp/ws/repo1", baseCommitSha: "aaaaaaa1" },
      repo2: { worktreePath: "/tmp/ws/repo2", baseCommitSha: "bbbbbbb2" },
    },
  } as unknown as Task;
}

describe("workspace Code Review diff base", () => {
  it("gives each repository reviewer the base of the repository it is reading", async () => {
    const task = workspaceTask();
    const reviewedWith: Array<{ cwd: string; base: string | undefined }> = [];

    /*
    Stand in for the per-repo callback in run-graph-custom-node: it resolves the repository from the
    worktree path it is handed and forwards that repository's own recorded base.
    */
    const invokeForCwd = async (cwd: string) => {
      const repoRel = Object.keys(task.workspaceWorktrees ?? {})
        .find((repo) => task.workspaceWorktrees?.[repo]?.worktreePath === cwd);
      reviewedWith.push({
        cwd,
        base: repoRel ? task.workspaceWorktrees?.[repoRel]?.baseCommitSha ?? undefined : undefined,
      });
      return { verdict: "APPROVE" as const, review: "ok", summary: "ok", retryable: false };
    };

    await reviewWorkspacePerRepo(task, invokeForCwd, {
      workspaceRepos: ["repo1", "repo2"],
      workspaceRootDir: "/tmp/ws",
      // Both repositories have committed work, which is what made the singular base fail.
      captureModifiedFiles: async (repoRel) => [`${repoRel}-fixture.txt`],
    });

    expect(reviewedWith).toEqual([
      { cwd: "/tmp/ws/repo1", base: "aaaaaaa1" },
      { cwd: "/tmp/ws/repo2", base: "bbbbbbb2" },
    ]);
    // The singular task base is NOT what any reviewer sees.
    expect(reviewedWith.every((entry) => entry.base !== (task as { baseCommitSha?: string }).baseCommitSha)).toBe(true);
  });

  /*
  Structural guard on the production wiring. `executeWorkflowStep` takes ~10 collaborators, so driving
  it here would assert a harness rather than the product; what must not regress is the THREADING — the
  per-repo base is resolved at the workspace call site and preferred over the singular task base by
  the capture that builds the reviewer's scope block. Both halves are required: either one alone
  restores the defect silently.
  */
  it("threads the per-repository base from the workspace call site into the scope capture", async () => {
    const { readFile } = await import("node:fs/promises");

    const callSite = await readFile(new URL("../executor/run-graph-custom-node.ts", import.meta.url), "utf8");
    expect(callSite, "the workspace reviewer must resolve its repository's own base")
      .toContain("live.workspaceWorktrees?.[repoRelPath]?.baseCommitSha");
    expect(callSite).toContain("diffBaseCommitSha");

    const step = await readFile(new URL("../executor/execute-workflow-step.ts", import.meta.url), "utf8");
    expect(step, "the override must win over the singular task base")
      .toContain("stepOptions?.diffBaseCommitSha ?? task.baseCommitSha");
    // The scope capture and the review fingerprint must both read the resolved base, not the raw task field.
    expect(step).not.toContain("captureModifiedFiles(worktreePath, task.baseCommitSha");
    expect(step).not.toContain("resolveDiffBaseRef(worktreePath, task.baseCommitSha)");
  });
});
