import type { MergeContentDescriptor, Task } from "@fusion/core";
import { describeMergeContentShape } from "@fusion/core";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";
import { probeReviewDiffFingerprint } from "../worktree/review-diff-fingerprint.js";
import { captureWorkspaceReviewEvidence } from "../worktree/workspace-review-evidence.js";

export type MergeContentCaptureDeps = {
  workspaceRootDir: string;
  settings: Record<string, unknown>;
};

/*
FNXC:MergeContentDescriptor 2026-08-23-07:14:
FN-180 requires every merge-start door to use content proof in the task's own
shape. This asynchronous capture stays outside synchronous queue ticks: Git
failure becomes an unavailable descriptor and the positive approval gate defers.
*/
export async function captureMergeContentDescriptor(
  task: Task,
  deps: MergeContentCaptureDeps,
): Promise<MergeContentDescriptor> {
  if (describeMergeContentShape(task) === "workspace") {
    try {
      const evidence = await captureWorkspaceReviewEvidence({
        task,
        workspaceRootDir: deps.workspaceRootDir,
        settings: deps.settings,
      });
      return {
        kind: "workspace",
        repositories: {
          state: "captured",
          fingerprints: Object.fromEntries(evidence.repositories
            .filter((repository) => repository.fingerprint)
            .map((repository) => [repository.repository, repository.fingerprint!])),
          inScopeModified: [...evidence.modifiedRepositories].sort(),
        },
      };
    } catch {
      return { kind: "workspace", repositories: { state: "unavailable", reason: "workspace-evidence-capture-failed" } };
    }
  }

  const baseRef = task.worktree
    ? await resolveDiffBaseRef(task.worktree, task.baseCommitSha)
    : undefined;
  const probe = await probeReviewDiffFingerprint(task.worktree, baseRef);
  return { kind: "singular", diff: probe };
}
