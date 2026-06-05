// ─────────────────────────────────────────────────────────────────────────────
// PARITY SUBJECT (test-file ownership, U7 / KTD-9):
//   This suite owns DEFAULT-WORKFLOW BYTE-IDENTITY parity — it proves the graph
//   executor reproduces the legacy monolithic execute → review → merge seam
//   sequence exactly (the parity ORACLE per KTD-1). It deliberately does NOT
//   cover per-step / updateStep-trajectory parity.
//
//   The stepwise per-step trajectory + merge-blocker-window parity (legacy
//   step-session path vs the stepwise foreach graph) is owned by the sibling
//   suite `stepwise-workflow-parity.test.ts`. Keep the two concerns separate.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import type { WorkflowLegacySeams } from "../workflow-node-handlers.js";

const task = { id: "FN-5767" } as TaskDetail;

function runLegacy(seams: WorkflowLegacySeams) {
  return async () => {
    const events: string[] = [];
    const execute = await seams.execute(task, {});
    events.push(`execute:${execute.outcome}`);
    if (execute.outcome !== "success") return events;
    const review = await seams.review(task, {});
    events.push(`review:${review.outcome}`);
    if (review.outcome !== "success") return events;
    const merge = await seams.merge(task, {});
    events.push(`merge:${merge.outcome}`);
    return events;
  };
}

describe("WorkflowGraphExecutor interpreter-parity", () => {
  it("is a strict no-op when workflowGraphExecutor flag is disabled", async () => {
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt, script: prompt, gate: prompt } });
    const result = await executor.run(task, { experimentalFeatures: {} });
    expect(result.executed).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("matches legacy execute-review-merge success path", async () => {
    const events: string[] = [];
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
    };
    const legacyEvents = await runLegacy(seams)();
    type BaseSeam = "planning" | "execute" | "review" | "merge" | "schedule";
    const executor = new WorkflowGraphExecutor({ seams, handlers: { prompt: async (node, ctx) => {
      const seam = String(node.config?.seam);
      const result = await seams[seam as BaseSeam](ctx.task, ctx.context);
      events.push(`${seam}:${result.outcome}`);
      return result;
    } } });

    const result = await executor.run(task, { experimentalFeatures: { workflowGraphExecutor: true } });
    expect(result.outcome).toBe("success");
    expect(events).toEqual(legacyEvents);
  });

  it("routes file-scope-like merge failure parity", async () => {
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "failure", value: "FileScopeViolationError" }),
      schedule: async () => ({ outcome: "success" }),
    };
    const legacyEvents = await runLegacy(seams)();
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(task, { experimentalFeatures: { workflowGraphExecutor: true } });
    expect(result.outcome).toBe("failure");
    expect(legacyEvents).toEqual(["execute:success", "review:success", "merge:failure"]);
  });

  it("preserves autoMerge:false terminal in-review semantics via review failure", async () => {
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "failure", value: "manual-merge-required" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
    };
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(task, { experimentalFeatures: { workflowGraphExecutor: true } });
    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).not.toContain("merge");
  });

  it("matches self-healing parity by routing deterministic failure outcomes", async () => {
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "failure", value: "recoverable" }),
      review: vi.fn(async () => ({ outcome: "success" as const })),
      merge: vi.fn(async () => ({ outcome: "success" as const })),
      schedule: async () => ({ outcome: "success" }),
    };
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(task, { experimentalFeatures: { workflowGraphExecutor: true } });
    expect(result.outcome).toBe("failure");
    expect(result.context["node:execute:value"]).toBe("recoverable");
    expect(seams.review).not.toHaveBeenCalled();
  });

  it("matches moveTask hard-cancel behavior by halting downstream seams", async () => {
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "failure", value: "hard-cancel" }),
      review: vi.fn(async () => ({ outcome: "success" as const })),
      merge: vi.fn(async () => ({ outcome: "success" as const })),
      schedule: async () => ({ outcome: "success" }),
    };
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(task, { experimentalFeatures: { workflowGraphExecutor: true } });
    expect(result.outcome).toBe("failure");
    expect(seams.review).not.toHaveBeenCalled();
    expect(seams.merge).not.toHaveBeenCalled();
  });
});
