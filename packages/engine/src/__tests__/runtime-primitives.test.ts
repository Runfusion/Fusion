import { describe, expect, it } from "vitest";

import { markSideEffectsStarted, primitiveNodeContext } from "../runtime-primitives.js";
import { createWorkflowRuntimePrimitiveProvider } from "../workflow-runtime-primitive-provider.js";

describe("runtime primitives", () => {
  it("creates a workflow primitive context from a run and node", () => {
    const run = {
      runId: "run-1",
      taskId: "FN-1",
      workflowId: "coding",
    };
    const node = {
      id: "execute",
      kind: "prompt" as const,
      column: "in-progress",
      config: { prompt: "implement" },
    };

    const ctx = primitiveNodeContext(run, node, {
      effectivePrincipalId: "agent:builder",
      attempt: 2,
      context: { priorOutcome: "revise" },
    });

    expect(ctx).toEqual({
      run,
      node: {
        node,
        effectivePrincipalId: "agent:builder",
        attempt: 2,
        context: { priorOutcome: "revise" },
      },
    });
  });

  it("marks side effects on an immutable context copy", () => {
    const ctx = primitiveNodeContext(
      {
        runId: "run-1",
        taskId: "FN-1",
        workflowId: "coding",
      },
      { id: "execute", kind: "prompt" as const },
    );

    const marked = markSideEffectsStarted(ctx);

    expect(marked).toEqual({
      ...ctx,
      run: {
        ...ctx.run,
        sideEffectsStarted: true,
      },
    });
    expect(ctx.run.sideEffectsStarted).toBeUndefined();
  });

  it("creates runtime primitives through a provider boundary", async () => {
    const provider = createWorkflowRuntimePrimitiveProvider((settings) => ({
      prepareWorktree: async () => ({
        outcome: "success" as const,
        value: settings.experimentalFeatures?.workflowGraphExecutor ? "enabled" : "disabled",
        data: { worktreePath: "/tmp/worktree" },
      }),
      readArtifact: async () => undefined,
      writeArtifact: async (_ctx, _task, key) => ({ outcome: "success" as const, data: { key } }),
      runPlanningSession: async () => ({ outcome: "success" as const, data: { approved: true, artifactKeys: [] } }),
      runCodingSession: async () => ({ outcome: "success" as const, data: { taskDone: true, modifiedFiles: [] } }),
      runTaskStep: async () => ({ outcome: "success" as const }),
      resetTaskStep: async () => ({ ok: true }),
      runReview: async () => ({ outcome: "success" as const, data: { verdict: "APPROVE" as const } }),
      runVerification: async () => ({ outcome: "success" as const, data: { verdict: "skipped" as const } }),
      updateSteps: async (_ctx, _task, steps) => ({ outcome: "success" as const, data: { count: steps.length } }),
      transitionTask: async (_ctx, _task, input) => ({ outcome: "success" as const, value: input.reason }),
      requestMerge: async () => ({ outcome: "success" as const, data: { status: "merged" as const } }),
      abortRun: async () => ({ outcome: "success" as const }),
      audit: () => undefined,
    }));

    const primitives = provider.create({ experimentalFeatures: { workflowGraphExecutor: true } } as never);
    const result = await primitives.prepareWorktree(
      primitiveNodeContext({ runId: "run-1", taskId: "FN-1", workflowId: "coding" }, { id: "execute", kind: "prompt" }),
      { id: "FN-1" } as never,
    );

    expect(result).toMatchObject({
      outcome: "success",
      value: "enabled",
      data: { worktreePath: "/tmp/worktree" },
    });
  });
});
