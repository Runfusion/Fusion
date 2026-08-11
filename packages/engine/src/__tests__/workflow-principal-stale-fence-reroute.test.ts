import { describe, expect, it } from "vitest";
import { admitWorkflowPrincipalBeforeNode } from "../executor/workflow-principal-before-node.js";

/*
FNXC:WorkflowAgentRouting 2026-08-10-07:50:
The dispatch surface, asserted separately from the pure router because this is where the wedge was VISIBLE.

FN-8869 was assigned to a permanent engineer-role agent, fenced its `step-execute` continuation to that owner,
and then held `named-principal-unavailable:executor` on every dispatch for hours — each self-healing bounce
re-read the same dead fence and re-asserted it, while two idle `Workflow Executor` pool agents were never
consulted. A router-only test cannot catch that: the fence path never calls the router at all.

Invariant: a node admission NEVER terminates in a hold that re-dispatch cannot clear. Either the fenced
principal still runs the node, or the fence is discarded and routing continues.
*/

const agent = (id: string, roles: string[]) => ({
  id, name: id, roles, role: roles[0], state: "idle",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata: {},
}) as any;

const executeNode = { id: "step-execute", kind: "prompt", config: { seam: "execute" } } as any;

function deps(agents: any[]) {
  const written: any[] = [];
  return {
    written,
    deps: {
      store: {
        getRootDir: () => "/repo",
        logEntry: async () => undefined,
        replaceActiveTaskWorkflowContinuation: async (input: any) => {
          written.push(input);
          return { id: `wi-${written.length}` };
        },
      },
      options: { agentStore: { listAgents: async () => agents, workflowProjectId: "proj" } },
      workflowAgentCapacity: {
        activeSessions: () => 0,
        acquire: async () => ({ status: "acquired" }),
        release: () => undefined,
      },
      activeWorkflowAuthorities: new Map(),
      activeWorkflowPrincipals: new Map(),
      workflowCapacityAttemptIds: new Set<string>(),
      directWorkflowPrincipalWorkItemIds: new Set<string>(),
      directWorkflowPrincipalHeldWorkItemIds: new Set<string>(),
      columnAgentIr: { version: "v2", name: "t", columns: [{ id: "todo", name: "Todo", traits: [] }], nodes: [executeNode] },
      resolveBindingForNode: () => undefined,
      resolvedRunId: "run-1",
      settings: { maxConcurrent: 12 },
    } as any,
  };
}

const fencedContext = (principalAgentId: string) => ({
  "workflow:principal-agent-id": principalAgentId,
  "workflow:principal-role": "executor",
  "workflow:principal-authority": "task-assignee",
} as Record<string, unknown>);

describe("admitWorkflowPrincipalBeforeNode — stale fences re-route instead of wedging", () => {
  it("admits an assigned engineer owner rather than holding its own executor node", async () => {
    const engineer = agent("agent-backend-engineer", ["engineer"]);
    const { deps: d } = deps([engineer]);
    const context = fencedContext(engineer.id);

    const result = await admitWorkflowPrincipalBeforeNode(
      d, executeNode, { id: "FN-8869", assignedAgentId: engineer.id } as any, context,
    );

    expect(result).toBeUndefined();
    expect(context["workflow:principal-agent-id"]).toBe(engineer.id);
    expect(context["workflow:principal-authority"]).toBe("task-assignee");
  });

  it("discards a fence whose principal lost the role and re-routes to the pool", async () => {
    const stale = agent("agent-was-executor", ["reviewer"]);
    const pool = agent("agent-workflow-executor", ["executor"]);
    const { deps: d, written } = deps([stale, pool]);
    const context = fencedContext(stale.id);

    const result = await admitWorkflowPrincipalBeforeNode(
      d, executeNode, { id: "FN-8869", assignedAgentId: stale.id } as any, context,
    );

    expect(result).toBeUndefined();
    expect(context["workflow:principal-agent-id"]).toBe(pool.id);
    expect(context["workflow:principal-authority"]).toBe("role-pool");
    // The durable continuation records the live principal, not the dead one.
    expect(written[written.length - 1]).toMatchObject({ state: "running", principalAgentId: pool.id });
  });

  it("discards a fence after ownership moves and runs under the new owner", async () => {
    const previous = agent("agent-previous-owner", ["executor"]);
    const current = agent("agent-current-owner", ["executor"]);
    const { deps: d } = deps([previous, current]);
    const context = fencedContext(previous.id);

    const result = await admitWorkflowPrincipalBeforeNode(
      d, executeNode, { id: "FN-8869", assignedAgentId: current.id } as any, context,
    );

    expect(result).toBeUndefined();
    expect(context["workflow:principal-agent-id"]).toBe(current.id);
  });

  it("still holds — and records the hold — when the fenced principal is merely paused", async () => {
    const paused = { ...agent("agent-owner", ["executor"]), state: "paused" };
    const pool = agent("agent-workflow-executor", ["executor"]);
    const { deps: d, written } = deps([paused, pool]);

    const result = await admitWorkflowPrincipalBeforeNode(
      d, executeNode, { id: "FN-8869", assignedAgentId: paused.id } as any, fencedContext(paused.id),
    );

    // A capable-but-unusable owner is a bounded wait, and is never silently replaced by the pool.
    expect(result).toEqual({ outcome: "failure", value: "workflow-principal-named-principal-unavailable:executor" });
    expect(written[written.length - 1]).toMatchObject({ state: "held", principalAgentId: paused.id });
  });
});
