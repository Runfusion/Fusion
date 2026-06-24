import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import type { TaskDetail } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflow-graph-executor.js";

/*
FNXC:WorkflowOptionalGroup 2026-06-21-15:10:
Built-in-level execution coverage for U6: the coding workflow now expresses the
pre-merge browser-verification step as an `optional-group` (default OFF). This is
the dead-toggle / two-task divergence guard at the BUILT-IN level (not just the
generic construct): two coding tasks identical except `enabledWorkflowSteps` must
diverge — the one including the group id runs the browser-verification prompt node
pre-merge; the sibling runs NONE and still reaches review. Real executor runs (not
traversal-only) so a mock-masked dead path cannot pass.

The inner template node id is `browser-verification-step` (distinct from the group
id `browser-verification` per the U1 template-node-id collision rule), and its
materialized visited id is `browser-verification::browser-verification-step`.
*/

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

const GROUP_ID = "browser-verification";
const INNER_STEP_VISITED_ID = "browser-verification::browser-verification-step";

function codingTask(enabledWorkflowSteps?: string[]): TaskDetail {
  return {
    id: "FN-CODING",
    ...(enabledWorkflowSteps ? { enabledWorkflowSteps } : {}),
  } as unknown as TaskDetail;
}

/** Count how many times the inner browser-verification prompt node ran. A prompt
 *  handler keyed on the inner template node id; everything else succeeds. */
function makeExecutor(onInnerStep: () => void) {
  const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
    if (node.id === "browser-verification-step") onInnerStep();
    return { outcome: "success" };
  });
  return new WorkflowGraphExecutor({ handlers: { prompt } });
}

describe("builtin coding browser-verification optional-group (U6)", () => {
  it("two-task divergence: the enabled task runs browser-verification pre-merge; the disabled task does not", async () => {
    // Enabled.
    let enabledRuns = 0;
    const enabledResult = await makeExecutor(() => {
      enabledRuns++;
    }).run(codingTask([GROUP_ID]), settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    // Disabled (no enabledWorkflowSteps).
    let disabledRuns = 0;
    const disabledResult = await makeExecutor(() => {
      disabledRuns++;
    }).run(codingTask(), settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    // The browser-verification step ran exactly once when enabled, never when off.
    expect(enabledRuns).toBe(1);
    expect(disabledRuns).toBe(0);

    // Enabled: the inner template node is visited pre-merge (before review).
    expect(enabledResult.visitedNodeIds).toContain(INNER_STEP_VISITED_ID);
    const innerIdx = enabledResult.visitedNodeIds.indexOf(INNER_STEP_VISITED_ID);
    const reviewIdxEnabled = enabledResult.visitedNodeIds.indexOf("review");
    const executeIdxEnabled = enabledResult.visitedNodeIds.indexOf("execute");
    expect(executeIdxEnabled).toBeLessThan(innerIdx);
    expect(innerIdx).toBeLessThan(reviewIdxEnabled);

    // Disabled: the group node is traversed (bypassed) but its body never runs;
    // both tasks reach the same downstream review node.
    expect(disabledResult.visitedNodeIds).toContain(GROUP_ID);
    expect(disabledResult.visitedNodeIds).not.toContain(INNER_STEP_VISITED_ID);
    expect(disabledResult.visitedNodeIds).toContain("review");
    expect(enabledResult.visitedNodeIds).toContain("review");
  });

  it("a browser-verification failure surfaces as the group's outcome and routes its failure edge to end", async () => {
    // The inner step fails → the group's failure edge (browser-verification → end)
    // fires, so review is never reached.
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "browser-verification-step") return { outcome: "failure", value: "verify-failed" };
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(codingTask([GROUP_ID]), settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(result.context[`node:${GROUP_ID}:outcome`]).toBe("failure");
    expect(result.visitedNodeIds).toContain(INNER_STEP_VISITED_ID);
    // The group's only two outgoing edges are `success → review` and
    // `failure → end`; the inner-step failure routes the failure edge, so review
    // is skipped. (`end` is a terminal node the executor does not record in
    // visitedNodeIds, so the routing is asserted via the group's failure outcome
    // above + review being unreachable here.)
    expect(result.visitedNodeIds).not.toContain("review");
  });
});
