import {
  getTaskAgeStalenessSignal,
  resolveProjectColumnsForRoles,
  resolveTaskLifecycleColumns,
  REVIEW_ROLES,
  type WorkflowIr,
  type Task,
  type TaskStore,
  type Settings,
} from "@fusion/core";
import { schedulerLog } from "./logger.js";

const STALE_LOG_PREFIX = "Stale task age threshold crossed";
const STALE_LOG_RE = /^Stale task age threshold crossed \[(warning|critical)\]/;

interface StaleTaskReporterOptions {
  store: TaskStore;
  logger?: Pick<typeof schedulerLog, "log" | "warn" | "error">;
  now?: () => number;
}

export class StaleTaskReporter {
  private readonly store: TaskStore;
  private readonly logger: Pick<typeof schedulerLog, "log" | "warn" | "error">;
  private readonly now: () => number;

  constructor(options: StaleTaskReporterOptions) {
    this.store = options.store;
    this.logger = options.logger ?? schedulerLog;
    this.now = options.now ?? (() => Date.now());
  }

  async report(): Promise<{ surfaced: number }> {
    const settings = await this.store.getSettings();
    const thresholds = this.getThresholds(settings);
    const hasAnyThreshold = Object.values(thresholds).some((value) => typeof value === "number" && value > 0);
    if (!hasAnyThreshold) {
      return { surfaced: 0 };
    }

    const cycleStartMs = this.now();
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-22:20:
    THE QUERY, not a comparison — this file's census count is ZERO and it was inert anyway.

    `listTasks({ column })` filters in the store, so on a board whose lanes are renamed both reads
    return EMPTY and the reporter surfaces nothing: no stale-task signal is ever raised, on exactly
    the board where work is most likely to be sitting unnoticed. Nothing errors, and no entry in the
    lifecycle backlog points here, because a query filter is not a comparison.

    Resolved through `resolveProjectColumnsForRoles`, which answers the PROJECT-level question a read
    needs — there is no task in hand yet — and always unions the legacy ids, so a board mid-rename
    still surfaces rows stored under the old ones.

    Second demonstration of the class after `backlog-pressure-reporter`; the pattern is three lines
    (resolve the roles, iterate the set, dedupe by id) and is deliberately identical between them.
    */
    const [wipColumns, reviewColumns] = await Promise.all([
      resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]),
      resolveProjectColumnsForRoles(this.store, REVIEW_ROLES),
    ]);
    const listByColumns = async (columns: ReadonlySet<string>): Promise<Task[]> => {
      const byId = new Map<string, Task>();
      for (const column of columns) {
        for (const task of await this.store.listTasks({ column, slim: false })) byId.set(task.id, task);
      }
      return [...byId.values()];
    };
    const [inProgress, inReview] = await Promise.all([
      listByColumns(wipColumns),
      listByColumns(reviewColumns),
    ]);

    /* One IR cache for the sweep, per the caller-owned-cache contract. */
    const staleIrCache = new Map<string, WorkflowIr>();
    let surfaced = 0;
    for (const task of [...inProgress, ...inReview]) {
      const updatedAtMs = Date.parse(task.updatedAt);
      if (Number.isFinite(updatedAtMs) && updatedAtMs >= cycleStartMs) {
        continue;
      }

      let signal;
      try {
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-31-22:40:
        BOTH LAYERS, and the second only became visible once the first was fixed.

        `getTaskAgeStalenessSignal` takes an optional `lifecycle` and defaults to the legacy pair, so
        a card the widened query now returns was still refused inside the signal — it answered
        `undefined` for every renamed lane. Converting only the query would have moved the failure one
        frame deeper and left `surfaced: 0` exactly as before; my test caught it precisely because it
        asserts the OUTCOME rather than the query argument.

        Resolved per task, because a board spans workflows and this is a per-card question — the flat
        project vocabulary above is correct for the READ and wrong for this.
        */
        const lifecycle = await resolveTaskLifecycleColumns(this.store, task.id, staleIrCache);
        signal = getTaskAgeStalenessSignal(task, {
          now: cycleStartMs,
          thresholds,
          ...(lifecycle ? { lifecycle } : {}),
        });
      } catch (error) {
        if (error instanceof RangeError) {
          this.logger.warn(`Stale task reporter disabled by invalid thresholds: ${error.message}`);
          return { surfaced };
        }
        throw error;
      }
      if (!signal) {
        continue;
      }

      if (!this.shouldEmit(task, signal.level, signal.warningThresholdMs, signal.criticalThresholdMs, cycleStartMs)) {
        continue;
      }

      const message = `${STALE_LOG_PREFIX} [${signal.level}]: column=${signal.column} paused=${String(signal.paused)} ageMs=${signal.ageMs} warningThresholdMs=${signal.warningThresholdMs} criticalThresholdMs=${signal.criticalThresholdMs}`;
      await this.store.logEntry(task.id, message);
      this.logger.log(message);
      surfaced++;
    }

    return { surfaced };
  }

  private getThresholds(settings: Settings) {
    return {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
  }

  private shouldEmit(
    task: Task,
    level: "warning" | "critical",
    warningThresholdMs: number,
    criticalThresholdMs: number,
    nowMs: number,
  ): boolean {
    const last = [...(task.log ?? [])].reverse().find((entry) => STALE_LOG_RE.test(entry.action));
    if (!last) {
      return true;
    }

    const match = last.action.match(STALE_LOG_RE);
    if (!match) {
      return true;
    }

    const lastLevel = match[1] as "warning" | "critical";
    if (lastLevel !== level) {
      return true;
    }

    const lastTs = Date.parse(last.timestamp);
    if (!Number.isFinite(lastTs)) {
      return true;
    }

    const windowMs = level === "critical" ? criticalThresholdMs : warningThresholdMs;
    if (windowMs <= 0) {
      return true;
    }

    return nowMs - lastTs >= windowMs;
  }
}
