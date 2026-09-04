import { describe, expect, it } from "vitest";
import { resolveGraphNodeSessionBoundary } from "../executor/run-graph-custom-node.js";

/*
FNXC:WorkspaceBoundary 2026-08-24-06:30:
Measured failure this guards, on a multi-repo project:

  Workflow node 'documentation-delivery-step' requires a task worktree — acquiring worktree
  [pre-merge] Workflow step failed: Documentation & Delivery
  Documentation & Delivery failed before producing a verdict:
    Refusing to start coding agent in incomplete worktree:
    .../multi-repo/.fusion/worktrees/mult-012
  Auto-recovered: session start refused unusable worktree — requeued to todo (attempt 1/3)

`mult-012` is the task DIRECTORY: a container whose per-repository worktrees (`mult-012/repo1`) hold
the Git metadata. The generic graph prompt path declared no session boundary, so the single-repo
assertion resolved that container as a worktree and refused. FN-158 gave Code Review the
`workspace-task-dir` boundary but not this path, so every OTHER write-capable gate stayed broken on
workspace projects — it simply went unnoticed because builtin:review-gated-coding died earlier on
the review seal.
*/
describe("graph node workspace session boundary", () => {
  const base = {
    isWorkspace: true,
    writeCapable: true,
    legacyWorkspaceLayout: false,
    rootDir: "/ws",
    worktreePath: "/ws/.fusion/worktrees/mult-012",
    confirmedRepositories: ["repo1", "repo2"] as const,
  };

  it("declares a workspace-task-dir boundary validating the per-repository children", () => {
    expect(resolveGraphNodeSessionBoundary(base)).toEqual({
      kind: "workspace-task-dir",
      writableRoot: "/ws/.fusion/worktrees/mult-012",
      projectRoot: "/ws",
      repoRoots: [
        { repoRelPath: "repo1", repoRootDir: "/ws/repo1" },
        { repoRelPath: "repo2", repoRootDir: "/ws/repo2" },
      ],
    });
  });

  it("leaves single-repository tasks on their existing implicit boundary", () => {
    expect(resolveGraphNodeSessionBoundary({ ...base, isWorkspace: false })).toBeUndefined();
  });

  it("binds read-only reporting nodes to the task directory and its acquired children", () => {
    expect(resolveGraphNodeSessionBoundary({ ...base, writeCapable: false })).toEqual({
      kind: "workspace-task-dir",
      writableRoot: "/ws/.fusion/worktrees/mult-012",
      projectRoot: "/ws",
      repoRoots: [
        { repoRelPath: "repo1", repoRootDir: "/ws/repo1" },
        { repoRelPath: "repo2", repoRootDir: "/ws/repo2" },
      ],
    });
  });

  it("keeps the legacy per-repo layout on its child-worktree boundary", () => {
    expect(resolveGraphNodeSessionBoundary({ ...base, legacyWorkspaceLayout: true })).toBeUndefined();
  });

  it("keeps Plan Review on its deliberate shared-root boundary", () => {
    expect(resolveGraphNodeSessionBoundary({ ...base, writeCapable: false, isPlanReview: true })).toBeUndefined();
  });

  /*
  A `workspace-task-dir` descriptor with zero repoRoots is itself refused by the session guard
  ("Refusing workspace-task-dir session without declared repository roots"), so an unconfirmed scope
  must fall back rather than trade one refusal for another.
  */
  it("falls back when the repository scope is not confirmed", () => {
    expect(resolveGraphNodeSessionBoundary({ ...base, confirmedRepositories: undefined })).toBeUndefined();
    expect(resolveGraphNodeSessionBoundary({ ...base, confirmedRepositories: [] })).toBeUndefined();
  });
});
