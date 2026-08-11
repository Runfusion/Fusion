import { describe, expect, it, vi } from "vitest";
import { canonicalizePlan, createCurrentPlanEvidence, evaluateSpecDrift, type DriftReport, type SpecLock, type Task } from "@fusion/core";
import { createStoreSpecDriftRepository, SpecDriftReconciler } from "../spec-drift-reconciler.js";

const prompt = "## Mission\n\nBuild widget\n\n## File Scope\n\n- src/widget.ts\n";
const evidence = createCurrentPlanEvidence({ version: 1, sourceRevision: 1, capturedAt: "2026-08-09T07:06:00.000Z", prompt });
const lock = { version: 1, acceptedAt: "2026-08-09T07:06:00.000Z", approvalFingerprint: "approved", currentPlanVersion: 1, currentPlanHash: evidence.plan.contentHash!, plan: evidence.plan };

describe("SpecDriftReconciler", () => {
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

  it("backs a persistent outage off exponentially instead of re-firing every second", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const reconciler = new SpecDriftReconciler({
      snapshot: async () => ({ latestLock: lock, currentPlan: evidence, approvedPlanFingerprint: "approved" }),
      persist: async () => { attempts += 1; throw new Error("persistent outage"); },
    });
    await expect(reconciler.reconcile("FN-BACKOFF")).rejects.toThrow("persistent outage");
    expect(attempts).toBe(1);

    // First retry lands inside the base window (jittered to 0.5-1x).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);

    // The second must NOT fire at another flat 1s — that lockstep re-fire is what kept the
    // connection pool exhausted once every task started failing for the same shared reason.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toBe(3);
    vi.useRealTimers();
  });

  it("does not leak queued writes after stop", async () => {
    const reconciler = new SpecDriftReconciler({ snapshot: async () => ({ latestLock: lock, currentPlan: evidence }), persist: async () => { throw new Error("must not write"); } });
    reconciler.enqueue("FN-QUEUED");
    reconciler.stop();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await expect(reconciler.reconcile("FN-1")).resolves.toBeUndefined();
  });
});
