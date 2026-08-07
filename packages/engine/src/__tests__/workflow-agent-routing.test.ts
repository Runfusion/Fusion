import { describe, expect, it } from "vitest";
import { isCurrentReviewerNodeOverride, routeWorkflowPrincipal, validateFencedWorkflowPrincipal } from "../agents/workflow-agent-router.js";

const agent = (id: string, roles: string[], createdAt = "2026-01-01T00:00:00.000Z") => ({
  id, name: id, roles, role: roles[0], state: "idle", createdAt, updatedAt: createdAt, metadata: {},
}) as any;
const ir: any = { version: "v2", name: "test", columns: [{ id: "todo", name: "Todo", traits: [] }], nodes: [] };

describe("routeWorkflowPrincipal", () => {
  it("uses exact review override and returns to task owner for execution", () => {
    const owner = agent("owner", ["custom"]);
    const reviewer = agent("reviewer", ["custom"]);
    expect(routeWorkflowPrincipal({ task: { assignedAgentId: "owner" }, ir, node: { id: "r", kind: "prompt", reviewerAgentId: "reviewer", config: { workflowRole: "reviewer" } }, agents: [owner, reviewer] })).toMatchObject({ status: "routed", route: { agent: reviewer, authority: "review-node-override" } });
    expect(routeWorkflowPrincipal({ task: { assignedAgentId: "owner" }, ir, node: { id: "e", kind: "prompt", config: { seam: "execute" } }, agents: [owner, reviewer] })).toMatchObject({ status: "routed", route: { agent: owner, authority: "task-assignee" } });
  });

  it("holds rather than falling back when a named principal is unavailable", () => {
    const paused = { ...agent("owner", ["executor"]), state: "paused" };
    const pool = agent("pool", ["executor"]);
    expect(routeWorkflowPrincipal({ task: { assignedAgentId: "owner" }, ir, node: { id: "e", kind: "prompt", config: { seam: "execute" } }, agents: [paused, pool] })).toEqual({ status: "held", role: "executor", reason: "named-principal-unavailable" });
  });

  it("never routes an ephemeral task worker through a durable workflow role", () => {
    const worker = {
      ...agent("worker", ["executor"]),
      name: "executor-FN-8764",
      metadata: { taskWorker: true },
    };
    expect(routeWorkflowPrincipal({ task: {}, ir, node: { id: "e", kind: "prompt", config: { seam: "execute" } }, agents: [worker] }))
      .toEqual({ status: "held", role: "executor", reason: "role-pool-exhausted" });
  });

  it("keeps a fenced reviewer on its exact node and fails closed after an override edit", () => {
    const reviewer = agent("reviewer", ["reviewer"]);
    const node = { id: "review", kind: "prompt", reviewerAgentId: "reviewer", config: { workflowRole: "reviewer" } } as any;
    expect(validateFencedWorkflowPrincipal({
      task: {}, node, principalAgentId: "reviewer", role: "reviewer", authority: "review-node-override", agents: [reviewer],
    })).toMatchObject({ status: "routed", route: { agent: reviewer, authority: "review-node-override" } });
    expect(validateFencedWorkflowPrincipal({
      task: {}, node: { ...node, reviewerAgentId: "other" }, principalAgentId: "reviewer", role: "reviewer", authority: "review-node-override", agents: [reviewer],
    })).toEqual({ status: "held", role: "reviewer", reason: "named-principal-unavailable" });
  });

  it("revokes a review authority when its exact durable override changes", () => {
    const reviewerNode = { id: "review", kind: "prompt", reviewerAgentId: "reviewer", config: { workflowRole: "reviewer" } };
    const reviewerIr = { ...ir, nodes: [reviewerNode] } as any;
    expect(isCurrentReviewerNodeOverride(reviewerIr, "review", "reviewer")).toBe(true);
    expect(isCurrentReviewerNodeOverride({ ...reviewerIr, nodes: [{ ...reviewerNode, reviewerAgentId: "replacement" }] }, "review", "reviewer")).toBe(false);
    expect(isCurrentReviewerNodeOverride(reviewerIr, "missing", "reviewer")).toBe(false);
  });

  it("fences reviewer overrides to the exact foreach template instance", () => {
    const reviewerNode = { id: "review", kind: "prompt", reviewerAgentId: "reviewer", config: { workflowRole: "reviewer" } };
    const reviewerIr = {
      ...ir,
      nodes: [{ id: "foreach", kind: "foreach", config: { template: { nodes: [reviewerNode] } } }],
    } as any;
    expect(isCurrentReviewerNodeOverride(reviewerIr, "foreach#0:review", "reviewer")).toBe(true);
    expect(isCurrentReviewerNodeOverride(reviewerIr, "foreach#0:review", "replacement")).toBe(false);
    expect(isCurrentReviewerNodeOverride({
      ...reviewerIr,
      nodes: [{ ...reviewerIr.nodes[0], config: { template: { nodes: [{ ...reviewerNode, reviewerAgentId: "replacement" }] } } }],
    }, "foreach#0:review", "reviewer")).toBe(false);
  });

  it("fences nested optional, foreach, and loop reviewer instances independently", () => {
    const review = { id: "review", kind: "prompt", reviewerAgentId: "reviewer", config: { workflowRole: "reviewer" } };
    const nestedIr = {
      ...ir,
      nodes: [{
        id: "optional",
        kind: "optional-group",
        config: { template: { nodes: [{
          id: "steps",
          kind: "foreach",
          config: { template: { nodes: [{
            id: "repeat",
            kind: "loop",
            config: { template: { nodes: [review] } },
          }] } },
        }] } },
      }],
    } as any;
    expect(isCurrentReviewerNodeOverride(nestedIr, "optional::steps#2:repeat#1:review", "reviewer")).toBe(true);
    expect(isCurrentReviewerNodeOverride(nestedIr, "optional::steps#2:repeat#1:review", "other")).toBe(false);
  });

  it("revalidates a nested reviewer fence against the persisted node instance", () => {
    const reviewer = agent("reviewer", ["reviewer"]);
    const nested = { id: "review", kind: "prompt", reviewerAgentId: "reviewer", config: { workflowRole: "reviewer" } } as any;
    const nestedIr = { ...ir, nodes: [{ id: "foreach", kind: "foreach", config: { template: { nodes: [nested] } } }] } as any;
    expect(validateFencedWorkflowPrincipal({
      task: {}, ir: nestedIr, node: nested, nodeInstanceId: "foreach#0:review", principalAgentId: "reviewer",
      role: "reviewer", authority: "review-node-override", agents: [reviewer],
    })).toMatchObject({ status: "routed" });
    const editedIr = { ...nestedIr, nodes: [{ ...nestedIr.nodes[0], config: { template: { nodes: [{ ...nested, reviewerAgentId: "replacement" }] } } }] };
    expect(validateFencedWorkflowPrincipal({
      task: {}, ir: editedIr, node: nested, nodeInstanceId: "foreach#0:review", principalAgentId: "reviewer",
      role: "reviewer", authority: "review-node-override", agents: [reviewer],
    })).toEqual({ status: "held", role: "reviewer", reason: "named-principal-unavailable" });
  });

  it("moves a raced role-pool route to the next deterministic candidate", () => {
    const first = agent("first", ["executor"], "2026-01-01T00:00:00.000Z");
    const second = agent("second", ["executor"], "2026-01-02T00:00:00.000Z");
    const node = { id: "execute", kind: "prompt", config: { seam: "execute" } } as any;
    expect(routeWorkflowPrincipal({ task: {}, ir, node, agents: [first, second] }))
      .toMatchObject({ status: "routed", route: { agent: first, authority: "role-pool" } });
    expect(routeWorkflowPrincipal({ task: {}, ir, node, agents: [first, second], excludedPoolAgentIds: new Set(["first"]) }))
      .toMatchObject({ status: "routed", route: { agent: second, authority: "role-pool" } });
  });

  it("fails a task-assignee fence after assignment changes instead of rerouting", () => {
    const owner = agent("owner", ["custom"]);
    expect(validateFencedWorkflowPrincipal({
      task: { assignedAgentId: "other" }, node: { id: "execute", kind: "prompt", config: { seam: "execute" } } as any,
      principalAgentId: "owner", role: "executor", authority: "task-assignee", agents: [owner],
    })).toEqual({ status: "held", role: "executor", reason: "named-principal-unavailable" });
  });

  it("fails a column fence after the durable binding is redirected", () => {
    const bound = agent("bound", ["executor"]);
    const node = { id: "execute", kind: "prompt", column: "todo", config: { seam: "execute" } } as any;
    const boundIr = {
      ...ir,
      columns: [{ id: "todo", name: "Todo", traits: [], agent: { agentId: "bound", mode: "override" } }],
      nodes: [node],
    } as any;
    expect(validateFencedWorkflowPrincipal({
      task: {}, ir: boundIr, node, principalAgentId: "bound", role: "executor", authority: "column-binding", agents: [bound],
    })).toMatchObject({ status: "routed", route: { agent: bound } });
    expect(validateFencedWorkflowPrincipal({
      task: {}, ir: { ...boundIr, columns: [{ ...boundIr.columns[0], agent: { agentId: "replacement", mode: "override" } }] }, node,
      principalAgentId: "bound", role: "executor", authority: "column-binding", agents: [bound],
    })).toEqual({ status: "held", role: "executor", reason: "named-principal-unavailable" });
  });
});
