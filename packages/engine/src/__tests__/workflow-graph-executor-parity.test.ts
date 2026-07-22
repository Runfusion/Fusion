// ─────────────────────────────────────────────────────────────────────────────
// PARITY SUBJECT (test-file ownership, U7 / KTD-9):
//   This suite owns DEFAULT-WORKFLOW BYTE-IDENTITY parity — it proves the graph
//   executor reproduces the workflow-native planning → execute → review → merge
//   seam sequence exactly (the parity ORACLE per KTD-1). It deliberately does NOT
//   cover per-step / updateStep-trajectory parity.
//
//   FNXC:WorkflowOptionalGroup 2026-06-21-15:10 (U6): the legacy `workflow-step`
//   seam was retired from the coding built-in; pre-merge browser-verification is
//   now a default-OFF `optional-group`. With no `enabledWorkflowSteps` on the task
//   the group is BYPASSED, so the lifecycle seam sequence is planning → execute →
//   review → merge (no workflow-step seam).
//
//   The stepwise per-step trajectory + merge-blocker-window parity (legacy
//   step-session path vs the stepwise foreach graph) is owned by the sibling
//   suite `stepwise-workflow-parity.test.ts`. Keep the two concerns separate.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIrV2, WorkflowStage } from "@fusion/core";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  buildWorkflowObservation,
  buildWorkflowObservationFromTask,
  compareWorkflowRunObservations,
} from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import type { WorkflowLegacySeams } from "../workflows/workflow-node-handlers.js";

/*
 * FNXC:WorkflowParity 2026-06-29-07:45:
 * These legacy byte-parity checks intentionally disable default-on optional groups so the observed seam sequence remains the historical planning → execute → review → merge oracle. Separate tests own default-on optional step execution and the stepwise builtin pipeline smoke.
 */
const task = { id: "FN-5767", enabledWorkflowSteps: [] } as TaskDetail;
type BaseSeam = "planning" | "execute" | "workflow-step" | "review" | "merge" | "schedule";

function isBaseSeam(seam: unknown): seam is BaseSeam {
  return seam === "planning" || seam === "execute" || seam === "workflow-step" || seam === "review" || seam === "merge" || seam === "schedule";
}

function runBaseSeam(seams: WorkflowLegacySeams, seam: BaseSeam, task: TaskDetail, context: Record<string, unknown>) {
  if (seam === "workflow-step") {
    return seams.workflowStep?.(task, context) ?? Promise.resolve({ outcome: "success" as const });
  }
  return seams[seam](task, context);
}

function runLegacy(seams: WorkflowLegacySeams) {
  return async () => {
    const events: string[] = [];
    const planning = await seams.planning(task, {});
    events.push(`planning:${planning.outcome}`);
    if (planning.outcome !== "success") return events;
    const execute = await seams.execute(task, {});
    events.push(`execute:${execute.outcome}`);
    if (execute.outcome !== "success") return events;
    // U6: no workflow-step seam — browser-verification is a bypassed optional-group.
    const review = await seams.review(task, {});
    events.push(`review:${review.outcome}`);
    if (review.outcome !== "success") return events;
    const merge = await seams.merge(task, {});
    events.push(`merge:${merge.outcome}`);
    return events;
  };
}

describe("WorkflowGraphExecutor interpreter-parity", () => {
  it("runs when workflowGraphExecutor is absent from experimental flags", async () => {
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt, script: prompt, gate: prompt } });
    const result = await executor.run(task, { experimentalFeatures: {} });
    expect(result.executed).toBe(true);
    expect(prompt).toHaveBeenCalled();
  });

  it("matches default planning-execute-review-merge success path", async () => {
    const events: string[] = [];
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      workflowStep: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
    };
    const legacyEvents = await runLegacy(seams)();
    const executor = new WorkflowGraphExecutor({ seams, handlers: { prompt: async (node, ctx) => {
      const seam = node.config?.seam;
      /*
       * FNXC:WorkflowParity 2026-06-29-14:20:
       * Default coding now includes non-legacy prompt nodes such as completion-summary in addition to legacy seams. Parity assertions must ignore those graph-native prompt nodes rather than failing the preserved planning/execute/review/merge byte-identity oracle.
       */
      if (!isBaseSeam(seam)) return { outcome: "success" };
      const result = await runBaseSeam(seams, seam, ctx.task, ctx.context);
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
      workflowStep: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "failure", value: "FileScopeViolationError" }),
      schedule: async () => ({ outcome: "success" }),
    };
    const legacyEvents = await runLegacy(seams)();
    const executor = new WorkflowGraphExecutor({ seams });
    const result = await executor.run(task, { experimentalFeatures: { workflowGraphExecutor: true } });
    expect(result.outcome).toBe("failure");
    expect(legacyEvents).toEqual(["planning:success", "execute:success", "review:success", "merge:failure"]);
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

// ─────────────────────────────────────────────────────────────────────────────
// COLUMN-AGENT INVISIBILITY PARITY (plan U7 / R9)
//
// The per-column agent feature must be invisible when no column carries a
// binding: the built-in default workflow synthesizes no `agent` field on any
// column, and a binding-free run produces observations identical to legacy via
// the same `compareWorkflowRunObservations` machinery the dual-observe gate uses.
// This is the byte-identity / parity oracle for the feature being unbound.
// ─────────────────────────────────────────────────────────────────────────────
describe("column-agent feature is invisible when unbound (U7 / R9)", () => {
  it("the default built-in workflow synthesizes NO column agent field on any column", () => {
    const ir = BUILTIN_CODING_WORKFLOW_IR as WorkflowIrV2;
    expect(ir.version).toBe("v2");
    expect(ir.columns.length).toBeGreaterThan(0);
    for (const col of ir.columns) {
      // Absent, not `null` and not an explicit default — R9 omission guarantee.
      expect("agent" in col).toBe(false);
    }
  });

  it("a binding-free run yields observations identical to legacy (compareWorkflowRunObservations agrees)", async () => {
    // Drive the graph executor over the default execute→review→merge sequence and
    // collect the stage transitions; with zero column bindings, the column-agent
    // feature contributes nothing, so the interpreter observation must equal the
    // legacy authoritative observation with no drift.
    const stages: string[] = [];
    const seams: WorkflowLegacySeams = {
      planning: async () => ({ outcome: "success" }),
      execute: async () => ({ outcome: "success" }),
      workflowStep: async () => ({ outcome: "success" }),
      review: async () => ({ outcome: "success" }),
      merge: async () => ({ outcome: "success" }),
      schedule: async () => ({ outcome: "success" }),
    };
    const executor = new WorkflowGraphExecutor({
      seams,
      handlers: {
        prompt: async (node, ctx) => {
          const seam = node.config?.seam;
          // FNXC:WorkflowParity 2026-06-29-14:20: Only legacy seams participate in the column-agent invisibility observation; graph-native summary prompts stay byte-inert for this oracle.
          if (!isBaseSeam(seam)) return { outcome: "success" };
          stages.push(seam);
          return runBaseSeam(seams, seam, ctx.task, ctx.context);
        },
      },
    });

    const result = await executor.run(task, {
      experimentalFeatures: { workflowGraphExecutor: true },
    });
    expect(result.outcome).toBe("success");
    // Bind the invariant to actual executor behavior (PR #1432 review): the
    // observation below derives from the run-captured seam sequence, so seam
    // drift fails here instead of being masked by a hard-coded literal.
    expect(stages).toEqual(["planning", "execute", "review", "merge"]);

    // Legacy authoritative observation: a clean run that lands in `done`/merged.
    const legacyObs = buildWorkflowObservation({
      stageTransitions: ["triage", "planning", "execute", "review", "merge"],
      terminalColumn: "done",
      terminalStatus: "done",
      reviewVerdict: "approve",
      mergeOutcome: "merged",
    });
    // Interpreter (binding-free) observation assembled from the same run.
    const interpreterObs = buildWorkflowObservation({
      stageTransitions: ["triage", ...stages] as WorkflowStage[],
      terminalColumn: "done",
      terminalStatus: "done",
      reviewVerdict: "approve",
      mergeOutcome: "merged",
    });

    const report = compareWorkflowRunObservations(legacyObs, interpreterObs);
    expect(report.agree).toBe(true);
    expect(report.diffs).toEqual([]);
  });
});
