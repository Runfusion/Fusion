import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task, TaskStore } from "@fusion/core";
import { deriveRepoForPath, deriveRepoScopeSubset, UNSCOPED_REPO } from "../worktree/workspace-paths.js";
import { createCommitRangeFilesReader, enforceSquashFileScopeInvariant, FileScopeViolationError } from "./merger-file-scope.js";
import type { RunAuditor } from "../util/run-audit.js";

const execFileAsync = promisify(execFile);

export function resolveRepoDeclaredScopeTransform({ repoRel, repoKeys }: { repoRel: string; repoKeys: readonly string[] }) {
  return {
    transform(scope: string[]): string[] {
      const subset = deriveRepoScopeSubset(scope, repoRel);
      if (subset.length) return subset;
      return scope.some((entry) => deriveRepoForPath(entry, repoKeys) !== UNSCOPED_REPO) ? [] : scope;
    },
    describe(scope: string[]): "repo-subset" | "unprefixed-fallback" | "foreign-repo-only" {
      if (deriveRepoScopeSubset(scope, repoRel).length) return "repo-subset";
      return scope.some((entry) => deriveRepoForPath(entry, repoKeys) !== UNSCOPED_REPO) ? "foreign-repo-only" : "unprefixed-fallback";
    },
  };
}

/*
FNXC:AIMerge 2026-08-16-05:28:
The pre-land diff-volume shrinkage gate (checkDiffVolume + merge:diff-volume-blocked audit)
was removed by operator decision: it blocked approved clean-room squashes whose review had
already accepted the diff, with no override path. File scope is the sole pre-land guard now;
the post-squash audit policy remains the shrinkage backstop.
*/
/** Apply the file-scope pre-land guard to the approved clean-room squash. */
export async function enforceAiMergeSquashGates(params: { store: TaskStore; task: Task; taskId: string; mergeRoot: string; branch: string; tipSha: string; squashSha: string; audit: RunAuditor; log: (message: string) => Promise<void>; repoRel?: string; repoKeys?: readonly string[] }): Promise<void> {
  const resolver = params.repoRel ? resolveRepoDeclaredScopeTransform({ repoRel: params.repoRel, repoKeys: params.repoKeys ?? [] }) : undefined;
  const transform = resolver ? (scope: string[]) => resolver.transform(scope) : undefined;
  try {
    await enforceSquashFileScopeInvariant({
      store: params.store,
      taskId: params.taskId,
      rootDir: params.mergeRoot,
      task: params.task,
      resetLabel: "ai-merge file-scope invariant violation",
      auditor: params.audit,
      stagedFilesReader: createCommitRangeFilesReader(params.tipSha, params.squashSha),
      scopeTransform: transform,
      // FNXC:AIMerge 2026-08-15-05:50:
      // A foreign-only workspace declaration is an invariant violation, not an
      // empty scope: repo-b/`repo-a/feature.txt` must not borrow repo-a's scope.
      forceViolation: resolver ? (scope) => resolver.describe(scope) === "foreign-repo-only" : undefined,
    });
  } catch (error) {
    if (!(error instanceof FileScopeViolationError)) throw error;
    /*
    FNXC:AIMergeRecovery 2026-08-15-06:37:
    A rejected approved squash must reset its clean room to the integration tip.
    Preexisting-clean-room recovery discovers candidates by HEAD, so leaving the
    rejected commit in place would make each retry select and reject it again.
    */
    await execFileAsync("git", ["reset", "--hard", params.tipSha], { cwd: params.mergeRoot });
    await execFileAsync("git", ["clean", "-fd"], { cwd: params.mergeRoot });
    throw error;
  }
}
