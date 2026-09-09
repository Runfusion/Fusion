import { evaluateSpecDrift, hasPriorLockDivergence, type CurrentPlanEvidence, type DriftReport, type SpecLock, type TaskStore } from "@fusion/core";

export interface SpecDriftSnapshot {
  latestLock?: SpecLock;
  currentPlan?: CurrentPlanEvidence;
  approvedPlanFingerprint?: string;
  modifiedFiles?: string[];
  priorDivergence?: boolean;
}
export interface SpecDriftRepository {
  snapshot(taskId: string): Promise<SpecDriftSnapshot>;
  persist(taskId: string, report: DriftReport): Promise<void>;
  onPersisted?(taskId: string, report: DriftReport): Promise<void>;
}

/*
FNXC:SpecDrift 2026-08-10-18:32 (connection-exhaustion incident):
Reconciliation is CONCURRENCY-BOUNDED because each run costs a dedicated PostgreSQL connection, not a
pooled one. `persist` -> `appendSpecDriftReport` -> `withPlanningLifecycleLock` opens its own
`postgres(directUrl, { max: 1 })` session, because the planning advisory lock is session-scoped and
deliberately fences a stale report against a newer plan (see `appendSpecDriftReportWhilePlanningLocked`).

Unbounded fan-out therefore converts directly into unbounded connections. At runtime boundary setup
`project-engine.ts` enqueues every live task (`listTasks({ includeArchived: false })`) and `enqueue` released
each one straight into a `queueMicrotask`, so a 1,082-task project opened ~1,082 lock sessions at once
against `max_connections = 500`. The cluster saturated ~25s into boot; every later query then failed
with "sorry, too many clients already", including the engine's own startup, so Fusion wedged on
"starting" behind the migration holding server and never recovered.

The flat 1s retry made it self-sustaining rather than transient: once saturated, every task failed and
re-armed at a fixed 1s, so ~1,082 tasks re-opened ~1,082 sessions every second indefinitely (measured:
4,777 lock sessions in 17s). Backoff is exponential + jittered so a persistent outage decays instead of
pinning the resource it is waiting on.
*/
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;
/** Max simultaneous reconciles, i.e. max simultaneous planning-lock sessions this component holds. */
const DEFAULT_MAX_CONCURRENT_RECONCILES = 4;

/**
 * FNXC:SpecDrift 2026-08-10-09:28:
 * Startup replay and live task mutations share this repository so both reconcile retained evidence
 * identically without treating drift as a lifecycle or quality verdict. A latest-report-only read
 * erases v1 divergence after a clean v2 re-lock; report identity fencing cannot prevent that
 * incorrect alignment because alignment is deliberately not part of the identity.
 */
export function createStoreSpecDriftRepository(
  store: Pick<TaskStore, "getTask" | "getLatestSpecLock" | "getLatestCurrentPlanEvidence" | "listSpecDriftReports" | "appendSpecDriftReport">,
  onPersisted?: SpecDriftRepository["onPersisted"],
): SpecDriftRepository {
  return {
    snapshot: async (taskId) => {
      const [task, latestLock, currentPlan, reports] = await Promise.all([
        store.getTask(taskId),
        store.getLatestSpecLock(taskId),
        store.getLatestCurrentPlanEvidence(taskId),
        store.listSpecDriftReports(taskId),
      ]);
      return {
        latestLock,
        currentPlan,
        approvedPlanFingerprint: task.approvedPlanFingerprint,
        modifiedFiles: task.modifiedFiles,
        priorDivergence: hasPriorLockDivergence(reports, latestLock?.version),
      };
    },
    persist: async (taskId, report) => { await store.appendSpecDriftReport(taskId, report); },
    onPersisted,
  };
}

/**
 * FNXC:SpecDrift 2026-08-09-18:17:
 * A report-write outage must retry from a fresh snapshot without waiting for process restart.
 * Timers coalesce per task and are cancelled on stop; retries never alter task lifecycle state.
 */
export class SpecDriftReconciler {
  private stopped = false;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Waiting to run. Insertion-ordered, so a burst is drained fairly rather than by task id. */
  private readonly queuedTaskIds = new Set<string>();
  /** Running right now — each one holds a dedicated planning-lock connection. */
  private readonly inFlightTaskIds = new Set<string>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly maxConcurrent: number;

  public constructor(
    private readonly repository: SpecDriftRepository,
    options: { maxConcurrent?: number } = {},
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_RECONCILES);
  }

  /**
   * FNXC:SpecDrift 2026-08-09-18:32:
   * Live task events can arrive in one transaction-sized burst. Queue one fresh comparison per
   * task rather than making event delivery a polling loop; persistence still fences the snapshot.
   *
   * FNXC:SpecDrift 2026-08-10-18:32:
   * The queue is now DRAINED by a bounded pump instead of releasing every id into its own
   * microtask. The previous version deleted the dedupe key before the work ran, so it coalesced
   * only ids still waiting in the same tick — a startup sweep over every task, or repeated
   * `task:updated` events, still produced one concurrent run (and one connection) per task.
   */
  enqueue(taskId: string): void {
    if (this.stopped) return;
    // Already waiting, or already running with a re-run implied by the in-flight pass.
    if (this.queuedTaskIds.has(taskId)) return;
    this.queuedTaskIds.add(taskId);
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.queuedTaskIds.clear();
    this.retryAttempts.clear();
  }

  /**
   * Start queued work up to the concurrency limit.
   *
   * Skips ids already in flight: a second reconcile for the same task would contend on the same
   * per-task advisory lock while holding a second connection, which is the worst of both costs.
   * Such an id stays queued and is picked up when its current pass finishes.
   */
  private pump(): void {
    if (this.stopped) return;
    while (this.inFlightTaskIds.size < this.maxConcurrent) {
      let next: string | undefined;
      for (const candidate of this.queuedTaskIds) {
        if (!this.inFlightTaskIds.has(candidate)) { next = candidate; break; }
      }
      if (next === undefined) return;
      this.queuedTaskIds.delete(next);
      this.inFlightTaskIds.add(next);
      const taskId = next;
      void this.reconcile(taskId)
        .catch(() => undefined)
        .finally(() => {
          this.inFlightTaskIds.delete(taskId);
          this.pump();
        });
    }
  }

  async reconcile(taskId: string): Promise<DriftReport | undefined> {
    if (this.stopped) return undefined;
    try {
      const snapshot = await this.repository.snapshot(taskId);
      if (this.stopped) return undefined;
      const report = evaluateSpecDrift(snapshot);
      if (this.stopped) return undefined;
      await this.repository.persist(taskId, report);
      /* FNXC:SpecLockMissionAlignment 2026-08-10-16:40: publish mission alignment only after the report is durable, so failed projection retries retained evidence. */
      await this.repository.onPersisted?.(taskId, report);
      const retry = this.retryTimers.get(taskId);
      if (retry) clearTimeout(retry);
      this.retryTimers.delete(taskId);
      this.retryAttempts.delete(taskId);
      return report;
    } catch (error) {
      this.scheduleRetry(taskId);
      throw error;
    }
  }

  /**
   * FNXC:SpecDrift 2026-08-10-18:32:
   * Exponential backoff with jitter, replacing a flat 1s. The failure this guards against is a
   * SHARED-resource outage: every task fails for the same reason at the same time, so a fixed delay
   * re-fires the whole fleet in lockstep once per second and keeps the resource exhausted. Retries
   * re-enter through `enqueue`, so they are also subject to the concurrency bound — a retry storm
   * can never open more connections than a first pass.
   */
  private scheduleRetry(taskId: string): void {
    if (this.stopped || this.retryTimers.has(taskId)) return;
    const attempt = (this.retryAttempts.get(taskId) ?? 0) + 1;
    this.retryAttempts.set(taskId, attempt);
    const backoff = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      this.enqueue(taskId);
    }, delay);
    // Never hold the event loop open for a retry — this is best-effort background repair.
    timer.unref?.();
    this.retryTimers.set(taskId, timer);
  }
}
