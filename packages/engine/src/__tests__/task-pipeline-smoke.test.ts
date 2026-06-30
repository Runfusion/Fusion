import { describe, expect, it } from "vitest";
import type { Settings, TaskDetail, TaskStep } from "@fusion/core";

import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import type { WorkflowRuntimePrimitives } from "../runtime-primitives.js";
import {
  WORKFLOW_ID_CONTEXT_KEY,
  WORKFLOW_RUN_ID_CONTEXT_KEY,
} from "../workflow-node-handlers.js";

const promptWithOneStep = `# Task: FN-7228 Pipeline smoke

## Steps

### Step 1: Add the minimal pipeline smoke test
- Prove the default task pipeline reaches merge.
`;

const task = {
  id: "FN-7228-SMOKE",
  title: "Pipeline smoke",
  description: "Exercise the default task pipeline without external side effects.",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  prompt: promptWithOneStep,
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:00.000Z",
} as TaskDetail;

const settings = { experimentalFeatures: {} } as Pick<Settings, "experimentalFeatures">;

describe("task pipeline smoke", () => {
  it("runs an unselected task through the default built-in coding pipeline", async () => {
    const calls: string[] = [];
    const mergeContexts: Array<{ workflowId: string; runId: string }> = [];
    let selectionReads = 0;

    /*
     * FNXC:WorkflowSmoke 2026-06-29-00:00:
     * This smoke intentionally drives WorkflowTaskRuntime with in-memory primitives only. The invariant is that an unselected task resolves to the default `builtin:coding` pipeline, parses the required PROMPT.md step source, executes one planned step, reaches review gates, and calls merge exactly once without git, network, subprocess, timer, or database dependencies.
     */
    const primitives: WorkflowRuntimePrimitives = {
      prepareWorktree: async () => {
        calls.push("prepare-worktree");
        return { outcome: "success", data: { worktreePath: "/memory/worktree" } };
      },
      readArtifact: async (_ctx, _task, key) => key === "PROMPT.md" ? promptWithOneStep : undefined,
      writeArtifact: async (_ctx, _task, key) => ({ outcome: "success", data: { key } }),
      runPlanningSession: async () => {
        calls.push("plan");
        return { outcome: "success", data: { approved: true, artifactKeys: ["PROMPT.md"] } };
      },
      runCodingSession: async () => {
        calls.push("coding-session");
        return { outcome: "success", data: { taskDone: true, modifiedFiles: [] } };
      },
      runTaskStep: async (_ctx, _task, stepIndex) => {
        calls.push(`step-execute:${stepIndex}`);
        return { outcome: "success", baselineSha: "baseline", checkpointId: "checkpoint" };
      },
      resetTaskStep: async () => ({ ok: true }),
      runReview: async (_ctx, _task, input) => {
        calls.push(input.type === "plan" ? "plan-review" : "code-review");
        return { outcome: "success", data: { verdict: "APPROVE" } };
      },
      runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
      updateSteps: async (_ctx, target, steps: TaskStep[]) => {
        calls.push("parse");
        target.steps = steps;
        return { outcome: "success", data: { count: steps.length } };
      },
      transitionTask: async () => ({ outcome: "success" }),
      requestMerge: async (ctx) => {
        calls.push("merge");
        mergeContexts.push({ workflowId: ctx.run.workflowId, runId: ctx.run.runId });
        return { outcome: "success", value: "merged", data: { status: "merged" } };
      },
      abortRun: async () => ({ outcome: "success" }),
      audit: () => undefined,
    };

    const runtime = new WorkflowTaskRuntime({
      store: {
        getTaskWorkflowSelection: () => {
          selectionReads += 1;
          return undefined;
        },
        getWorkflowDefinition: async () => undefined,
        getTaskDocument: async (_taskId, key) => key === "PROMPT.md" ? { key, content: promptWithOneStep } : null,
      },
      primitives,
      runCustomNode: async (node) => {
        calls.push(`custom:${node.id}`);
        return { outcome: "success" };
      },
      parseStepsDeps: {
        readArtifact: async (_target, key) => key === "PROMPT.md" ? promptWithOneStep : undefined,
        writeSteps: async (target, steps) => {
          calls.push("parse");
          target.steps = steps;
        },
      },
    });

    const result = await runtime.run({ ...task, steps: [] }, settings);

    expect(result.disposition).toBe("completed");
    expect(result.outcome).toBe("success");
    expect(selectionReads).toBe(1);
    expect(result.context[WORKFLOW_RUN_ID_CONTEXT_KEY]).toBe("FN-7228-SMOKE:builtin:coding");
    expect(result.context[WORKFLOW_ID_CONTEXT_KEY]).toBe("builtin-stepwise-final-review-coding");
    expect(result.visitedNodeIds).toEqual([
      "start",
      "plan",
      "plan-review",
      "plan-review::plan-review-step",
      "parse",
      "steps",
      "steps#0:step-execute",
      "steps#0:step-done",
      "browser-verification",
      "code-review",
      "code-review::code-review-step",
      /*
       * FNXC:WorkflowSmoke 2026-06-29-14:20:
       * The stepwise built-in smoke tracks the full graph route, including the graph-native completion summary and bypassed post-merge verification group, so merge-gate coverage stays active without quarantining this suite.
       */
      "completion-summary",
      "merge",
      "post-merge-verification",
    ]);
    expect(calls).toEqual([
      "plan",
      "custom:plan-review-step",
      "parse",
      "step-execute:0",
      "custom:code-review-step",
      "custom:completion-summary",
      "merge",
    ]);
    expect(mergeContexts).toEqual([
      { workflowId: "builtin-stepwise-final-review-coding", runId: "FN-7228-SMOKE:builtin:coding" },
    ]);
  });
});
