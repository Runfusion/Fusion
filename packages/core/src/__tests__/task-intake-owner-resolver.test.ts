import { describe, expect, it } from "vitest";
import {
  createFixtureIntakeOwnershipExemption,
  getInternalIntakeOwnershipExemptionReason,
  resolveTaskIntakeOwner,
} from "../tasks/task-intake-owner-resolver.js";
import type { Agent } from "../types.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";

const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({
  id, name: id, roles: ["executor"], role: "executor", state: "idle",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata: {}, ...overrides,
});

const workflow: WorkflowIr = {
  version: "v2",
  nodes: [
    { id: "start", kind: "start", column: "plan" },
    { id: "plan", kind: "prompt", column: "plan", config: { seam: "planning" } },
    { id: "execute", kind: "prompt", column: "work", config: { seam: "execute" } },
  ],
  edges: [{ from: "start", to: "plan" }, { from: "plan", to: "execute" }],
  columns: [
    { id: "plan", name: "Plan", traits: [], agent: { agentId: "triage", mode: "override" } },
    { id: "work", name: "Work", traits: [], agent: { agentId: "bound", mode: "defer" } },
  ],
};

describe("resolveTaskIntakeOwner", () => {
  it("uses an eligible explicit executor before workflow and pool candidates", () => {
    expect(resolveTaskIntakeOwner({ workflow, explicitAssigneeId: "explicit", agents: [agent("bound"), agent("explicit")] })).toEqual({ status: "selected", agentId: "explicit", source: "explicit" });
  });

  it("uses the canonical explicit-routing policy for engineers and operator overrides", () => {
    const engineer = agent("engineer", { roles: ["engineer"], role: "engineer" });
    const deprecatedEngineer = agent("deprecated-engineer", { roles: [], role: "engineer" });
    const multiRoleEngineer = agent("multi-role-engineer", { roles: ["reviewer", "engineer"], role: "reviewer" });
    const reviewer = agent("reviewer", { roles: ["reviewer"], role: "reviewer" });
    for (const selected of [engineer, deprecatedEngineer, multiRoleEngineer]) {
      expect(resolveTaskIntakeOwner({ workflow, explicitAssigneeId: selected.id, agents: [selected] }))
        .toEqual({ status: "selected", agentId: selected.id, source: "explicit" });
    }
    expect(resolveTaskIntakeOwner({ workflow, explicitAssigneeId: reviewer.id, agents: [reviewer] }))
      .toEqual({ status: "rejected", reason: "explicit-assignee-ineligible" });
    expect(resolveTaskIntakeOwner({ workflow, explicitAssigneeId: reviewer.id, explicitAssigneeRoleOverride: true, agents: [reviewer] }))
      .toEqual({ status: "selected", agentId: reviewer.id, source: "explicit" });
  });

  it("keeps non-role explicit eligibility gates hard even with an override", () => {
    const rejected = [
      agent("policy-none", { runtimeConfig: { assignmentPolicy: "none" } }),
      agent("ephemeral", { metadata: { internal: true } }),
      agent("disabled", { runtimeConfig: { enabled: false } }),
      agent("paused", { state: "paused" }),
      agent("error", { state: "error" }),
    ];
    for (const candidate of rejected) {
      expect(resolveTaskIntakeOwner({
        workflow,
        explicitAssigneeId: candidate.id,
        explicitAssigneeRoleOverride: true,
        agents: [candidate],
      })).toEqual({ status: "rejected", reason: "explicit-assignee-ineligible" });
    }
  });

  it("rejects an unavailable named execute binding", () => {
    expect(resolveTaskIntakeOwner({ workflow, agents: [agent("pool")] })).toEqual({ status: "rejected", reason: "named-execute-binding-unavailable" });
  });

  it("uses only the first reachable executor binding, never intake or unreachable bindings", () => {
    const graph: WorkflowIr = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        { id: "unreachable-execute", kind: "prompt", column: "unreachable", config: { seam: "execute" } },
      ],
      columns: [...workflow.columns, { id: "unreachable", name: "Unreachable", traits: [], agent: { agentId: "wrong", mode: "override" } }],
    };
    expect(resolveTaskIntakeOwner({ workflow: graph, agents: [agent("bound"), agent("wrong"), agent("triage", { roles: ["triage"], role: "triage" })] }))
      .toEqual({ status: "selected", agentId: "bound", source: "execute-binding" });
  });

  it("resolves a reachable foreach execute template through its inherited binding", () => {
    const graph: WorkflowIr = {
      version: "v2",
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        { id: "steps", kind: "foreach", column: "work", config: { source: "task-steps", template: { nodes: [{ id: "run", kind: "prompt", config: { seam: "execute" } }], edges: [] } } },
      ],
      edges: [{ from: "start", to: "steps" }],
      columns: [{ id: "plan", name: "Plan", traits: [] }, { id: "work", name: "Work", traits: [], agent: { agentId: "bound", mode: "override" } }],
    };
    expect(resolveTaskIntakeOwner({ workflow: graph, agents: [agent("bound")] }))
      .toEqual({ status: "selected", agentId: "bound", source: "execute-binding" });
  });

  it("honors defer bindings by falling back to the eligible pool when task model settings exist", () => {
    expect(resolveTaskIntakeOwner({ workflow, ownModelProvider: "openai", ownModelId: "gpt", agents: [agent("bound"), agent("pool", { createdAt: "2025-01-01T00:00:00.000Z" })] }))
      .toEqual({ status: "selected", agentId: "pool", source: "executor-pool" });
  });

  it("ignores execute bindings inside disabled optional groups", () => {
    const optionalExecute: WorkflowIr = {
      version: "v2",
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        { id: "optional-execute", kind: "optional-group", column: "work", config: {
          defaultOn: false,
          template: { nodes: [{ id: "run", kind: "prompt", config: { seam: "execute" } }], edges: [] },
        } },
      ],
      edges: [{ from: "start", to: "optional-execute" }],
      columns: [{ id: "plan", name: "Plan", traits: [] }, { id: "work", name: "Work", traits: [], agent: { agentId: "missing-bound", mode: "override" } }],
    };
    expect(resolveTaskIntakeOwner({ workflow: optionalExecute, agents: [agent("pool")] }))
      .toEqual({ status: "selected", agentId: "pool", source: "executor-pool" });
    expect(resolveTaskIntakeOwner({ workflow: optionalExecute, enabledWorkflowSteps: ["optional-execute"], agents: [agent("pool")] }))
      .toEqual({ status: "rejected", reason: "named-execute-binding-unavailable" });
  });

  it("pool-resolves no-workflow creates and reports only a genuinely empty pool as unowned", () => {
    expect(resolveTaskIntakeOwner({ workflow: "no-workflow-context", agents: [agent("executor")] })).toEqual({ status: "selected", agentId: "executor", source: "executor-pool" });
    expect(resolveTaskIntakeOwner({ workflow: "no-workflow-context", agents: [] })).toEqual({ status: "unowned", reason: "no-eligible-executor" });
  });

  it("keeps automatic selection executor-only and orders its pool by load, creation time, then id", () => {
    const explicitOnly = agent("explicit-only", { runtimeConfig: { assignmentPolicy: "explicit-only" } });
    const engineer = agent("engineer", { roles: ["engineer"], role: "engineer" });
    const paused = agent("paused", { state: "paused" });
    const policyDenied = agent("denied", { runtimeConfig: { assignmentPolicy: "none" } });
    const olderBusy = agent("older-busy", { createdAt: "2025-01-01T00:00:00.000Z" });
    const newerIdle = agent("newer-idle", { createdAt: "2026-01-01T00:00:00.000Z" });
    expect(resolveTaskIntakeOwner({
      workflow: "no-workflow-context",
      agents: [explicitOnly, engineer, paused, policyDenied, olderBusy, newerIdle],
      activeSessions: new Map([["older-busy", 1]]),
    })).toEqual({ status: "selected", agentId: "newer-idle", source: "executor-pool" });
    expect(resolveTaskIntakeOwner({ workflow: "no-workflow-context", explicitAssigneeId: "explicit-only", agents: [explicitOnly] }))
      .toEqual({ status: "selected", agentId: "explicit-only", source: "explicit" });
    expect(resolveTaskIntakeOwner({ workflow: "no-workflow-context", agents: [engineer] }))
      .toEqual({ status: "unowned", reason: "no-eligible-executor" });
    const engineerBinding = {
      ...workflow,
      columns: workflow.columns.map((column) => column.id === "work"
        ? { ...column, agent: { agentId: engineer.id, mode: "defer" as const } }
        : column),
    };
    expect(resolveTaskIntakeOwner({ workflow: engineerBinding, agents: [engineer] }))
      .toEqual({ status: "rejected", reason: "named-execute-binding-unavailable" });
  });

  it("finds a reachable executor nested inside a container template", () => {
    const graph: WorkflowIr = {
      version: "v2",
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        { id: "container", kind: "foreach", column: "work", config: { source: "task-steps", template: {
          nodes: [{ id: "nested", kind: "parse-steps", config: { template: { nodes: [{ id: "execute", kind: "prompt", column: "nested-work", config: { seam: "execute" } }], edges: [] } } }],
          edges: [],
        } } },
      ],
      edges: [{ from: "start", to: "container" }],
      columns: [
        { id: "plan", name: "Plan", traits: [] },
        { id: "work", name: "Work", traits: [], agent: { agentId: "outer", mode: "override" } },
        { id: "nested-work", name: "Nested work", traits: [], agent: { agentId: "bound", mode: "override" } },
      ],
    };
    expect(resolveTaskIntakeOwner({ workflow: graph, agents: [agent("outer"), agent("bound")] }))
      .toEqual({ status: "selected", agentId: "bound", source: "execute-binding" });
  });

  it("keeps rejection, exemption, and unowned outcomes distinct", () => {
    expect(resolveTaskIntakeOwner({ workflow: "unresolvable", agents: [] })).toEqual({ status: "rejected", reason: "workflow-unresolvable" });
    expect(resolveTaskIntakeOwner({ workflow: "no-workflow-context", agents: [], ownershipExemptionReason: "fixture" })).toEqual({ status: "exempt", reason: "fixture" });
  });

  it("accepts the named fixture capability but rejects payload-shaped exemptions", () => {
    expect(getInternalIntakeOwnershipExemptionReason(createFixtureIntakeOwnershipExemption())).toBe("fixture");
    expect(getInternalIntakeOwnershipExemptionReason({ reason: "fixture", ownershipExemption: true })).toBeUndefined();
    expect(getInternalIntakeOwnershipExemptionReason("fixture")).toBeUndefined();
  });
});
