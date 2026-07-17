import "./executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor, evaluateTaskDoneRefusal } from "../executor.js";
import { resetExecutorMocks } from "./executor-test-helpers.js";
import { evaluateSkipBypassTaint } from "@fusion/core";

/*
FNXC:Lifecycle 2026-07-16-21:40:
FN-8141 laundered a failed task into `done`: a `bulk-step-completion-without-review`
refusal fired, then the agent marked the remaining unreviewed steps `skipped`, and the
implicit completion path treated the all-done/skipped task as done. These tests assert
the executor's AUTO-promotion glue (implicit completion, graph merge-boundary proof) is
skip-bypass-taint-aware, while the explicit fn_task_done honest exit (PREMISE STALE) is
unaffected.
*/
function createStore() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function taskWith(
  statuses: Array<"done" | "skipped" | "pending" | "in-progress">,
  bulkCompletionRefusalAt?: string,
) {
  return {
    id: "FN-8141",
    title: "Skip bypass",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: statuses.map((status, index) => ({ name: `Step ${index + 1}`, status })),
    currentStep: 0,
    bulkCompletionRefusalAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any;
}

describe("TaskExecutor skip-bypass taint (FN-8141)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.clearAllMocks();
  });

  it("implicit completion is REFUSED when steps were skipped after a bulk-step-completion refusal", () => {
    const executor = new TaskExecutor(createStore(), "/tmp/test");
    // The FN-8141 sequence: 3 done + 2 skipped, refusal marker active, no accepted done.
    const task = taskWith(["done", "done", "done", "skipped", "skipped"], "2026-07-16T21:40:00.000Z");
    const result = (executor as any).evaluateImplicitCompletionRefusal(task, new Map());
    expect(result.ok).toBe(false);
    expect(result.refusalClass).toBe("bulk-step-completion-without-review");
    expect(result.reason).toContain("skipped after a bulk-step-completion refusal");
  });

  it("implicit completion is ALLOWED for a clean all-done/skipped task with no refusal marker", () => {
    const executor = new TaskExecutor(createStore(), "/tmp/test");
    const task = taskWith(["done", "skipped"], undefined);
    const result = (executor as any).evaluateImplicitCompletionRefusal(task, new Map());
    expect(result).toEqual({ ok: true });
  });

  it("implicit completion is ALLOWED for a tainted task once every step is genuinely done (no skips left)", () => {
    const executor = new TaskExecutor(createStore(), "/tmp/test");
    const task = taskWith(["done", "done", "done"], "2026-07-16T21:40:00.000Z");
    const result = (executor as any).evaluateImplicitCompletionRefusal(task, new Map());
    expect(result).toEqual({ ok: true });
  });

  it("the graph merge boundary reports missing implementation proof for a tainted task", async () => {
    const executor = new TaskExecutor(createStore(), "/tmp/test");
    const task = taskWith(["done", "skipped", "skipped"], "2026-07-16T21:40:00.000Z");
    const failure = await (executor as any).getWorkflowMergeImplementationProofFailure(task);
    expect(failure).toContain("steps were skipped after a bulk-step-completion refusal");
  });

  it("does NOT taint the EXPLICIT fn_task_done honest exit: PREMISE STALE skip-then-done still accepted", () => {
    // The taint lives only in the AUTO-promotion glue; the exported refusal function
    // (which backs the explicit fn_task_done tool) must still accept a skipped-only task
    // so the accepted-done path can clear the marker. Same shape the taint blocks for
    // AUTO promotion is accepted here for the explicit call.
    const task = taskWith(["done", "skipped", "skipped", "skipped"], "2026-07-16T21:40:00.000Z");
    const explicit = evaluateTaskDoneRefusal(
      task,
      { summary: "PREMISE STALE: already implemented on HEAD, remaining steps skipped" },
      new Map(),
    );
    expect(explicit).toEqual({ ok: true });
    // But the AUTO-promotion evaluator blocks the same shape while the marker is active.
    expect(evaluateSkipBypassTaint(task).blocked).toBe(true);
  });
});
