import {
  getTaskAgeStalenessSignal,
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
    const [inProgress, inReview] = await Promise.all([
      this.store.listTasks({ column: "in-progress", slim: false }),
      this.store.listTasks({ column: "in-review", slim: false }),
    ]);

    let surfaced = 0;
    for (const task of [...inProgress, ...inReview]) {
      const updatedAtMs = Date.parse(task.updatedAt);
      if (Number.isFinite(updatedAtMs) && updatedAtMs >= cycleStartMs) {
        continue;
      }

      let signal;
      try {
        signal = getTaskAgeStalenessSignal(task, { now: cycleStartMs, thresholds });
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
