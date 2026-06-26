import { describe, expect, it } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler, type WorkflowNodeResult } from "../workflow-graph-executor.js";

/*
FNXC:WorkflowStepResults 2026-06-25-12:00:
Plan U2 coverage: an ENABLED optional-group node must upsert a WorkflowStepResult
into `task.workflowStepResults` keyed by the GROUP node id, with status mapped from
the inner exit node's outcome/verdict (APPROVE → passed; advisory REVISE →
advisory_failure; gate REVISE / group failure → failed). A DISABLED group records
NOTHING (byte-inert). Uses the executor `handlers` override pattern to inject inner
prompt/gate node results (real executor runs, not traversal-only).
*/

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

/** A graph with one `optional-group` ("Code review") between `before` and `after`.
 *  The group's template runs a single `reviewstep` prompt when enabled. */
function codeReviewGroupIr(): WorkflowIr {
  return {
    version: "v2",
    name: "code-review-results-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "before", kind: "prompt", config: { prompt: "before" } },
      {
        id: "code-review",
        kind: "optional-group",
        config: {
          name: "Code review",
          defaultOn: false,
          template: {
            nodes: [{ id: "reviewstep", kind: "prompt", config: { prompt: "review" } }],
            edges: [],
          },
        },
      },
      { id: "after", kind: "prompt", config: { prompt: "after" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "before" },
      { from: "before", to: "code-review" },
      { from: "code-review", to: "after", condition: "success" },
      // Route a group failure away from the success edge so the run terminates
      // cleanly when the inner gate REVISEs / fails.
      { from: "code-review", to: "after", condition: "failure" },
      { from: "after", to: "end" },
    ],
  };
}

function taskWith(enabled: string[] | undefined): TaskDetail {
  return { id: "FN-CR", enabledWorkflowSteps: enabled } as TaskDetail;
}

/** A capturing sink that mirrors the production executor adapter's upsert-by-id
 *  semantics so the final recorded state can be asserted. */
function makeRecorder() {
  const results: WorkflowStepResult[] = [];
  const calls: WorkflowStepResult[] = [];
  const record = async (_taskId: string, result: WorkflowStepResult) => {
    calls.push(result);
    const idx = results.findIndex((r) => r.workflowStepId === result.workflowStepId);
    if (idx >= 0) results[idx] = result;
    else results.push(result);
  };
  return { results, calls, record };
}

/** Inject a fixed inner-node result for `reviewstep`; everything else succeeds. */
function innerHandler(reviewResult: WorkflowNodeResult): WorkflowNodeHandler {
  return async (node) => (node.id === "reviewstep" ? reviewResult : { outcome: "success" });
}

describe("WorkflowGraphExecutor optional-group → task.workflowStepResults (plan U2)", () => {
  it("(a) enabled group + APPROVE verdict → one entry keyed by the group node id with status 'passed'", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: innerHandler({ outcome: "success", value: "APPROVE" }) },
      recordWorkflowStepResult: recorder.record,
    });

    const result = await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());
    expect(result.outcome).toBe("success");

    // Exactly one entry, keyed by the GROUP node id (not the inner template id).
    expect(recorder.results).toHaveLength(1);
    const entry = recorder.results[0];
    expect(entry.workflowStepId).toBe("code-review");
    expect(entry.workflowStepName).toBe("Code review");
    expect(entry.phase).toBe("pre-merge");
    expect(entry.status).toBe("passed");
    expect(entry.verdict).toBe("APPROVE");
    // Upsert: a pending entry was written first, then replaced by the terminal one
    // (same startedAt preserved; completedAt added).
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0].status).toBe("pending");
    expect(recorder.calls[0].startedAt).toBeDefined();
    expect(entry.startedAt).toBe(recorder.calls[0].startedAt);
    expect(entry.completedAt).toBeDefined();
  });

  it("(b) advisory REVISE (success outcome, REVISE verdict) → status 'advisory_failure'", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      // Advisory: the inner node returns success (non-blocking) but a REVISE verdict.
      handlers: { prompt: innerHandler({ outcome: "success", value: "REVISE" }) },
      recordWorkflowStepResult: recorder.record,
    });

    await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());

    expect(recorder.results).toHaveLength(1);
    expect(recorder.results[0].workflowStepId).toBe("code-review");
    expect(recorder.results[0].status).toBe("advisory_failure");
    expect(recorder.results[0].verdict).toBe("REVISE");
  });

  it("(c) gate REVISE / group failure → status 'failed'", async () => {
    // Gate REVISE: a blocking gate surfaces the REVISE as a failure OUTCOME.
    const gateRecorder = makeRecorder();
    const gateExecutor = new WorkflowGraphExecutor({
      handlers: { prompt: innerHandler({ outcome: "failure", value: "REVISE" }) },
      recordWorkflowStepResult: gateRecorder.record,
    });
    await gateExecutor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());
    expect(gateRecorder.results).toHaveLength(1);
    expect(gateRecorder.results[0].status).toBe("failed");

    // Hard group failure (no verdict) → also 'failed'.
    const failRecorder = makeRecorder();
    const failExecutor = new WorkflowGraphExecutor({
      handlers: { prompt: innerHandler({ outcome: "failure", value: "failed" }) },
      recordWorkflowStepResult: failRecorder.record,
    });
    await failExecutor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());
    expect(failRecorder.results).toHaveLength(1);
    expect(failRecorder.results[0].status).toBe("failed");
  });

  it("(d) DISABLED group → no entry recorded (byte-inert)", async () => {
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: innerHandler({ outcome: "success", value: "APPROVE" }) },
      recordWorkflowStepResult: recorder.record,
    });

    const result = await executor.run(taskWith([]), settingsOn(), codeReviewGroupIr());
    expect(result.outcome).toBe("success");

    expect(recorder.calls).toHaveLength(0);
    expect(recorder.results).toHaveLength(0);
  });

  it("(e) carries the inner node's output AND notes through to the recorded result (REVISE with notes)", async () => {
    // FNXC:WorkflowStepResults 2026-06-26-00:00: The recorded WorkflowStepResult
    // must carry the step agent's `output` and the parsed verdict `notes` (surfaced
    // on the inner node result's contextPatch by runGraphCustomNode) so the Workflow
    // tab shows real detail instead of a fallback and `[pre-merge]` revision logs
    // carry the notes. Advisory REVISE keeps the success outcome (non-blocking).
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: innerHandler({
          outcome: "success",
          value: "REVISE",
          contextPatch: { output: "full step output text", notes: "please fix the null check" },
        }),
      },
      recordWorkflowStepResult: recorder.record,
    });

    await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());

    expect(recorder.results).toHaveLength(1);
    const entry = recorder.results[0];
    expect(entry.status).toBe("advisory_failure");
    expect(entry.verdict).toBe("REVISE");
    expect(entry.output).toBe("full step output text");
    expect(entry.notes).toBe("please fix the null check");
  });

  it("emits parity [pre-merge] logs for the enabled group via logTaskEntry", async () => {
    const logs: string[] = [];
    const recorder = makeRecorder();
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: innerHandler({ outcome: "success", value: "APPROVE" }) },
      recordWorkflowStepResult: recorder.record,
      logTaskEntry: (summary: string) => {
        logs.push(summary);
      },
    });

    await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());

    expect(logs).toContain("[pre-merge] Starting workflow step: Code review");
    expect(logs).toContain("[pre-merge] Workflow step completed: Code review");
  });
});
