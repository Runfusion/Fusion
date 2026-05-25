import type { GlobalSettings, ProjectSettings, TaskStore } from "@fusion/core";
import { resolveGithubTrackingAuth } from "./github-auth.js";
import { GitHubClient } from "./github.js";

const RECONCILE_SCAN_LIMIT = 200;
const RECONCILE_CONCURRENCY_LIMIT = 4;

export class GitHubTrackingReconciler {
  async reconcile(store: TaskStore): Promise<{ scanned: number; closed: number; skipped: number; errors: number }> {
    const listedTasks = await store.listTasks({ slim: true, includeArchived: false });
    const tasks = (Array.isArray(listedTasks) ? listedTasks : [])
      .filter((task) => task.status === "done")
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

        await client.setIssueState(issue.owner, issue.repo, issue.number, "closed", "completed");
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

  async reconcileDeletedAndArchived(store: TaskStore): Promise<{ scanned: number; closed: number; skipped: number; errors: number }> {
    const listedTasks = await store.listTasksForGithubTrackingReconcile();
    const tasks = (Array.isArray(listedTasks) ? listedTasks : []).slice(0, RECONCILE_SCAN_LIMIT);

    const projectSettings = ((await store.getSettings()) ?? {}) as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      for (const task of tasks) {
        await store.logEntry(task.id, "Skipped GitHub tracking issue reconciliation (deleted/archived pass)", resolution.message);
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

    return { scanned: tasks.length, closed, skipped, errors };
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
