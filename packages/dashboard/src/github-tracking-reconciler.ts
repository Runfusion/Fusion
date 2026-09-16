import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-github-tracking-reconciler");
import type { GlobalSettings, LifecycleColumns, ProjectSettings, Task, TaskSourceIssue, TaskStore, WorkflowIr } from "@fusion/core";
import { resolveTaskLifecycleColumns } from "@fusion/core";
import { resolveGithubTrackingAuth } from "./github-auth.js";
import { GitHubClient } from "./github.js";
import { safeLogTaskEntry } from "./task-log-safety.js";

const RECONCILE_SCAN_LIMIT = 200;
const RECONCILE_CONCURRENCY_LIMIT = 4;
const DELETED_DIAGNOSTIC_SIGNATURE_CAP = 50;

/*
FNXC:WorkflowResolvedColumns 2026-07-31-05:10:
Prefetch one workflow-lifecycle map per bounded live-task page, then filter synchronously. Custom
Complete columns close tracked issues without loading or reviving historical archive snapshots.
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

/** Is this task in a Complete lane by its own workflow's roles? */
function isTerminalTask(task: Task, lifecycleByTaskId: LifecycleByTaskId): boolean {
  const lifecycle = lifecycleByTaskId.get(task.id);
  return task.column === (lifecycle?.complete ?? "done");
}

function hasLinkedTrackingIssue(task: Task): boolean {
  const issue = task.githubTracking?.issue;
  return task.githubTracking?.enabled === true
    && Boolean(issue?.owner && issue.repo && issue.number);
}

function compareUpdatedAtDesc(a: Task, b: Task): number {
  const delta = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  return delta !== 0 ? delta : b.id.localeCompare(a.id);
}

export class GitHubTrackingReconciler {
  private readonly deletedDiagnosticSignaturesByStore = new WeakMap<TaskStore, {
    authSignatures: Set<string>;
    taskSignatures: Set<string>;
  }>();

  private warnDeletedDiagnostic(store: TaskStore, signature: string, message: string): void {
    const known = this.deletedDiagnosticSignaturesByStore.get(store) ?? { authSignatures: new Set<string>(), taskSignatures: new Set<string>() };
    if (signature.startsWith("auth:")) {
      if (known.authSignatures.has(signature)) return;
      known.authSignatures.add(signature);
    } else {
      if (known.taskSignatures.has(signature)) return;
      known.taskSignatures.add(signature);
      // Keep backlog failures diagnostic without retaining unbounded deleted-task history.
      while (known.taskSignatures.size > DELETED_DIAGNOSTIC_SIGNATURE_CAP) known.taskSignatures.delete(known.taskSignatures.values().next().value!);
    }
    this.deletedDiagnosticSignaturesByStore.set(store, known);
    severityAuditLog.warn(message);
  }
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
    await this.runPass("deleted", async () => {
      const result = await this.reconcileDeletedTasks(store, {
        offset: options.offset,
        limit: RECONCILE_SCAN_LIMIT,
      });
      nextOffset = result.hasMore ? options.offset + RECONCILE_SCAN_LIMIT : 0;
    });
    // Done-task tracking + source-issue passes run regardless of the deleted-task pass outcome.
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
    const listedTasks = await store.listTasks({ slim: true, includeArchived: false });
    const allTasks = Array.isArray(listedTasks) ? listedTasks : [];
    /*
    FNXC:GithubTracking 2026-08-15-22:27:
    This board lists thousands of terminal rows oldest-first (`createdAt ASC`). The previous
    scan took the first 200 terminal cards — almost all untracked archived history — so a
    recently completed tracked task (FN-9046 / FN-9054 / FN-9061, positions ~7880+) never
    entered the close pass. Restrict to linked tracking issues, then prefer recently updated
    rows so late-created issues are closed on the next sweep.
    */
    const tracked = allTasks.filter(hasLinkedTrackingIssue);
    const newestTracked = [...tracked].sort(compareUpdatedAtDesc).slice(0, RECONCILE_SCAN_LIMIT);
    const lifecycleByTaskId = await resolveLifecycleByTaskId(store, newestTracked, new Map<string, WorkflowIr>());
    const tasks = newestTracked.filter((task) => isTerminalTask(task, lifecycleByTaskId));

    const projectSettings = ((await store.getSettings()) ?? {}) as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      /*
      FNXC:TerminalTaskWrites 2026-09-15-21:41:
      Authentication outages are service-level state. Per-task log writes churn terminal rows on every
      sweep, so retain one deduplicated diagnostic while leaving live issue reconciliation unchanged.
      */
      this.warnDeletedDiagnostic(store, `auth:tracking:${resolution.message}`, `[github-tracking-reconcile] skipped ${tasks.length} GitHub tracking task(s): ${resolution.message}`);
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
        await safeLogTaskEntry(
          store,
          task.id,
          "Failed to reconcile GitHub tracking issue",
          error instanceof Error ? error.message : String(error),
          { logger: severityAuditLog, context: "github-tracking-reconcile" },
        );
      }
    });

    return { scanned: tasks.length, closed, skipped, errors };
  }

  async reconcileSourceIssues(store: TaskStore): Promise<{ scanned: number; closed: number; skipped: number; errors: number }> {
    const listedTasks = await store.listTasks({ slim: false, includeArchived: false });
    const allTasks = Array.isArray(listedTasks) ? listedTasks : [];
    const lifecycleByTaskId = await resolveLifecycleByTaskId(store, allTasks, new Map<string, WorkflowIr>(), {
      match: (task, lifecycle) => task.sourceIssue?.provider === "github"
        && task.column === (lifecycle?.complete ?? "done"),
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
      this.warnDeletedDiagnostic(store, `auth:source:${resolution.message}`, `[github-tracking-reconcile] skipped ${tasks.length} GitHub source issue task(s): ${resolution.message}`);
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

        await client.setIssueState(owner, repo, issueNumberValue, "closed", "completed");
        if (!sourceIssue.closedAt) {
          await persistSourceIssueClosedAt(store, task.id, sourceIssue, new Date().toISOString());
        }
        closed += 1;
      } catch (error) {
        errors += 1;
        await safeLogTaskEntry(
          store,
          task.id,
          "Failed to reconcile GitHub source issue",
          error instanceof Error ? error.message : String(error),
          { logger: severityAuditLog, context: "github-tracking-reconcile" },
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
    const listedTasks = await store.listTasks({ slim: false, includeArchived: false });
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
      this.warnDeletedDiagnostic(store, `auth:backfill:${resolution.message}`, `[github-tracking-reconcile] skipped ${tasks.length} GitHub source issue backfill task(s): ${resolution.message}`);
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
        await safeLogTaskEntry(
          store,
          task.id,
          "Failed to backfill GitHub source issue closed-at",
          error instanceof Error ? error.message : String(error),
          { logger: severityAuditLog, context: "github-tracking-reconcile" },
        );
      }
    });

    return { scanned: tasks.length, filled, skipped, errors, hasMore };
  }

  async reconcileDeletedTasks(
    store: TaskStore,
    options?: { offset?: number; limit?: number },
  ): Promise<{ scanned: number; closed: number; skipped: number; errors: number; hasMore: boolean }> {
    // Pagination is authoritative in TaskStore.listTasksForGithubTrackingReconcile.
    const listedTasks = await store.listTasksForGithubTrackingReconcile(options);
    const tasks = Array.isArray(listedTasks?.tasks) ? listedTasks.tasks : [];
    const hasMore = listedTasks?.hasMore === true;
    /*
    FNXC:GithubTrackingReconcile 2026-09-15-15:19:
    Every row this pass holds was selected with `deletedAt IS NOT NULL`, so task-log writes are refused
    by construction. Diagnostics belong in the service log and are first-occurrence-only: repeating them
    each cycle recreates the reported symptom. Issue #3616's outbox cadence is owned by poll outcomes;
    this pass owes idle projects quiescence: zero task-store writes and no repeated per-cycle work.
    Retain at most 50 distinct signatures per store so a large deleted backlog cannot grow memory forever.
    */
    const projectSettings = ((await store.getSettings()) ?? {}) as Pick<ProjectSettings, "githubAuthMode" | "githubAuthToken">;
    const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Pick<GlobalSettings, never>;
    const resolution = resolveGithubTrackingAuth({ projectSettings, globalSettings });
    if (!resolution.ok) {
      const signature = `auth:${resolution.message}:${tasks.length}`;
      this.warnDeletedDiagnostic(
        store,
        signature,
        `[github-tracking-reconcile] skipped ${tasks.length} deleted/archived GitHub tracking task(s): ${resolution.message}`,
      );
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

        await client.setIssueState(issue.owner, issue.repo, issue.number, "closed", "not_planned");
        closed += 1;
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        const coordinates = `${issue.owner}/${issue.repo}#${issue.number}`;
        this.warnDeletedDiagnostic(
          store,
          `task:${task.id}:${coordinates}:${message}`,
          `[github-tracking-reconcile] failed deleted/archived GitHub tracking reconciliation for ${task.id} (${coordinates}): ${message}`,
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
    await safeLogTaskEntry(
      store,
      taskId,
      "Failed to persist GitHub source issue closed timestamp",
      error instanceof Error ? error.message : String(error),
      { logger: severityAuditLog, context: "github-tracking-reconcile" },
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
