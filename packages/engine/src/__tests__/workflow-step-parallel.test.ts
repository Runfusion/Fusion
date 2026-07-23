import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, TaskStep, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import {
  FOREACH_ACTIVE_CONTEXT_KEY,
  type ForeachActiveContext,
  type WorkflowLegacySeams,
} from "../workflows/workflow-node-handlers.js";
import {
  IntegrationQueue,
  type IntegrationGitOps,
  type IntegrationProjection,
  type IntegrationAttemptResult,
} from "../execution/step-integration.js";
import type { WorkflowStepInstanceState } from "../workflows/workflow-graph-foreach.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

// ── shared test scaffolding ─────────────────────────────────────────────────

/** Build a TaskDetail with a step list; dependsOn (0-indexed) per step optional. */
function taskWithSteps(specs: Array<{ dependsOn?: number[] }> | number): TaskDetail {
  const list: Array<{ dependsOn?: number[] }> =
    typeof specs === "number" ? Array.from({ length: specs }, () => ({})) : specs;
  const steps: TaskStep[] = list.map((s, i) => ({
    name: `Step ${i + 1}`,
    status: "pending" as const,
    ...(Array.isArray(s.dependsOn) ? { dependsOn: s.dependsOn } : {}),
  }));
  return { id: "FN-PAR", steps } as unknown as TaskDetail;
}

/** Base no-op seams with an optional override. */
function baseSeams(overrides: Partial<WorkflowLegacySeams>): WorkflowLegacySeams {
  const ok = async () => ({ outcome: "success" as const });
  return { planning: ok, execute: ok, review: ok, merge: ok, schedule: ok, ...overrides };
}

/** A single step-execute template. */
function singleExecuteTemplate() {
  return {
    nodes: [{ id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } }],
    edges: [],
  };
}

/** exec → step-review template (review routes approve/revise/rethink). */
function reviewTemplate() {
  return {
    nodes: [
      { id: "exec", kind: "prompt" as const, config: { seam: "step-execute" } },
      { id: "review", kind: "step-review" as const, config: { type: "code" } },
    ],
    edges: [
      { from: "exec", to: "review", condition: "success" },
      { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" as const },
      { from: "review", to: "exec", condition: "outcome:rethink", kind: "rework" as const },
    ],
  };
}

function foreachIr(
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIr["edges"] },
  config: Record<string, unknown> = {},
): WorkflowIr {
  return {
    version: "v2",
    name: "parallel-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "fe", kind: "foreach", config: { source: "task-steps", template, ...config } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "fe" },
      { from: "fe", to: "end", condition: "success" },
    ],
  };
}

/**
 * A fake worktree+git+integration backend the executor deps are wired to. Models
 * a per-instance branch and an ordered integration base purely in-memory; tests
 * script which (stepIndex) integrations conflict.
 */
function makeFakeBackend(opts: {
  conflictSteps?: Set<number>;
  /** Steps whose integration conflicts only on the FIRST attempt (then succeed). */
  conflictOnceSteps?: Set<number>;
} = {}) {
  const conflictSteps = opts.conflictSteps ?? new Set<number>();
  const conflictOnceSteps = opts.conflictOnceSteps ?? new Set<number>();
  const integrateAttempts = new Map<number, number>();

  const allocations: Array<{ stepIndex: number; branchName: string; base: string | undefined }> = [];
  const integrationOrder: number[] = [];
  const discarded: string[] = [];
  const released: string[] = [];
  const doneSteps: number[] = [];
  const instanceIntegrated: Array<{ stepIndex: number; at: string }> = [];
  let integrationBase = "main@0";
  let integratedCount = 0;
  const resetBranches: string[] = [];

  const gitOps: IntegrationGitOps = {
    integrate: async (branchName, stepIndex): Promise<IntegrationAttemptResult> => {
      const attempt = (integrateAttempts.get(stepIndex) ?? 0) + 1;
      integrateAttempts.set(stepIndex, attempt);
      const conflictNow =
        conflictSteps.has(stepIndex) || (conflictOnceSteps.has(stepIndex) && attempt === 1);
      if (conflictNow) {
        return { kind: "conflict", conflictedFiles: [`step-${stepIndex}.ts`] };
      }
      integrationOrder.push(stepIndex);
      integratedCount += 1;
      integrationBase = `main@${integratedCount}`; // base advances on each integration
      return { kind: "integrated", integratedAt: `t${stepIndex}` };
    },
    discardBranch: async (branchName) => {
      discarded.push(branchName);
      released.push(branchName);
    },
  };

  const projection: IntegrationProjection = {
    markStepDone: async (stepIndex) => {
      doneSteps.push(stepIndex);
    },
    markInstanceIntegrated: async (stepIndex, at) => {
      instanceIntegrated.push({ stepIndex, at });
    },
  };

  return {
    gitOps,
    projection,
    allocations,
    integrationOrder,
    discarded,
    released,
    doneSteps,
    instanceIntegrated,
    resetBranches,
    getBase: () => integrationBase,
    deps: {
      allocateInstanceWorktree: async (stepIndex: number, base: string | undefined) => {
        const branchName = `fusion/fn-par-step-${stepIndex}`;
        allocations.push({ stepIndex, branchName, base });
        return { worktreePath: `/wt/step-${stepIndex}`, branchName };
      },
      resolveIntegrationBase: async () => integrationBase,
      integrationGitOps: gitOps,
      integrationProjection: projection,
    },
  };
}

// ── IntegrationQueue state machine (TEST-FIRST) ─────────────────────────────

describe("IntegrationQueue (ordered integration state machine)", () => {
  function queueHarness(pinned: number, integrate: (b: string, i: number) => IntegrationAttemptResult) {
    const order: number[] = [];
    const done: number[] = [];
    const integrated: number[] = [];
    const discarded: string[] = [];
    const git: IntegrationGitOps = {
      integrate: async (b, i) => {
        const r = integrate(b, i);
        if (r.kind === "integrated") order.push(i);
        return r;
      },
      discardBranch: async (b) => {
        discarded.push(b);
      },
    };
    const proj: IntegrationProjection = {
      markStepDone: async (i) => {
        done.push(i);
      },
      markInstanceIntegrated: async (i) => {
        integrated.push(i);
      },
    };
    const q = new IntegrationQueue(git, proj, pinned);
    return { q, order, done, integrated, discarded };
  }

  it("integrates strictly in step order even when completion order inverts", async () => {
    const h = queueHarness(3, () => ({ kind: "integrated", integratedAt: "t" }));
    // Enqueue out of order: 2 first, then 0, then 1.
    h.q.enqueue(2, "b2");
    let outcomes = await h.q.drain();
    expect(outcomes).toEqual([]); // 0 not ready → nothing integrates.
    h.q.enqueue(0, "b0");
    outcomes = await h.q.drain();
    expect(h.order).toEqual([0]); // only 0 (1 is the next gap).
    h.q.enqueue(1, "b1");
    await h.q.drain();
    expect(h.order).toEqual([0, 1, 2]); // 1 then 2 cascade.
    expect(h.q.isDrained()).toBe(true);
  });

  it("projection-first: markStepDone precedes markInstanceIntegrated per step", async () => {
    const events: string[] = [];
    const git: IntegrationGitOps = {
      integrate: async () => ({ kind: "integrated", integratedAt: "t" }),
      discardBranch: async () => {},
    };
    const proj: IntegrationProjection = {
      markStepDone: async (i) => {
        events.push(`done:${i}`);
      },
      markInstanceIntegrated: async (i) => {
        events.push(`row:${i}`);
      },
    };
    const q = new IntegrationQueue(git, proj, 1);
    q.enqueue(0, "b0");
    await q.drain();
    expect(events).toEqual(["done:0", "row:0"]);
  });

  it("conflict stops the drain, discards the branch, and does not mark done", async () => {
    const h = queueHarness(2, (_b, i) =>
      i === 0 ? { kind: "conflict", conflictedFiles: ["x"] } : { kind: "integrated", integratedAt: "t" },
    );
    h.q.enqueue(0, "b0");
    h.q.enqueue(1, "b1");
    const outcomes = await h.q.drain();
    expect(outcomes).toEqual([{ stepIndex: 0, status: "conflict", conflictedFiles: ["x"] }]);
    expect(h.done).toEqual([]);
    expect(h.discarded).toContain("b0");
    // Step 1 must NOT integrate ahead of the unresolved step 0.
    expect(h.order).toEqual([]);
  });

  it("skip advances the cursor past a failed step", async () => {
    const h = queueHarness(3, () => ({ kind: "integrated", integratedAt: "t" }));
    h.q.skip(0);
    h.q.enqueue(1, "b1");
    h.q.enqueue(2, "b2");
    await h.q.drain();
    expect(h.order).toEqual([1, 2]);
    expect(h.q.isDrained()).toBe(true);
  });
});

// ── full U10 scenarios ──────────────────────────────────────────────────────

describe("WorkflowGraphExecutor parallel/worktree foreach (U10)", () => {
  /** Run a foreach IR with a fake backend; record the order steps START. */
  async function runScenario(
    task: TaskDetail,
    config: Record<string, unknown>,
    backend: ReturnType<typeof makeFakeBackend>,
    overrides: Partial<{
      semaphoreAvailability: () => number;
      stepExecute: WorkflowLegacySeams["stepExecute"];
      stepReview: WorkflowLegacySeams["stepReview"];
      onReworkReset: (a: ForeachActiveContext) => void;
      template: { nodes: WorkflowIrNode[]; edges: WorkflowIr["edges"] };
      signal: AbortSignal;
      logTaskEntry: (summary: string, detail?: string) => void;
    }> = {},
  ) {
    const startOrder: number[] = [];
    const seams = baseSeams({
      stepExecute:
        overrides.stepExecute ??
        (async (_t, ctx) => {
          const active = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
          startOrder.push(active.stepIndex);
          return { outcome: "success", value: "step-done" };
        }),
      ...(overrides.stepReview ? { stepReview: overrides.stepReview } : {}),
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      ...backend.deps,
      ...(overrides.semaphoreAvailability ? { semaphoreAvailability: overrides.semaphoreAvailability } : {}),
      ...(overrides.onReworkReset ? { onReworkReset: overrides.onReworkReset as never } : {}),
      ...(overrides.signal ? { signal: overrides.signal } : {}),
      ...(overrides.logTaskEntry ? { logTaskEntry: overrides.logTaskEntry } : {}),
    });
    const ir = foreachIr(overrides.template ?? singleExecuteTemplate(), config);
    const result = await executor.run(task, settingsOn(), ir);
    return { result, startOrder };
  }

  it("diamond dep graph (0 ← 1,2 ← 3) runs 1∥2 then 3", async () => {
    // Step 0 root; 1 and 2 depend on 0; 3 depends on 1 and 2.
    const task = taskWithSteps([
      { dependsOn: [] },
      { dependsOn: [0] },
      { dependsOn: [0] },
      { dependsOn: [1, 2] },
    ]);
    const backend = makeFakeBackend();
    const { result, startOrder } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 4 },
      backend,
    );
    expect(result.outcome).toBe("success");
    // 0 first; 1 and 2 after 0 integrated; 3 last.
    expect(startOrder[0]).toBe(0);
    expect(new Set([startOrder[1], startOrder[2]])).toEqual(new Set([1, 2]));
    expect(startOrder[3]).toBe(3);
    // Ordered integration is step order.
    expect(backend.integrationOrder).toEqual([0, 1, 2, 3]);
    expect(backend.doneSteps).toEqual([0, 1, 2, 3]);
  });

  it("sequential + worktree runs one at a time with per-step branches + ordered integration", async () => {
    const task = taskWithSteps(3);
    const backend = makeFakeBackend();
    const concurrentPeak = { value: 0 };
    let active = 0;
    const { result } = await runScenario(task, { mode: "sequential", isolation: "worktree" }, backend, {
      stepExecute: async () => {
        active += 1;
        concurrentPeak.value = Math.max(concurrentPeak.value, active);
        await Promise.resolve();
        active -= 1;
        return { outcome: "success", value: "step-done" };
      },
    });
    expect(result.outcome).toBe("success");
    expect(concurrentPeak.value).toBe(1); // never more than one at a time.
    expect(backend.allocations.map((a) => a.branchName)).toEqual([
      "fusion/fn-par-step-0",
      "fusion/fn-par-step-1",
      "fusion/fn-par-step-2",
    ]);
    expect(backend.integrationOrder).toEqual([0, 1, 2]);
  });

  it("explicit empty dependsOn steps run as independent parallel roots", async () => {
    const task = taskWithSteps([{ dependsOn: [] }, { dependsOn: [] }, { dependsOn: [] }]);
    const backend = makeFakeBackend();
    const concurrentPeak = { value: 0 };
    const order: number[] = [];
    let active = 0;
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 3 },
      backend,
      {
        stepExecute: async (_t, ctx) => {
          const a = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
          order.push(a.stepIndex);
          active += 1;
          concurrentPeak.value = Math.max(concurrentPeak.value, active);
          await Promise.resolve();
          active -= 1;
          return { outcome: "success", value: "step-done" };
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(new Set(order)).toEqual(new Set([0, 1, 2]));
    expect(concurrentPeak.value).toBeGreaterThan(1);
    expect(backend.integrationOrder).toEqual([0, 1, 2]);
  });

  it("unannotated plan stays fully sequential at concurrency 4", async () => {
    const task = taskWithSteps(4); // no dependsOn → each implicitly depends on prev.
    const backend = makeFakeBackend();
    const concurrentPeak = { value: 0 };
    const order: number[] = [];
    let active = 0;
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 4 },
      backend,
      {
        stepExecute: async (_t, ctx) => {
          const a = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
          order.push(a.stepIndex);
          active += 1;
          concurrentPeak.value = Math.max(concurrentPeak.value, active);
          await Promise.resolve();
          active -= 1;
          return { outcome: "success", value: "step-done" };
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(concurrentPeak.value).toBe(1);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(backend.integrationOrder).toEqual([0, 1, 2, 3]);
  });

  it("conflict between parallel steps → loser reworks on updated base and succeeds", async () => {
    const task = taskWithSteps([{ dependsOn: [] }, { dependsOn: [] }]);
    // Step 1 conflicts the first integration attempt, then succeeds.
    const backend = makeFakeBackend({ conflictOnceSteps: new Set([1]) });
    const execStarts: number[] = [];
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 2 },
      backend,
      {
        stepExecute: async (_t, ctx) => {
          const a = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
          execStarts.push(a.stepIndex);
          return { outcome: "success", value: "step-done" };
        },
      },
    );
    expect(result.outcome).toBe("success");
    // Step 1 executed twice (initial + rework after conflict).
    expect(execStarts.filter((s) => s === 1).length).toBe(2);
    // Both eventually integrated, in step order.
    expect(backend.integrationOrder).toEqual([0, 1]);
    expect(backend.doneSteps).toEqual([0, 1]);
    // The conflicting branch was discarded before re-running.
    expect(backend.discarded).toContain("fusion/fn-par-step-1");
    // The rework re-allocated off the UPDATED base (after step 0 integrated).
    const step1Allocs = backend.allocations.filter((a) => a.stepIndex === 1);
    expect(step1Allocs.length).toBe(2);
    expect(step1Allocs[1].base).toBe("main@1");
  });

  it("FIX 4: an integration conflict writes a task-level log entry naming the conflicted files", async () => {
    const task = taskWithSteps([{ dependsOn: [] }, { dependsOn: [] }]);
    const backend = makeFakeBackend({ conflictOnceSteps: new Set([1]) });
    const logged: Array<{ summary: string; detail?: string }> = [];
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 2 },
      backend,
      { logTaskEntry: (summary, detail) => logged.push({ summary, detail }) },
    );
    expect(result.outcome).toBe("success");
    const conflictLog = logged.find((l) => l.summary.includes("integration conflict on step 1"));
    expect(conflictLog).toBeDefined();
    expect(conflictLog!.summary).toContain("reworking on updated base");
    // The fake backend reports `step-1.ts` as the conflicted file.
    expect(conflictLog!.summary).toContain("step-1.ts");
    expect(conflictLog!.detail).toContain("step-1.ts");
  });

  it("conflict rework exhaustion routes rework-exhausted", async () => {
    const task = taskWithSteps([{ dependsOn: [] }]);
    const backend = makeFakeBackend({ conflictSteps: new Set([0]) }); // always conflicts.
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 1, maxReworkCycles: 2 },
      backend,
    );
    expect(result.outcome).toBe("failure");
    expect(result.context).toBeDefined();
    // The foreach node's value surfaces rework-exhausted.
    expect(result.visitedNodeIds).toContain("fe");
    // Never marked done.
    expect(backend.doneSteps).toEqual([]);
  });

  it("FIX 2: a failed instance releases its allocated worktree exactly once", async () => {
    const task = taskWithSteps([{ dependsOn: [] }]);
    const backend = makeFakeBackend();
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 1 },
      backend,
      {
        // The instance allocates a worktree, then its step-execute FAILS — the
        // scheduler never enqueues it for integration, so without explicit
        // release its worktree+branch would leak.
        stepExecute: async () => ({ outcome: "failure", value: "boom" }),
      },
    );
    expect(result.outcome).toBe("failure");
    // The allocated branch was released exactly once (discard==release in the fake).
    expect(backend.allocations.map((a) => a.branchName)).toEqual(["fusion/fn-par-step-0"]);
    expect(backend.released).toEqual(["fusion/fn-par-step-0"]);
    expect(backend.released.filter((b) => b === "fusion/fn-par-step-0").length).toBe(1);
    // It never integrated.
    expect(backend.doneSteps).toEqual([]);
  });

  it("FIX 2: abort mid-run releases every allocated instance worktree", async () => {
    const task = taskWithSteps([{ dependsOn: [] }, { dependsOn: [] }]);
    const backend = makeFakeBackend();
    const controller = new AbortController();
    let executed = 0;
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 2 },
      backend,
      {
        // Both instances allocate worktrees and run; abort after the first batch's
        // step-execute so the scheduler's top-of-loop abort check fires while their
        // worktrees are still allocated.
        stepExecute: async () => {
          executed += 1;
          if (executed >= 1) controller.abort();
          return { outcome: "success", value: "step-done" };
        },
        signal: controller.signal,
      },
    );
    expect(result.outcome).toBe("failure");
    // Every allocated branch was released (no leak), each exactly once.
    const allocated = backend.allocations.map((a) => a.branchName);
    expect(allocated.length).toBeGreaterThan(0);
    for (const b of allocated) {
      expect(backend.released.filter((r) => r === b).length).toBe(1);
    }
  });

  it("integration order is step order even when completion order inverts", async () => {
    const task = taskWithSteps([{ dependsOn: [] }, { dependsOn: [] }, { dependsOn: [] }]);
    const backend = makeFakeBackend();
    // Make later steps complete FIRST by delaying step 0's execution.
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 3 },
      backend,
      {
        stepExecute: async (_t, ctx) => {
          const a = ctx[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
          // step 0 yields the most → completes last.
          const delays = 2 - a.stepIndex;
          for (let i = 0; i < delays; i++) await Promise.resolve();
          return { outcome: "success", value: "step-done" };
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(backend.integrationOrder).toEqual([0, 1, 2]);
    expect(backend.doneSteps).toEqual([0, 1, 2]);
  });

  it("semaphore starvation degrades to sequential without deadlock", async () => {
    const task = taskWithSteps([{ dependsOn: [] }, { dependsOn: [] }, { dependsOn: [] }]);
    const backend = makeFakeBackend();
    const concurrentPeak = { value: 0 };
    let active = 0;
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 4 },
      backend,
      {
        semaphoreAvailability: () => 0, // fully starved.
        stepExecute: async () => {
          active += 1;
          concurrentPeak.value = Math.max(concurrentPeak.value, active);
          await Promise.resolve();
          active -= 1;
          return { outcome: "success", value: "step-done" };
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(concurrentPeak.value).toBe(1); // forced to 1 under starvation, no deadlock.
    expect(backend.integrationOrder).toEqual([0, 1, 2]);
  });

  it("dependency cycle at expansion fails audited", async () => {
    // Step 1 depends on step 2 (a forward reference → cycle signature).
    const task = taskWithSteps([{ dependsOn: [] }, { dependsOn: [2] }, { dependsOn: [] }]);
    const backend = makeFakeBackend();
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 4 },
      backend,
    );
    expect(result.outcome).toBe("failure");
    expect(backend.allocations).toEqual([]); // never expanded any instance.
  });

  it("RETHINK resets only the instance branch (branch-scoped)", async () => {
    const task = taskWithSteps([{ dependsOn: [] }]);
    const backend = makeFakeBackend();
    const resetBranches: string[] = [];
    let reviewCalls = 0;
    const { result } = await runScenario(
      task,
      { mode: "parallel", isolation: "worktree", concurrency: 1 },
      backend,
      {
        template: reviewTemplate(),
        stepReview: async () => {
          reviewCalls += 1;
          return reviewCalls === 1 ? { verdict: "RETHINK" as const } : { verdict: "APPROVE" as const };
        },
        onReworkReset: (active: ForeachActiveContext) => {
          // Branch-scoped reset: the active context carries THIS instance's branch.
          resetBranches.push(active.branchName ?? "<none>");
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(resetBranches).toEqual(["fusion/fn-par-step-0"]);
    expect(backend.integrationOrder).toEqual([0]);
  });

  it("merge-blocker stays blocked until last integration (projection rule)", async () => {
    const task = taskWithSteps([{ dependsOn: [] }, { dependsOn: [0] }]);
    const backend = makeFakeBackend();
    // Capture doneSteps progression: step 1 must not be done until it integrates.
    const doneAfterStep0Integrated: number[] = [];
    const origMarkDone = backend.projection.markStepDone;
    backend.projection.markStepDone = async (i) => {
      await origMarkDone(i);
      doneAfterStep0Integrated.push(i);
    };
    const { result } = await runScenario(
      task,
      { mode: "sequential", isolation: "worktree" },
      backend,
    );
    expect(result.outcome).toBe("success");
    // done flips strictly in integration order — step 1 done ONLY after step 0.
    expect(doneAfterStep0Integrated).toEqual([0, 1]);
  });

  it("worktree isolation without wiring fails cleanly (routable)", async () => {
    const task = taskWithSteps(2);
    const executor = new WorkflowGraphExecutor({ seams: baseSeams({}) });
    const result = await executor.run(
      task,
      settingsOn(),
      foreachIr(singleExecuteTemplate(), { mode: "parallel", isolation: "worktree" }),
    );
    expect(result.outcome).toBe("failure");
  });
});

// ── crash-resume reconciliation ─────────────────────────────────────────────

describe("worktree-isolation crash-resume reconciliation (U10)", () => {
  it("persists branchName + awaiting-integration through the persistence hook", async () => {
    const task = taskWithSteps([{ dependsOn: [] }]);
    const backend = makeFakeBackend();
    const saved: WorkflowStepInstanceState[] = [];
    const persistence = {
      saveInstanceState: (s: WorkflowStepInstanceState) => {
        saved.push({ ...s });
      },
    };
    const seams = baseSeams({
      stepExecute: async () => ({ outcome: "success", value: "step-done" }),
    });
    const executor = new WorkflowGraphExecutor({
      seams,
      ...backend.deps,
      stepInstancePersistence: persistence,
    });
    const result = await executor.run(
      task,
      settingsOn(),
      foreachIr(singleExecuteTemplate(), { mode: "sequential", isolation: "worktree" }),
    );
    expect(result.outcome).toBe("success");
    // The instance row carried branchName and reached awaiting-integration.
    const awaiting = saved.find((s) => s.status === "awaiting-integration");
    expect(awaiting).toBeDefined();
    expect(awaiting?.branchName).toBe("fusion/fn-par-step-0");
  });
});
