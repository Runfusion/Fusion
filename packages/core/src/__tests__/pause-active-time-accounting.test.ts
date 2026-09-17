// @vitest-environment node
/*
FN-457 — durable paused-time accounting.

The task card's clock chip must show worked time, so pause has to be subtracted; subtracting it
requires banking it, and banking it requires that EVERY seam which writes `task.paused` close the
segment it may have opened elsewhere. A segment opened by an explicit pause and then cleared by,
say, lifecycle reset would stay open forever, and a reader that keeps subtracting an interval that
ended hours ago produces a chip WORSE than the wall clock this work replaces.

These cases therefore drive the shared helper AND each production seam, plus the negative control
that pause accounting never disturbs the execution anchors self-healing and resume depend on.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { applyPauseAccounting, computePauseAccountingPatch } from "../tasks/task-pause-accounting.js";
import { buildResetTask } from "../task-store/reset-lifecycle.js";
import { clearDoneTransientFieldsImpl } from "../task-store/task-artifacts-ops.js";
import {
  __resetDefaultWorkflowHooksForTests,
  applyResetOnEntryEffects,
  registerDefaultWorkflowHooks,
  type DefaultWorkflowMoveContext,
} from "../workflows/default-workflow-hooks.js";
import { __resetTraitRegistryForTests } from "../workflows/trait-registry.js";
import { registerBuiltinTraits } from "../builtin-traits.js";
import { planLegacyAdoption } from "../db/legacy-adoption.js";
import type { Task, TaskStore } from "../types.js";

const T0 = "2026-09-16T10:00:00.000Z";
const T5M = "2026-09-16T10:05:00.000Z";
const T20M = "2026-09-16T10:20:00.000Z";
/** Frozen "now", 30 minutes after T0, so seams that stamp `Date.now()` are deterministic. */
const NOW = "2026-09-16T10:30:00.000Z";
const FIVE_MIN = 5 * 60_000;
const TWENTY_MIN = 20 * 60_000;
const THIRTY_MIN = 30 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-457",
    title: "Clock chip",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: T0,
    updatedAt: T0,
    firstExecutionAt: T0,
    executionStartedAt: T0,
    cumulativeActiveMs: 600_000,
    ...overrides,
  } as unknown as Task;
}

/** The three anchors self-healing and resume read; pause accounting must never move them. */
function anchorsOf(t: Task) {
  return {
    executionStartedAt: t.executionStartedAt,
    firstExecutionAt: t.firstExecutionAt,
    cumulativeActiveMs: t.cumulativeActiveMs,
  };
}

describe("applyPauseAccounting — the shared contract", () => {
  it("opens a segment when a wip-lane card becomes paused", () => {
    const t = task();
    applyPauseAccounting(t, true, T0, true);
    expect(t.pausedStartedAt).toBe(T0);
    expect(t.cumulativePausedMs).toBeUndefined();
  });

  it("banks exactly the elapsed delta when the card resumes", () => {
    const t = task();
    applyPauseAccounting(t, true, T0, true);
    applyPauseAccounting(t, false, T5M, true);
    expect(t.cumulativePausedMs).toBe(FIVE_MIN);
    expect(t.pausedStartedAt).toBeUndefined();
  });

  it("adds to an existing bank across repeated pause cycles", () => {
    const t = task({ cumulativePausedMs: FIVE_MIN });
    applyPauseAccounting(t, true, T5M, true);
    applyPauseAccounting(t, false, T20M, true);
    expect(t.cumulativePausedMs).toBe(FIVE_MIN + (TWENTY_MIN - FIVE_MIN));
  });

  it("does not open a second segment on a consecutive pause", () => {
    const t = task();
    applyPauseAccounting(t, true, T0, true);
    applyPauseAccounting(t, true, T5M, true);
    expect(t.pausedStartedAt).toBe(T0);
  });

  it("opens no segment when the card is not in a wip lane", () => {
    const t = task({ column: "in-review" });
    applyPauseAccounting(t, true, T0, false);
    expect(t.pausedStartedAt).toBeUndefined();
    expect(t.cumulativePausedMs).toBeUndefined();
  });

  it("is a no-op when resuming with no open segment", () => {
    const t = task();
    applyPauseAccounting(t, false, T5M, true);
    expect(t.cumulativePausedMs).toBeUndefined();
    expect(t.pausedStartedAt).toBeUndefined();
  });

  it("banks zero rather than a negative value for an out-of-order anchor", () => {
    const t = task({ pausedStartedAt: T20M });
    applyPauseAccounting(t, false, T0, true);
    expect(t.cumulativePausedMs).toBe(0);
    expect(t.pausedStartedAt).toBeUndefined();
  });

  it("clears an unparseable anchor without banking", () => {
    const t = task({ pausedStartedAt: "not-a-timestamp" });
    applyPauseAccounting(t, false, T5M, true);
    expect(t.cumulativePausedMs).toBeUndefined();
    expect(t.pausedStartedAt).toBeUndefined();
  });

  it("never touches the execution anchors that self-healing and resume read", () => {
    const t = task();
    const before = anchorsOf(t);
    applyPauseAccounting(t, true, T0, true);
    applyPauseAccounting(t, false, T20M, true);
    expect(anchorsOf(t)).toEqual(before);
  });

  it("computePauseAccountingPatch reports only the fields that change", () => {
    const open = computePauseAccountingPatch(task(), true, T0, true);
    expect(open).toEqual({ pausedStartedAt: T0 });

    const close = computePauseAccountingPatch(task({ pausedStartedAt: T0 }), false, T5M, true);
    expect(close).toEqual({ cumulativePausedMs: FIVE_MIN, pausedStartedAt: undefined });

    expect(computePauseAccountingPatch(task(), false, T5M, true)).toEqual({});
  });
});

/*
`pauseTaskImpl` is the primary seam. It needs a TaskStore, so it is driven against a minimal fake
that implements only the collaborators it actually calls — this exercises the production function
itself rather than a re-implementation, and stays runnable without PostgreSQL.
*/
vi.mock("../workflows/workflow-lifecycle-traits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflows/workflow-lifecycle-traits.js")>();
  return {
    ...actual,
    resolveTaskLifecycleColumns: vi.fn(async () => ({
      intake: "triage",
      hold: "todo",
      wip: "building",
      review: "verifying",
      complete: "shipped",
    })),
  };
});

const { pauseTaskImpl } = await import("../task-store/branch-group-ops.js");

function fakeStore(current: Task): { store: TaskStore; written: Task[] } {
  const written: Task[] = [];
  const store = {
    withTaskLock: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    taskDir: () => "/tmp/fn-457",
    readTaskJson: async () => current,
    atomicWriteTaskJson: async (_dir: string, t: Task) => { written.push(t); },
    atomicWriteTaskJsonWithAudit: async (_dir: string, t: Task) => { written.push(t); },
    isWatching: false,
    taskCache: new Map(),
    emit: () => true,
  } as unknown as TaskStore;
  return { store, written };
}

describe("pauseTaskImpl — the explicit pause/unpause seam", () => {
  it("opens a segment for a wip-lane pause and banks it on resume", async () => {
    const live = task({ column: "building" });
    const paused = await pauseTaskImpl(fakeStore(live).store, live.id, true);
    expect(paused.pausedStartedAt).toBeTruthy();

    expect(paused.pausedStartedAt).toBe(NOW);

    vi.setSystemTime(new Date(Date.parse(NOW) + FIVE_MIN));
    const resumed = await pauseTaskImpl(fakeStore(paused).store, paused.id, false);
    expect(resumed.pausedStartedAt).toBeUndefined();
    expect(resumed.cumulativePausedMs).toBe(FIVE_MIN);
  });

  it("opens no segment when the paused card is outside the wip lane", async () => {
    const reviewing = task({ column: "verifying" });
    const paused = await pauseTaskImpl(fakeStore(reviewing).store, reviewing.id, true);
    expect(paused.pausedStartedAt).toBeUndefined();
    expect(paused.cumulativePausedMs).toBeUndefined();
  });

  it("leaves the execution anchors untouched across a pause cycle", async () => {
    const live = task({ column: "building" });
    const before = anchorsOf(live);
    const paused = await pauseTaskImpl(fakeStore(live).store, live.id, true);
    const resumed = await pauseTaskImpl(fakeStore(paused).store, paused.id, false);
    expect(anchorsOf(resumed)).toEqual(before);
  });
});

describe("cleanup seams close an open segment instead of abandoning it", () => {
  it("clearDoneTransientFieldsImpl banks the open segment", () => {
    const t = task({ paused: true, pausedStartedAt: T0 });
    clearDoneTransientFieldsImpl({} as unknown as TaskStore, t);
    expect(t.paused).toBeUndefined();
    expect(t.pausedStartedAt).toBeUndefined();
    expect(t.cumulativePausedMs).toBe(THIRTY_MIN);
    expect(t.cumulativeActiveMs).toBe(600_000);
  });

  it("buildResetTask banks the open segment and preserves the accumulated bank", () => {
    const t = task({ paused: true, pausedStartedAt: T0, cumulativePausedMs: FIVE_MIN });
    const reset = buildResetTask(t, "triage");
    expect(reset.paused).toBe(false);
    expect(reset.pausedStartedAt).toBeUndefined();
    expect(reset.cumulativePausedMs).toBe(FIVE_MIN + THIRTY_MIN);
    // Timing analytics Reset deliberately preserves.
    expect(reset.cumulativeActiveMs).toBe(600_000);
    expect(reset.firstExecutionAt).toBe(T0);
  });

  it("buildResetTask leaves a card with no open segment alone", () => {
    const reset = buildResetTask(task({ cumulativePausedMs: FIVE_MIN }), "triage");
    expect(reset.cumulativePausedMs).toBe(FIVE_MIN);
    expect(reset.pausedStartedAt).toBeUndefined();
  });
});

describe("applyResetOnEntryEffects — reopen into planning", () => {
  beforeEach(() => {
    __resetTraitRegistryForTests();
    __resetDefaultWorkflowHooksForTests();
    registerBuiltinTraits();
    registerDefaultWorkflowHooks();
  });

  function ctx(t: Task, preservePause: boolean): DefaultWorkflowMoveContext {
    return {
      task: t,
      fromColumn: "in-progress",
      toColumn: "todo",
      moveSource: "engine",
      bypassGuards: false,
      movedAt: T20M,
      resetSteps: () => {},
      options: { preservePause },
      lifecycleColumns: {
        intake: "triage",
        hold: "todo",
        wip: "in-progress",
        review: "in-review",
        complete: "done",
      },
    } as unknown as DefaultWorkflowMoveContext;
  }

  it("banks the open segment when the reopen clears the park", () => {
    const t = task({ paused: true, pausedStartedAt: T0 });
    applyResetOnEntryEffects(ctx(t, false));
    expect(t.paused).toBeUndefined();
    expect(t.pausedStartedAt).toBeUndefined();
    expect(t.cumulativePausedMs).toBe(TWENTY_MIN);
    /* Reopen clears `executionStartedAt` by its own long-standing contract; pause accounting adds
       nothing to that, and must leave the monotonic totals alone. */
    expect(t.cumulativeActiveMs).toBe(600_000);
    expect(t.firstExecutionAt).toBe(T0);
  });

  it("keeps the segment running under preservePause, because the park survives", () => {
    const t = task({ paused: true, pausedStartedAt: T0 });
    applyResetOnEntryEffects(ctx(t, true));
    expect(t.paused).toBe(true);
    expect(t.pausedStartedAt).toBe(T0);
    expect(t.cumulativePausedMs).toBeUndefined();
  });
});

describe("seams that deliberately account nothing", () => {
  /*
  Negative control for the in-review stall SQL patch path: it only ever observes a REVIEW-lane card,
  never un-pauses, and therefore has nothing to open and nothing to bank. Asserted through the pure
  contract so the documented exemption is a tested claim rather than prose.
  */
  it("a review-lane park opens no segment, which is what the stall observer emits", () => {
    const t = task({ column: "in-review" });
    applyPauseAccounting(t, true, T0, false);
    expect(t).not.toHaveProperty("pausedStartedAt", expect.any(String));
    expect(t.cumulativePausedMs).toBeUndefined();
  });

  it("legacy adoption emits a park patch and computes no accounting of its own", () => {
    const plan = planLegacyAdoption(
      { id: "FN-457", status: "some-unknown-legacy-status", column: "in-review", steps: [] } as never,
      T0,
    );
    expect(plan.action).toBe("park-paused");
    expect(plan.patch?.paused).toBe(true);
    // The pure planner must not carry accounting: `updateTask` owns the one seam that resolves lanes.
    expect(plan.patch).not.toHaveProperty("cumulativePausedMs");
    expect(plan.patch).not.toHaveProperty("pausedStartedAt");
  });
});
