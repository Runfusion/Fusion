import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, TaskStep, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  SPLIT_ACTIVE_CONTEXT_KEY,
  type ForeachActiveContext,
  type StepReviewSeamResult,
  type WorkflowLegacySeams,
} from "../workflows/workflow-node-handlers.js";
import type { WorkflowStepInstanceState } from "../workflows/workflow-graph-foreach.js";

/**
 * U5 — step-review node + verdict wiring (KTD-4). These scenarios exercise the
 * real {@link createStepReviewHandler} (registered by default in the executor)
 * driving a `seams.stepReview` fake, with the foreach sub-walk providing the
 * `foreach:active` context, rework edges, and the RETHINK reset hook.
 */

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

function taskWithSteps(n: number): TaskDetail {
  const steps: TaskStep[] = Array.from({ length: n }, (_, i) => ({
    name: `Step ${i + 1}`,
    status: "pending" as const,
  }));
  return { id: "FN-REVIEW", steps } as unknown as TaskDetail;
}

/** Base no-op seams with overrides. */
function baseSeams(overrides: Partial<WorkflowLegacySeams>): WorkflowLegacySeams {
  const ok = async () => ({ outcome: "success" as const });
  return { planning: ok, execute: ok, review: ok, merge: ok, schedule: ok, ...overrides };
}

/**
 * Build: start → foreach{ exec(step-execute) → review(step-review) } → end.
 * Verdict edges from review: approve → exit (no edge = template exit), revise →
 * rework to exec, rethink → rework to exec. Foreach exhaustion routes to a hold.
 */
function reviewForeachIr(opts: { config?: Record<string, unknown> } = {}): WorkflowIr {
  const template = {
    nodes: [
      { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
      { id: "review", kind: "step-review" as const, config: { type: "code" } },
    ] as WorkflowIrNode[],
    edges: [
      { from: "exec", to: "review", condition: "success" },
      // approve (and unavailable) have NO outgoing edge from review → template exit
      // (instance done / advisory continuation).
      { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" as const },
      { from: "review", to: "exec", condition: "outcome:rethink", kind: "rework" as const },
    ],
  };
  return {
    version: "v2",
    name: "review-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "fe", kind: "foreach", config: { source: "task-steps", template, ...(opts.config ?? {}) } },
      { id: "hold", kind: "prompt", config: {} },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "fe" },
      { from: "fe", to: "end", condition: "success" },
      { from: "fe", to: "hold", condition: "outcome:rework-exhausted" },
    ],
  };
}

describe("WorkflowGraphExecutor step-review (U5)", () => {
  it("APPROVE marks the step done via the projection and routes the approve edge", async () => {
    const doneMarks: Array<{ index: number; status: string }> = [];
    const stepReview = vi.fn(async (): Promise<StepReviewSeamResult> => ({ verdict: "APPROVE" }));
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        active.baselineSha = `base-${active.stepIndex}`;
        // step-execute leaves the step in-progress (review decides done) — record
        // that nothing was done here.
        return { outcome: "success", value: "step-done", contextPatch: { [FOREACH_ACTIVE_CONTEXT_KEY]: active } };
      },
      stepReview: async (_t, _ctx, cfg) => {
        const r = await stepReview();
        // Simulate the executor's APPROVE projection write.
        if (r.verdict === "APPROVE" && !cfg.advisory) doneMarks.push({ index: 0, status: "done" });
        return r;
      },
    });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(taskWithSteps(1), settingsOn(), reviewForeachIr());

    expect(result.outcome).toBe("success");
    expect(stepReview).toHaveBeenCalledTimes(1);
    expect(doneMarks).toEqual([{ index: 0, status: "done" }]);
  });

  /*
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Regression for a node's own `config.thinkingLevel` being dropped by resolveStepReviewConfig
   * before it reached `seams.stepReview` — the FN-7771 per-node override would silently never
   * apply to review sessions even though the dashboard persisted it on the node.
   */
  it("threads the review node's own config.thinkingLevel into the stepReview seam config", async () => {
    const seenThinkingLevels: Array<string | undefined> = [];
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
      stepReview: async (_t, _ctx, cfg) => {
        seenThinkingLevels.push(cfg.thinkingLevel);
        return { verdict: "APPROVE" };
      },
    });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(
      taskWithSteps(1),
      settingsOn(),
      reviewForeachIr({ config: {} }),
    );
    void result;

    // Baseline: no thinkingLevel on the node -> undefined reaches the seam.
    expect(seenThinkingLevels).toEqual([undefined]);

    // Now with a pinned node-level thinkingLevel on the review node itself.
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "review", kind: "step-review" as const, config: { type: "code", thinkingLevel: "high" } },
      ] as WorkflowIrNode[],
      edges: [{ from: "exec", to: "review", condition: "success" }],
    };
    const ir: WorkflowIr = {
      version: "v2",
      name: "review-thinking-test",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "fe", kind: "foreach", config: { source: "task-steps", template } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "fe" },
        { from: "fe", to: "end", condition: "success" },
      ],
    };
    seenThinkingLevels.length = 0;
    await executor.run(taskWithSteps(1), settingsOn(), ir);
    expect(seenThinkingLevels).toEqual(["high"]);
  });

  it("REVISE routes a rework edge without triggering a reset", async () => {
    const resets: string[] = [];
    let reviewCalls = 0;
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
      stepReview: async (): Promise<StepReviewSeamResult> => {
        reviewCalls += 1;
        return reviewCalls === 1 ? { verdict: "REVISE" } : { verdict: "APPROVE" };
      },
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      onReworkReset: async (active, reason) => {
        resets.push(`${active.stepIndex}:${reason}`);
      },
    });
    const result = await executor.run(taskWithSteps(1), settingsOn(), reviewForeachIr());

    expect(result.outcome).toBe("success");
    expect(reviewCalls).toBe(2); // revise → rework → approve
    expect(resets).toEqual([]); // REVISE never resets
  });

  it("RETHINK resets to baseline then re-executes the step", async () => {
    const resets: Array<{ index: number; reason: string; baseline?: string }> = [];
    let reviewCalls = 0;
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        active.baselineSha = "base-rethink";
        active.checkpointId = "ckpt-1";
        return { outcome: "success", value: "step-done", contextPatch: { [FOREACH_ACTIVE_CONTEXT_KEY]: active } };
      },
      stepReview: async (): Promise<StepReviewSeamResult> => {
        reviewCalls += 1;
        return reviewCalls === 1 ? { verdict: "RETHINK" } : { verdict: "APPROVE" };
      },
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      onReworkReset: async (active, reason) => {
        resets.push({ index: active.stepIndex, reason, baseline: active.baselineSha });
      },
    });
    const result = await executor.run(taskWithSteps(1), settingsOn(), reviewForeachIr());

    expect(result.outcome).toBe("success");
    expect(reviewCalls).toBe(2);
    expect(resets).toEqual([{ index: 0, reason: "rethink", baseline: "base-rethink" }]);
  });

  it("UNAVAILABLE retries inside the handler (cap 2) then routes outcome:unavailable", async () => {
    let reviewCalls = 0;
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
      stepReview: async (): Promise<StepReviewSeamResult> => {
        reviewCalls += 1;
        return { verdict: "UNAVAILABLE" };
      },
    });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(taskWithSteps(1), settingsOn(), reviewForeachIr());

    // The handler retries up to the cap (3 invocations: initial + 2 retries).
    expect(reviewCalls).toBe(3);
    // value routed is "unavailable"; the IR has no unavailable edge from review,
    // so the instance exits the template (advisory) and the foreach succeeds.
    expect(result.outcome).toBe("success");
  });

  it("persists the verdict into the instance row", async () => {
    const saved: WorkflowStepInstanceState[] = [];
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
      stepReview: async (): Promise<StepReviewSeamResult> => ({ verdict: "APPROVE" }),
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      stepInstancePersistence: {
        saveInstanceState: (s) => {
          saved.push({ ...s });
        },
      },
    });
    const result = await executor.run(taskWithSteps(1), settingsOn(), reviewForeachIr());

    expect(result.outcome).toBe("success");
    // The final (completed) instance row carries the authoritative APPROVE verdict.
    const completed = saved.filter((s) => s.status === "completed");
    expect(completed.length).toBeGreaterThan(0);
    expect(completed[completed.length - 1].verdict).toBe("APPROVE");
  });

  it("split-branch review is advisory-only: no authoritative verdict, no projection write", async () => {
    // Simulate the split-active marker the executor sets around branches: the
    // handler reads SPLIT_ACTIVE_CONTEXT_KEY from the shared context and flags the
    // review advisory. We assert the seam was told advisory=true and that an
    // advisory APPROVE does not write the projection.
    const calls: Array<{ advisory: boolean | undefined }> = [];
    const projectionWrites: number[] = [];
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
      stepReview: async (_t, _ctx, cfg) => {
        calls.push({ advisory: cfg.advisory });
        if (cfg.type === "code" && !cfg.advisory) projectionWrites.push(1);
        return { verdict: "APPROVE" };
      },
    });
    const executor = new WorkflowGraphExecutor({ seams });

    // Build a foreach whose template puts the step-review behind a manual
    // split-active marker on the shared context via a custom prelude node.
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "mark", kind: "prompt" as const, config: {} },
        { id: "review", kind: "step-review" as const, config: { type: "code" } },
        { id: "exit", kind: "prompt" as const, config: {} },
      ] as WorkflowIrNode[],
      edges: [
        { from: "exec", to: "mark", condition: "success" },
        { from: "mark", to: "review", condition: "success" },
        { from: "review", to: "exit", condition: "outcome:approve" },
      ],
    };
    const ir: WorkflowIr = {
      version: "v2",
      name: "advisory-test",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "fe", kind: "foreach", config: { source: "task-steps", template } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "fe" },
        { from: "fe", to: "end", condition: "success" },
      ],
    };

    // Custom handler for the "mark" node sets split:active on the shared context
    // to simulate running inside a split branch window.
    const exec = new WorkflowGraphExecutor({
      seams,
      handlers: {
        prompt: async (node, ctx) => {
          if (node.config?.seam === "step-execute") return seams.stepExecute!(ctx.task, ctx.context);
          if (node.id === "mark") {
            ctx.context[SPLIT_ACTIVE_CONTEXT_KEY] = true;
            return { outcome: "success" };
          }
          return { outcome: "success" };
        },
      },
    });
    void executor;
    const result = await exec.run(taskWithSteps(1), settingsOn(), ir);

    expect(result.outcome).toBe("success");
    expect(calls).toEqual([{ advisory: true }]);
    expect(projectionWrites).toEqual([]); // advisory APPROVE never writes projection
  });
});
