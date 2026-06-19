import type { GlobalSettings, ProjectSettings, TaskSourceIssue, TaskStore } from "@fusion/core";
import { resolveGithubTrackingAuth } from "./github-auth.js";
import { GitHubClient } from "./github.js";

const RECONCILE_SCAN_LIMIT = 200;
const RECONCILE_CONCURRENCY_LIMIT = 4;

export class GitHubTrackingReconciler {
  async reconcile(store: TaskStore): Promise<{ scanned: number; closed: number; skipped: number; errors: number }> {
    const listedTasks = await store.listTasks({ slim: true, includeArchived: true });
    const tasks = (Array.isArray(listedTasks) ? listedTasks : [])
      .filter((task) => task.column === "done" || task.column === "archived")
      .slice(0, RECONCILE_SCAN_LIMIT);

    const projectSettings = ((await store.getSettings()) ?? {}) as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      for (const task of tasks) {
        await store.logEntry(task.id, "Skipped GitHub tracking issue reconciliation", resolution.message);
      }
      return { scanned: tasks.length, closed: 0, skipped: tasks.length, errors: 0 };
    }

    const client = resolution.auth.mode === "token"
      ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
      : new GitHubClient({ forceMode: "gh-cli" });

    let closed = 0;
    let skipped = 0;
    let errors = 0;

    await runWithConcurrencyLimit(tasks, RECONCILE_CONCURRENCY_LIMIT, async (task) => {
      const issue = task.githubTracking?.issue;
      if (task.githubTracking?.enabled !== true || !issue?.owner || !issue.repo || !issue.number) {
        skipped += 1;
        return;
      }

      try {
        const linkedIssue = await client.getIssue(issue.owner, issue.repo, issue.number);
        if (!linkedIssue || linkedIssue.state === "closed") {
          skipped += 1;
          return;
        }

        const stateReason = task.column === "archived" && !task.executionCompletedAt ? "not_planned" : "completed";
        await client.setIssueState(issue.owner, issue.repo, issue.number, "closed", stateReason);
        closed += 1;
      } catch (error) {
        errors += 1;
        await store.logEntry(
          task.id,
          "Failed to reconcile GitHub tracking issue",
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    return { scanned: tasks.length, closed, skipped, errors };
  }

  async reconcileSourceIssues(store: TaskStore): Promise<{ scanned: number; closed: number; skipped: number; errors: number }> {
    const listedTasks = await store.listTasks({ slim: false, includeArchived: true });
    const tasks = (Array.isArray(listedTasks) ? listedTasks : [])
      .filter((task) => (task.column === "done" || task.column === "archived") && task.sourceIssue?.provider === "github")
      .slice(0, RECONCILE_SCAN_LIMIT);

    const projectSettings = ((await store.getSettings()) ?? {}) as Pick<ProjectSettings, "githubCloseSourceIssueOnDone" | "githubAuthMode" | "githubAuthToken">;
    if (projectSettings.githubCloseSourceIssueOnDone !== true) {
      return { scanned: tasks.length, closed: 0, skipped: tasks.length, errors: 0 };
    }

    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      for (const task of tasks) {
        await store.logEntry(task.id, "Skipped GitHub source issue reconciliation", resolution.message);
      }
      return { scanned: tasks.length, closed: 0, skipped: tasks.length, errors: 0 };
    }

    const client = resolution.auth.mode === "token"
      ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
      : new GitHubClient({ forceMode: "gh-cli" });

    let closed = 0;
    let skipped = 0;
    let errors = 0;

    await runWithConcurrencyLimit(tasks, RECONCILE_CONCURRENCY_LIMIT, async (task) => {
      const sourceIssue = task.sourceIssue;
      const repository = sourceIssue?.repository ?? "";
      const [owner, repo] = repository.split("/");
      const issueNumber = sourceIssue?.issueNumber;
      if (!sourceIssue || !owner || !repo || !Number.isInteger(issueNumber)) {
        skipped += 1;
        return;
      }

      const issueNumberValue = issueNumber as number;
      try {
        const linkedIssue = await client.getIssue(owner, repo, issueNumberValue);
        if (!linkedIssue) {
          skipped += 1;
          return;
        }
        if (linkedIssue.state === "closed") {
          if (!sourceIssue.closedAt && linkedIssue.closedAt) {
            await persistSourceIssueClosedAt(store, task.id, sourceIssue, linkedIssue.closedAt);
          }
          skipped += 1;
          return;
        }

        const stateReason = task.column === "archived" && !task.executionCompletedAt ? "not_planned" : "completed";
        await client.setIssueState(owner, repo, issueNumberValue, "closed", stateReason);
        if (!sourceIssue.closedAt) {
          await persistSourceIssueClosedAt(store, task.id, sourceIssue, new Date().toISOString());
        }
        closed += 1;
      } catch (error) {
        errors += 1;
        await store.logEntry(
          task.id,
          "Failed to reconcile GitHub source issue",
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    return { scanned: tasks.length, closed, skipped, errors };
  }

  /**
   * FNXC:GithubSourceIssueBackfill 2026-06-18-18:53:
   * Historical GitHub-imported tasks need an optional one-time sweep that fills missing `sourceIssueClosedAt` from real GitHub `closed_at` values only. Keep this path decoupled from analytics so Command Center aggregation never performs network calls, and keep it idempotent by excluding already-filled tasks and never fabricating timestamps.
   */
  async backfillSourceIssueClosedAt(
    store: TaskStore,
    options?: { offset?: number; limit?: number },
  ): Promise<{ scanned: number; filled: number; skipped: number; errors: number; hasMore: boolean }> {
    const listedTasks = await store.listTasks({ slim: false, includeArchived: true });
    const offset = Number.isInteger(options?.offset) && (options?.offset ?? 0) > 0 ? options?.offset ?? 0 : 0;
    const limit = Number.isInteger(options?.limit) && (options?.limit ?? RECONCILE_SCAN_LIMIT) >= 0
      ? Math.min(options?.limit ?? RECONCILE_SCAN_LIMIT, RECONCILE_SCAN_LIMIT)
      : RECONCILE_SCAN_LIMIT;
    const matchingTasks = (Array.isArray(listedTasks) ? listedTasks : [])
      .filter((task) => (task.column === "done" || task.column === "archived")
        && task.sourceIssue?.provider === "github"
        && !task.sourceIssue?.closedAt);
    const tasks = matchingTasks.slice(offset, offset + limit);
    const hasMore = offset + limit < matchingTasks.length;

    const projectSettings = ((await store.getSettings()) ?? {}) as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      for (const task of tasks) {
        await store.logEntry(task.id, "Skipped GitHub source issue closed-at backfill", resolution.message);
      }
      return { scanned: tasks.length, filled: 0, skipped: tasks.length, errors: 0, hasMore };
    }

    const client = resolution.auth.mode === "token"
      ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
      : new GitHubClient({ forceMode: "gh-cli" });

    let filled = 0;
    let skipped = 0;
    let errors = 0;

    await runWithConcurrencyLimit(tasks, RECONCILE_CONCURRENCY_LIMIT, async (task) => {
      const sourceIssue = task.sourceIssue;
      const repository = sourceIssue?.repository ?? "";
      const [owner, repo] = repository.split("/");
      const issueNumber = sourceIssue?.issueNumber;
      if (!sourceIssue || !owner || !repo || !Number.isInteger(issueNumber)) {
        skipped += 1;
        return;
      }

      try {
        const linkedIssue = await client.getIssue(owner, repo, issueNumber as number);
        const closedAt = typeof linkedIssue?.closedAt === "string" ? linkedIssue.closedAt.trim() : "";
        if (linkedIssue?.state !== "closed" || closedAt.length === 0) {
          skipped += 1;
          return;
        }

        await store.updateTask(task.id, { sourceIssue: { ...sourceIssue, closedAt } });
        filled += 1;
      } catch (error) {
        errors += 1;
        await store.logEntry(
          task.id,
          "Failed to backfill GitHub source issue closed-at",
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    return { scanned: tasks.length, filled, skipped, errors, hasMore };
  }

  async reconcileDeletedAndArchived(
    store: TaskStore,
    options?: { offset?: number; limit?: number },
  ): Promise<{ scanned: number; closed: number; skipped: number; errors: number; hasMore: boolean }> {
    // Pagination is authoritative in TaskStore.listTasksForGithubTrackingReconcile.
    const listedTasks = await store.listTasksForGithubTrackingReconcile(options);
    const tasks = Array.isArray(listedTasks?.tasks) ? listedTasks.tasks : [];
    const hasMore = listedTasks?.hasMore === true;

    const projectSettings = ((await store.getSettings()) ?? {}) as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      for (const task of tasks) {
        await store.logEntry(task.id, "Skipped GitHub tracking issue reconciliation (deleted/archived pass)", resolution.message);
      }
      return { scanned: tasks.length, closed: 0, skipped: tasks.length, errors: 0, hasMore };
    }

    const client = resolution.auth.mode === "token"
      ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" })
      : new GitHubClient({ forceMode: "gh-cli" });

    let closed = 0;
    let skipped = 0;
    let errors = 0;

    await runWithConcurrencyLimit(tasks, RECONCILE_CONCURRENCY_LIMIT, async (task) => {
      const issue = task.githubTracking?.issue;
      if (task.githubTracking?.enabled !== true || !issue?.owner || !issue.repo || !issue.number) {
        skipped += 1;
        return;
      }

      try {
        const linkedIssue = await client.getIssue(issue.owner, issue.repo, issue.number);
        if (!linkedIssue || linkedIssue.state === "closed") {
          skipped += 1;
          return;
        }

        // Archived entries do not preserve the pre-archive column. FN-5577 uses
        // executionCompletedAt as the done-heuristic for archived rows.
        const stateReason = task.deletedAt
          ? "not_planned"
          : task.column === "archived" && task.executionCompletedAt
            ? "completed"
            : "not_planned";

        await client.setIssueState(issue.owner, issue.repo, issue.number, "closed", stateReason);
        closed += 1;
      } catch (error) {
        errors += 1;
        await store.logEntry(
          task.id,
          "Failed to reconcile GitHub tracking issue (deleted/archived pass)",
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    return { scanned: tasks.length, closed, skipped, errors, hasMore };
  }
}

/**
 * FNXC:GithubSourceIssueAnalytics 2026-06-18-18:19:
 * Source-issue reconciliation is the authenticated path that can know real GitHub closure times; persist that exact timestamp idempotently and treat write failures as best-effort worker log entries instead of fabricating or overwriting analytics data.
 */
async function persistSourceIssueClosedAt(
  store: TaskStore,
  taskId: string,
  sourceIssue: TaskSourceIssue,
  closedAt: string,
): Promise<void> {
  try {
    await store.updateTask(taskId, { sourceIssue: { ...sourceIssue, closedAt } });
  } catch (error) {
    await store.logEntry(
      taskId,
      "Failed to persist GitHub source issue closed timestamp",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function runWithConcurrencyLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        await worker(item);
      }
    }
  });

  await Promise.all(workers);
}

export { RECONCILE_CONCURRENCY_LIMIT, RECONCILE_SCAN_LIMIT };
