import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-github-tracking-reconciler");
import type { GlobalSettings, LifecycleColumns, ProjectSettings, Task, TaskSourceIssue, TaskStore, WorkflowIr } from "@fusion/core";
import { resolveTaskLifecycleColumns } from "@fusion/core";
import { resolveGithubTrackingAuth } from "./github-auth.js";
import { GitHubClient } from "./github.js";

const RECONCILE_SCAN_LIMIT = 200;
const RECONCILE_CONCURRENCY_LIMIT = 4;


/*
FNXC:WorkflowResolvedColumns 2026-07-31-05:10 (fleet phase — the SYNC-FILTER class, decided):
PREFETCH A RESOLVED MAP, then filter synchronously. This is the pattern for every
`.filter((task) => task.column === "<id>")` over a list of OTHER tasks — a shape I flagged across four
files and left unconverted while waiting for a decision that had to be mine.

THE TWO OPTIONS AND WHY THIS ONE. The alternative is making the predicates async, which forces every
caller into `for await` and turns one list comprehension into a sequential walk. Prefetching keeps the
filters synchronous and puts the awaits in one bounded place; it also lets the IR cache do its job, which
is the whole reason `resolveTaskLifecycleColumns` takes a caller-owned one:

  "A self-healing pass over 400 cards spanning three workflows must read three IRs, not 400."

So the cache is shared across the WHOLE reconcile run, not per pass. The three passes in this file each
list the board independently; one cache means the IR is read once per distinct workflow for all of them.
`resolveLifecycleColumns` itself is pure and is not memoized by that cache, so this still costs one cheap
struct build per task — acceptable in a background reconcile, and stated rather than hidden.

WHY CONVERTING `archived` HERE IS NOT THE SPLIT BRAIN #2724 DESCRIBES. That guard covers the archived
gate in `packages/core`, where the same question is answered in TypeScript AND in SQL, so converting one
encoding alone diverges them. This file contains ZERO SQL (measured: no drizzle, no `sql` template, no
eq/ne) and calls `listTasks({ includeArchived: true })` — the SQL half has already been told to include
archived rows, so this filter SELECTS among rows it was handed rather than deciding liveness a second
time. Gate versus consumer is the distinction; a consumer can be converted alone.

WHAT IT COST BEFORE. On a board whose terminal lanes are renamed, every filter here matched nothing, so
the reconciler closed NO GitHub issues and reported `scanned: 0` — a clean-looking pass that did nothing.
*/
type LifecycleByTaskId = ReadonlyMap<string, LifecycleColumns | undefined>;

async function resolveLifecycleByTaskId(
  store: TaskStore,
  tasks: readonly Task[],
  irCache: Map<string, WorkflowIr>,
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-12:10 (#2737 review — greptile P2):
  STOP once `limit` tasks have matched. The first version resolved for every row `listTasks` returned —
  an unbounded board — before slicing to RECONCILE_SCAN_LIMIT, so the prefetch did unbounded work to feed
  a bounded scan. `match` is applied here rather than by the caller precisely so the loop can stop.

  Rows past the cut are left unresolved and absent from the map. That is safe because the only consumers
  are the terminal predicates, which fall back to the legacy ids for an absent entry — the same degraded
  answer they would give on a store with no workflow reader — and those rows are dropped by the slice
  anyway.
  */
  options?: { match?: (task: Task, lifecycle: LifecycleColumns | undefined) => boolean; limit?: number },
): Promise<LifecycleByTaskId> {
  const byTaskId = new Map<string, LifecycleColumns | undefined>();
  let matched = 0;
  for (const task of tasks) {
    if (byTaskId.has(task.id)) continue;
    const lifecycle = await resolveTaskLifecycleColumns(store, task.id, irCache);
    byTaskId.set(task.id, lifecycle);
    if (options?.match && options.match(task, lifecycle)) {
      matched += 1;
      if (options.limit !== undefined && matched >= options.limit) break;
    }
  }
  return byTaskId;
}

/** Is this task in a terminal lane — complete or archived — by its OWN workflow's roles? */
function isTerminalTask(task: Task, lifecycleByTaskId: LifecycleByTaskId): boolean {
  const lifecycle = lifecycleByTaskId.get(task.id);
  return task.column === (lifecycle?.complete ?? "done")
    || task.column === (lifecycle?.archived ?? "archived");
}

/** Is this task in the ARCHIVED lane specifically (used for the FN-5577 done-heuristic)? */
function isArchivedTask(task: Task, lifecycleByTaskId: LifecycleByTaskId): boolean {
  return task.column === (lifecycleByTaskId.get(task.id)?.archived ?? "archived");
}

export class GitHubTrackingReconciler {
  /*
  FNXC:GithubTrackingReconcile 2026-07-16-15:40:
  The three reconcile passes are INDEPENDENT and each MUST run even when another throws.
  Regression that motivated this: the caller ran all three inside one try/catch with a silent
  swallow, and the fragile PG-backend `reconcileDeletedAndArchived` pass ran first. When it threw
  (e.g. an async-layer/row-hydration failure), the done-task `reconcile()` and source-issue
  `reconcileSourceIssues()` passes never executed — on every sweep, startup and periodic. Net effect:
  the reconcile safety-net closed ZERO GitHub issues while only the live move-handler worked, so any
  task the live path missed (moved to Done before tracking adoption was reflected in the move event,
  or a transient close failure like FN-8066's) kept its linked issue OPEN indefinitely.
  runSweep isolates each pass and surfaces failures via console.warn instead of hiding them, so one
  broken pass can never starve the others and a future breakage is observable rather than silent.
  */
  async runSweep(store: TaskStore, options: { offset: number }): Promise<{ nextOffset: number }> {
    let nextOffset = 0;
    await this.runPass("deleted/archived", async () => {
      const result = await this.reconcileDeletedAndArchived(store, {
        offset: options.offset,
        limit: RECONCILE_SCAN_LIMIT,
      });
      nextOffset = result.hasMore ? options.offset + RECONCILE_SCAN_LIMIT : 0;
    });
    // Done-task tracking + source-issue passes run regardless of the deleted/archived pass outcome.
    await this.runPass("done-task tracking", () => this.reconcile(store));
    await this.runPass("source-issue", () => this.reconcileSourceIssues(store));
    return { nextOffset };
  }

  private async runPass(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      severityAuditLog.warn(
        `[github-tracking-reconcile] ${label} pass failed (other passes still run): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async reconcile(store: TaskStore): Promise<{ scanned: number; closed: number; skipped: number; errors: number }> {
    const listedTasks = await store.listTasks({ slim: true, includeArchived: true });
    const allTasks = Array.isArray(listedTasks) ? listedTasks : [];
    const lifecycleByTaskId = await resolveLifecycleByTaskId(store, allTasks, new Map<string, WorkflowIr>(), {
      match: (task, lifecycle) => task.column === (lifecycle?.complete ?? "done")
        || task.column === (lifecycle?.archived ?? "archived"),
      limit: RECONCILE_SCAN_LIMIT,
    });
    const tasks = allTasks
      .filter((task) => isTerminalTask(task, lifecycleByTaskId))
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

        const stateReason = isArchivedTask(task, lifecycleByTaskId) && !task.executionCompletedAt ? "not_planned" : "completed";
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
    const allTasks = Array.isArray(listedTasks) ? listedTasks : [];
    const lifecycleByTaskId = await resolveLifecycleByTaskId(store, allTasks, new Map<string, WorkflowIr>(), {
      match: (task, lifecycle) => task.sourceIssue?.provider === "github"
        && (task.column === (lifecycle?.complete ?? "done") || task.column === (lifecycle?.archived ?? "archived")),
      limit: RECONCILE_SCAN_LIMIT,
    });
    const tasks = allTasks
      .filter((task) => isTerminalTask(task, lifecycleByTaskId) && task.sourceIssue?.provider === "github")
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

        const stateReason = isArchivedTask(task, lifecycleByTaskId) && !task.executionCompletedAt ? "not_planned" : "completed";
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
    const allTasks = Array.isArray(listedTasks) ? listedTasks : [];
    const lifecycleByTaskId = await resolveLifecycleByTaskId(store, allTasks, new Map<string, WorkflowIr>());
    const matchingTasks = allTasks
      .filter((task) => isTerminalTask(task, lifecycleByTaskId)
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
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-05:20:
    Resolved for the PAGE, not the board — this pass's list comes from
    `listTasksForGithubTrackingReconcile`, which is already offset/limit bounded (<= RECONCILE_SCAN_LIMIT).

    NOT the split brain #2724 documents, and I checked before converting: that store impl filters on
    `deletedAt IS NOT NULL` AND `githubTracking IS NOT NULL` — it does NOT compare the column to
    'archived', so there is no SQL-side encoding of this question to diverge from.

    REACHABILITY, worth recording: in backend mode this pass returns only SOFT-DELETED rows (its own
    comment says the archived-tasks fallback is a separate AsyncArchiveLineage subsystem, skipped here),
    and `task.deletedAt` is tested FIRST in the stateReason chain below. So the archived arm is
    effectively unreachable in backend mode today. Converted anyway rather than deleted: it is the
    documented FN-5577 done-heuristic, and whether that fallback should be wired here is a separate
    question from what vocabulary it speaks.
    */
    const lifecycleByTaskId = await resolveLifecycleByTaskId(store, tasks, new Map<string, WorkflowIr>());

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
          : isArchivedTask(task, lifecycleByTaskId) && task.executionCompletedAt
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
