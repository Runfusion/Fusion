/*
FNXC:PlanReview 2026-07-19-01:20:
U3 / R4/R5 — the GRAPH is the sole Plan Review owner, and a `pending` Plan Review
result is a CAS lease. These execution-level tests prove the duplicate-reviewer
interleaving from the user report (FN-1315-shaped double "Starting workflow step:
Plan Review") is impossible by construction: when a live lease is held, the graph
adopts it and dispatches ZERO second reviewers.

Symptom verification (AGENTS.md "Fix the invariant, not the repro"):
  Original symptom  — triage wrote a `pending` Plan Review result and dispatched a
                      reviewer; the graph's passed-only dedup ignored `pending` and
                      launched a SECOND reviewer, so two "Starting workflow step:
                      Plan Review" logs / two reviewer sessions raced.
  Reproduction      — run the graph plan-review node with a live `pending` lease
                      already present in task.workflowStepResults.
  Assertion it's gone — the reviewer template node runs ZERO times and no second
                      "Starting workflow step: Plan Review" is emitted; the run
                      holds (PLAN_REVIEW_LEASE_HELD_VALUE) for the lease owner.
*/
import { describe, expect, it } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";

import {
  PLAN_REVIEW_LEASE_HELD_VALUE,
  WorkflowGraphExecutor,
  type WorkflowNodeHandler,
} from "../workflow-graph-executor.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

/** A minimal workflow with the Plan Review optional-group in a hold column, an
 *  execute node in a wip column, and a plain success path. The group id is
 *  exactly `plan-review` so the graph's lease dedup applies. */
function planReviewIr(): WorkflowIr {
  return {
    version: "v2",
    name: "plan-review-owner-test",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: "plan-review",
        kind: "optional-group",
        column: "todo",
        config: {
          name: "Plan Review",
          defaultOn: true,
          template: {
            nodes: [{ id: "plan-review-step", kind: "prompt", config: { prompt: "review the plan" } }],
            edges: [],
          },
        },
      },
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "in-progress" },
    ],
    edges: [
      { from: "start", to: "plan-review" },
      { from: "plan-review", to: "execute", condition: "success" },
      { from: "execute", to: "end", condition: "success" },
    ],
  };
}

interface Harness {
  reviewerDispatches: () => number;
  executeDispatches: () => number;
  planReviewStartLogs: () => number;
  leaseHeldLogs: () => number;
  recorded: WorkflowStepResult[];
  run: (task: TaskDetail) => ReturnType<WorkflowGraphExecutor["run"]>;
}

function harness(opts: { now?: number } = {}): Harness {
  const logs: string[] = [];
  const recorded: WorkflowStepResult[] = [];
  let reviewer = 0;
  let execute = 0;
  const handler: WorkflowNodeHandler = async (node) => {
    if (node.id === "plan-review-step") reviewer += 1;
    if (node.id === "execute") execute += 1;
    return { outcome: "success" };
  };
  const executor = new WorkflowGraphExecutor({
    handlers: { prompt: handler },
    runId: "run-under-test",
    logTaskEntry: (msg: string) => { logs.push(msg); },
    recordWorkflowStepResult: (_taskId, result) => { recorded.push(result); },
    ...(opts.now !== undefined ? { runLoopNowForTests: () => opts.now! } : {}),
  } as ConstructorParameters<typeof WorkflowGraphExecutor>[0]);
  return {
    reviewerDispatches: () => reviewer,
    executeDispatches: () => execute,
    planReviewStartLogs: () => logs.filter((l) => l.includes("Starting workflow step: Plan Review")).length,
    leaseHeldLogs: () => logs.filter((l) => l.includes("lease held")).length,
    recorded,
    run: (task) => executor.run(task, settingsOn(), planReviewIr()),
  };
}

const baseTask = (over: Partial<TaskDetail> = {}): TaskDetail =>
  ({ id: "FN-PR-1", column: "todo", enabledWorkflowSteps: ["plan-review"], ...over } as TaskDetail);

const liveLease = (startedAtMs: number): WorkflowStepResult => ({
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "pending",
  startedAt: new Date(startedAtMs).toISOString(),
  leaseOwner: "other-run",
});

describe("Plan Review single owner + lease (U3)", () => {
  it("adopts a live lease and dispatches ZERO second reviewers (the report's race)", async () => {
    const now = Date.parse("2026-07-19T00:00:00.000Z");
    const h = harness({ now });
    const task = baseTask({ workflowStepResults: [liveLease(now - 1000)] }); // 1s old, well within floor

    const result = await h.run(task);

    // The reviewer never ran a second time; the run held for the lease owner.
    expect(h.reviewerDispatches()).toBe(0);
    expect(result.outcome).toBe("failure");
    expect(result.context["node:plan-review:value"]).toBe(PLAN_REVIEW_LEASE_HELD_VALUE);
    // Symptom: NO "Starting workflow step: Plan Review" (no second dispatch); exactly one lease-held log.
    expect(h.planReviewStartLogs()).toBe(0);
    expect(h.leaseHeldLogs()).toBe(1);
    // Execution never began — the card holds at the gate, not released.
    expect(h.executeDispatches()).toBe(0);
  });

  it("claims when no prior result exists: dispatches exactly one reviewer and writes a lease record", async () => {
    const h = harness();
    const task = baseTask({ workflowStepResults: [] });

    await h.run(task);

    expect(h.reviewerDispatches()).toBe(1);
    // Exactly one "Starting workflow step: Plan Review" — never doubled.
    expect(h.planReviewStartLogs()).toBe(1);
    // The pending lease record carries the owner so a re-entry adopts instead of re-dispatching.
    const pending = h.recorded.find((r) => r.workflowStepId === "plan-review" && r.status === "pending");
    expect(pending?.leaseOwner).toBe("run-under-test");
  });

  it("reclaims a STALE lease (past the floor) and dispatches exactly once", async () => {
    const now = Date.parse("2026-07-19T00:00:00.000Z");
    const h = harness({ now });
    // Lease started 30 minutes ago — well past the 15-minute staleness floor.
    const task = baseTask({ workflowStepResults: [liveLease(now - 30 * 60 * 1000)] });

    const result = await h.run(task);

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.leaseHeldLogs()).toBe(0);
    expect(result.outcome).toBe("success");
  });

  it("skips a settled (passed) Plan Review without dispatching a reviewer (existing dedup preserved)", async () => {
    const h = harness();
    const task = baseTask({
      workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed" }],
    });

    const result = await h.run(task);

    expect(h.reviewerDispatches()).toBe(0);
    expect(result.outcome).toBe("success"); // proceeds straight to execute
    expect(h.executeDispatches()).toBe(1);
  });

  it("releases without any reviewer when Plan Review is disabled (U3 scenario 5)", async () => {
    const h = harness();
    const task = baseTask({ enabledWorkflowSteps: [], workflowStepResults: [] });

    const result = await h.run(task);

    expect(h.reviewerDispatches()).toBe(0);
    expect(h.planReviewStartLogs()).toBe(0);
    expect(result.outcome).toBe("success");
    expect(h.executeDispatches()).toBe(1);
  });
});
