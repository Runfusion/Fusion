import { describe, expect, it } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import { postMergeOptionalGroupNode } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";

/*
FNXC:WorkflowPostMerge 2026-06-26-15:30:
Graph-native post-merge steps. `graphNativePostMerge` is DEFAULT-ON; a post-merge
optional-group node wired off `merge-attempt` success runs AFTER the merge seam and
records a WorkflowStepResult with phase:"post-merge". An explicit opt-out
(`graphNativePostMerge: false`) DISABLES graph-native post-merge execution for that run:
the merge region stays collapsed and the post-merge node is never reached — it records
nothing. There is NO legacy merger fallback anymore (the merger-side post-merge path was
removed in U7c), so an opt-out simply means post-merge work does not run via the graph.
Post-merge failures are non-blocking: the run still completes with the merge-success
outcome.
*/

const POST_MERGE_ID = "post-merge-docs";
const POST_MERGE_STEP_ID = `${POST_MERGE_ID}-step`;

/** Minimal IR: start → execute → merge-attempt (collapses to the merge seam) with a
 *  post-merge optional-group hanging off merge-attempt success → end. */
function postMergeIr(options: { gateMode?: "advisory" | "gate" } = {}): WorkflowIr {
  return {
    version: "v2",
    name: "post-merge-test",
    columns: [
      { id: "work", name: "Work", traits: [] },
      { id: "review", name: "Review", traits: [] },
      { id: "done", name: "Done", traits: [] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "work" },
      { id: "execute", kind: "prompt", column: "work", config: { prompt: "x" } },
      { id: "merge-attempt", kind: "merge-attempt", column: "review", config: { capability: "task-merge" } },
      postMergeOptionalGroupNode({
        id: POST_MERGE_ID,
        name: "Post Merge Docs",
        column: "done",
        prompt: "post-merge doc check",
        gateMode: options.gateMode,
        defaultOn: false,
      }),
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "execute" },
      { from: "execute", to: "merge-attempt", condition: "success" },
      // Existing terminal success edge (the merge region collapses; this is the
      // flag-OFF terminal). The post-merge entry is the SECOND success edge.
      { from: "merge-attempt", to: "end", condition: "success" },
      { from: "merge-attempt", to: POST_MERGE_ID, condition: "success" },
      { from: POST_MERGE_ID, to: "end", condition: "success" },
    ],
  };
}

function taskWith(enabled: string[] | undefined): TaskDetail {
  return { id: "FN-PM", enabledWorkflowSteps: enabled } as TaskDetail;
}

function makeRecorder() {
  const results: WorkflowStepResult[] = [];
  const record = async (_taskId: string, result: WorkflowStepResult) => {
    const idx = results.findIndex((r) => r.workflowStepId === result.workflowStepId);
    if (idx >= 0) results[idx] = result;
    else results.push(result);
  };
  return { results, record };
}

/** All seam prompts (id "merge" synthetic node included) succeed; the post-merge inner
 *  step returns the injected verdict. `handlers.prompt` overrides every prompt node, so
 *  branch on id. */
function handler(innerValue: string): WorkflowNodeHandler {
  return async (node) =>
    node.id === POST_MERGE_STEP_ID
      ? { outcome: "success", value: innerValue }
      : { outcome: "success" };
}

function failureHandler(innerValue: string): WorkflowNodeHandler {
  return async (node) =>
    node.id === POST_MERGE_STEP_ID
      ? { outcome: "failure", value: innerValue }
      : { outcome: "success" };
}

describe("WorkflowGraphExecutor graph-native post-merge steps", () => {
  it("flag ON: runs the post-merge optional group after merge and records phase:'post-merge'", async () => {
    const recorder = makeRecorder();
    const logs: string[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler("APPROVE") },
      recordWorkflowStepResult: recorder.record,
      logTaskEntry: (summary: string) => logs.push(summary),
    });

    const result = await executor.run(
      taskWith([POST_MERGE_ID]),
      { experimentalFeatures: { graphNativePostMerge: true } },
      postMergeIr(),
    );

    expect(result.outcome).toBe("success");
    // The post-merge node ran AFTER the collapsed merge seam.
    expect(result.visitedNodeIds).toContain("merge");
    expect(result.visitedNodeIds.indexOf(POST_MERGE_ID)).toBeGreaterThan(
      result.visitedNodeIds.indexOf("merge"),
    );

    expect(recorder.results).toHaveLength(1);
    const entry = recorder.results[0];
    expect(entry.workflowStepId).toBe(POST_MERGE_ID);
    expect(entry.workflowStepName).toBe("Post Merge Docs");
    expect(entry.phase).toBe("post-merge");
    expect(entry.status).toBe("passed");
    expect(entry.verdict).toBe("APPROVE");

    expect(logs).toContain("[post-merge] Starting workflow step: Post Merge Docs");
    expect(logs).toContain("[post-merge] Workflow step completed: Post Merge Docs");
  });

  it("flag ON: a post-merge REVISE is recorded advisory_failure and is NON-BLOCKING (run still succeeds)", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler("REVISE") },
      recordWorkflowStepResult: recorder.record,
    });

    const result = await executor.run(
      taskWith([POST_MERGE_ID]),
      { experimentalFeatures: { graphNativePostMerge: true } },
      postMergeIr(),
    );

    // Merge succeeded; post-merge advisory REVISE must NOT flip the run to failure.
    expect(result.outcome).toBe("success");
    expect(recorder.results).toHaveLength(1);
    expect(recorder.results[0].phase).toBe("post-merge");
    expect(recorder.results[0].status).toBe("advisory_failure");
  });

  it("flag ON: a gate-mode post-merge failure records failure and blocks final graph success", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: failureHandler("REVISE") },
      recordWorkflowStepResult: recorder.record,
    });

    const result = await executor.run(
      taskWith([POST_MERGE_ID]),
      { experimentalFeatures: { graphNativePostMerge: true } },
      postMergeIr({ gateMode: "gate" }),
    );

    /*
     * FNXC:WorkflowPostMerge 2026-06-29-11:47:
     * Explicit gate-mode post-merge verification must block final workflow success;
     * advisory post-merge checks remain non-blocking for legacy parity.
    */
    expect(result.outcome).toBe("failure");
    expect(recorder.results).toHaveLength(1);
    expect(recorder.results[0]).toMatchObject({
      workflowStepId: POST_MERGE_ID,
      phase: "post-merge",
      status: "failed",
      verdict: "REVISE",
    });
  });

  it("flag explicitly OFF (opt-out): the post-merge node is NOT run via the graph and records nothing", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler("APPROVE") },
      recordWorkflowStepResult: recorder.record,
    });

    // FNXC:WorkflowPostMerge 2026-06-26-12:00: U7b cutover flipped the DEFAULT to ON, so the
    // OFF path is now an explicit opt-out (graphNativePostMerge:false), not the default.
    const result = await executor.run(
      taskWith([POST_MERGE_ID]),
      { experimentalFeatures: { graphNativePostMerge: false } },
      postMergeIr(),
    );

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain("merge");
    // The merge region stays collapsed; the post-merge node is never traversed.
    expect(result.visitedNodeIds).not.toContain(POST_MERGE_ID);
    expect(recorder.results).toHaveLength(0);
  });

  it("flag DEFAULT (no experimentalFeatures): runs the post-merge node via the graph (default-ON, U7b)", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler("APPROVE") },
      recordWorkflowStepResult: recorder.record,
    });

    // No experimentalFeatures at all → flag now defaults ON after the U7b cutover.
    const result = await executor.run(taskWith([POST_MERGE_ID]), {}, postMergeIr());

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain("merge");
    // Default-ON: the post-merge node IS traversed after the collapsed merge seam.
    expect(result.visitedNodeIds.indexOf(POST_MERGE_ID)).toBeGreaterThan(
      result.visitedNodeIds.indexOf("merge"),
    );
    expect(recorder.results).toHaveLength(1);
    expect(recorder.results[0].phase).toBe("post-merge");
    expect(recorder.results[0].status).toBe("passed");
  });
});
