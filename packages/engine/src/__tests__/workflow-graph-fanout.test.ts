import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflow-graph-executor.js";
import type {
  WorkflowBranchPersistence,
  WorkflowBranchProgress,
  WorkflowBranchRunState,
} from "../workflow-graph-branches.js";

const task = { id: "FN-FANOUT" } as TaskDetail;
const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

/** A controllable deferred so branches can complete in any order under test control. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** start → split → (branchA → branchB) → join → tail → end */
function twoBranchIr(joinConfig: Record<string, unknown>): WorkflowIr {
  return {
    version: "v2",
    name: "two-branch",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "split", kind: "split", column: "work" },
      { id: "branchA", kind: "prompt", column: "work", config: { prompt: "a" } },
      { id: "branchB", kind: "prompt", column: "work", config: { prompt: "b" } },
      { id: "join", kind: "join", column: "work", config: joinConfig },
      { id: "tail", kind: "prompt", column: "work", config: { prompt: "tail" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "split" },
      { from: "split", to: "branchA" },
      { from: "split", to: "branchB" },
      { from: "branchA", to: "join", condition: "success" },
      { from: "branchB", to: "join", condition: "success" },
      { from: "join", to: "tail", condition: "success" },
      { from: "join", to: "end", condition: "failure" },
      { from: "tail", to: "end", condition: "success" },
    ],
  };
}

describe("WorkflowGraphExecutor fan-out/join (U13)", () => {
  it("mode:all — both branches complete in any order, join fires once, advances to tail", async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    const tail = vi.fn(async () => ({ outcome: "success" as const }));
    const prompt: WorkflowNodeHandler = async (node) => {
      if (node.id === "branchA") await a.promise;
      if (node.id === "branchB") await b.promise;
      if (node.id === "tail") return tail();
      return { outcome: "success" as const };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });
    const run = executor.run(task, settingsOn(), twoBranchIr({ mode: "all" }));

    // Complete in reverse order to prove order-independence.
    b.resolve();
    await Promise.resolve();
    expect(tail).not.toHaveBeenCalled();
    a.resolve();

    const result = await run;
    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain("tail");
    expect(tail).toHaveBeenCalledTimes(1);
  });

  it("mode:any with collect — first completion fires join; slower branch finishes without re-firing", async () => {
    const slow = deferred<void>();
    const tail = vi.fn(async () => ({ outcome: "success" as const }));
    let slowFinished = false;
    const prompt: WorkflowNodeHandler = async (node) => {
      if (node.id === "branchB") {
        await slow.promise;
        slowFinished = true;
      }
      if (node.id === "tail") return tail();
      return { outcome: "success" as const };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });
    const run = executor.run(task, settingsOn(), twoBranchIr({ mode: "any", onBranchFailure: "collect" }));

    // branchA resolves immediately → join fires. tail must run exactly once.
    await Promise.resolve();
    slow.resolve();
    const result = await run;

    expect(result.outcome).toBe("success");
    expect(tail).toHaveBeenCalledTimes(1);
    expect(slowFinished).toBe(true);
  });

  it("mode:any with fail-fast — slower branch is aborted via signal", async () => {
    let aborted = false;
    const slow = deferred<void>();
    const prompt: WorkflowNodeHandler = async (node, ctx) => {
      if (node.id === "branchB") {
        ctx.signal?.addEventListener("abort", () => {
          aborted = true;
          slow.resolve();
        });
        await slow.promise;
        if (ctx.signal?.aborted) return { outcome: "failure" as const, value: "aborted" };
      }
      return { outcome: "success" as const };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });
    const result = await executor.run(task, settingsOn(), twoBranchIr({ mode: "any", onBranchFailure: "fail-fast" }));

    expect(result.outcome).toBe("success");
    expect(aborted).toBe(true);
  });

  it("quorum(2) of 3 — join fires on the second completion", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "quorum",
      columns: [{ id: "w", name: "W", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "split", kind: "split" },
        { id: "b1", kind: "prompt", config: {} },
        { id: "b2", kind: "prompt", config: {} },
        { id: "b3", kind: "prompt", config: {} },
        { id: "join", kind: "join", config: { mode: { quorum: 2 }, onBranchFailure: "collect" } },
        { id: "tail", kind: "prompt", config: {} },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "split" },
        { from: "split", to: "b1" },
        { from: "split", to: "b2" },
        { from: "split", to: "b3" },
        { from: "b1", to: "join", condition: "success" },
        { from: "b2", to: "join", condition: "success" },
        { from: "b3", to: "join", condition: "success" },
        { from: "join", to: "tail", condition: "success" },
        { from: "join", to: "end", condition: "failure" },
        { from: "tail", to: "end" },
      ],
    };
    const d3 = deferred<void>();
    const tail = vi.fn(async () => ({ outcome: "success" as const }));
    const prompt: WorkflowNodeHandler = async (node) => {
      if (node.id === "b3") await d3.promise;
      if (node.id === "tail") return tail();
      return { outcome: "success" as const };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });
    const run = executor.run(task, settingsOn(), ir);
    // b1 + b2 resolve immediately → quorum(2) satisfied without b3.
    await Promise.resolve();
    d3.resolve();
    const result = await run;
    expect(result.outcome).toBe("success");
    expect(tail).toHaveBeenCalledTimes(1);
  });

  it("branch failure fail-fast — siblings aborted, join routes the failure edge", async () => {
    let siblingAborted = false;
    const slow = deferred<void>();
    const prompt: WorkflowNodeHandler = async (node, ctx) => {
      if (node.id === "branchA") return { outcome: "failure" as const, value: "boom" };
      if (node.id === "branchB") {
        ctx.signal?.addEventListener("abort", () => {
          siblingAborted = true;
          slow.resolve();
        });
        await slow.promise;
        return { outcome: "success" as const };
      }
      return { outcome: "success" as const };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });
    const result = await executor.run(task, settingsOn(), twoBranchIr({ mode: "all", onBranchFailure: "fail-fast" }));

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).not.toContain("tail");
    expect(siblingAborted).toBe(true);
  });

  it("branch failure collect — all branches finish; join evaluates combined outcomes", async () => {
    const calls: string[] = [];
    const prompt: WorkflowNodeHandler = async (node) => {
      calls.push(node.id);
      if (node.id === "branchA") return { outcome: "failure" as const, value: "boom" };
      return { outcome: "success" as const };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });
    const result = await executor.run(task, settingsOn(), twoBranchIr({ mode: "all", onBranchFailure: "collect" }));

    // mode:all unmet (one failed) → join outcome failure; both branches ran.
    expect(result.outcome).toBe("failure");
    expect(calls).toContain("branchA");
    expect(calls).toContain("branchB");
    const branchOutcomes = result.context["node:join:branchOutcomes"] as { outcome: string }[];
    expect(branchOutcomes.some((b) => b.outcome === "failure")).toBe(true);
    expect(branchOutcomes.some((b) => b.outcome === "success")).toBe(true);
  });

  it("crash mid-branch resume — completed branches' nodes are NOT re-run", async () => {
    const calls: string[] = [];
    const store: WorkflowBranchRunState[] = [];
    const persistence: WorkflowBranchPersistence = {
      saveBranchState: (s) => {
        const idx = store.findIndex((e) => e.branchId === s.branchId);
        if (idx >= 0) store[idx] = s;
        else store.push({ ...s });
      },
      loadBranchStates: () => store.map((s) => ({ ...s })),
    };

    // First run: branchA completes, branchB hangs (simulated crash before join).
    const hang = deferred<void>();
    const aPersisted = deferred<void>();
    const persistenceA: WorkflowBranchPersistence = {
      saveBranchState: (s) => {
        persistence.saveBranchState!(s);
        if (s.branchId === "branchA" && s.status === "completed") aPersisted.resolve();
      },
      loadBranchStates: persistence.loadBranchStates,
    };
    const prompt1: WorkflowNodeHandler = async (node) => {
      calls.push(`run1:${node.id}`);
      if (node.id === "branchB") await hang.promise; // never resolves this run
      return { outcome: "success" as const };
    };
    const exec1 = new WorkflowGraphExecutor({ handlers: { prompt: prompt1 }, branchPersistence: persistenceA });
    const run1 = exec1.run(task, settingsOn(), twoBranchIr({ mode: "all" }));
    await aPersisted.promise;
    // Don't await run1 (branchB stuck) — simulate process death by starting fresh.

    expect(store.find((s) => s.branchId === "branchA")?.status).toBe("completed");

    // Resume: a brand-new executor reconstructed from persisted rows.
    const prompt2: WorkflowNodeHandler = async (node) => {
      calls.push(`run2:${node.id}`);
      return { outcome: "success" as const };
    };
    const exec2 = new WorkflowGraphExecutor({ handlers: { prompt: prompt2 }, branchPersistence: persistence });
    const result = await exec2.run(task, settingsOn(), twoBranchIr({ mode: "all" }));

    expect(result.outcome).toBe("success");
    // branchA already completed → not re-run on resume.
    expect(calls).not.toContain("run2:branchA");
    // branchB re-runs (it never completed).
    expect(calls).toContain("run2:branchB");
    hang.resolve();
    await run1.catch(() => {});
  });

  it("card-position invariant — no column move occurs during the parallel window", async () => {
    // The executor never touches task.column; assert the handler context exposes
    // the split's column to all branch nodes and the task object is untouched.
    const columnsSeen = new Set<string | undefined>();
    const taskColumnBefore = (task as { column?: string }).column;
    const prompt: WorkflowNodeHandler = async (node) => {
      if (node.id.startsWith("branch")) columnsSeen.add(node.column);
      return { outcome: "success" as const };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });
    await executor.run(task, settingsOn(), twoBranchIr({ mode: "all" }));
    // Branch nodes live in the split's column; task position never forked.
    expect(columnsSeen).toEqual(new Set(["work"]));
    expect((task as { column?: string }).column).toBe(taskColumnBefore);
  });

  it("semaphore bound — branches queue, never exceeding the limit (fake semaphore)", async () => {
    let active = 0;
    let peak = 0;
    const limit = 1;
    const queue: (() => void)[] = [];
    const fakeSemaphore = {
      async run<T>(fn: () => Promise<T>): Promise<T> {
        if (active >= limit) await new Promise<void>((res) => queue.push(res));
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await fn();
        } finally {
          active -= 1;
          queue.shift()?.();
        }
      },
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success" as const }) },
      branchSemaphore: fakeSemaphore,
    });
    const result = await executor.run(task, settingsOn(), twoBranchIr({ mode: "all" }));
    expect(result.outcome).toBe("success");
    expect(peak).toBeLessThanOrEqual(limit);
  });

  it("nested split resolves recursively", async () => {
    // start → split(outer) → [ branchX | split(inner) → [i1 | i2] → joinInner ] → joinOuter → end
    const ir: WorkflowIr = {
      version: "v2",
      name: "nested",
      columns: [{ id: "w", name: "W", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "outer", kind: "split" },
        { id: "branchX", kind: "prompt", config: {} },
        { id: "inner", kind: "split" },
        { id: "i1", kind: "prompt", config: {} },
        { id: "i2", kind: "prompt", config: {} },
        { id: "joinInner", kind: "join", config: { mode: "all" } },
        { id: "joinOuter", kind: "join", config: { mode: "all" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "outer" },
        { from: "outer", to: "branchX" },
        { from: "outer", to: "inner" },
        { from: "branchX", to: "joinOuter", condition: "success" },
        { from: "inner", to: "i1" },
        { from: "inner", to: "i2" },
        { from: "i1", to: "joinInner", condition: "success" },
        { from: "i2", to: "joinInner", condition: "success" },
        { from: "joinInner", to: "joinOuter", condition: "success" },
        { from: "joinOuter", to: "end", condition: "success" },
      ],
    };
    const calls: string[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async (node) => {
          calls.push(node.id);
          return { outcome: "success" as const };
        },
      },
    });
    const result = await executor.run(task, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(calls).toEqual(expect.arrayContaining(["branchX", "i1", "i2"]));
  });

  it("reports live per-branch progress for the dashboard", async () => {
    const progress: WorkflowBranchProgress[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success" as const }) },
      onBranchProgress: (p) => progress.push(p),
    });
    await executor.run(task, settingsOn(), twoBranchIr({ mode: "all" }));
    expect(progress.some((p) => p.branchId === "branchA" && p.status === "completed")).toBe(true);
    expect(progress.some((p) => p.branchId === "branchB" && p.status === "completed")).toBe(true);
  });
});
