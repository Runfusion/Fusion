import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task, TaskStore } from "@fusion/core";
import { resolveRepoDeclaredScope } from "../worktree/workspace-paths.js";
import { createCommitRangeFilesReader, enforceSquashFileScopeInvariant, FileScopeViolationError } from "./merger-file-scope.js";
import type { RunAuditor } from "../util/run-audit.js";

const execFileAsync = promisify(execFile);

export function resolveRepoDeclaredScopeTransform({ repoRel, repoKeys }: { repoRel: string; repoKeys: readonly string[] }) {
  return {
    transform(scope: string[]): string[] {
      return resolveRepoDeclaredScope(scope, repoRel, repoKeys).scope;
    },
    describe(scope: string[]): "repo-subset" | "unprefixed-fallback" | "foreign-repo-only" {
      return resolveRepoDeclaredScope(scope, repoRel, repoKeys).source;
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
    /*
    FNXC:AIMergeReviewReconciliation 2026-08-23-22:05:
    Resetting the clean room is no longer enough to stop a retry re-selecting the rejected squash.
    FN-090 made `aiMergeReviewReconciliation` a SECOND selector: `mergeAndReview` skips its merge
    agent entirely while the record still carries a `candidateSha`, and pre-existing clean-room
    recovery admits that same twice-confirmed candidate. A file-scope violation is a verdict on the
    candidate itself, so the durable record must be dropped with the commit — otherwise every retry
    re-enters the gate on a squash the invariant already rejected and never re-merges.
    Best effort: the violation is the caller's answer and must not be masked by a store failure.
    */
    try {
      await params.store.updateTask(params.taskId, { aiMergeReviewReconciliation: null });
    } catch {
      // The clean-room reset already removed the HEAD-based selector; report the violation.
    }
    throw error;
  }
}
