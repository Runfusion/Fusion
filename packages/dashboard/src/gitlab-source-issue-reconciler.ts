import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { completeColumnsForTask } from "./task-lifecycle-lanes.js";
import { resolveGitLabClient, resolveGitLabTarget, safeLogGitLabEntry } from "./gitlab-lifecycle.js";

export const GITLAB_RECONCILE_SCAN_LIMIT = 200;

type BackfillResult = { scanned: number; filled: number; skipped: number; errors: number; hasMore: boolean };

/*
FNXC:WorkflowResolvedColumns 2026-07-30-03:25 (batch-core):
Candidacy is now resolved from each task's OWN workflow. Keyed on `done`, this backfill found nothing
on a renamed board and reported a clean scan — `scanned: N, filled: 0` reads as "nothing to do", so
the failure was indistinguishable from success.

Two-stage on purpose: the CHEAP provider and closedAt tests run first and reject almost everything,
so the workflow read only happens for tasks that could actually be candidates. It also shares one IR
cache across the scan, making it one read per distinct workflow rather than per task.

`completeColumnsForTask` is the sole terminal criterion. The live store scan excludes soft-deleted
and historical-sentinel rows.
*/
function isGitLabSourceCandidate(task: Task): boolean {
  return task.sourceIssue?.provider === "gitlab" && !task.sourceIssue.closedAt;
}

async function filterGitLabBackfillCandidates(store: TaskStore, tasks: readonly Task[]): Promise<Task[]> {
  const irCache = new Map<string, WorkflowIr>();
  const candidates: Task[] = [];
  for (const task of tasks) {
    if (!isGitLabSourceCandidate(task)) continue;
    if ((await completeColumnsForTask(store, task.id, irCache)).has(task.column)) candidates.push(task);
  }
  return candidates;
}

function normalizeProviderTimestamp(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("0001-01-01T00:00:00")) return undefined;
  return trimmed;
}

/**
 * FNXC:CommandCenterGitLab 2026-07-02-00:00:
 * GitLab closed-at backfill is an explicit operator action for local analytics accuracy. It reads real GitLab issue/MR terminal timestamps only, skips already-filled rows, and never fabricates timestamps from local task state or provider `updated_at` values.
 *
 * FNXC:CommandCenterGitLab 2026-07-02-00:00:
 * This active-task backfill excludes soft-deleted and historical-sentinel rows instead of mutating read-only history.
 */
export class GitLabSourceIssueReconciler {
  async backfillSourceIssueClosedAt(
    store: TaskStore,
    options?: { offset?: number; limit?: number },
  ): Promise<BackfillResult> {
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(0, options?.limit ?? GITLAB_RECONCILE_SCAN_LIMIT);
    const listedTasks = await store.listTasks({ slim: false, includeArchived: false } as Parameters<TaskStore["listTasks"]>[0]);
    const matchingTasks = await filterGitLabBackfillCandidates(store, Array.isArray(listedTasks) ? listedTasks : []);
    const tasks = matchingTasks.slice(offset, offset + limit);
    const hasMore = offset + limit < matchingTasks.length;

    const resolved = await resolveGitLabClient(store);
    if (!resolved.ok) {
      for (const task of tasks) {
        await safeLogGitLabEntry(store, task.id, "Skipped GitLab source issue closed-at backfill", resolved.message);
      }
      return { scanned: tasks.length, filled: 0, skipped: tasks.length, errors: 0, hasMore };
    }

    let filled = 0;
    let skipped = 0;
    let errors = 0;

    for (const task of tasks) {
      const sourceIssue = task.sourceIssue;
      if (!sourceIssue) {
        skipped += 1;
        continue;
      }

      const target = resolveGitLabTarget(task);
      if (!target) {
        skipped += 1;
        await safeLogGitLabEntry(store, task.id, "Skipped GitLab source issue closed-at backfill", "Linked GitLab source metadata is incomplete");
        continue;
      }

      try {
        if (target.kind === "merge_request") {
          const mergeRequest = await resolved.client.getMergeRequest(target.project, target.iid);
          const closedAt = normalizeProviderTimestamp(mergeRequest.mergedAt) ?? normalizeProviderTimestamp(mergeRequest.closedAt);
          if (!["closed", "merged"].includes(mergeRequest.state) || !closedAt) {
            skipped += 1;
            continue;
          }
          await store.updateTask(task.id, { sourceIssue: { ...sourceIssue, closedAt } });
          filled += 1;
          continue;
        }

        const issue = await resolved.client.getProjectIssue(target.project, target.iid);
        const closedAt = normalizeProviderTimestamp(issue.closedAt);
        if (issue.state !== "closed" || !closedAt) {
          skipped += 1;
          continue;
        }
        await store.updateTask(task.id, { sourceIssue: { ...sourceIssue, closedAt } });
        filled += 1;
      } catch (error) {
        errors += 1;
        await safeLogGitLabEntry(
          store,
          task.id,
          "Failed to backfill GitLab source issue closed-at",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return { scanned: tasks.length, filled, skipped, errors, hasMore };
  }
}
