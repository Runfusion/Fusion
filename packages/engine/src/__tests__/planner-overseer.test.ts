import { describe, expect, it, vi } from "vitest";
import {
  OVERSEER_WATCHED_STAGES,
  PlannerOverseerMonitor,
  resolveWatchedStage,
  type OverseerTaskRef,
} from "../planner-overseer.js";

function taskFixture(overrides: Partial<OverseerTaskRef> = {}): OverseerTaskRef {
  return {
    id: "FN-1000",
    column: "in-progress",
    prInfo: undefined,
    reviewState: undefined,
    paused: false,
    pausedReason: undefined,
    workflowTransitionNotification: undefined,
    ...overrides,
  } as OverseerTaskRef;
}

describe("resolveWatchedStage", () => {
  it("resolves an active in-progress task to executor", () => {
    expect(resolveWatchedStage(taskFixture({ column: "in-progress" }))).toBe("executor");
  });

  it("resolves in-review with a pending reviewState to reviewer", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-review",
          reviewState: {
            source: "reviewer-agent",
            items: [],
            addressing: [],
          } as unknown as OverseerTaskRef["reviewState"],
        }),
      ),
    ).toBe("reviewer");
  });

  it("resolves in-review with no reviewState/PR/gate marker to merger (awaiting integration)", () => {
    expect(resolveWatchedStage(taskFixture({ column: "in-review" }))).toBe("merger");
  });

  it("resolves in-review with an explicit manual-merge-hold marker to merger", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-review",
          reviewState: {
            source: "reviewer-agent",
            items: [],
            addressing: [],
          } as unknown as OverseerTaskRef["reviewState"],
          workflowTransitionNotification: {
            kind: "manual-merge-hold",
            column: "in-review",
            transitionId: "t-1",
          } as unknown as OverseerTaskRef["workflowTransitionNotification"],
        }),
      ),
    ).toBe("merger");
  });

  it("resolves in-review with an active (open) PR to pull-request", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-review",
          prInfo: {
            url: "https://github.com/o/r/pull/1",
            number: 1,
            status: "open",
            title: "t",
            headBranch: "h",
            baseBranch: "b",
            commentCount: 0,
          } as unknown as OverseerTaskRef["prInfo"],
        }),
      ),
    ).toBe("pull-request");
  });

  it("resolves a paused workflow-cli-approval gate to workflow-gate regardless of column", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-progress",
          paused: true,
          pausedReason: "workflow-cli-approval:build: npm run build",
        }),
      ),
    ).toBe("workflow-gate");
  });

  it("resolves a paused workflow-input gate to workflow-gate", () => {
    expect(
      resolveWatchedStage(
        taskFixture({
          column: "in-review",
          paused: true,
          pausedReason: "workflow-input:ask: What environment?",
        }),
      ),
    ).toBe("workflow-gate");
  });

  it("returns null for non-monitorable columns (todo/done/archived/triage)", () => {
    for (const column of ["todo", "done", "archived", "triage"] as const) {
      expect(resolveWatchedStage(taskFixture({ column }))).toBeNull();
    }
  });

  it("deterministic precedence: workflow-gate wins over an active PR and reviewState in a compound state", () => {
    const compound = taskFixture({
      column: "in-review",
      paused: true,
      pausedReason: "workflow-cli-approval:deploy: run deploy",
      prInfo: {
        url: "https://github.com/o/r/pull/2",
        number: 2,
        status: "open",
        title: "t",
        headBranch: "h",
        baseBranch: "b",
        commentCount: 0,
      } as unknown as OverseerTaskRef["prInfo"],
      reviewState: {
        source: "reviewer-agent",
        items: [],
        addressing: [],
      } as unknown as OverseerTaskRef["reviewState"],
    });
    expect(resolveWatchedStage(compound)).toBe("workflow-gate");
  });

  it("deterministic precedence: an active PR wins over reviewState when no gate is paused", () => {
    const compound = taskFixture({
      column: "in-review",
      prInfo: {
        url: "https://github.com/o/r/pull/3",
        number: 3,
        status: "open",
        title: "t",
        headBranch: "h",
        baseBranch: "b",
        commentCount: 0,
      } as unknown as OverseerTaskRef["prInfo"],
      reviewState: {
        source: "reviewer-agent",
        items: [],
        addressing: [],
      } as unknown as OverseerTaskRef["reviewState"],
    });
    expect(resolveWatchedStage(compound)).toBe("pull-request");
  });

  it("never throws on a malformed/partial task (missing column/optional fields)", () => {
    expect(resolveWatchedStage({} as OverseerTaskRef)).toBeNull();
    expect(resolveWatchedStage(null)).toBeNull();
    expect(resolveWatchedStage(undefined)).toBeNull();
    expect(resolveWatchedStage({ id: "FN-1" } as OverseerTaskRef)).toBeNull();
  });
});

describe("PlannerOverseerMonitor.observeTask", () => {
  const stageFixtures: Array<{ stage: (typeof OVERSEER_WATCHED_STAGES)[number]; task: OverseerTaskRef }> = [
    { stage: "executor", task: taskFixture({ column: "in-progress" }) },
    {
      stage: "reviewer",
      task: taskFixture({
        column: "in-review",
        reviewState: { source: "reviewer-agent", items: [], addressing: [] } as unknown as OverseerTaskRef["reviewState"],
      }),
    },
    { stage: "merger", task: taskFixture({ column: "in-review" }) },
    {
      stage: "pull-request",
      task: taskFixture({
        column: "in-review",
        prInfo: {
          url: "https://github.com/o/r/pull/9",
          number: 9,
          status: "open",
          title: "t",
          headBranch: "h",
          baseBranch: "b",
          commentCount: 0,
        } as unknown as OverseerTaskRef["prInfo"],
      }),
    },
    {
      stage: "workflow-gate",
      task: taskFixture({ column: "in-progress", paused: true, pausedReason: "workflow-input:ask: env?" }),
    },
  ];

  it.each(stageFixtures)(
    "records exactly one observation for the $stage stage when level is not off",
    async ({ stage, task }) => {
      for (const level of ["observe", "steer", "autonomous"] as const) {
        const monitor = new PlannerOverseerMonitor();
        const observation = await monitor.observeTask(task, level);
        expect(observation).not.toBeNull();
        expect(observation?.stage).toBe(stage);
        expect(observation?.oversightLevel).toBe(level);
        expect(observation?.taskId).toBe(task.id);
        expect(observation?.sources.length).toBeGreaterThan(0);
        expect(monitor.getObservations(task.id)).toHaveLength(1);
      }
    },
  );

  it.each(stageFixtures)("records nothing and returns null for the $stage stage when level is off", async ({ task }) => {
    const monitor = new PlannerOverseerMonitor();
    const observation = await monitor.observeTask(task, "off");
    expect(observation).toBeNull();
    expect(monitor.getObservations(task.id)).toHaveLength(0);
  });

  it("returns null and records nothing when no stage is monitorable", async () => {
    const monitor = new PlannerOverseerMonitor();
    const observation = await monitor.observeTask(taskFixture({ column: "todo" }), "autonomous");
    expect(observation).toBeNull();
    expect(monitor.getObservations("FN-1000")).toHaveLength(0);
  });

  it("invokes the onObservation callback when provided", async () => {
    const onObservation = vi.fn().mockResolvedValue(undefined);
    const monitor = new PlannerOverseerMonitor({ onObservation });
    const task = taskFixture({ column: "in-progress" });
    const observation = await monitor.observeTask(task, "observe");
    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation).toHaveBeenCalledWith(observation);
  });

  it("still resolves when the onObservation callback throws (best-effort)", async () => {
    const onObservation = vi.fn().mockRejectedValue(new Error("callback exploded"));
    const monitor = new PlannerOverseerMonitor({ onObservation });
    const task = taskFixture({ column: "in-progress" });
    await expect(monitor.observeTask(task, "observe")).resolves.not.toBeNull();
    expect(monitor.getObservations(task.id)).toHaveLength(1);
  });

  it("records into the store best-effort and swallows logEntry failures", async () => {
    const store = { logEntry: vi.fn().mockRejectedValue(new Error("log failed")) };
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({ column: "in-progress" });
    await expect(monitor.observeTask(task, "observe")).resolves.not.toBeNull();
    expect(store.logEntry).toHaveBeenCalledTimes(1);
  });

  // FN-7577: an unchanged heartbeat (same stage/signal/reason) must not re-write
  // the activity feed on every poll tick — only a CHANGE re-logs; clear() resets
  // the dedup so a re-run re-logs its first observation.
  it("dedupes consecutive identical feed entries, re-logs on signal change, resets on clear", async () => {
    const store = { logEntry: vi.fn().mockResolvedValue(undefined) };
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({ column: "in-progress" });

    // Three identical healthy ticks → a single feed entry.
    await monitor.observeTask(task, "observe");
    await monitor.observeTask(task, "observe");
    await monitor.observeTask(task, "observe");
    expect(store.logEntry).toHaveBeenCalledTimes(1);

    // Signal flips (executor paused → "blocked") → re-logs once.
    const paused = { ...task, paused: true, pausedReason: "gate" };
    await monitor.observeTask(paused, "observe");
    await monitor.observeTask(paused, "observe");
    expect(store.logEntry).toHaveBeenCalledTimes(2);

    // clear() drops the dedup key so the next identical observation re-logs.
    monitor.clear(task.id);
    await monitor.observeTask(paused, "observe");
    expect(store.logEntry).toHaveBeenCalledTimes(3);
  });

  it("bounds the per-task ring buffer to the configured cap, keeping the most recent N", async () => {
    const monitor = new PlannerOverseerMonitor({ maxObservationsPerTask: 3 });
    const task = taskFixture({ column: "in-progress" });
    const observations = [];
    for (let i = 0; i < 5; i++) {
      const obs = await monitor.observeTask(task, "observe");
      observations.push(obs);
    }
    const retained = monitor.getObservations(task.id);
    expect(retained).toHaveLength(3);
    // The three retained entries should be the last three recorded (index 2,3,4).
    expect(retained.map((o) => o.observedAt)).toEqual(
      [observations[2], observations[3], observations[4]].map((o) => o!.observedAt),
    );
  });

  it("defaults the ring buffer cap to 20 entries per task", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ column: "in-progress" });
    for (let i = 0; i < 25; i++) {
      await monitor.observeTask(task, "observe");
    }
    expect(monitor.getObservations(task.id)).toHaveLength(20);
  });

  it("clear() removes retained observations for a task", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ column: "in-progress" });
    await monitor.observeTask(task, "observe");
    expect(monitor.getObservations(task.id)).toHaveLength(1);
    monitor.clear(task.id);
    expect(monitor.getObservations(task.id)).toHaveLength(0);
    expect(monitor.getObservedTaskIds()).not.toContain(task.id);
  });

  it("never throws on a malformed/partial task passed to observeTask (degrades to no-op)", async () => {
    const monitor = new PlannerOverseerMonitor();
    await expect(monitor.observeTask({} as OverseerTaskRef, "autonomous")).resolves.toBeNull();
    await expect(monitor.observeTask(undefined as unknown as OverseerTaskRef, "autonomous")).resolves.toBeNull();
  });
});

// FN-7743: executor-stage stall detection. FN-7732 was a non-paused in-progress
// task that sat stuck for hours while the overseer always reported
// `signal: "progressing"` because there was no staleness check. These tests lock
// the invariant across the enumerated data states: stale (stuck), recent
// (progressing, unchanged), paused (blocked, unchanged), and missing/malformed
// timestamp (fail-safe progressing).
describe("PlannerOverseerMonitor.observeTask — FN-7743 executor stall detection", () => {
  const THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h, mirrors the declared setting default
  const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

  function isoMsAgo(ms: number): string {
    return new Date(NOW - ms).toISOString();
  }

  it("reports stuck for a non-paused in-progress task whose last activity is older than the threshold", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-progress",
      updatedAt: isoMsAgo(THRESHOLD_MS + 60 * 60 * 1000), // 3h idle
    });

    const observation = await monitor.observeTask(task, "autonomous", {
      now: () => NOW,
      executorStuckAfterMs: THRESHOLD_MS,
    });

    expect(observation?.signal).toBe("stuck");
    expect(observation?.stage).toBe("executor");
    expect(observation?.reason).toMatch(/inactive for over \d+h/);
  });

  it("prefers columnMovedAt over updatedAt when both are present", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-progress",
      // updatedAt looks fresh, but columnMovedAt (the more specific signal) is stale.
      updatedAt: isoMsAgo(1000),
      columnMovedAt: isoMsAgo(THRESHOLD_MS + 60 * 60 * 1000),
    });

    const observation = await monitor.observeTask(task, "autonomous", {
      now: () => NOW,
      executorStuckAfterMs: THRESHOLD_MS,
    });

    expect(observation?.signal).toBe("stuck");
  });

  it("remains progressing for a non-paused in-progress task with recent activity", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-progress",
      updatedAt: isoMsAgo(5 * 60 * 1000), // 5 minutes ago — well under threshold
    });

    const observation = await monitor.observeTask(task, "autonomous", {
      now: () => NOW,
      executorStuckAfterMs: THRESHOLD_MS,
    });

    expect(observation?.signal).toBe("progressing");
  });

  it("remains progressing at exactly the threshold boundary minus one ms, and flips to stuck at/after the boundary", async () => {
    const monitor = new PlannerOverseerMonitor();
    const justUnder = taskFixture({ column: "in-progress", updatedAt: isoMsAgo(THRESHOLD_MS - 1) });
    const atThreshold = taskFixture({ column: "in-progress", updatedAt: isoMsAgo(THRESHOLD_MS) });

    const obsUnder = await monitor.observeTask(justUnder, "autonomous", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });
    expect(obsUnder?.signal).toBe("progressing");

    const obsAt = await monitor.observeTask(atThreshold, "autonomous", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });
    expect(obsAt?.signal).toBe("stuck");
  });

  it("still reports blocked (unchanged) for a paused in-progress task even with a stale timestamp", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({
      column: "in-progress",
      paused: true,
      pausedReason: "some-engine-park-reason",
      updatedAt: isoMsAgo(THRESHOLD_MS + 60 * 60 * 1000),
    });

    const observation = await monitor.observeTask(task, "autonomous", {
      now: () => NOW,
      executorStuckAfterMs: THRESHOLD_MS,
    });

    expect(observation?.signal).toBe("blocked");
  });

  it("fails safe to progressing when both updatedAt and columnMovedAt are missing", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ column: "in-progress", updatedAt: undefined, columnMovedAt: undefined });

    const observation = await monitor.observeTask(task, "autonomous", {
      now: () => NOW,
      executorStuckAfterMs: THRESHOLD_MS,
    });

    expect(observation?.signal).toBe("progressing");
  });

  it("fails safe to progressing when the timestamp is malformed/unparseable", async () => {
    const monitor = new PlannerOverseerMonitor();
    const task = taskFixture({ column: "in-progress", updatedAt: "not-a-real-date" });

    const observation = await monitor.observeTask(task, "autonomous", {
      now: () => NOW,
      executorStuckAfterMs: THRESHOLD_MS,
    });

    expect(observation?.signal).toBe("progressing");
  });

  it("defaults executorStuckAfterMs to the declared 2h default when options are omitted", async () => {
    const monitor = new PlannerOverseerMonitor();
    const staleTask = taskFixture({ column: "in-progress", updatedAt: isoMsAgo(3 * 60 * 60 * 1000) });
    const freshTask = taskFixture({ column: "in-progress", updatedAt: isoMsAgo(60 * 1000) });

    const staleObs = await monitor.observeTask(staleTask, "autonomous", { now: () => NOW });
    const freshObs = await monitor.observeTask(freshTask, "autonomous", { now: () => NOW });

    expect(staleObs?.signal).toBe("stuck");
    expect(freshObs?.signal).toBe("progressing");
  });

  // FN-7577: the dedup key must stay stable within an hour bucket so an ever-
  // changing millisecond-precise duration in the reason does not defeat dedup.
  it("keeps the stuck reason stable within the same inactivity-hour bucket for feed dedup", async () => {
    const store = { logEntry: vi.fn().mockResolvedValue(undefined) };
    const monitor = new PlannerOverseerMonitor({ store });
    const task = taskFixture({ column: "in-progress", updatedAt: isoMsAgo(THRESHOLD_MS + 5 * 60 * 1000) });

    // Two polls a few seconds apart within the same inactivity-hour bucket.
    await monitor.observeTask(task, "observe", { now: () => NOW, executorStuckAfterMs: THRESHOLD_MS });
    await monitor.observeTask(task, "observe", { now: () => NOW + 5000, executorStuckAfterMs: THRESHOLD_MS });
    expect(store.logEntry).toHaveBeenCalledTimes(1);

    // An hour-boundary crossing is a real state change — re-logs once.
    await monitor.observeTask(task, "observe", { now: () => NOW + 60 * 60 * 1000, executorStuckAfterMs: THRESHOLD_MS });
    expect(store.logEntry).toHaveBeenCalledTimes(2);
  });
});
