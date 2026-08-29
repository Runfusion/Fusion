import { describe, expect, it } from "vitest";
import { isCurrentReviewerNodeOverride, routeWorkflowPrincipal, validateFencedWorkflowPrincipal } from "../agents/workflow-agent-router.js";

const agent = (id: string, roles: string[], createdAt = "2026-01-01T00:00:00.000Z") => ({
  id, name: id, roles, role: roles[0], state: "idle", createdAt, updatedAt: createdAt, metadata: {},
}) as any;
const ir: any = { version: "v2", name: "test", columns: [{ id: "todo", name: "Todo", traits: [] }], nodes: [] };

describe("routeWorkflowPrincipal", () => {
  it("uses exact review override and returns to an executor owner for execution", () => {
    const owner = agent("owner", ["executor"]);
    const reviewer = agent("reviewer", ["reviewer"]);
    expect(routeWorkflowPrincipal({ task: { assignedAgentId: "owner" }, ir, node: { id: "r", kind: "prompt", reviewerAgentId: "reviewer", config: { workflowRole: "reviewer" } }, agents: [owner, reviewer] })).toMatchObject({ status: "routed", route: { agent: reviewer, authority: "review-node-override" } });
    expect(routeWorkflowPrincipal({ task: { assignedAgentId: "owner" }, ir, node: { id: "e", kind: "prompt", config: { seam: "execute" } }, agents: [owner, reviewer] })).toMatchObject({ status: "routed", route: { agent: owner, authority: "task-assignee" } });
  });

  /*
  FNXC:WorkflowAgentRouting 2026-08-10-07:50:
  The invariant is STRUCTURAL-INCAPABILITY-FALLS-THROUGH / UNAVAILABILITY-HOLDS, and it is asserted across
  every named authority because the wedge reached the board through only one of them. An owner that cannot
  ever run the node was never authority for it; an owner that could but is momentarily unusable is a real
  wait whose end is in sight. The previous behaviour — hold on both — stranded FN-8869/FN-8928/FN-8845 for
  hours apiece behind two idle pool executors.
  */
  it("falls through to the pool when a named principal can NEVER satisfy the node", () => {
    const pool = agent("pool", ["executor"]);
    const reviewerPool = agent("reviewer-pool", ["reviewer"]);
    const executeNode = { id: "e", kind: "prompt", config: { seam: "execute" } } as any;
    const reviewNode = { id: "r", kind: "prompt", config: { workflowRole: "reviewer" } } as any;

    // Wrong role for the node, assignment policy hard-floored, and an owner id that resolves to nothing.
    for (const owner of [
      agent("triage-owner", ["triage"]),
      { ...agent("policy-denied-owner", ["executor"]), runtimeConfig: { assignmentPolicy: "none" } },
    ]) {
      expect(routeWorkflowPrincipal({ task: { assignedAgentId: owner.id }, ir, node: executeNode, agents: [owner, pool] }))
        .toMatchObject({ status: "routed", route: { agent: pool, authority: "role-pool" } });
    }
    expect(routeWorkflowPrincipal({ task: { assignedAgentId: "deleted-owner" }, ir, node: executeNode, agents: [pool] }))
      .toMatchObject({ status: "routed", route: { agent: pool, authority: "role-pool" } });

    // Same rule for a review override and a column binding — a dead name is not a wait on any surface.
    expect(routeWorkflowPrincipal({
      task: {}, ir, node: { ...reviewNode, reviewerAgentId: "triage-owner" }, agents: [agent("triage-owner", ["triage"]), reviewerPool],
    })).toMatchObject({ status: "routed", route: { agent: reviewerPool, authority: "role-pool" } });
    const boundNode = { ...executeNode, column: "todo" };
    const boundIr = {
      ...ir,
      columns: [{ id: "todo", name: "Todo", traits: [], agent: { agentId: "triage-owner", mode: "override" } }],
      nodes: [boundNode],
    } as any;
    expect(routeWorkflowPrincipal({
      task: {}, ir: boundIr, node: boundNode, agents: [agent("triage-owner", ["triage"]), pool],
    })).toMatchObject({ status: "routed", route: { agent: pool, authority: "role-pool" } });
  });

  /*
  FNXC:WorkflowAgentRouting 2026-08-10-07:50:
  A durable ENGINEER explicitly assigned to a task executes it, continuously, through graph dispatch.
  `canAgentTakeImplementationTaskForExplicitRouting` already permits that assignment, so refusing it at the
  executor node left the owner's hourly heartbeat as the only thing touching the card — it logged
  "progressing, no blockers" and exited while nothing progressed. The POOL stays strict: an unassigned
  executor node must not silently land on an engineer, since backlog pickup is a separate opt-in.
  */
  it("routes an assigned engineer owner to its own executor node, but never through the pool", () => {
    const engineer = agent("backend-engineer", ["engineer"]);
    const node = { id: "e", kind: "prompt", config: { seam: "execute" } } as any;
    expect(routeWorkflowPrincipal({ task: { assignedAgentId: "backend-engineer" }, ir, node, agents: [engineer] }))
      .toMatchObject({ status: "routed", route: { agent: engineer, authority: "task-assignee" } });
    expect(routeWorkflowPrincipal({ task: {}, ir, node, agents: [engineer] }))
      .toEqual({ status: "held", role: "executor", reason: "role-pool-exhausted" });
    // The hard floor still wins over ownership.
    const denied = { ...agent("liaison", ["engineer"]), runtimeConfig: { assignmentPolicy: "none" } };
    expect(routeWorkflowPrincipal({ task: { assignedAgentId: "liaison" }, ir, node, agents: [denied] }))
      .toEqual({ status: "held", role: "executor", reason: "role-pool-exhausted" });
  });

  it("still holds a role-capable owner that is only momentarily unusable", () => {
    const pool = agent("pool", ["executor"]);
    const node = { id: "e", kind: "prompt", config: { seam: "execute" } } as any;
    for (const owner of [
      { ...agent("disabled-owner", ["executor"]), runtimeConfig: { enabled: false } },
      { ...agent("paused-owner", ["executor"]), state: "paused" },
      { ...agent("errored-owner", ["executor"]), state: "error" },
    ]) {
      expect(routeWorkflowPrincipal({ task: { assignedAgentId: owner.id }, ir, node, agents: [owner, pool] }))
        .toEqual({ status: "held", role: "executor", reason: "named-principal-unavailable" });
    }
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
    })).toEqual({ status: "held", role: "reviewer", reason: "named-principal-unavailable", staleFence: true });
  });

  /*
  FNXC:WorkflowAgentRouting 2026-08-10-07:50:
  `staleFence` is the caller's signal to re-route instead of re-asserting a dead principal every dispatch.
  It must be set on EVERY branch that proves the fence no longer describes reality — node reclassified,
  ownership moved, override edited, binding redirected, agent deleted or stripped of the role — and must NOT
  be set when the fenced principal is still the right one and merely unavailable.
  */
  it("marks a fence stale on every branch that proves it no longer describes reality", () => {
    const executeNode = { id: "e", kind: "prompt", config: { seam: "execute" } } as any;
    const owner = agent("owner", ["executor"]);
    const base = { task: { assignedAgentId: "owner" }, ir, node: executeNode, role: "executor", authority: "task-assignee", agents: [owner] } as any;

    // Ownership moved away from the fenced principal.
    expect(validateFencedWorkflowPrincipal({ ...base, task: { assignedAgentId: "someone-else" }, principalAgentId: "owner" }))
      .toMatchObject({ status: "held", staleFence: true });
    // The node is no longer the role the fence claims.
    expect(validateFencedWorkflowPrincipal({ ...base, node: { id: "r", kind: "prompt", config: { workflowRole: "reviewer" } }, principalAgentId: "owner" }))
      .toMatchObject({ status: "held", staleFence: true });
    // The fenced agent is gone, or lost the role.
    expect(validateFencedWorkflowPrincipal({ ...base, agents: [], principalAgentId: "owner" }))
      .toMatchObject({ status: "held", staleFence: true });
    expect(validateFencedWorkflowPrincipal({ ...base, agents: [agent("owner", ["reviewer"])], principalAgentId: "owner" }))
      .toMatchObject({ status: "held", staleFence: true });
    // The column binding was redirected.
    expect(validateFencedWorkflowPrincipal({
      ...base,
      task: {},
      authority: "column-binding",
      node: { ...executeNode, column: "todo" },
      ir: { ...ir, columns: [{ id: "todo", name: "Todo", traits: [], agent: { agentId: "other", mode: "override" } }] },
      principalAgentId: "owner",
    })).toMatchObject({ status: "held", staleFence: true });

    // Still the right principal, merely unusable right now — a real wait, never a re-route.
    expect(validateFencedWorkflowPrincipal({ ...base, agents: [{ ...owner, state: "paused" }], principalAgentId: "owner" }))
      .toEqual({ status: "held", role: "executor", reason: "named-principal-unavailable" });
  });

  /*
  FNXC:WorkflowAgentRouting 2026-08-10-08:35:
  "Cannot resolve this instance" must fail CLOSED while "the override was edited away" re-routes. Both make
  `isCurrentReviewerNodeOverride` return false, so marking them alike discarded a real reviewer fence whenever
  the IR failed to load — handing a named review to the pool. The pair is asserted together because only their
  DIFFERENCE is the invariant; either one alone passes under the broken code.
  */
  it("fails closed on an unresolvable fence and re-routes only on a real override edit", () => {
    const reviewer = agent("reviewer", ["reviewer"]);
    const node = { id: "review", kind: "prompt", reviewerAgentId: "reviewer", config: { workflowRole: "reviewer" } } as any;
    const reviewerIr = { ...ir, nodes: [node] } as any;
    const base = {
      task: {}, node, principalAgentId: "reviewer", role: "reviewer",
      authority: "review-node-override", agents: [reviewer],
    } as any;

    // Unresolvable instance id, and a missing IR: hold, never stale.
    expect(validateFencedWorkflowPrincipal({ ...base, ir: reviewerIr, nodeInstanceId: "does-not-exist" }))
      .toEqual({ status: "held", role: "reviewer", reason: "named-principal-unavailable" });
    expect(validateFencedWorkflowPrincipal({ ...base, ir: undefined, nodeInstanceId: "review" }))
      .toEqual({ status: "held", role: "reviewer", reason: "named-principal-unavailable" });

    // A resolved node whose override genuinely changed is stale and re-routes.
    const edited = { ...ir, nodes: [{ ...node, reviewerAgentId: "replacement" }] } as any;
    expect(validateFencedWorkflowPrincipal({ ...base, ir: edited, nodeInstanceId: "review" }))
      .toEqual({ status: "held", role: "reviewer", reason: "named-principal-unavailable", staleFence: true });

    // A column binding behaves the same way: an absent IR cannot prove the binding was removed.
    expect(validateFencedWorkflowPrincipal({
      task: {}, ir: undefined, node: { id: "e", kind: "prompt", config: { seam: "execute" } } as any,
      principalAgentId: "bound", role: "executor", authority: "column-binding", agents: [agent("bound", ["executor"])],
    })).toEqual({ status: "held", role: "executor", reason: "named-principal-unavailable" });
  });

  it("keeps a fenced engineer owner on its own executor node", () => {
    const engineer = agent("backend-engineer", ["engineer"]);
    expect(validateFencedWorkflowPrincipal({
      task: { assignedAgentId: "backend-engineer" }, ir, node: { id: "e", kind: "prompt", config: { seam: "execute" } } as any,
      principalAgentId: "backend-engineer", role: "executor", authority: "task-assignee", agents: [engineer],
    })).toMatchObject({ status: "routed", route: { agent: engineer, authority: "task-assignee" } });
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
    })).toEqual({ status: "held", role: "reviewer", reason: "named-principal-unavailable", staleFence: true });
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

  it("fails a task-assignee fence after assignment changes, and marks it stale so the caller re-routes", () => {
    const owner = agent("owner", ["custom"]);
    expect(validateFencedWorkflowPrincipal({
      task: { assignedAgentId: "other" }, node: { id: "execute", kind: "prompt", config: { seam: "execute" } } as any,
      principalAgentId: "owner", role: "executor", authority: "task-assignee", agents: [owner],
    })).toEqual({ status: "held", role: "executor", reason: "named-principal-unavailable", staleFence: true });
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
    })).toEqual({ status: "held", role: "executor", reason: "named-principal-unavailable", staleFence: true });
  });
});
