import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR, BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "@fusion/core";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflow-graph-executor.js";

/*
FNXC:WorkflowOptionalGroup 2026-06-21-14:05:
Execution-level coverage for the run-once/bypass dispatch (U2). The contract that
guards the dead-toggle failure mode is the TWO-TASK DIVERGENCE test: two tasks
identical except `enabledWorkflowSteps` must diverge — the enabled one runs the
template's nodes, the disabled one runs NONE and still reaches the same downstream
node. These are real executor runs (not traversal-only) so a mock-masked dead path
cannot pass.
*/

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

/** A graph with one `optional-group` between `before` and `after`. The group's
 *  template runs a single `optstep` prompt when the group is enabled. */
function optionalGroupIr(): WorkflowIr {
  return {
    version: "v2",
    name: "optional-group-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "before", kind: "prompt", config: { prompt: "before" } },
      {
        id: "group",
        kind: "optional-group",
        config: {
          name: "Browser verification",
          defaultOn: false,
          template: {
            nodes: [{ id: "optstep", kind: "prompt", config: { prompt: "verify" } }],
            edges: [],
          },
        },
      },
      { id: "after", kind: "prompt", config: { prompt: "after" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "before" },
      { from: "before", to: "group" },
      { from: "group", to: "after", condition: "success" },
      { from: "after", to: "end" },
    ],
  };
}

/** A graph with a two-node template so we can prove a single pass walks all
 *  template nodes once (not per-step, not looped). */
function multiNodeGroupIr(): WorkflowIr {
  return {
    version: "v2",
    name: "optional-group-multi",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "group",
        kind: "optional-group",
        config: {
          defaultOn: false,
          template: {
            nodes: [
              { id: "a", kind: "prompt", config: { prompt: "a" } },
              { id: "b", kind: "gate", config: { prompt: "b" } },
            ],
            edges: [{ from: "a", to: "b" }],
          },
        },
      },
      { id: "after", kind: "prompt", config: { prompt: "after" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "group" },
      { from: "group", to: "after", condition: "success" },
      { from: "after", to: "end" },
    ],
  };
}

function taskWith(enabled: string[] | undefined): TaskDetail {
  return { id: "FN-OG", enabledWorkflowSteps: enabled } as TaskDetail;
}

function reviseGroupIr(options: { phase?: "pre-merge" | "post-merge"; gateMode?: "advisory" | "gate" } = {}): WorkflowIr {
  return {
    version: "v2",
    name: "optional-group-revise-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "group",
        kind: "optional-group",
        config: {
          name: options.phase === "post-merge" ? "Post-merge verification" : "Code Review",
          defaultOn: true,
          phase: options.phase,
          template: {
            nodes: [{ id: "review", kind: options.gateMode === "gate" ? "gate" : "prompt", config: { prompt: "review" } }],
            edges: [],
          },
        },
      },
      { id: "after", kind: "prompt", config: { prompt: "after" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "group" },
      { from: "group", to: "after", condition: "success" },
      { from: "group", to: "end", condition: "failure" },
      { from: "after", to: "end" },
    ],
  };
}

describe("WorkflowGraphExecutor optional-group", () => {
  it("two-task divergence: only the task whose enabledWorkflowSteps includes the group id runs the template; the sibling runs none and both reach downstream", async () => {
    const ir = optionalGroupIr();

    const enabledCalls: string[] = [];
    const enabledExecutor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async (node) => {
          enabledCalls.push(node.id);
          return { outcome: "success" };
        },
      },
    });
    const enabledResult = await enabledExecutor.run(taskWith(["group"]), settingsOn(), ir);

    const disabledCalls: string[] = [];
    const disabledExecutor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async (node) => {
          disabledCalls.push(node.id);
          return { outcome: "success" };
        },
      },
    });
    const disabledResult = await disabledExecutor.run(taskWith([]), settingsOn(), ir);

    // Enabled task executed the template node; disabled did not.
    expect(enabledCalls).toContain("optstep");
    expect(disabledCalls).not.toContain("optstep");

    // The materialized template id is recorded only for the enabled run.
    expect(enabledResult.visitedNodeIds).toContain("group::optstep");
    expect(disabledResult.visitedNodeIds).not.toContain("group::optstep");

    // Both still reach the same downstream node.
    expect(enabledCalls).toContain("after");
    expect(disabledCalls).toContain("after");
    expect(enabledResult.visitedNodeIds).toContain("after");
    expect(disabledResult.visitedNodeIds).toContain("after");

    expect(enabledResult.outcome).toBe("success");
    expect(disabledResult.outcome).toBe("success");
  });

  it("runs an enabled group's template exactly once (single pass, not per-step/looped)", async () => {
    const runTemplate = vi.fn<WorkflowNodeHandler>(async () => ({ outcome: "success" }));
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: runTemplate, gate: runTemplate },
    });

    const result = await executor.run(taskWith(["group"]), settingsOn(), multiNodeGroupIr());

    // Each template node ran exactly once; plus the downstream `after`.
    const templateRuns = runTemplate.mock.calls
      .map(([node]) => node.id)
      .filter((id) => id === "a" || id === "b");
    expect(templateRuns).toEqual(["a", "b"]);

    expect(result.visitedNodeIds.filter((id) => id === "group::a")).toHaveLength(1);
    expect(result.visitedNodeIds.filter((id) => id === "group::b")).toHaveLength(1);
    expect(result.context["node:group:outcome"]).toBe("success");
    expect(result.outcome).toBe("success");
  });

  it("disabled group is inert: downstream outcome/context identical to the group not being there", async () => {
    const ir = optionalGroupIr();
    const handler: WorkflowNodeHandler = async () => ({ outcome: "success" });

    // Run with the group disabled.
    const withGroup = new WorkflowGraphExecutor({ handlers: { prompt: handler } });
    const disabledResult = await withGroup.run(taskWith([]), settingsOn(), ir);

    // Reference graph: identical but with the group node removed (before → after).
    const refIr: WorkflowIr = {
      ...ir,
      nodes: ir.nodes.filter((n) => n.id !== "group"),
      edges: [
        { from: "start", to: "before" },
        { from: "before", to: "after" },
        { from: "after", to: "end" },
      ],
    };
    const refExecutor = new WorkflowGraphExecutor({ handlers: { prompt: handler } });
    const refResult = await refExecutor.run(taskWith([]), settingsOn(), refIr);

    expect(disabledResult.outcome).toBe(refResult.outcome);
    // Downstream node outcome is identical in both graphs.
    expect(disabledResult.context["node:after:outcome"]).toBe(refResult.context["node:after:outcome"]);
    expect(disabledResult.context["node:before:outcome"]).toBe(refResult.context["node:before:outcome"]);
    // No template node executed.
    expect(disabledResult.visitedNodeIds).not.toContain("group::optstep");
  });

  it("a template-node failure inside an enabled group surfaces as the group's outcome and routes its outcome: edge", async () => {
    const ir = optionalGroupIr();
    // Route the group's failure value to a dedicated recovery node.
    ir.nodes.push({ id: "recover", kind: "prompt", config: { prompt: "recover" } });
    ir.edges.push({ from: "group", to: "recover", condition: "outcome:boom" });

    const calls: string[] = [];
    const handler: WorkflowNodeHandler = async (node) => {
      calls.push(node.id);
      if (node.id === "optstep") return { outcome: "failure", value: "boom" };
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler } });

    const result = await executor.run(taskWith(["group"]), settingsOn(), ir);

    // The group's outcome reflects the template failure.
    expect(result.context["node:group:outcome"]).toBe("failure");
    expect(result.context["node:group:value"]).toBe("boom");
    // The outcome: edge routed to recover, NOT the success edge to `after`.
    expect(calls).toContain("recover");
    expect(calls).not.toContain("after");
  });

  it("treats a stale/unknown enabled id as not-enabled (group bypassed, no crash)", async () => {
    const ir = optionalGroupIr();
    const calls: string[] = [];
    const handler: WorkflowNodeHandler = async (node) => {
      calls.push(node.id);
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler } });

    // enabledWorkflowSteps references a since-removed group id, not "group".
    const result = await executor.run(taskWith(["stale-group-id"]), settingsOn(), ir);

    expect(calls).not.toContain("optstep");
    expect(calls).toContain("after");
    expect(result.outcome).toBe("success");
  });

  it("pre-merge advisory REVISE requests a bounded fix and aborts forward traversal when scheduled", async () => {
    const calls: string[] = [];
    const records: unknown[] = [];
    const requestFix = vi.fn(async () => true);
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async (node) => {
          calls.push(node.id);
          if (node.id === "review") {
            return { outcome: "success", value: "REVISE", contextPatch: { output: "Fix the review finding" } };
          }
          return { outcome: "success" };
        },
      },
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result); },
      requestPreMergeOptionalStepFix: requestFix,
    });

    const result = await executor.run(taskWith(["group"]), settingsOn(), reviseGroupIr());

    expect(requestFix).toHaveBeenCalledWith("FN-OG", {
      stepName: "Code Review",
      feedback: "Fix the review finding",
      phase: "pre-merge",
      status: "advisory_failure",
      verdict: "REVISE",
    });
    expect(calls).not.toContain("after");
    expect(result.context["node:group:fixScheduled"]).toBe(true);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowStepId: "group", status: "advisory_failure", verdict: "REVISE", output: "Fix the review finding" }),
    ]));
  });

  it("falls through unchanged when the pre-merge fix seam is absent or declines", async () => {
    for (const requestFix of [undefined, vi.fn(async () => false)] as const) {
      const calls: string[] = [];
      const executor = new WorkflowGraphExecutor({
        handlers: {
          prompt: async (node) => {
            calls.push(node.id);
            if (node.id === "review") return { outcome: "success", value: "REVISE", contextPatch: { output: "still advisory" } };
            return { outcome: "success" };
          },
        },
        ...(requestFix ? { requestPreMergeOptionalStepFix: requestFix } : {}),
      });

      const result = await executor.run(taskWith(["group"]), settingsOn(), reviseGroupIr());

      expect(calls).toContain("after");
      expect(result.context["node:group:fixScheduled"]).toBeUndefined();
      if (requestFix) expect(requestFix).toHaveBeenCalledOnce();
    }
  });

  it("requests fixes for pre-merge gate REVISE but not post-merge, non-REVISE, or fast-mode skipped outcomes", async () => {
    const requestFix = vi.fn(async () => true);
    const gateExecutor = new WorkflowGraphExecutor({
      handlers: {
        gate: async () => ({ outcome: "failure", value: "REVISE", contextPatch: { output: "gate finding" } }),
        prompt: async () => ({ outcome: "success" }),
      },
      requestPreMergeOptionalStepFix: requestFix,
    });
    await gateExecutor.run(taskWith(["group"]), settingsOn(), reviseGroupIr({ gateMode: "gate" }));
    expect(requestFix).toHaveBeenLastCalledWith("FN-OG", expect.objectContaining({ status: "failed", feedback: "gate finding" }));

    requestFix.mockClear();
    const postMergeCalls: string[] = [];
    const postMergeExecutor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async (node) => {
          postMergeCalls.push(node.id);
          if (node.id === "review") return { outcome: "success", value: "REVISE", contextPatch: { output: "post merge finding" } };
          return { outcome: "success" };
        },
      },
      requestPreMergeOptionalStepFix: requestFix,
    });
    await postMergeExecutor.run(taskWith(["group"]), settingsOn(), reviseGroupIr({ phase: "post-merge" }));
    expect(requestFix).not.toHaveBeenCalled();
    expect(postMergeCalls).toContain("after");

    const approveExecutor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "success", value: "APPROVE_WITH_NOTES", contextPatch: { output: "notes only" } }),
      },
      requestPreMergeOptionalStepFix: requestFix,
    });
    await approveExecutor.run(taskWith(["group"]), settingsOn(), reviseGroupIr());
    expect(requestFix).not.toHaveBeenCalled();

    const fastExecutor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async (_node, context) => context.task.executionMode === "fast"
          ? { outcome: "success", value: "workflow-step-skipped" }
          : { outcome: "success", value: "REVISE", contextPatch: { output: "would revise outside fast mode" } },
      },
      requestPreMergeOptionalStepFix: requestFix,
    });
    await fastExecutor.run({ ...taskWith(["group"]), executionMode: "fast" } as TaskDetail, settingsOn(), reviseGroupIr());
    expect(requestFix).not.toHaveBeenCalled();
  });

  it("cycles REVISE findings across graph runs until APPROVE, and falls through only after the budget seam declines", async () => {
    const verdicts = ["REVISE", "REVISE", "APPROVE"];
    const requestFix = vi.fn(async () => true);

    for (let cycle = 0; cycle < verdicts.length; cycle += 1) {
      const calls: string[] = [];
      const executor = new WorkflowGraphExecutor({
        handlers: {
          prompt: async (node) => {
            calls.push(node.id);
            if (node.id === "review") {
              const verdict = verdicts[cycle];
              return { outcome: "success", value: verdict, contextPatch: { output: `cycle ${cycle + 1} ${verdict}` } };
            }
            return { outcome: "success" };
          },
        },
        requestPreMergeOptionalStepFix: requestFix,
      });

      const result = await executor.run(taskWith(["group"]), settingsOn(), reviseGroupIr());

      if (cycle < 2) {
        expect(requestFix).toHaveBeenCalledTimes(cycle + 1);
        expect(calls).not.toContain("after");
        expect(result.context["node:group:fixScheduled"]).toBe(true);
      } else {
        expect(requestFix).toHaveBeenCalledTimes(2);
        expect(calls).toContain("after");
        expect(result.context["node:group:fixScheduled"]).toBeUndefined();
      }
    }

    let exhaustedFixesScheduled = 0;
    const exhaustedRequestFix = vi.fn(async () => {
      if (exhaustedFixesScheduled >= 3) return false;
      exhaustedFixesScheduled += 1;
      return true;
    });
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const calls: string[] = [];
      const executor = new WorkflowGraphExecutor({
        handlers: {
          prompt: async (node) => {
            calls.push(node.id);
            return node.id === "review"
              ? { outcome: "success", value: "REVISE", contextPatch: { output: `persistent finding ${cycle + 1}` } }
              : { outcome: "success" };
          },
        },
        requestPreMergeOptionalStepFix: exhaustedRequestFix,
      });

      const result = await executor.run(taskWith(["group"]), settingsOn(), reviseGroupIr());

      if (cycle < 3) {
        expect(calls).not.toContain("after");
        expect(result.context["node:group:fixScheduled"]).toBe(true);
      } else {
        expect(calls).toContain("after");
        expect(result.context["node:group:fixScheduled"]).toBeUndefined();
      }
    }
    expect(exhaustedRequestFix).toHaveBeenCalledTimes(4);
  });

  it("builtin coding optional Code Review and Browser Verification REVISE abort before review, and stepwise carries the same pre-merge path", async () => {
    for (const groupId of ["code-review", "browser-verification"] as const) {
      const requestFix = vi.fn(async () => true);
      const calls: string[] = [];
      const executor = new WorkflowGraphExecutor({
        handlers: {
          prompt: async (node) => {
            calls.push(node.id);
            if ((groupId === "code-review" && node.id === "code-review-step")
              || (groupId === "browser-verification" && node.id === "browser-verification-step")) {
              return { outcome: "success", value: "REVISE", contextPatch: { output: `${groupId} finding` } };
            }
            return { outcome: "success" };
          },
        },
        requestPreMergeOptionalStepFix: requestFix,
      });

      const result = await executor.run(
        { ...taskWith(groupId === "code-review" ? ["code-review"] : ["browser-verification", "code-review"]), id: `FN-${groupId}` } as TaskDetail,
        settingsOn(),
        BUILTIN_CODING_WORKFLOW_IR,
      );

      expect(requestFix).toHaveBeenCalledWith(`FN-${groupId}`, expect.objectContaining({
        stepName: groupId === "code-review" ? "Code Review" : "Browser Verification",
        feedback: `${groupId} finding`,
      }));
      expect(calls).not.toContain("review");
      expect(result.context[`node:${groupId}:fixScheduled`]).toBe(true);
    }

    for (const ir of [BUILTIN_CODING_WORKFLOW_IR, BUILTIN_STEPWISE_CODING_WORKFLOW_IR]) {
      for (const groupId of ["browser-verification", "code-review"] as const) {
        const node = ir.nodes.find((candidate) => candidate.id === groupId);
        expect(node).toMatchObject({ kind: "optional-group" });
        expect(node?.config?.phase).toBeUndefined();
        expect(ir.edges).toEqual(expect.arrayContaining([
          expect.objectContaining({ from: groupId, to: groupId === "browser-verification" ? "code-review" : "review", condition: "success" }),
          expect.objectContaining({ from: groupId, to: "end", condition: "failure" }),
        ]));
      }
    }

    for (const groupId of ["browser-verification", "code-review"] as const) {
      const stepwiseRequestFix = vi.fn(async () => true);
      const stepwiseExecutor = new WorkflowGraphExecutor({
        handlers: {
          "parse-steps": async () => ({ outcome: "success", value: "no-steps" }),
          prompt: async (node) => {
            if ((groupId === "code-review" && node.id === "code-review-step")
              || (groupId === "browser-verification" && node.id === "browser-verification-step")) {
              return { outcome: "success", value: "REVISE", contextPatch: { output: `stepwise ${groupId} finding` } };
            }
            return { outcome: "success" };
          },
        },
        requestPreMergeOptionalStepFix: stepwiseRequestFix,
      });

      const stepwiseResult = await stepwiseExecutor.run(
        { ...taskWith(groupId === "code-review" ? ["code-review"] : ["browser-verification", "code-review"]), id: `FN-stepwise-${groupId}`, steps: [] } as TaskDetail,
        settingsOn(),
        BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
      );

      expect(stepwiseRequestFix).toHaveBeenCalledWith(`FN-stepwise-${groupId}`, expect.objectContaining({
        stepName: groupId === "code-review" ? "Code Review" : "Browser Verification",
        feedback: `stepwise ${groupId} finding`,
      }));
      expect(stepwiseResult.context[`node:${groupId}:fixScheduled`]).toBe(true);
    }
  });
});
