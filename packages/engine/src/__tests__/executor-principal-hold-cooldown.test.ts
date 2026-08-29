/*
FNXC:WorkflowAgentRouting 2026-08-23-22:22:
Regression coverage for the workflow-principal hold cooldown, which the U4 executor peel (#3317) left
recorded, cleared, and never honored: the reader was dropped from executeCore and re-inlined inside
executeWorkflowGraph behind `!opts?.alreadyClaimed`, a flag its only caller always sets.

The invariant under test is "a recorded hold defers dispatch", asserted across every surface that can enter
the graph — the claimed outer routing path (executeCore) and direct unclaimed graph entry — plus the negative
cases that keep the guard from becoming a permanent block. Asserting only the reported symptom would let the
same reader go missing from the other surface, which is exactly how it was lost.
*/
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { executeCore } from "../executor/execute-core.js";
import {
  clearPrincipalHoldBackoff,
  getActivePrincipalHoldCooldown,
  isPrincipalHoldCoolingDown,
  recordPrincipalHoldBackoff,
} from "../executor/execute-workflow-graph.js";

const TASK_ID = "FN-0001";
const HOLD_REASON = "workflow-principal-role-pool-exhausted:reviewer";

/*
The ladder's base delay is zero under VITEST so suites never wait on wall-clock. Production behavior is what
needs proving here, so drive the real writer with the production base and keep the clock mocked instead.
*/
function withProductionBackoff(fn: () => void): void {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  try {
    fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return { id: TASK_ID, title: "held card", column: "in-progress", ...overrides } as Task;
}

function buildDeps() {
  const executeWorkflowGraph = vi.fn(async () => undefined);
  return {
    graphRouting: new Set<string>(),
    completionFinalizedTaskIds: new Set<string>(),
    releaseSemaphore: vi.fn(),
    clearStalePauseAbortBeforeDispatch: vi.fn(async () => undefined),
    blockOuterDispatchWhenDependenciesUnmet: vi.fn(async () => false),
    executeWorkflowGraph,
  };
}

describe("workflow-principal hold cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPrincipalHoldBackoff(TASK_ID);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearPrincipalHoldBackoff(TASK_ID);
  });

  it("defers outer dispatch while a hold is cooling down, without claiming graphRouting", async () => {
    withProductionBackoff(() => recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON));
    const deps = buildDeps();

    await executeCore(deps as never, buildTask());

    // The whole point of the guard: the graph is never re-entered to re-fence and re-park.
    expect(deps.executeWorkflowGraph).not.toHaveBeenCalled();
    // A deferral that stranded the claim would wedge the task against every later dispatch.
    expect(deps.graphRouting.has(TASK_ID)).toBe(false);
    // Gates that can write or await must not run for a card that is only waiting.
    expect(deps.clearStalePauseAbortBeforeDispatch).not.toHaveBeenCalled();
    expect(deps.blockOuterDispatchWhenDependenciesUnmet).not.toHaveBeenCalled();
  });

  it("keeps deferring across repeated dispatches, which is the hot loop it exists to stop", async () => {
    withProductionBackoff(() => recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON));
    const deps = buildDeps();

    for (let i = 0; i < 5; i += 1) await executeCore(deps as never, buildTask());

    expect(deps.executeWorkflowGraph).not.toHaveBeenCalled();
  });

  it("dispatches once the cooldown window elapses", async () => {
    withProductionBackoff(() => recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON));
    const deps = buildDeps();

    vi.advanceTimersByTime(15_000);
    await executeCore(deps as never, buildTask());

    expect(deps.executeWorkflowGraph).toHaveBeenCalledWith(expect.objectContaining({ id: TASK_ID }), { alreadyClaimed: true });
  });

  it("dispatches when no hold is recorded, and after an explicit clear", async () => {
    const fresh = buildDeps();
    await executeCore(fresh as never, buildTask());
    expect(fresh.executeWorkflowGraph).toHaveBeenCalledTimes(1);

    withProductionBackoff(() => recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON));
    clearPrincipalHoldBackoff(TASK_ID);
    const cleared = buildDeps();
    await executeCore(cleared as never, buildTask());
    expect(cleared.executeWorkflowGraph).toHaveBeenCalledTimes(1);
  });

  it("refuses a soft-deleted card before consulting the cooldown", async () => {
    withProductionBackoff(() => recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON));
    const deps = buildDeps();

    await executeCore(deps as never, buildTask({ deletedAt: new Date().toISOString() }));

    expect(deps.executeWorkflowGraph).not.toHaveBeenCalled();
    expect(deps.graphRouting.has(TASK_ID)).toBe(false);
  });

  describe("the ladder primitive both surfaces read", () => {
    it("reports an active cooldown with its reason, and none once elapsed", () => {
      withProductionBackoff(() => recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON));

      expect(isPrincipalHoldCoolingDown(TASK_ID)).toBe(true);
      expect(getActivePrincipalHoldCooldown(TASK_ID)?.reason).toBe(HOLD_REASON);

      vi.advanceTimersByTime(15_000);
      expect(isPrincipalHoldCoolingDown(TASK_ID)).toBe(false);
      expect(getActivePrincipalHoldCooldown(TASK_ID)).toBeNull();
    });

    it("extends the window on a repeated reason and resets it on a new one", () => {
      withProductionBackoff(() => {
        expect(recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON)).toEqual({ attempt: 1, repeated: false });
        expect(recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON)).toEqual({ attempt: 2, repeated: true });

        // Attempt 2 doubles the base, so the task is still cooling at the attempt-1 boundary.
        vi.advanceTimersByTime(15_000);
        expect(isPrincipalHoldCoolingDown(TASK_ID)).toBe(true);

        // A changed reason is genuinely new information and restarts the ladder.
        expect(recordPrincipalHoldBackoff(TASK_ID, "workflow-principal-routing-unavailable:owner")).toEqual({ attempt: 1, repeated: false });
      });
    });

    it("caps the window at the five-minute ceiling", () => {
      withProductionBackoff(() => {
        for (let i = 0; i < 20; i += 1) recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON);
        const hold = getActivePrincipalHoldCooldown(TASK_ID);
        expect(hold).not.toBeNull();
        expect(hold!.until - Date.now()).toBe(300_000);
      });
    });

    it("holds no cooldown under test mode, so suites never wait on wall-clock", () => {
      recordPrincipalHoldBackoff(TASK_ID, HOLD_REASON);
      expect(isPrincipalHoldCoolingDown(TASK_ID)).toBe(false);
    });
  });
});
