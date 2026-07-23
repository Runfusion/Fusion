import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, TaskStep, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  type ForeachActiveContext,
  type WorkflowLegacySeams,
} from "../workflows/workflow-node-handlers.js";
import type { WorkflowStepInstanceState } from "../workflows/workflow-graph-foreach.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

/** Build a TaskDetail with a fixed step list. */
function taskWithSteps(n: number): TaskDetail {
  const steps: TaskStep[] = Array.from({ length: n }, (_, i) => ({
    name: `Step ${i + 1}`,
    status: "pending" as const,
  }));
  return { id: "FN-FOREACH", steps } as unknown as TaskDetail;
}

/** Build a TaskDetail with explicit persisted step statuses. */
function taskWithStepStatuses(statuses: TaskStep["status"][]): TaskDetail {
  const steps: TaskStep[] = statuses.map((status, i) => ({
    name: `Step ${i + 1}`,
    status,
  }));
  return { id: "FN-FOREACH", steps } as unknown as TaskDetail;
}

/**
 * Build a graph: start → foreach → end. The foreach template is provided inline.
 * Extra edges from the foreach node (e.g. outcome:rework-exhausted) are appended.
 */
function foreachIr(
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIr["edges"] },
  opts: {
    config?: Record<string, unknown>;
    extraNodes?: WorkflowIrNode[];
    foreachEdges?: WorkflowIr["edges"];
  } = {},
): WorkflowIr {
  return {
    version: "v2",
    name: "foreach-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "fe",
        kind: "foreach",
        config: { source: "task-steps", template, ...(opts.config ?? {}) },
      },
      { id: "end", kind: "end" },
      ...(opts.extraNodes ?? []),
    ],
    edges: [
      { from: "start", to: "fe" },
      { from: "fe", to: "end", condition: "success" },
      ...(opts.foreachEdges ?? []),
    ],
  };
}

/** A single-node template: one step-execute prompt. */
function singleExecuteTemplate() {
  return {
    nodes: [{ id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } }],
    edges: [],
  };
}

describe("WorkflowGraphExecutor foreach (U3)", () => {
  it("3-step expansion runs instances in step order, all 3 template-node instances", async () => {
    const order: string[] = [];
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        order.push(`exec#${active.stepIndex}`);
        return { outcome: "success", value: "step-done" };
      },
    });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(taskWithSteps(3), settingsOn(), foreachIr(singleExecuteTemplate()));

    expect(result.outcome).toBe("success");
    expect(order).toEqual(["exec#0", "exec#1", "exec#2"]);
    // Instance ids are materialized deterministically.
    expect(result.visitedNodeIds).toEqual(
      expect.arrayContaining(["fe#0:exec", "fe#1:exec", "fe#2:exec"]),
    );
    // The foreach itself is visited and routes its success edge to end (end is
    // intentionally not pushed to visited — same posture as other tail edges).
    expect(result.visitedNodeIds).toContain("fe");
  });

  it("zero steps → foreach traverses its success edge without running any instance", async () => {
    const exec = vi.fn(async () => ({ outcome: "success" as const }));
    const seams = baseSeams({ stepExecute: exec });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(taskWithSteps(0), settingsOn(), foreachIr(singleExecuteTemplate()));

    expect(result.outcome).toBe("success");
    expect(exec).not.toHaveBeenCalled();
    expect(result.visitedNodeIds).toContain("fe");
    expect(result.visitedNodeIds.some((id) => id.startsWith("fe#"))).toBe(false);
  });

  it("resume skips all instances when every step is already done", async () => {
    const exec = vi.fn(async () => ({ outcome: "success" as const, value: "step-done" }));
    const seams = baseSeams({ stepExecute: exec });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(
      taskWithStepStatuses(["done", "done", "done"]),
      settingsOn(),
      foreachIr(singleExecuteTemplate()),
    );

    expect(result.outcome).toBe("success");
    expect(exec).not.toHaveBeenCalled();
    expect(result.visitedNodeIds).toContain("fe");
    expect(result.visitedNodeIds.some((id) => id.startsWith("fe#"))).toBe(false);
  });

  it("resume skips done instances and runs the first pending step", async () => {
    const executedStepIndexes: number[] = [];
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        executedStepIndexes.push(active.stepIndex);
        return { outcome: "success", value: "step-done" };
      },
    });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(
      taskWithStepStatuses(["done", "done", "done", "pending"]),
      settingsOn(),
      foreachIr(singleExecuteTemplate()),
    );

    expect(result.outcome).toBe("success");
    expect(executedStepIndexes).toEqual([3]);
  });

  it("resume consults live steps before running a stale in-progress instance", async () => {
    const exec = vi.fn(async () => ({ outcome: "failure" as const, value: "should-not-run" }));
    const seams = baseSeams({ stepExecute: exec });
    const executor = new WorkflowGraphExecutor({
      seams,
      getTaskSteps: async () => [
        { name: "Step 1", status: "done" },
        { name: "Step 2", status: "done" },
      ] as TaskStep[],
    });
    const result = await executor.run(
      taskWithStepStatuses(["done", "in-progress"]),
      settingsOn(),
      foreachIr(singleExecuteTemplate()),
    );

    expect(result.outcome).toBe("success");
    expect(exec).not.toHaveBeenCalled();
  });

  it("resume skips mixed done and skipped instances and runs pending steps only", async () => {
    const executedStepIndexes: number[] = [];
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        executedStepIndexes.push(active.stepIndex);
        return { outcome: "success", value: "step-done" };
      },
    });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(
      taskWithStepStatuses(["done", "skipped", "done", "pending"]),
      settingsOn(),
      foreachIr(singleExecuteTemplate()),
    );

    expect(result.outcome).toBe("success");
    expect(executedStepIndexes).toEqual([3]);
  });

  it("resume re-runs in-progress steps instead of treating them as terminal", async () => {
    const executedStepIndexes: number[] = [];
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        executedStepIndexes.push(active.stepIndex);
        return { outcome: "success", value: "step-done" };
      },
    });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(
      taskWithStepStatuses(["done", "done", "in-progress", "pending"]),
      settingsOn(),
      foreachIr(singleExecuteTemplate()),
    );

    expect(result.outcome).toBe("success");
    expect(executedStepIndexes).toEqual([2, 3]);
  });

  it("revise-style rework loops twice then completes (custom node routes a rework edge)", async () => {
    // Template: exec → review. review routes a rework edge back to exec for the
    // first 2 passes, then approves (success edge → exit).
    let reviewCalls = 0;
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "review", kind: "prompt" as const, config: {} },
      ],
      edges: [
        { from: "exec", to: "review", condition: "success" },
        // rework loop back to exec when review says "revise"
        { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" as const },
        // success/approve exits (no outgoing edge → template exit)
      ],
    };
    const reviewHandler: WorkflowNodeHandler = async () => {
      reviewCalls += 1;
      if (reviewCalls <= 2) return { outcome: "success", value: "revise" };
      return { outcome: "success", value: "approve" };
    };
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: { prompt: makePromptRouter(seams, { review: reviewHandler }) },
    });
    const result = await executor.run(taskWithSteps(1), settingsOn(), foreachIr(template));

    expect(result.outcome).toBe("success");
    expect(reviewCalls).toBe(3); // 2 revises + 1 approve
  });

  it("rework exhaustion routes the outcome:rework-exhausted edge", async () => {
    // review always says revise → budget (2) exhausts → foreach emits
    // rework-exhausted, routed to a hold node.
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "review", kind: "prompt" as const, config: {} },
      ],
      edges: [
        { from: "exec", to: "review", condition: "success" },
        { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" as const },
      ],
    };
    const reviewHandler: WorkflowNodeHandler = async () => ({ outcome: "success", value: "revise" });
    const holdHandler = vi.fn(async () => ({ outcome: "success" as const }));
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: {
        prompt: makePromptRouter(seams, { review: reviewHandler }),
        hold: holdHandler,
      },
    });
    const result = await executor.run(
      taskWithSteps(1),
      settingsOn(),
      foreachIr(template, {
        config: { maxReworkCycles: 2 },
        extraNodes: [{ id: "exhausted-hold", kind: "hold" }],
        foreachEdges: [
          { from: "fe", to: "exhausted-hold", condition: "outcome:rework-exhausted" },
          { from: "exhausted-hold", to: "end", condition: "success" },
        ],
      }),
    );

    expect(holdHandler).toHaveBeenCalledTimes(1);
    expect(result.visitedNodeIds).toContain("exhausted-hold");
  });

  it("rework exhaustion with NO routed edge falls back to failure", async () => {
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "review", kind: "prompt" as const, config: {} },
      ],
      edges: [
        { from: "exec", to: "review", condition: "success" },
        { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" as const },
      ],
    };
    const reviewHandler: WorkflowNodeHandler = async () => ({ outcome: "success", value: "revise" });
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: { prompt: makePromptRouter(seams, { review: reviewHandler }) },
    });
    const result = await executor.run(
      taskWithSteps(1),
      settingsOn(),
      foreachIr(template, { config: { maxReworkCycles: 1 } }),
    );

    expect(result.outcome).toBe("failure");
  });

  it("rework budget is per-instance, not shared across instances", async () => {
    // 2 steps, budget 1 each. Each instance reworks exactly once then approves.
    // If the budget were shared, the second instance would exhaust on its first
    // rework. Per-instance, both succeed.
    const reviewCallsByStep = new Map<number, number>();
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "review", kind: "prompt" as const, config: {} },
      ],
      edges: [
        { from: "exec", to: "review", condition: "success" },
        { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" as const },
      ],
    };
    const reviewHandler: WorkflowNodeHandler = async (_node, ctx) => {
      const active = ctx.context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
      const n = (reviewCallsByStep.get(active.stepIndex) ?? 0) + 1;
      reviewCallsByStep.set(active.stepIndex, n);
      if (n === 1) return { outcome: "success", value: "revise" }; // 1 rework per step
      return { outcome: "success", value: "approve" };
    };
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: { prompt: makePromptRouter(seams, { review: reviewHandler }) },
    });
    const result = await executor.run(
      taskWithSteps(2),
      settingsOn(),
      foreachIr(template, { config: { maxReworkCycles: 1 } }),
    );

    expect(result.outcome).toBe("success");
    expect(reviewCallsByStep.get(0)).toBe(2);
    expect(reviewCallsByStep.get(1)).toBe(2);
  });

  it("a non-rework cycle outside an active instance still throws (recursive detector untouched)", async () => {
    // Top-level graph with a plain cycle (no rework kind) — the recursive walk's
    // inStack detector must still throw.
    const ir: WorkflowIr = {
      version: "v2",
      name: "cycle",
      columns: [{ id: "w", name: "W", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt", config: {} },
        { id: "b", kind: "prompt", config: {} },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b", condition: "success" },
        { from: "b", to: "a", condition: "success" }, // non-rework cycle
      ],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success" as const }) },
    });
    await expect(executor.run(taskWithSteps(0), settingsOn(), ir)).rejects.toThrow(/Cycle detected/);
  });

  it("abort mid-instance stops cleanly (signal honored between nodes)", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    // Template: exec → second. exec aborts the controller; `second` must not run
    // (abort is checked at the top of the loop before the next node).
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "second", kind: "prompt" as const, config: {} },
      ],
      edges: [{ from: "exec", to: "second", condition: "success" }],
    };
    const secondHandler: WorkflowNodeHandler = async () => {
      seen.push("second");
      return { outcome: "success" };
    };
    const seams = baseSeams({
      stepExecute: async () => {
        seen.push("exec");
        controller.abort();
        return { outcome: "success", value: "step-done" };
      },
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: { prompt: makePromptRouter(seams, { second: secondHandler }) },
      signal: controller.signal,
    });
    const result = await executor.run(taskWithSteps(2), settingsOn(), foreachIr(template));

    expect(result.outcome).toBe("failure");
    expect(seen).toEqual(["exec"]); // second never ran; instance 1 never started
  });

  it("foreach:active context is visible to template handlers and absent outside instances", async () => {
    const insideValues: Array<number | undefined> = [];
    let outsideAfter: unknown = "unset";
    // Template node records the active stepIndex; a tail node after the foreach
    // asserts the key was cleared.
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
        insideValues.push(active?.stepIndex);
        return { outcome: "success", value: "step-done" };
      },
    });
    const tailHandler: WorkflowNodeHandler = async (_node, ctx) => {
      outsideAfter = ctx.context[FOREACH_ACTIVE_CONTEXT_KEY];
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: { prompt: makePromptRouter(seams, { tail: tailHandler }) },
    });
    const ir = foreachIr(singleExecuteTemplate(), {
      extraNodes: [{ id: "tail", kind: "prompt", config: {} }],
      foreachEdges: [
        { from: "fe", to: "tail", condition: "success" },
        { from: "tail", to: "end", condition: "success" },
      ],
    });
    // Remove the direct fe→end edge so fe→tail is the only success route.
    ir.edges = ir.edges.filter((e) => !(e.from === "fe" && e.to === "end"));
    const result = await executor.run(taskWithSteps(2), settingsOn(), ir);

    expect(result.outcome).toBe("success");
    expect(insideValues).toEqual([0, 1]);
    expect(outsideAfter).toBeUndefined(); // cleared on instance exit
  });

  it("step-execute seam is invoked with the correct stepIndex and captured baseline flows into context", async () => {
    const captured: Array<{ stepIndex: number; baseline?: string }> = [];
    // step-execute sets a baseline; a following review node reads it from the
    // active context to prove the capture threads forward within the instance.
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "review", kind: "prompt" as const, config: {} },
      ],
      edges: [{ from: "exec", to: "review", condition: "success" }],
    };
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        active.baselineSha = `sha-for-${active.stepIndex}`;
        active.checkpointId = `ckpt-${active.stepIndex}`;
        return {
          outcome: "success",
          value: "step-done",
          contextPatch: { [FOREACH_ACTIVE_CONTEXT_KEY]: active },
        };
      },
    });
    const reviewHandler: WorkflowNodeHandler = async (_node, ctx) => {
      const active = ctx.context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
      captured.push({ stepIndex: active.stepIndex, baseline: active.baselineSha });
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: { prompt: makePromptRouter(seams, { review: reviewHandler }) },
    });
    const result = await executor.run(taskWithSteps(2), settingsOn(), foreachIr(template));

    expect(result.outcome).toBe("success");
    expect(captured).toEqual([
      { stepIndex: 0, baseline: "sha-for-0" },
      { stepIndex: 1, baseline: "sha-for-1" },
    ]);
  });

  it("step-execute with no seam wired fails closed (does not silently succeed)", async () => {
    // No stepExecute seam provided → step-execute node fails with a clear value.
    const seams = baseSeams({});
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(taskWithSteps(1), settingsOn(), foreachIr(singleExecuteTemplate()));
    expect(result.outcome).toBe("failure");
  });

  it("parallel mode (now worktree isolation, U10) fails cleanly without isolation wiring", async () => {
    // U10: parallel mode defaults to worktree isolation. Without the worktree /
    // integration deps wired, the foreach fails with a routable value rather than
    // running shared-mode physics (which would be an unguardable concurrent-write race).
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
    });
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(
      taskWithSteps(2),
      settingsOn(),
      foreachIr(singleExecuteTemplate(), { config: { mode: "parallel", concurrency: 2 } }),
    );
    expect(result.outcome).toBe("failure");
    expect(result.context["node:fe:value"]).toBe("worktree-isolation-unwired");
  });

  it("getTaskSteps dep is used to read a fresh count when injected", async () => {
    const exec = vi.fn(async () => ({ outcome: "success" as const, value: "step-done" }));
    const seams = baseSeams({ stepExecute: exec });
    // task.steps is empty, but the injected accessor returns 2 steps.
    const executor = new WorkflowGraphExecutor({
      seams,
      getTaskSteps: () => [
        { name: "fresh-1", status: "pending" },
        { name: "fresh-2", status: "pending" },
      ],
    });
    const result = await executor.run(taskWithSteps(0), settingsOn(), foreachIr(singleExecuteTemplate()));
    expect(result.outcome).toBe("success");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("step instance persistence hook is called at start/completion/rework (no-op default safe)", async () => {
    const saved: WorkflowStepInstanceState[] = [];
    const template = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "review", kind: "prompt" as const, config: {} },
      ],
      edges: [
        { from: "exec", to: "review", condition: "success" },
        { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" as const },
      ],
    };
    let reviewCalls = 0;
    const reviewHandler: WorkflowNodeHandler = async () => {
      reviewCalls += 1;
      return reviewCalls === 1
        ? { outcome: "success", value: "revise" }
        : { outcome: "success", value: "approve" };
    };
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: { prompt: makePromptRouter(seams, { review: reviewHandler }) },
      stepInstancePersistence: {
        saveInstanceState: (s) => {
          saved.push({ ...s });
        },
      },
    });
    const result = await executor.run(
      taskWithSteps(1),
      settingsOn(),
      foreachIr(template, { config: { maxReworkCycles: 2 } }),
    );

    expect(result.outcome).toBe("success");
    // in-progress at start, a rework in-progress bump, and a final completed.
    expect(saved.some((s) => s.status === "in-progress" && s.reworkCount === 0)).toBe(true);
    expect(saved.some((s) => s.status === "in-progress" && s.reworkCount === 1)).toBe(true);
    expect(saved.some((s) => s.status === "completed")).toBe(true);
    expect(saved.every((s) => s.pinnedStepCount === 1)).toBe(true);
  });

  // ── U6: projection discipline ──────────────────────────────────────────────

  it("projection-first ordering: step projection writes precede the completed instance row", async () => {
    // The merge-blocker race (KTD-7) is closed by ordering: the step projection
    // (updateStep) must be observable BEFORE the instance row flips to completed.
    // We interleave both into one event log: the stepExecute seam stands in for
    // the projection write; the persistence hook records the row status.
    const events: string[] = [];
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        events.push(`projection:done#${active.stepIndex}`);
        return { outcome: "success", value: "step-done" };
      },
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      stepInstancePersistence: {
        saveInstanceState: (s) => {
          events.push(`row:${s.status}#${s.stepIndex}`);
        },
      },
    });
    const result = await executor.run(taskWithSteps(1), settingsOn(), foreachIr(singleExecuteTemplate()));

    expect(result.outcome).toBe("success");
    const projectionIdx = events.indexOf("projection:done#0");
    const completedIdx = events.indexOf("row:completed#0");
    expect(projectionIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    // Projection (done) is observable before the instance row flips to completed.
    expect(projectionIdx).toBeLessThan(completedIdx);
  });

  it("sets deferDoneToReview on the active instance when the template has a step-review node", async () => {
    // U6/KTD-4: with a step-review node present, step-execute must NOT mark the
    // step done (markDoneOnSuccess:false) — the active context flags this so the
    // step-execute seam can pass the flag to runTaskStep.
    let observedDefer: boolean | undefined;
    let observedNoReviewDefer: boolean | undefined;
    const seams = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        observedDefer = active.deferDoneToReview;
        return { outcome: "success", value: "step-done" };
      },
      stepReview: async () => ({ verdict: "APPROVE" as const }),
    });
    const reviewTemplate = {
      nodes: [
        { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
        { id: "review", kind: "step-review" as const, config: { type: "code" } },
      ],
      edges: [{ from: "exec", to: "review", condition: "success" }],
    };
    const executor = new WorkflowGraphExecutor({ seams });
    await executor.run(taskWithSteps(1), settingsOn(), foreachIr(reviewTemplate));
    expect(observedDefer).toBe(true);

    // Without a step-review node, deferDoneToReview is false (step-execute is the
    // done authority).
    const seamsNoReview = baseSeams({
      stepExecute: async (_t, ctx) => {
        const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        observedNoReviewDefer = active.deferDoneToReview;
        return { outcome: "success", value: "step-done" };
      },
    });
    const executor2 = new WorkflowGraphExecutor({ seams: seamsNoReview });
    await executor2.run(taskWithSteps(1), settingsOn(), foreachIr(singleExecuteTemplate()));
    expect(observedNoReviewDefer).toBe(false);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

/** Base no-op seams with an optional override (stepExecute etc.). */
function baseSeams(overrides: Partial<WorkflowLegacySeams>): WorkflowLegacySeams {
  const ok = async () => ({ outcome: "success" as const });
  return {
    planning: ok,
    execute: ok,
    review: ok,
    merge: ok,
    schedule: ok,
    ...overrides,
  };
}

/**
 * A prompt handler that dispatches: step-execute seam → seams.stepExecute;
 * otherwise to a per-node-id custom handler map (review/tail/second/etc.).
 */
function makePromptRouter(
  seams: WorkflowLegacySeams,
  byId: Record<string, WorkflowNodeHandler>,
): WorkflowNodeHandler {
  return async (node, ctx) => {
    if (node.config?.seam === "step-execute") {
      if (!seams.stepExecute) return { outcome: "failure", value: "step-execute-unwired" };
      return seams.stepExecute(ctx.task, ctx.context);
    }
    const handler = byId[node.id];
    if (handler) return handler(node, ctx);
    return { outcome: "success" };
  };
}
