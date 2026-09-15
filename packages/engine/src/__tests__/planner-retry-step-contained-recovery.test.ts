/*
FNXC:PlannerOversight 2026-09-15-19:20:
FN-429. The planner's `retryStep` handler discarded the `moveTaskToContainedBackwardTarget` result and
returned `true` unconditionally, so a containment refusal was reported to `PlannerRecoveryController` as a
successful retry. On FN-428 that produced a "retry" claim roughly every 45 seconds while `lifecycle-move`
logged the same refusal and the card never moved. These cases drive the REAL production handler (extracted
from the `ProjectEngine` prototype exactly like the FN-7551 wiring suite) with the lifecycle-move seam
controlled, so every refusal shape returns false with a single deduped diagnostic while a real move still
returns true and emits its retry intervention.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const { moveTaskToContainedBackwardTarget } = vi.hoisted(() => ({ moveTaskToContainedBackwardTarget: vi.fn() }));
vi.mock("../execution/lifecycle-move.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execution/lifecycle-move.js")>();
  return { ...actual, moveTaskToContainedBackwardTarget };
});

import { ProjectEngine } from "../project-engine.js";
import type { PlannerRecoveryHandlers } from "../overseer/planner-recovery-controller.js";

interface EngineInternals {
  plannerLiveRetrySkipLogDedup: Set<string>;
  runtime: { getExecutor: () => { isTaskLiveForOverseerRetry?: (id: string) => boolean } | undefined };
  buildPlannerRecoveryHandlers(store: any): PlannerRecoveryHandlers;
}

function engineInternals(): EngineInternals {
  const engineLike = Object.create(ProjectEngine.prototype) as EngineInternals;
  engineLike.plannerLiveRetrySkipLogDedup = new Set();
  engineLike.runtime = { getExecutor: () => ({ isTaskLiveForOverseerRetry: () => false }) };
  return engineLike;
}

function fakeStore() {
  return {
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(() => ({ id: "evt-1" })),
    getTask: vi.fn(async () => task),
  } as any;
}

const task = { id: "FN-B", column: "in-progress", title: "waiting task" } as any;
const decision = { watchedStage: "executor", reason: "stalled before preflight", attemptCount: 0, attemptLimit: 3, sourceLinks: [] } as any;

describe("planner retryStep honors contained lifecycle recovery (FN-429)", () => {
  beforeEach(() => { moveTaskToContainedBackwardTarget.mockReset(); });

  it.each([
    ["in-place-recovery", { moved: false, reason: "in-place-recovery", column: "in-progress" }],
    ["no-contained-target", { moved: false, reason: "no-contained-target", column: "in-progress" }],
    ["capacity deferral", { moved: false, deferred: "capacity", detail: "destination at capacity" }],
  ] as const)("returns false and logs once for %s", async (_label, result) => {
    moveTaskToContainedBackwardTarget.mockResolvedValue(result);
    const store = fakeStore();
    const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

    const outcomes = [
      await handlers.retryStep!(task, decision, {} as any),
      await handlers.retryStep!(task, decision, {} as any),
      await handlers.retryStep!(task, decision, {} as any),
    ];

    expect(outcomes).toEqual([false, false, false]);
    expect(moveTaskToContainedBackwardTarget).toHaveBeenCalledTimes(3);
    // One durable diagnostic per (taskId, stage, reason) — three 45s polls must not flood the task log.
    expect(store.logEntry.mock.calls.filter((call: any[]) => String(call[1]).includes("retry-not-dispatched"))).toHaveLength(1);
    // No retry intervention: the attempt was never dispatched, so the budget must not be consumed.
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("still returns true and emits the retry intervention when the card really moves", async () => {
    moveTaskToContainedBackwardTarget.mockResolvedValue({ moved: true });
    const store = fakeStore();
    const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

    await expect(handlers.retryStep!(task, decision, {} as any)).resolves.toBe(true);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "overseer:intervention" }));
    expect(store.logEntry.mock.calls.filter((call: any[]) => String(call[1]).includes("retry-not-dispatched"))).toHaveLength(0);
  });

  it("keeps the live-session refusal ahead of any lifecycle move", async () => {
    const store = fakeStore();
    const internals = engineInternals();
    internals.runtime = { getExecutor: () => ({ isTaskLiveForOverseerRetry: () => true }) };
    const handlers = internals.buildPlannerRecoveryHandlers(store);

    await expect(handlers.retryStep!(task, decision, {} as any)).resolves.toBe(false);
    expect(moveTaskToContainedBackwardTarget).not.toHaveBeenCalled();
  });

  it("never grants backward-move authority to the recovery reason", async () => {
    moveTaskToContainedBackwardTarget.mockResolvedValue({ moved: false, reason: "in-place-recovery", column: "in-progress" });
    const handlers = engineInternals().buildPlannerRecoveryHandlers(fakeStore());
    await handlers.retryStep!(task, decision, {} as any);
    expect(moveTaskToContainedBackwardTarget).toHaveBeenCalledWith(expect.anything(), "FN-B", "self-healing-stranded-recovery", expect.objectContaining({ preserveProgress: true, moveSource: "engine" }), "in-progress");
  });
});
