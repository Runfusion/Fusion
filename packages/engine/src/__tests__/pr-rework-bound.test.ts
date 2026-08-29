/**
 * U6 — bounded-rework generalization to the top-level walk.
 *
 * U1–U5 confined `kind: "rework"` cycles to the foreach sub-walk; the top-level
 * recursive `walk` threw "Cycle detected" on ANY back-edge. U6 lifts the same
 * bounded-rework mechanism to the top level so the PR review loop (await-review →
 * pr-respond → rework → await-review) is a legal, bounded cycle. These tests pin:
 *
 *   - a top-level rework cycle loops up to the cap then routes
 *     `outcome:rework-exhausted` (finite; never infinite; never "Cycle detected");
 *   - a NON-rework top-level back-edge still throws "Cycle detected" (safety);
 *   - the bound is honored exactly (cap traversals of the rework edge).
 */
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

const task = { id: "FN-U6" } as TaskDetail;
const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

describe("WorkflowGraphExecutor bounded-rework generalization (U6)", () => {
  it("loops a top-level rework cycle up to the cap then routes rework-exhausted (never infinite)", async () => {
    // start → A(head) → B → rework back to A; A also has an
    // `outcome:rework-exhausted` forward edge to `done`. B always emits
    // value:"again" so the rework edge keeps firing until the budget runs out.
    const ir: WorkflowIr = {
      version: "v1",
      name: "toplevel-rework",
      nodes: [
        { id: "start", kind: "start" },
        { id: "A", kind: "gate", config: { maxReworkCycles: 2 } },
        { id: "B", kind: "prompt" },
        { id: "done", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "A" },
        { from: "A", to: "B", condition: "success" },
        // exhaustion routes the head forward via the rework-exhausted value.
        { from: "A", to: "done", condition: "outcome:rework-exhausted" },
        { from: "B", to: "A", kind: "rework", condition: "outcome:again" },
        { from: "done", to: "end" },
      ],
    };

    const a = vi.fn(async () => ({ outcome: "success" as const }));
    const b = vi.fn(async () => ({ outcome: "success" as const, value: "again" }));
    const done = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      handlers: { gate: a, prompt: b, script: done },
    });

    const result = await executor.run(task, settingsOn(), ir);

    expect(result.outcome).toBe("success");
    // cap = 2 → A runs the initial pass + 2 rework re-entries = 3 times; B once
    // per A pass = 3; then exhaustion routes `done` exactly once.
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(3);
    expect(done).toHaveBeenCalledTimes(1);
    expect(result.visitedNodeIds).toContain("done");
  });

  it("never throws 'Cycle detected' for the legal rework edge", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "rework-no-throw",
      nodes: [
        { id: "start", kind: "start" },
        { id: "A", kind: "gate", config: { maxReworkCycles: 1 } },
        { id: "B", kind: "prompt" },
        { id: "done", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "A" },
        { from: "A", to: "B", condition: "success" },
        { from: "A", to: "done", condition: "outcome:rework-exhausted" },
        { from: "B", to: "A", kind: "rework", condition: "outcome:again" },
        { from: "done", to: "end" },
      ],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: {
        gate: async () => ({ outcome: "success" }),
        prompt: async () => ({ outcome: "success", value: "again" }),
        script: async () => ({ outcome: "success" }),
      },
    });

    // Must resolve, not reject with "Cycle detected".
    await expect(executor.run(task, settingsOn(), ir)).resolves.toMatchObject({
      outcome: "success",
    });
  });

  it("a rework cycle that resolves before the cap takes the forward edge (no exhaustion)", async () => {
    // B emits value:"again" on the first pass (rework), then value:"ok" so A's
    // forward edge to `done` is taken on the second pass — exhaustion never fires.
    const ir: WorkflowIr = {
      version: "v1",
      name: "rework-resolves",
      nodes: [
        { id: "start", kind: "start" },
        { id: "A", kind: "gate", config: { maxReworkCycles: 5 } },
        { id: "B", kind: "prompt" },
        { id: "done", kind: "script" },
        { id: "exhausted", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "A" },
        // A routes forward to B on every pass; B decides rework vs. proceed.
        { from: "A", to: "B", condition: "success" },
        { from: "A", to: "exhausted", condition: "outcome:rework-exhausted" },
        { from: "B", to: "done", condition: "outcome:ok" },
        { from: "B", to: "A", kind: "rework", condition: "outcome:again" },
        { from: "done", to: "end" },
        { from: "exhausted", to: "end" },
      ],
    };
    let bCalls = 0;
    const done = vi.fn(async () => ({ outcome: "success" as const }));
    const exhausted = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      handlers: {
        gate: async () => ({ outcome: "success" }),
        prompt: async () => {
          bCalls += 1;
          return { outcome: "success" as const, value: bCalls === 1 ? "again" : "ok" };
        },
        script: async (node) => (node.id === "done" ? done() : exhausted()),
      },
    });

    const result = await executor.run(task, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(done).toHaveBeenCalledTimes(1);
    expect(exhausted).not.toHaveBeenCalled();
    expect(result.visitedNodeIds).toContain("done");
  });

  it("a NON-rework top-level back-edge still throws 'Cycle detected' (safety preserved)", async () => {
    // A → B → A with NO kind:"rework" on the back-edge. This must still be
    // rejected as an illegal cycle.
    const ir: WorkflowIr = {
      version: "v1",
      name: "illegal-cycle",
      nodes: [
        { id: "start", kind: "start" },
        { id: "A", kind: "prompt" },
        { id: "B", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "A" },
        { from: "A", to: "B", condition: "success" },
        // plain back-edge — NOT a rework edge.
        { from: "B", to: "A", condition: "success" },
      ],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "success" }) },
    });

    await expect(executor.run(task, settingsOn(), ir)).rejects.toThrow(/Cycle detected/);
  });

  it("defaults the rework cap when the head omits maxReworkCycles", async () => {
    // No config.maxReworkCycles → DEFAULT_MAX_REWORK_CYCLES (3): A runs 1 + 3 = 4.
    const ir: WorkflowIr = {
      version: "v1",
      name: "rework-default-cap",
      nodes: [
        { id: "start", kind: "start" },
        { id: "A", kind: "gate" },
        { id: "B", kind: "prompt" },
        { id: "done", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "A" },
        { from: "A", to: "B", condition: "success" },
        { from: "A", to: "done", condition: "outcome:rework-exhausted" },
        { from: "B", to: "A", kind: "rework", condition: "outcome:again" },
        { from: "done", to: "end" },
      ],
    };
    const a = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      handlers: {
        gate: a,
        prompt: async () => ({ outcome: "success", value: "again" }),
        script: async () => ({ outcome: "success" }),
      },
    });

    const result = await executor.run(task, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(a).toHaveBeenCalledTimes(4); // initial + 3 reworks (default cap)
  });
});
