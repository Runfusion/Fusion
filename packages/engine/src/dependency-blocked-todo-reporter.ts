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
  FNXC:WorkflowLifecycleColumns 2026-07-28-17:50 (PR #2479 review, P1 + P2):
  Classify every task against ITS OWN workflow.

  This replaces a board-wide UNION of roles, which was wrong in the way this whole
  program is about: a column id means something only RELATIVE TO ITS WORKFLOW. If
  one workflow calls `done` its hold column and another calls `done` terminal, a
  union marks that column BOTH, so dependents count as held while the blocker
  beside them is discarded as finished — from a single ambiguous id. Resolving per
  task makes that impossible by construction instead of detectable afterwards.

  It also fixes the sibling P2 as a side effect rather than needing its own memo
  layer: ONE caller-owned `irCache` is shared across the whole pass, so
  workflow-definition and prompt-override reads scale with the number of
  WORKFLOWS, not the number of cards.

  Fail-soft per task: a card whose workflow will not resolve falls back to the
  legacy roles, so one bad workflow degrades that card to today's behavior instead
  of breaking the report.
  */
  private async buildTaskLifecycleClassifier(
    tasks: readonly Task[],
  ): Promise<(task: Task) => { isHold: boolean; isTerminal: boolean }> {
    const irCache = new Map<string, WorkflowIr>();
    const rolesByTaskId = new Map<string, { isHold: boolean; isTerminal: boolean }>();

    for (const task of tasks) {
      try {
        const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(this.store, task.id, irCache));
        if (!lifecycle) continue;
        rolesByTaskId.set(task.id, {
          isHold: lifecycle.hold !== undefined && task.column === lifecycle.hold,
          isTerminal:
            (lifecycle.complete !== undefined && task.column === lifecycle.complete) ||
            (lifecycle.archived !== undefined && task.column === lifecycle.archived),
        });
      } catch {
        // Leave unmapped: the legacy fallback below applies to this card only.
      }
    }

    return (task: Task) =>
      rolesByTaskId.get(task.id) ?? {
        isHold: task.column === "todo",
        isTerminal: task.column === "done" || task.column === "archived",
      };
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
      const classifyTask = await this.buildTaskLifecycleClassifier(tasks);
      const report = computeDependencyBlockedTodoReport(tasks, maxAutoMergeRetries, {
        now: nowMs,
        freshAgeMs,
        staleAgeMs,
        minBlockedTodoCount,
        maxGroups: DEFAULT_DEPENDENCY_BLOCKED_TODO_MAX_GROUPS,
        classifyTask,
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
