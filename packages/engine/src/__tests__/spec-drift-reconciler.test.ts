import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizePlan, createCurrentPlanEvidence, evaluateSpecDrift, type DriftReport, type SpecLock, type Task } from "@fusion/core";
import { createStoreSpecDriftRepository, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS, SpecDriftReconciler } from "../spec-drift-reconciler.js";

const prompt = "## Mission\n\nBuild widget\n\n## File Scope\n\n- src/widget.ts\n";
const evidence = createCurrentPlanEvidence({ version: 1, sourceRevision: 1, capturedAt: "2026-08-09T07:06:00.000Z", prompt });
const lock = { version: 1, acceptedAt: "2026-08-09T07:06:00.000Z", approvalFingerprint: "approved", currentPlanVersion: 1, currentPlanHash: evidence.plan.contentHash!, plan: evidence.plan };

const backoffForGap = (gap: number) => Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (gap - 1));

async function driveExactBackoffSchedule({
  random,
  attempts,
  onGapReached,
}: {
  random: () => number;
  attempts: { count: number };
  onGapReached?: (gap: number, expected: number) => void;
}): Promise<number[]> {
  const draws: number[] = [];
  const reconciler = new SpecDriftReconciler({
    snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
    persist: async () => { attempts.count += 1; throw new Error("persistent outage"); },
  }, { random: () => { const draw = random(); draws.push(draw); return draw; } });

  try {
    await expect(reconciler.reconcile("FN-BACKOFF")).rejects.toThrow("persistent outage");
    expect(attempts.count).toBe(1);
    const gaps: number[] = [];
    for (let gap = 1; gap <= 8; gap += 1) {
      const backoff = backoffForGap(gap);
      const expected = backoff * (1 + draws[gap - 1]!) / 2;
      gaps.push(expected);
      onGapReached?.(gap, expected);
      /* FNXC:SpecDrift 2026-09-12-23:41: JavaScript timeout delays are integer-millisecond values, so fake timers execute a fractional delay at its floor. Assert the final whole millisecond before that actual scheduler boundary without rounding the product delay. */
      const schedulerFiringInstant = Math.floor(expected);
      await vi.advanceTimersByTimeAsync(schedulerFiringInstant - 1);
      expect(attempts.count).toBe(gap);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts.count).toBe(gap + 1);
    }
    return gaps;
  } finally {
    reconciler.stop();
  }
}

describe("SpecDriftReconciler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("persists a deterministic out-of-scope finding without moving the task", async () => {
    const persisted: unknown[] = [];
    const reconciler = new SpecDriftReconciler({ snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved", modifiedFiles: ["src/outside.ts"] }), persist: async (_taskId, report) => { persisted.push(report); } });
    const report = await reconciler.reconcile("FN-1");
    expect(report?.findings).toContainEqual(expect.objectContaining({ kind: "scope-creep", path: "src/outside.ts" }));
    expect(persisted).toHaveLength(1);
  });
  it("projects mission alignment after the report is durably persisted", async () => {
    const persisted: string[] = [];
    const projected: string[] = [];
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved", modifiedFiles: ["src/outside.ts"] }),
      persist: async (_taskId, report) => { persisted.push(report.alignment); },
      onPersisted: async (_taskId, report) => { projected.push(report.alignment); },
    });

    await reconciler.reconcile("FN-MISSION");
    expect(persisted).toEqual(["diverged-needs-review"]);
    expect(projected).toEqual(persisted);
  });

  it("retries a failed persistence write without waiting for restart", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
      persist: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary database outage"); },
    });
    await expect(reconciler.reconcile("FN-RETRY")).rejects.toThrow("temporary database outage");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    reconciler.stop();
    vi.useRealTimers();
  });

  it("coalesces live mutation events into one fresh comparison", async () => {
    let persisted = 0;
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
      persist: async () => { persisted += 1; },
    });
    reconciler.enqueue("FN-LIVE");
    reconciler.enqueue("FN-LIVE");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(persisted).toBe(1);
    reconciler.stop();
  });

  it("retains v1 divergence through a clean v2 re-lock for event and startup reconciliation", async () => {
    const taskId = "FN-RELOCK";
    const v1 = createCurrentPlanEvidence({ version: 1, sourceRevision: 1, capturedAt: "2026-08-10T09:28:00.000Z", prompt });
    const v1Lock: SpecLock = { version: 1, acceptedAt: "2026-08-10T09:28:00.000Z", approvalFingerprint: "v1-approved", currentPlanVersion: v1.version, currentPlanHash: v1.plan.contentHash!, plan: canonicalizePlan(prompt) };
    const v1Divergence = evaluateSpecDrift({
      latestLock: v1Lock,
      currentPlan: createCurrentPlanEvidence({ version: 2, sourceRevision: 2, capturedAt: "2026-08-10T09:28:00.000Z", prompt: prompt.replace("Build widget", "Build changed widget") }),
      approvedPlanFingerprint: "v1-approved",
    });
    expect(v1Divergence.alignment).toBe("diverged-needs-review");
    const v2 = createCurrentPlanEvidence({ version: 3, sourceRevision: 3, capturedAt: "2026-08-10T09:28:00.000Z", prompt: prompt.replace("Build widget", "Build changed widget") });
    const v2Lock: SpecLock = { version: 2, acceptedAt: "2026-08-10T09:28:00.000Z", approvalFingerprint: "v2-approved", currentPlanVersion: v2.version, currentPlanHash: v2.plan.contentHash!, plan: v2.plan, priorVersion: 1 };
    const reports: DriftReport[] = [v1Divergence];
    const store = {
      getTask: async () => ({ id: taskId, approvedPlanFingerprint: "v2-approved", modifiedFiles: [] } as Task),
      getLatestSpecLock: async () => v2Lock,
      getLatestCurrentPlanEvidence: async () => v2,
      listSpecDriftReports: async () => reports,
      appendSpecDriftReport: async (_taskId: string, report: DriftReport) => {
        if (!reports.some((entry) => entry.reportHash === report.reportHash)) reports.push(report);
        return report;
      },
    };
    const reconciler = new SpecDriftReconciler(createStoreSpecDriftRepository(store));

    reconciler.enqueue(taskId);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const eventReport = reports.at(-1)!;
    expect(eventReport).toMatchObject({ alignment: "diverged-relocked-approved", lockVersion: 2, findings: [] });
    expect(eventReport.alignment).not.toBe("on-plan");

    const startupReport = await reconciler.reconcile(taskId);
    expect(startupReport).toMatchObject({ alignment: "diverged-relocked-approved", lockVersion: 2, findings: [] });
    expect(startupReport?.alignment).not.toBe("on-plan");
    reconciler.stop();
  });

  it("preserves empty, same-lock, and unavailable repository states", async () => {
    const task = { id: "FN-EDGE", approvedPlanFingerprint: "approved", modifiedFiles: [] } as Task;
    const cleanStore = {
      getTask: async () => task,
      getLatestSpecLock: async () => lock,
      getLatestCurrentPlanEvidence: async () => evidence,
      listSpecDriftReports: async (): Promise<DriftReport[]> => [],
      appendSpecDriftReport: async (_taskId: string, report: DriftReport) => report,
    };
    const divergence = evaluateSpecDrift({ latestLock: lock, currentPlan: createCurrentPlanEvidence({ version: 2, sourceRevision: 2, capturedAt: "2026-08-10T09:28:00.000Z", prompt: prompt.replace("Build widget", "Build changed widget") }), approvedPlanFingerprint: "approved" });
    const sameLockStore = { ...cleanStore, listSpecDriftReports: async (): Promise<DriftReport[]> => [{ ...divergence, lockVersion: lock.version }] };
    const unavailableStore = { ...cleanStore, getTask: async () => ({ id: "FN-UNAVAILABLE" } as Task), getLatestSpecLock: async () => undefined, getLatestCurrentPlanEvidence: async () => undefined };

    await expect(new SpecDriftReconciler(createStoreSpecDriftRepository(cleanStore)).reconcile(task.id)).resolves.toMatchObject({ alignment: "on-plan" });
    await expect(new SpecDriftReconciler(createStoreSpecDriftRepository(sameLockStore)).reconcile(task.id)).resolves.toMatchObject({ alignment: "on-plan" });
    await expect(new SpecDriftReconciler(createStoreSpecDriftRepository(unavailableStore)).reconcile("FN-UNAVAILABLE")).resolves.toMatchObject({ alignment: "unavailable" });
  });

  /*
  FNXC:SpecDrift 2026-08-10-18:32 (connection-exhaustion incident):
  Each reconcile costs a DEDICATED PostgreSQL connection — `appendSpecDriftReport` takes the
  session-scoped planning advisory lock, which opens its own `max: 1` session. So concurrency here is
  a connection count, not just a scheduling detail.

  The regression: `project-engine.ts` enqueues every task at runtime-boundary setup
  (`listTasks({ includeArchived: true })`) and `enqueue` released each id into its own microtask. On a
  1,082-task project that opened ~1,082 lock sessions at once against `max_connections = 500`; the
  cluster saturated ~25s into boot, every later query failed with "sorry, too many clients already",
  and Fusion wedged on "starting" behind the migration holding server. Measured 4,777 lock sessions in
  17 seconds. This asserts the bound that makes a large project survive boot.
  */
  it("bounds concurrent reconciles so a whole-project enqueue cannot exhaust connections", async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
      persist: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        completed += 1;
      },
    }, { maxConcurrent: 4 });

    for (let i = 0; i < 200; i += 1) reconciler.enqueue(`FN-${i}`);
    // Let every queued id get a chance to start before releasing the gate.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(peak).toBeLessThanOrEqual(4);

    release?.();
    await vi.waitFor(() => expect(completed).toBe(200), { timeout: 5_000 });
    // Bounded, but still drains everything — throughput is preserved, only fan-out is capped.
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("does not run the same task twice concurrently", async () => {
    // Two sessions on one task would contend on its own advisory lock while holding two connections.
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
      persist: async () => { active += 1; peak = Math.max(peak, active); await gate; active -= 1; },
    }, { maxConcurrent: 4 });

    reconciler.enqueue("FN-SAME");
    reconciler.enqueue("FN-SAME");
    reconciler.enqueue("FN-SAME");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(1);
    release?.();
  });

  /*
  FNXC:SpecDrift 2026-08-10-18:32 (connection-exhaustion incident):
  A shared database outage cannot retry every task in a one-second lockstep. This suite pins and
  observes each jittered delay exactly, including the two ceiling gaps that prove retries saturate.
  */
  it("backs a persistent outage off exponentially instead of re-firing every second", async () => {
    vi.useFakeTimers();
    const sources = [
      () => 0,
      () => 0.5,
      () => 0.998,
      (() => { const draws = [0, 0.5, 0.998, 0, 0.5, 0.998, 0.998, 0.998]; let index = 0; return () => draws[index++ % draws.length]!; })(),
    ];

    for (const random of sources) {
      const attempts = { count: 0 };
      const gaps = await driveExactBackoffSchedule({ random, attempts });
      expect(gaps.slice(0, 6).map((_gap, index) => backoffForGap(index + 1))).toEqual([
        RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * 2, RETRY_BASE_DELAY_MS * 4,
        RETRY_BASE_DELAY_MS * 8, RETRY_BASE_DELAY_MS * 16, RETRY_BASE_DELAY_MS * 32,
      ]);
      expect(backoffForGap(7)).toBe(RETRY_MAX_DELAY_MS);
      expect(backoffForGap(8)).toBe(RETRY_MAX_DELAY_MS);
      expect(gaps[6]).toBe(gaps[7]);
      expect(gaps.every((gap) => gap <= RETRY_MAX_DELAY_MS)).toBe(true);
    }
  });

  it("holds the exact backoff schedule for arbitrary unpinned jitter draws", async () => {
    vi.useFakeTimers();
    const draws: number[] = [];
    const attempts = { count: 0 };
    const gaps = await driveExactBackoffSchedule({
      random: () => { const draw = Math.random(); draws.push(draw); return draw; },
      attempts,
    });
    const replay = `recorded draws: ${JSON.stringify(draws)}`;
    /* FNXC:SpecDrift 2026-09-12-23:19: Attempt nine arms an unused successor before helper cleanup, so retain its draw in replay evidence while asserting the eight observed gaps. */
    expect(draws, replay).toHaveLength(9);
    for (const [index, draw] of draws.slice(0, 8).entries()) {
      const backoff = backoffForGap(index + 1);
      expect(draw, replay).toBeGreaterThanOrEqual(0);
      expect(draw, replay).toBeLessThan(1);
      expect(gaps[index]!, replay).toBeGreaterThanOrEqual(backoff / 2);
      expect(gaps[index]!, replay).toBeLessThan(backoff);
    }
  });

  it("keeps the exact backoff schedule when unrelated timers and microtasks are interleaved", async () => {
    vi.useFakeTimers();
    const attempts = { count: 0 };
    let ambient = 0;
    const interval = setInterval(() => { ambient += 1; queueMicrotask(() => { ambient += 1; }); void Promise.resolve().then(() => { ambient += 1; }); }, 25);
    try {
      await driveExactBackoffSchedule({
        random: () => 0,
        attempts,
        onGapReached: (_gap, expected) => {
          for (const offset of [expected / 3, expected / 2]) {
            setTimeout(() => { ambient += 1; queueMicrotask(() => { ambient += 1; }); void Promise.resolve().then(() => { ambient += 1; }); }, offset);
          }
        },
      });
      expect(ambient).toBeGreaterThan(0);
    } finally {
      clearInterval(interval);
    }
  });

  it("resets backoff after a successful retry", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
      persist: async () => { attempts += 1; if (attempts !== 3) throw new Error("outage"); },
    }, { random: () => 0 });
    try {
      await expect(reconciler.reconcile("FN-RESET")).rejects.toThrow("outage");
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(3);
      await expect(reconciler.reconcile("FN-RESET")).rejects.toThrow("outage");
      await vi.advanceTimersByTimeAsync(499);
      expect(attempts).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(5);
    } finally {
      reconciler.stop();
    }
  });

  it("does not double-arm a retry already pending for the same task", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
      persist: async () => { attempts += 1; throw new Error("outage"); },
    }, { random: () => 0 });
    try {
      await expect(reconciler.reconcile("FN-DUPLICATE")).rejects.toThrow("outage");
      await expect(reconciler.reconcile("FN-DUPLICATE")).rejects.toThrow("outage");
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(3);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(4);
    } finally {
      reconciler.stop();
    }
  });

  it("cancels a pending retry when stopped", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
      persist: async () => { attempts += 1; throw new Error("outage"); },
    }, { random: () => 0 });
    await expect(reconciler.reconcile("FN-STOP")).rejects.toThrow("outage");
    reconciler.stop();
    await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS * 2);
    expect(attempts).toBe(1);
  });

  it("does not leak queued writes after stop", async () => {
    const reconciler = new SpecDriftReconciler({ snapshot: async () => ({ latestLock: lock, currentPlan: evidence }), persist: async () => { throw new Error("must not write"); } });
    reconciler.enqueue("FN-QUEUED");
    reconciler.stop();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await expect(reconciler.reconcile("FN-1")).resolves.toBeUndefined();
  });
});
