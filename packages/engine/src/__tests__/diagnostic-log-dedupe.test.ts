import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import {
  DIAGNOSTIC_LOG_WINDOW_MS,
  diagnosticSignature,
  logDiagnosticOnce,
} from "../util/durable-diagnostic-log.js";
import {
  containmentLiveSignature,
  moveTaskToContainedBackwardTarget,
  resetContainmentRefusalLogForTesting,
} from "../execution/lifecycle-move.js";

/*
FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643):
Every writer these tests cover already had a first-sighting guard, and every guard was a process map —
`lastLoggedKey`, `shouldLogContainmentRefusal`, `noteFinalizationPass`. Measured on the live board
2026-10-11 they had still produced 11,465 / 16,025 / 14,059 / 9,942 / 12,346 identical rows, because a
process map dies on restart and the supervised dashboard restarts every ~14-27 min (RUFU-642): each
restart converts every already-seen refusal back into a first sighting. So the regression these tests
pin is "a repeat re-announced by a FRESH process still writes one line", which is exactly the case the
in-process guards could not express. A fake store that keeps its sighting record outside the module
under test is the honest model of that boundary.
*/

interface FakeLogEntry {
  timestamp: string;
  action: string;
  outcome?: string;
  dedupeKey?: string;
}

/**
 * Models `logEntryOnceImpl`'s contract: the sighting record lives with the ROW, a duplicate is
 * returned without writing the row at all, and `logEntry` is the un-deduped historical shape.
 */
function createDurableLogStore() {
  const state: { entries: FakeLogEntry[]; rowWrites: number } = { entries: [], rowWrites: 0 };
  const store = {
    logEntryOnce: vi.fn(async (_id: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) => {
      const now = Date.now();
      const duplicate = state.entries.some((entry) => entry.dedupeKey === input.dedupeKey
        && now - Date.parse(entry.timestamp) < input.windowMs);
      // A duplicate must not touch the row: no log growth, no `updated_at`, and no row re-materialization.
      if (duplicate) return false;
      state.entries.push({
        timestamp: new Date(now).toISOString(),
        action: input.action,
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        dedupeKey: input.dedupeKey,
      });
      state.rowWrites += 1;
      return true;
    }),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => {
      state.entries.push({
        timestamp: new Date().toISOString(),
        action,
        ...(outcome !== undefined ? { outcome } : {}),
      });
      state.rowWrites += 1;
      return { id: _id } as unknown as Task;
    }),
  };
  return { store, state };
}

describe("logDiagnosticOnce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records one entry for a repeated diagnostic and writes the row only for that entry", async () => {
    const { store, state } = createDurableLogStore();
    const key = `specification-failure:${diagnosticSignature("boom")}`;

    const first = await logDiagnosticOnce(store, "T-1", { action: "Specification failed: boom", dedupeKey: key });
    const second = await logDiagnosticOnce(store, "T-1", { action: "Specification failed: boom", dedupeKey: key });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(state.entries).toHaveLength(1);
    // The suppressed repeat performed no row write at all, so it cannot bump `updated_at`, rewrite the
    // task.json mirror, or emit task:updated — the three things a per-pass append costs.
    expect(state.rowWrites).toBe(1);
  });

  it("still records a different failure signature as its own entry", async () => {
    const { store, state } = createDurableLogStore();

    await logDiagnosticOnce(store, "T-1", {
      action: "Specification failed: fence unavailable",
      dedupeKey: `specification-failure:${diagnosticSignature("fence unavailable")}`,
    });
    await logDiagnosticOnce(store, "T-1", {
      action: "Specification failed: boom",
      dedupeKey: `specification-failure:${diagnosticSignature("boom")}`,
    });

    expect(state.entries.map((entry) => entry.action)).toEqual([
      "Specification failed: fence unavailable",
      "Specification failed: boom",
    ]);
  });

  it("re-announces the same episode once its window has passed", async () => {
    const { store, state } = createDurableLogStore();
    const input = { action: "Merge confirmed finalization blocked — gate unreachable.", dedupeKey: "merge-finalize:fast-path-outcome:abc" };

    await logDiagnosticOnce(store, "T-1", input);
    vi.advanceTimersByTime(DIAGNOSTIC_LOG_WINDOW_MS - 60_000);
    await logDiagnosticOnce(store, "T-1", input);
    expect(state.entries).toHaveLength(1);

    vi.advanceTimersByTime(120_000);
    await logDiagnosticOnce(store, "T-1", input);
    expect(state.entries).toHaveLength(2);
  });

  it("forwards the caller's window when the lane owns a longer episode", async () => {
    const { store } = createDurableLogStore();
    const windowMs = 3 * DIAGNOSTIC_LOG_WINDOW_MS;

    await logDiagnosticOnce(store, "T-1", { action: "one", dedupeKey: "k", windowMs });

    expect(store.logEntryOnce).toHaveBeenCalledWith("T-1", expect.objectContaining({ dedupeKey: "k", windowMs }));
  });

  it("falls back to the caller's exact logEntry call shape on a store without the durable seam", async () => {
    const sink = { logEntry: vi.fn(async () => undefined) };
    const runContext = { agentId: "executor", runId: "run-1", taskId: "T-1" };

    await logDiagnosticOnce(sink, "T-1", { action: "[goal-injection] no-goals count=0", dedupeKey: "k" });
    expect(sink.logEntry).toHaveBeenLastCalledWith("T-1", "[goal-injection] no-goals count=0");

    await logDiagnosticOnce(sink, "T-1", { action: "with stack", outcome: "at Foo", dedupeKey: "k" });
    expect(sink.logEntry).toHaveBeenLastCalledWith("T-1", "with stack", "at Foo");

    await logDiagnosticOnce(sink, "T-1", { action: "attributed", dedupeKey: "k", runContext });
    expect(sink.logEntry).toHaveBeenLastCalledWith("T-1", "attributed", undefined, runContext);
  });

  it("never lets a failing log sink change what the caller does next", async () => {
    const warnings: string[] = [];
    const hostile = {
      logEntryOnce: vi.fn(async () => { throw new Error("database is down"); }),
      logEntry: vi.fn(async () => { throw new Error("database is down"); }),
    };

    const appended = await logDiagnosticOnce(hostile, "T-1", {
      action: "boom", dedupeKey: "k", onWarn: (message) => warnings.push(message),
    });

    expect(appended).toBe(false);
    expect(warnings).toEqual(["database is down"]);
  });
});

describe("containment refusal log", () => {
  const task = {
    id: "FN-643",
    column: "in-progress",
    status: "failed",
    steps: [{ status: "done" }],
    workflowStepResults: [{ workflowStepId: "code-review", status: "approved" }],
  } as unknown as Task;

  function storeFor(taskRow: Task) {
    const { store, state } = createDurableLogStore();
    return {
      store: { ...store, getTask: vi.fn(async () => taskRow) } as unknown as TaskStore,
      state,
    };
  }

  beforeEach(() => {
    resetContainmentRefusalLogForTesting();
  });

  afterEach(() => {
    resetContainmentRefusalLogForTesting();
  });

  it("writes one refusal line even when a fresh process re-announces the same refusal", async () => {
    const { store, state } = storeFor(task);

    const first = await moveTaskToContainedBackwardTarget(store, task.id, "self-healing-stranded-recovery");
    expect(first).toEqual({ moved: false, reason: "in-place-recovery", column: "in-progress" });
    expect(state.entries).toHaveLength(1);

    // A restart keeps the card's durable log and loses every in-process sighting map. This is the
    // RUFU-643 regression: before the durable key, this call appended a second byte-identical line.
    resetContainmentRefusalLogForTesting();
    await moveTaskToContainedBackwardTarget(store, task.id, "self-healing-stranded-recovery");
    expect(state.entries).toHaveLength(1);

    // A state change is a different refusal, so the operator still sees it.
    resetContainmentRefusalLogForTesting();
    const movedColumnTask = { ...task, column: "in-review" } as unknown as Task;
    store.getTask = vi.fn(async () => movedColumnTask);
    await moveTaskToContainedBackwardTarget(store, task.id, "self-healing-stranded-recovery");
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1]!.action).toContain("Lifecycle recovery retained in 'in-review'");
    expect(state.entries[1]!.dedupeKey).not.toBe(state.entries[0]!.dedupeKey);
  });

  it("keeps the refusal sentence identical to the pre-dedupe wording", async () => {
    const { store, state } = storeFor(task);
    await moveTaskToContainedBackwardTarget(store, task.id, "self-healing-stranded-recovery");

    expect(state.entries[0]!.action).toBe(
      `Lifecycle recovery retained in '${task.column}' — self-healing-stranded-recovery has no backward-move authority`,
    );
  });

  it("signs an unchanged card identically across processes", () => {
    expect(containmentLiveSignature(task)).toBe(containmentLiveSignature({ ...task }));
  });
});
