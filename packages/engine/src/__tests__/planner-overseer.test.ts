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
