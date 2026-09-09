import { computeInsightFingerprint, type Task, type TaskPriority, type TaskStore, resolveProjectColumnsForRoles} from "@fusion/core";
import { createLogger } from "../logger.js";

const reporterLog = createLogger("backlog-pressure");
const TOP_CANDIDATES = 5;
const TITLE_PREFIX = "Backlog pressure detected";

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

type BacklogPressureLogger = {
  warn: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
};

interface BacklogPressureReporterOptions {
  store: TaskStore;
  projectId: string;
  logger?: BacklogPressureLogger;
  now?: () => number;
}

/**
 * Detects sustained backlog pressure (high todo inventory vs low in-progress throughput)
 * and surfaces a durable workflow insight. If InsightStore access is unavailable, it
 * falls back to writing the same payload to the top candidate task log entry.
 */
export class BacklogPressureReporter {
  private readonly store: TaskStore;
  private readonly projectId: string;
  private readonly logger: BacklogPressureLogger;
  private readonly now: () => number;

  constructor(options: BacklogPressureReporterOptions) {
    this.store = options.store;
    this.projectId = options.projectId;
    this.logger = options.logger ?? reporterLog;
    this.now = options.now ?? (() => Date.now());
  }

  async report(): Promise<{ alerted: boolean; reason?: string }> {
    try {
      const settings = await this.store.getSettings();
      if (settings.backlogPressureAlertEnabled === false) {
        return { alerted: false, reason: "disabled" };
      }

      const ratioThreshold = settings.backlogPressureRatioThreshold ?? 10;
      const minTodoCount = settings.backlogPressureMinTodoCount ?? 5;
      if (!Number.isFinite(ratioThreshold) || ratioThreshold <= 0 || !Number.isFinite(minTodoCount) || minTodoCount <= 0) {
        this.logger.warn("[backlog-pressure] invalid config: thresholds must be positive finite numbers");
        return { alerted: false, reason: "invalid-config" };
      }

      /*
      FNXC:WorkflowLifecycleColumns 2026-07-31-20:10:
      THE QUERY, not the comparison — this reporter had no comparison to convert at all.

      `listTasks({ column })` filters in the store, so on a board whose lanes are renamed both reads
      return EMPTY and the ratio is computed as 0/0: the backlog-pressure alert never fires, on a
      board that may be under exactly the pressure it exists to report. Nothing errors, and the
      census never pointed here because a query filter is not a comparison.

      Resolved through `resolveProjectColumnsForRoles`, which answers the PROJECT-level question a
      read needs (there is no task in hand yet to resolve from) and always unions the legacy id, so a
      board mid-rename still counts rows stored under the old one.
      */
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-19:10:
      THE THIRD LANE QUESTION IN THIS REPORTER WAS STILL LITERAL. Hold and wip were resolved here;
      "is this card's dependency finished?" was asked one method down with `dependency.column !== "done"`.
      Two lane answers about the same board, one resolved and one not.

      Consequence is a report that reads plausible and is wrong: on a renamed board EVERY dependency
      looks unfinished, so `isRunnableCandidate` rejects every card that has one and the backlog-pressure
      alert names only dependency-free cards as the runnable ones. The operator is told the queue is
      blocked on nothing in particular.

      Membership is workflow Complete only. Store-open reintegration moves historical snapshots into
      those live columns before scheduling, so this reporter never needs a second archive authority.
      */
      const [holdColumns, wipColumns, dependencyCompleteColumns] = await Promise.all([
        resolveProjectColumnsForRoles(this.store, ["hold"]),
        resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]),
        resolveProjectColumnsForRoles(this.store, ["complete"]),
      ]);
      const dependencyFinishedColumns = new Set(dependencyCompleteColumns);
      const listByColumns = async (columns: ReadonlySet<string>, slim: boolean): Promise<Task[]> => {
        const byId = new Map<string, Task>();
        for (const column of columns) {
          for (const task of await this.store.listTasks({ column, slim })) byId.set(task.id, task);
        }
        return [...byId.values()];
      };
      const [todoSlim, inProgressSlim] = await Promise.all([
        listByColumns(holdColumns, true),
        listByColumns(wipColumns, true),
      ]);

      const todoCount = todoSlim.length;
      const inProgressCount = inProgressSlim.length;
      const ratio = todoCount / Math.max(inProgressCount, 1);
      if (todoCount < minTodoCount || ratio <= ratioThreshold) {
        return { alerted: false, reason: "under-threshold" };
      }

      const [todoFull, allTasks] = await Promise.all([
        listByColumns(holdColumns, false),
        this.store.listTasks({ slim: true, includeArchived: false }),
      ]);
      const byId = new Map(allTasks.map((task) => [task.id, task]));
      const candidates = todoFull
        .filter((task) => this.isRunnableCandidate(task, byId, dependencyFinishedColumns))
        .sort((a, b) => {
          const pa = PRIORITY_WEIGHT[a.priority ?? "normal"];
          const pb = PRIORITY_WEIGHT[b.priority ?? "normal"];
          if (pa !== pb) return pa - pb;
          return Date.parse(a.createdAt) - Date.parse(b.createdAt);
        })
        .slice(0, TOP_CANDIDATES);

      if (candidates.length < 3) {
        return { alerted: false, reason: "insufficient-candidates" };
      }

      const nowMs = this.now();
      const cooldownMs = settings.backlogPressureAlertCooldownMs ?? 24 * 60 * 60_000;
      const detectedAtIso = new Date(nowMs).toISOString();
      const dayBucket = detectedAtIso.slice(0, 10);
      const title = `${TITLE_PREFIX} ${dayBucket}`;
      const contentPayload = {
        todoCount,
        inProgressCount,
        ratio: Number(ratio.toFixed(2)),
        detectedAt: detectedAtIso,
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          priority: candidate.priority,
        })),
      };
      const content = JSON.stringify(contentPayload);
      const candidateIds = candidates.map((c) => c.id);

      let insightStore;
      try {
        if (!this.projectId) {
          throw new Error("empty projectId");
        }
        // FNXC:PostgresInsights 2026-07-14-17:25: Await the common store surface
        // so scheduled advisories persist instead of degrading to task logs.
        insightStore = this.store.getInsightStore();
      } catch (error) {
        await this.store.logEntry(candidates[0].id, `[backlog-pressure] ${content}`);
        this.logger.warn("[backlog-pressure] insight store unavailable; logged fallback payload", error);
        this.logger.warn(`[backlog-pressure] alert: todo=${todoCount} inProgress=${inProgressCount} ratio=${ratio.toFixed(2)} candidates=${candidateIds.join(",")}`);
        return { alerted: true };
      }

      if (cooldownMs > 0 && Number.isFinite(cooldownMs)) {
        const insights = await insightStore.listInsights({
          projectId: this.projectId,
          category: "workflow",
          status: "generated",
          limit: 5,
        });
        const latest = [...insights]
          .filter((insight) => insight.title.startsWith(TITLE_PREFIX))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        if (latest) {
          const updatedAt = Date.parse(latest.updatedAt);
          if (Number.isFinite(updatedAt) && nowMs - updatedAt < cooldownMs) {
            return { alerted: false, reason: "under-threshold" };
          }
        }
      }

      const fingerprint = computeInsightFingerprint(title, "workflow");
      await insightStore.upsertInsight(this.projectId, {
        title,
        content,
        category: "workflow",
        fingerprint,
        provenance: {
          trigger: "schedule",
          description: "Todo:InProgress imbalance heuristic (generated by backlog-pressure-reporter)",
          relatedEntityIds: candidateIds,
          metadata: { generator: "backlog-pressure-reporter" },
        },
      });

      this.logger.warn(`[backlog-pressure] alert: todo=${todoCount} inProgress=${inProgressCount} ratio=${ratio.toFixed(2)} candidates=${candidateIds.join(",")}`);
      return { alerted: true };
    } catch (error) {
      this.logger.error?.("[backlog-pressure] reporter failed", error);
      return { alerted: false, reason: "error" };
    }
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-19:10:
  `finishedColumns` is REQUIRED and resolved by the caller — this predicate is sync (it runs inside
  `Array.filter`, where an `await` would make every element pass) and its caller is async.

  Required rather than optional-with-a-literal-default: an optional parameter leaves `done` in the
  file as a silent fallback, and the next caller gets the pre-conversion answer by writing nothing.
  `resolveProjectColumnsForRoles` seeds the legacy ids itself, so an unconverted board is unchanged.
  */
  private isRunnableCandidate(task: Task, byId: Map<string, Task>, finishedColumns: ReadonlySet<string>): boolean {
    if (task.paused) return false;
    if ((task.blockedBy ?? "").trim().length > 0) return false;
    if ((task.overlapBlockedBy ?? "").trim().length > 0) return false;
    if (task.status === "queued") return false;

    for (const depId of task.dependencies ?? []) {
      const dependency = byId.get(depId);
      if (!dependency) continue;
      if (!finishedColumns.has(dependency.column)) {
        return false;
      }
    }

    return true;
  }
}

export { TOP_CANDIDATES };
