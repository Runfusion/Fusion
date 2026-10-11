import { describe, it, expect, vi, beforeEach } from "vitest";
import "./executor-test-helpers.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { Task } from "@fusion/core";
import {
  SUSPEND_NOTICE_WINDOW_MS,
  noteWorkflowRunSuspended,
  resetWorkflowRunSuspendedNoticeState,
  runSuspendedNoticeSignature,
} from "../executor/run-suspended-notice.js";
import {
  clearFinalizationNotice,
  isBoundedFinalizationRefusal,
  noteFinalizationPass,
  resetFinalizationNoticeState,
} from "../merge/finalization-refusal-notice.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import type { MergeResult } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import type { Logger } from "../logger.js";

/*
FNXC:FinalizationRefusalBounded 2026-10-07-09:10 (RUFU-431 / RUFU-442):
Both cards are the same defect on different surfaces: an engine loop re-states a persistent refusal
on every pass and each restatement writes an audit row plus (for finalization) two durable task-log
entries. The invariant under test is therefore GENERAL, not per-repro: a restated condition is
recorded on its transition and nowhere else, while ANY change of state still records.

Surfaces enumerated and covered here:
  1. `task:workflow-run-suspended` audit row + its `log()` line (executor/execute-workflow-graph).
  2. `task:auto-merge-finalize-column-mismatch-no-action` audit row, reached through the real
     `finalizeProvenAutoMergeTask` path that the auto-merge sweep calls every pass.
  3. The merge-confirmed fast path's two `store.logEntry` calls (project-engine) — the durable
     per-task log that RUFU-452 counts its re-run budget from, which the churn was rotating away.
  4. The bounded/unbounded classification itself: terminal outcomes must NEVER be suppressed.
  5. RUFU-386 widened the shared instance to a SECOND writer — the `recover-merged-review` self-healing
     lane. Its own behavior is pinned by `self-healing-merged-review-refusal-bounded.test.ts`; what
     belongs HERE is the property that only the shared instance can break: two lanes reporting the same
     card must not read as a transition against each other.
*/

function fakeLogger(): Logger & { lines: Array<{ level: string; message: string }> } {
  const lines: Array<{ level: string; message: string }> = [];
  return {
    lines,
    log: (m: string) => lines.push({ level: "log", message: m }),
    debug: (m: string) => lines.push({ level: "debug", message: m }),
    warn: (m: string) => lines.push({ level: "warn", message: m }),
    error: (m: string) => lines.push({ level: "error", message: m }),
  };
}

const wait = {
  nodeId: "parse",
  reason: "capacity",
  fromColumn: "todo",
  toColumn: "in-progress",
  continuationId: "cont-1",
  continuationNodeId: "parse",
  continuationState: "running",
};

describe("RUFU-442 suspended-run notice", () => {
  beforeEach(() => resetWorkflowRunSuspendedNoticeState());

  it("records the wait once and drops identical re-dispatches to debug", () => {
    const logger = fakeLogger();
    const signature = runSuspendedNoticeSignature(wait);

    expect(noteWorkflowRunSuspended(logger, "SANE-1", signature, "suspended")).toBe(true);
    expect(noteWorkflowRunSuspended(logger, "SANE-1", signature, "suspended")).toBe(false);
    expect(noteWorkflowRunSuspended(logger, "SANE-1", signature, "suspended")).toBe(false);

    expect(logger.lines.filter((l) => l.level === "log")).toHaveLength(1);
    expect(logger.lines.filter((l) => l.level === "debug")).toHaveLength(2);
  });

  it("treats a changed reason or boundary as news, and keeps cards independent", () => {
    const logger = fakeLogger();
    noteWorkflowRunSuspended(logger, "SANE-2", runSuspendedNoticeSignature(wait), "m");
    // A different refusal reason is news, inside the window.
    expect(noteWorkflowRunSuspended(logger, "SANE-2", runSuspendedNoticeSignature({ ...wait, reason: "pause" }), "m")).toBe(true);
    // A different column boundary is news too: the card is waiting somewhere else.
    expect(
      noteWorkflowRunSuspended(
        logger,
        "SANE-2",
        runSuspendedNoticeSignature({ ...wait, reason: "pause", toColumn: "hold" }),
        "m",
      ),
    ).toBe(true);
    // Identical again → restatement.
    expect(
      noteWorkflowRunSuspended(logger, "SANE-2", runSuspendedNoticeSignature({ ...wait, reason: "pause", toColumn: "hold" }), "m"),
    ).toBe(false);
    // A different card is independent.
    expect(noteWorkflowRunSuspended(logger, "SANE-3", runSuspendedNoticeSignature(wait), "m")).toBe(true);
  });

  /*
  FNXC:RunSuspendedAuditBackoff 2026-10-07-18:40 (RUFU-442 follow-up):
  This is the shape that defeated the first cut in production: SANE-556 wrote 7 rows for the SAME
  `(parse, capacity)` wait in 4 minutes, because the signature carried the continuation identity and the
  scheduler installs a fresh continuation every pass. Continuation churn may therefore never produce a
  row. Before this test existed, that assertion was the opposite (`toBe(true)`), which is exactly how a
  wrong design passes its own suite.
  */
  it("does not treat a fresh continuation identity as a new wait while the card keeps waiting", () => {
    const logger = fakeLogger();
    const results = Array.from({ length: 7 }, (_, i) =>
      noteWorkflowRunSuspended(
        logger,
        "SANE-556",
        runSuspendedNoticeSignature({ ...wait, continuationId: `cont-${i}`, continuationState: i % 2 ? "held" : "running" }),
        "m",
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(logger.lines.filter((l) => l.level === "log")).toHaveLength(1);
  });

  it("produces one signature for one wait regardless of continuation identity", () => {
    const base = runSuspendedNoticeSignature(wait);
    expect(runSuspendedNoticeSignature({ ...wait, continuationId: "c1", continuationState: "held", continuationNodeId: "parse" })).toBe(base);
    expect(runSuspendedNoticeSignature({ ...wait, continuationId: "c2", continuationState: "running" })).toBe(base);
  });

  it("reports the same wait again once the notice window has elapsed", () => {
    const logger = fakeLogger();
    const signature = runSuspendedNoticeSignature(wait);
    expect(noteWorkflowRunSuspended(logger, "SANE-6", signature, "m", 1_000)).toBe(true);
    expect(noteWorkflowRunSuspended(logger, "SANE-6", signature, "m", 1_000 + SUSPEND_NOTICE_WINDOW_MS - 1)).toBe(false);
    expect(noteWorkflowRunSuspended(logger, "SANE-6", signature, "m", 1_000 + SUSPEND_NOTICE_WINDOW_MS)).toBe(true);
  });

  it("writes one audit row across repeated suspended graph runs, and a new row after the run stops suspended", async () => {
    const task = { id: "FN-SUS", column: "in-progress", steps: [], dependencies: [] } as any;
    const store = createMockStore() as any;
    store.getTask.mockResolvedValue(task);
    store.getSettings.mockResolvedValue({ experimentalFeatures: { workflowGraphExecutor: true } });
    store.getTaskWorkflowSelectionAsync = vi.fn().mockResolvedValue({ workflowId: "wf-s", stepIds: [] });
    store.getWorkflowDefinition = vi.fn().mockResolvedValue({ id: "wf-s", ir: { version: "v2", columns: [], nodes: [], edges: [] } });
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockResolvedValue({
      disposition: "suspended", outcome: "failure", visitedNodeIds: [],
      suspension: { nodeId: "wait", reason: "capacity", fromColumn: "in-progress", toColumn: "todo" },
    } as any);
    const rows = () => (store.recordRunAuditEvent.mock.calls as any[][])
      .map((c) => c[0]?.mutationType).filter((t) => t === "task:workflow-run-suspended").length;
    try {
      const executor = new TaskExecutor(store, "/repo") as any;
      await executor.executeWorkflowGraph(task);
      await executor.executeWorkflowGraph(task);
      expect(rows()).toBe(1);

      /*
      FNXC:RunSuspendedAuditBackoff 2026-10-07-18:40 (RUFU-442 follow-up):
      The interleaved non-suspended run is the capacity-loop shape: dispatch → suspend → dispatch →
      suspend. The first cut wrote a second row here because the non-suspended pass cleared the notice.
      A row now appears only when the wait identity changes, so an alternating loop stays at one row.
      */
      run.mockResolvedValue({ disposition: "completed", outcome: "success", visitedNodeIds: [] } as any);
      await executor.executeWorkflowGraph(task);
      run.mockResolvedValue({
        disposition: "suspended", outcome: "failure", visitedNodeIds: [],
        suspension: { nodeId: "wait", reason: "capacity", fromColumn: "in-progress", toColumn: "todo" },
      } as any);
      await executor.executeWorkflowGraph(task);
      expect(rows()).toBe(1);

      // The same card waiting for a DIFFERENT reason is a new condition and reports immediately.
      run.mockResolvedValue({
        disposition: "suspended", outcome: "failure", visitedNodeIds: [],
        suspension: { nodeId: "wait", reason: "dependency", fromColumn: "in-progress", toColumn: "todo" },
      } as any);
      await executor.executeWorkflowGraph(task);
      expect(rows()).toBe(2);
    } finally {
      run.mockRestore();
    }
  });
});

describe("RUFU-431 finalization refusal notice", () => {
  beforeEach(() => resetFinalizationNoticeState());

  function makeFinalizeStore(overrides: Partial<Task> = {}) {
    let current: any = {
      id: "FN-REFUSE",
      title: "Refusal",
      description: "Test",
      column: "in-review",
      status: null,
      error: null,
      blockedBy: null,
      overlapBlockedBy: null,
      dependencies: [],
      steps: [{ status: "done" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mergeDetails: undefined,
      ...overrides,
    };
    return {
      current: () => current,
      getTask: vi.fn(async () => current),
      listTasks: vi.fn().mockResolvedValue([]),
      updateTask: vi.fn(async (_id: string, patch: any) => { current = { ...current, ...patch }; return current; }),
      moveTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    };
  }

  /** Calls the exact function the auto-merge sweep calls, twice, with nothing changed in between. */
  async function runBlockedTwice(store: any) {
    const call = () => finalizeProvenAutoMergeTask({
      store,
      taskId: "FN-REFUSE",
      result: { task: store.current(), ok: true, merged: true, commitSha: "abc123" } as MergeResult,
      source: "workflow-graph-merge-finalize",
    } as any);
    const first = await call();
    const second = await call();
    return { first, second };
  }

  it("emits the same finalize refusal once, not once per auto-merge pass", async () => {
    const store = makeFinalizeStore();
    const { first, second } = await runBlockedTwice(store);

    expect(first).toEqual(expect.objectContaining({ outcome: "blocked", reason: "missing-merge-confirmation" }));
    expect(second).toEqual(expect.objectContaining({ outcome: "blocked", reason: "missing-merge-confirmation" }));

    const refusals = (store.recordRunAuditEvent.mock.calls as any[][])
      .filter((c) => c[0]?.mutationType === "task:auto-merge-finalize-column-mismatch-no-action");
    expect(refusals).toHaveLength(1);
    expect(refusals[0][0].metadata).toEqual(expect.objectContaining({ reason: "missing-merge-confirmation" }));
  });

  it("records again when the refusal itself changes — bounding cannot mask a state change", async () => {
    const store = makeFinalizeStore({ column: "in-progress" });
    await finalizeProvenAutoMergeTask({
      store, taskId: "FN-REFUSE",
      result: { task: store.current(), ok: true, merged: true, commitSha: "abc123" } as MergeResult,
      source: "workflow-graph-merge-finalize",
    } as any);
    // Same task, now in `done` without proof: a different refusal sentence.
    store.current().column = "done";
    await finalizeProvenAutoMergeTask({
      store, taskId: "FN-REFUSE",
      result: { task: store.current(), ok: true, merged: true, commitSha: "abc123" } as MergeResult,
      source: "workflow-graph-merge-finalize",
    } as any);

    const refusals = (store.recordRunAuditEvent.mock.calls as any[][])
      .filter((c) => c[0]?.mutationType === "task:auto-merge-finalize-column-mismatch-no-action");
    expect(refusals).toHaveLength(2);
    expect(refusals.map((c) => c[0].metadata.reason)).toEqual(["missing-merge-confirmation", "done-without-merge-confirmation"]);
  });

  it("never bounds terminal outcomes, only restatements", () => {
    expect(isBoundedFinalizationRefusal("task:auto-merge-finalize-column-mismatch-no-action")).toBe(true);
    expect(isBoundedFinalizationRefusal("task:auto-merge-finalize-column-mismatch-reconciled")).toBe(false);
    expect(isBoundedFinalizationRefusal("task:auto-merge-skipped-already-done")).toBe(false);
  });

  it("keeps the fast path's two durable-log slots independent and writes the log entry on the transition only", () => {
    const logger = fakeLogger();
    // Slot 1: the fast path ran. Slot 2: it was refused, with a reason. They must not read as a
    // transition against each other, or every pass would roll the per-task log.
    expect(noteFinalizationPass(logger, "FN-REFUSE", "fast-path-attempt", "attempted", "attempt")).toBe(true);
    expect(noteFinalizationPass(logger, "FN-REFUSE", "fast-path-outcome", "post-merge gate X is not approved", "blocked", "warn")).toBe(true);
    expect(noteFinalizationPass(logger, "FN-REFUSE", "fast-path-attempt", "attempted", "attempt")).toBe(false);
    expect(noteFinalizationPass(logger, "FN-REFUSE", "fast-path-outcome", "post-merge gate X is not approved", "blocked", "warn")).toBe(false);
    expect(logger.lines.filter((l) => l.level === "log")).toHaveLength(1);
    expect(logger.lines.filter((l) => l.level === "warn")).toHaveLength(1);

    // A new refusal sentence is a real transition and must reach the durable log again.
    expect(noteFinalizationPass(logger, "FN-REFUSE", "fast-path-outcome", "waiting on dependency FN-1", "blocked", "warn")).toBe(true);
  });

  /*
  FNXC:FinalizationRefusalBounded 2026-10-11-05:43 (RUFU-386):
  One `finalizationNotice` instance now serves two lanes over possibly the SAME card: the merge-confirmed
  fast path can alternate with the `recover-merged-review` maintenance step while a card sits stranded.
  If the two shared a key — or if a future edit collapsed the slot dimension — every alternation would
  read as a state change and the churn would return at double rate, which is the exact failure the slot
  exists to prevent. The keyspace claim is therefore part of the invariant, not an implementation detail.
  */
  it("keeps the fast path and the self-healing lane independent for one card", () => {
    const logger = fakeLogger();
    const reason = "required post-merge gate 'post-merge-verification' has not reported";

    // Both lanes report the same card and the same reason: each writes its own first row.
    expect(noteFinalizationPass(logger, "FN-DUAL", "fast-path-outcome", `blocked|${reason}`, "fp", "warn")).toBe(true);
    expect(noteFinalizationPass(logger, "FN-DUAL", "self-heal-outcome", `blocked|${reason}`, "sh", "warn")).toBe(true);
    // And each then suppresses only its own restatement — an interleaved pass is not news.
    expect(noteFinalizationPass(logger, "FN-DUAL", "fast-path-outcome", `blocked|${reason}`, "fp", "warn")).toBe(false);
    expect(noteFinalizationPass(logger, "FN-DUAL", "self-heal-outcome", `blocked|${reason}`, "sh", "warn")).toBe(false);
    expect(logger.lines.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  /*
  FNXC:FinalizationRefusalBounded 2026-10-11-05:43 (RUFU-386):
  `clearFinalizationNotice` enumerates its slots, so a slot added without enumerating it here would be
  unforgettable — the card's next refusal after a real finalize would be swallowed until the process
  restarted. This is the ratchet that makes the enumeration in that function checkable.
  */
  it("forgets every owned slot for a card, including the self-healing lane's", () => {
    const logger = fakeLogger();
    expect(noteFinalizationPass(logger, "FN-CLEAR", "fast-path-outcome", "blocked|a", "fp", "warn")).toBe(true);
    expect(noteFinalizationPass(logger, "FN-CLEAR", "self-heal-outcome", "resumed|a", "sh")).toBe(true);
    expect(noteFinalizationPass(logger, "FN-CLEAR", "self-heal-outcome", "resumed|a", "sh")).toBe(false);

    clearFinalizationNotice("FN-CLEAR");

    expect(noteFinalizationPass(logger, "FN-CLEAR", "fast-path-outcome", "blocked|a", "fp", "warn")).toBe(true);
    expect(noteFinalizationPass(logger, "FN-CLEAR", "self-heal-outcome", "resumed|a", "sh")).toBe(true);
  });
});
