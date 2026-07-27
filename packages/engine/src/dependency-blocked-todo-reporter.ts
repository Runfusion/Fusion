import {
  computeDependencyBlockedTodoReport,
  computeInsightFingerprint,
  resolveLifecycleColumns,
  resolveWorkflowIrForTask,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_MAX_GROUPS,
  type Task,
  type TaskStore,
  type WorkflowIr,
} from "@fusion/core";
import { createLogger } from "./logger.js";

const reporterLog = createLogger("dependency-blocked-todo");
const TITLE_PREFIX = "Backlog health: dependency-blocked todos";

type DependencyBlockedTodoReporterLogger = {
  warn: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
};

interface DependencyBlockedTodoReporterOptions {
  store: TaskStore;
  projectId: string;
  logger?: DependencyBlockedTodoReporterLogger;
  now?: () => number;
}

export class DependencyBlockedTodoReporter {
  private readonly store: TaskStore;
  private readonly projectId: string;
  private readonly logger: DependencyBlockedTodoReporterLogger;
  private readonly now: () => number;

  constructor(options: DependencyBlockedTodoReporterOptions) {
    this.store = options.store;
    this.projectId = options.projectId;
    this.logger = options.logger ?? reporterLog;
    this.now = options.now ?? (() => Date.now());
  }

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-28-03:05 (PR #2470 review, P1):
  Resolve the lifecycle roles for the board this report covers.

  This report is BOARD-WIDE, so it can span several workflows at once — hence a
  UNION of each workflow's hold and terminal columns rather than one vocabulary.
  Before this, the report passed neither and fell back to the legacy
  {done,archived}/"todo": a renamed terminal column counted as ACTIVE (finished
  blockers reported as live) while cards in a renamed hold column were not
  counted as blocked todos at all (real blockage invisible).

  One IR read per WORKFLOW, not per card: the cache is keyed by the resolver on
  the task's workflow selection, so a 400-card board spanning three workflows
  reads three IRs. The legacy ids are always seeded, so a project mixing a custom
  workflow with builtin:coding keeps working for the builtin cards, and any
  resolution failure degrades to exactly today's behavior rather than dropping
  columns from the union.
  */
  private async resolveBoardLifecycleRoles(
    tasks: readonly Task[],
  ): Promise<{ holdColumns: string[]; terminalColumns: string[] }> {
    const holdColumns = new Set<string>(["todo"]);
    const terminalColumns = new Set<string>(["done", "archived"]);
    const irCache = new Map<string, WorkflowIr>();
    const seenWorkflows = new Set<string>();

    for (const task of tasks) {
      try {
        const workflowId = (await this.store.getTaskWorkflowSelectionAsync?.(task.id))?.workflowId;
        // One resolution per distinct workflow on the board.
        if (workflowId && seenWorkflows.has(workflowId)) continue;
        if (workflowId) seenWorkflows.add(workflowId);

        const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(this.store, task.id, irCache));
        if (!lifecycle) continue;
        if (lifecycle.hold) holdColumns.add(lifecycle.hold);
        if (lifecycle.complete) terminalColumns.add(lifecycle.complete);
        if (lifecycle.archived) terminalColumns.add(lifecycle.archived);
      } catch {
        // Fail-soft: a backlog-health report must not break on one bad workflow.
      }
    }

    return { holdColumns: [...holdColumns], terminalColumns: [...terminalColumns] };
  }

  async report(): Promise<{ alerted: boolean; reason?: string; groupCount?: number }> {
    try {
      const settings = await this.store.getSettings();
      if (settings.dependencyBlockedTodoReportEnabled === false) {
        return { alerted: false, reason: "disabled" };
      }

      const freshAgeMs = settings.dependencyBlockedTodoFreshAgeMs ?? 30 * 60_000;
      const staleAgeMs = settings.dependencyBlockedTodoStaleAgeMs ?? 4 * 60 * 60_000;
      const minBlockedTodoCount = settings.dependencyBlockedTodoMinCount ?? 1;
      const cooldownMs = settings.dependencyBlockedTodoReportCooldownMs ?? 6 * 60 * 60_000;
      if (
        !Number.isFinite(freshAgeMs) ||
        freshAgeMs <= 0 ||
        !Number.isFinite(staleAgeMs) ||
        staleAgeMs <= 0 ||
        !Number.isFinite(minBlockedTodoCount) ||
        minBlockedTodoCount <= 0 ||
        !Number.isFinite(cooldownMs) ||
        cooldownMs < 0
      ) {
        this.logger.warn("[dependency-blocked-todo] invalid config: thresholds must be valid finite values");
        return { alerted: false, reason: "invalid-config" };
      }

      const configuredMaxAutoMergeRetries = Number(settings.maxAutoMergeRetries);
      const maxAutoMergeRetries = Number.isFinite(configuredMaxAutoMergeRetries)
        ? configuredMaxAutoMergeRetries
        : 3;
      const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const nowMs = this.now();
      const roles = await this.resolveBoardLifecycleRoles(tasks);
      const report = computeDependencyBlockedTodoReport(tasks, maxAutoMergeRetries, {
        now: nowMs,
        freshAgeMs,
        staleAgeMs,
        minBlockedTodoCount,
        maxGroups: DEFAULT_DEPENDENCY_BLOCKED_TODO_MAX_GROUPS,
        holdColumns: roles.holdColumns,
        terminalColumns: roles.terminalColumns,
      });

      if (report.uniqueBlockerCount === 0) {
        return { alerted: false, reason: "no-blocked-groups" };
      }

      const hasAgingOrStale = report.groups.some((group) => group.ageBucket !== "fresh");
      if (!hasAgingOrStale && report.totalBlockedTodoCount < 3) {
        return { alerted: false, reason: "below-significance" };
      }

      const detectedAt = new Date(nowMs).toISOString();
      const title = `${TITLE_PREFIX} ${detectedAt.slice(0, 10)}`;
      const contentPayload = {
        observedAt: report.observedAt,
        totalBlockedTodoCount: report.totalBlockedTodoCount,
        uniqueBlockerCount: report.uniqueBlockerCount,
        thresholds: report.thresholds,
        groups: report.groups.map((group) => ({
          blockerId: group.blockerId,
          blockerColumn: group.blockerColumn,
          blockerTitle: taskById.get(group.blockerId)?.title,
          blockedTodoCount: group.blockedTodoCount,
          ageBucket: group.ageBucket,
          blockingAgeMs: group.blockingAgeMs,
          blockedTodoIds: group.blockedTodoIds.slice(0, 10),
          viaDependencies: group.viaDependencies.slice(0, 10),
          viaBlockedBy: group.viaBlockedBy.slice(0, 10),
        })),
      };
      const content = JSON.stringify(contentPayload);

      let insightStore;
      try {
        if (!this.projectId) throw new Error("empty projectId");
        // FNXC:PostgresInsights 2026-07-14-17:25: Both store implementations
        // share an awaitable API; backend mode must emit durable insights.
        insightStore = this.store.getInsightStore();
      } catch (error) {
        await this.store.logEntry(report.groups[0].blockerId, `[dependency-blocked-todo] ${content}`);
        this.logger.warn("[dependency-blocked-todo] insight store unavailable; logged fallback payload", error);
        this.logger.warn(
          `[dependency-blocked-todo] alert: groups=${report.uniqueBlockerCount} blockedTodos=${report.totalBlockedTodoCount} blockers=${report.groups
            .slice(0, 3)
            .map((group) => group.blockerId)
            .join(",")}`,
        );
        return { alerted: true, groupCount: report.uniqueBlockerCount };
      }

      if (cooldownMs > 0) {
        const insights = await insightStore.listInsights({
          projectId: this.projectId,
          category: "workflow",
          status: "generated",
          limit: 10,
        });
        const latest = [...insights]
          .filter((insight) => insight.title.startsWith(TITLE_PREFIX))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        if (latest) {
          const updatedAtMs = Date.parse(latest.updatedAt);
          if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < cooldownMs) {
            return { alerted: false, reason: "cooldown" };
          }
        }
      }

      await insightStore.upsertInsight(this.projectId, {
        title,
        content,
        category: "workflow",
        fingerprint: computeInsightFingerprint(title, "workflow"),
        provenance: {
          trigger: "schedule",
          description: "Dependency-blocked Todo grouping (generated by dependency-blocked-todo-reporter)",
          relatedEntityIds: report.groups.map((group) => group.blockerId),
          metadata: { generator: "dependency-blocked-todo-reporter" },
        },
      });

      this.logger.warn(
        `[dependency-blocked-todo] alert: groups=${report.uniqueBlockerCount} blockedTodos=${report.totalBlockedTodoCount} blockers=${report.groups
          .slice(0, 3)
          .map((group) => group.blockerId)
          .join(",")}`,
      );
      return { alerted: true, groupCount: report.uniqueBlockerCount };
    } catch (error) {
      this.logger.error?.("[dependency-blocked-todo] reporter failed", error);
      return { alerted: false, reason: "error" };
    }
  }
}

export { TITLE_PREFIX as DEPENDENCY_BLOCKED_TODO_TITLE_PREFIX };
