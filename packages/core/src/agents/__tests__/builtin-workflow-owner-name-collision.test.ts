/*
FNXC:WorkflowAgentIdentities 2026-09-23-10:30:
Regression coverage for a project left with NO workflow principals. A second registered project held a durable
agent named "Workflow Merger" whose provenance keys were gone (a copied row). Provisioning saw no Merger owner,
created one under the canonical name, and `createAgent` threw on the duplicate name. The throw aborted the whole
provisioning pass — including the Planner created a moment earlier — so the project had no `triage` principal
and every card needing planning held on `role-pool-exhausted:triage` indefinitely.

The fake `createAgent` enforces durable-name uniqueness exactly as the real store does, so the canonical-name
collision is reproduced rather than assumed.
*/
import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agent-store.js";
import {
  BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULTS,
  builtinWorkflowOwnerFallbackName,
} from "../workflow-role-agent-defaults.js";
import type { Agent } from "../../types/agents/agents.js";

const MERGER = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULTS.merger.name;
const PLANNER = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULTS.triage.name;

function durable(name: string, metadata: Record<string, unknown> = {}): Agent {
  return {
    id: `agent-${name.toLowerCase().replaceAll(/[^a-z]/g, "")}`,
    name,
    role: "merger",
    roles: ["merger"],
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata,
    runtimeConfig: { enabled: true },
  } as Agent;
}

function fakeStore(agents: Agent[], options: { claimDuringCreate?: string } = {}) {
  const store = new AgentStore({ rootDir: process.cwd() });
  const self = store as unknown as Record<string, unknown>;
  self.listAgents = vi.fn(async () => [...agents]);
  self.findAgentByName = vi.fn(async (name: string) => agents.find((item) => item.name === name) ?? null);
  self.materializeBuiltinWorkflowRoleBundle = vi.fn(async () => undefined);
  self.writeAgent = vi.fn(async (updated: Agent) => {
    const index = agents.findIndex((item) => item.id === updated.id);
    if (index >= 0) agents[index] = updated;
  });
  self.createAgent = vi.fn(async (input: Record<string, unknown>) => {
    const name = input.name as string;
    if (options.claimDuringCreate === name) agents.push(durable(name));
    const existing = agents.find((item) => item.name === name);
    if (existing) throw new Error(`Agent with name "${name}" already exists (agentId: ${existing.id})`);
    const roles = input.roles as string[];
    const created = {
      ...durable(name, input.metadata as Record<string, unknown>),
      role: roles[0],
      roles,
      runtimeConfig: input.runtimeConfig,
    } as Agent;
    agents.push(created);
    return created;
  });
  return store as AgentStore & { createAgent: ReturnType<typeof vi.fn> };
}

const ownerRoles = (agents: Agent[]) =>
  agents.filter((agent) => agent.metadata?.builtInWorkflowRole === true).map((agent) => agent.metadata?.workflowRole).sort();

describe("built-in workflow owner provisioning with a name collision", () => {
  it("still provisions every owner when a provenance-less agent holds a canonical name", async () => {
    const copied = durable(MERGER);
    const agents = [copied];
    const store = fakeStore(agents);

    const owners = await store.provisionBuiltinWorkflowRoleAgents();

    expect(ownerRoles(agents)).toEqual(["executor", "merger", "reviewer", "triage"]);
    expect(owners.map((owner) => owner.name)).toContain(PLANNER);
    expect(owners.find((owner) => owner.metadata?.workflowRole === "merger")?.name).toBe(builtinWorkflowOwnerFallbackName(MERGER));
    // The existing agent is neither adopted nor rewritten.
    expect(agents.find((agent) => agent.id === copied.id)).toEqual(copied);
  });

  it("skips only the colliding role when its fallback name is taken too", async () => {
    const agents = [durable(MERGER), durable(builtinWorkflowOwnerFallbackName(MERGER))];
    const store = fakeStore(agents);

    await expect(store.provisionBuiltinWorkflowRoleAgents()).resolves.toHaveLength(3);
    expect(ownerRoles(agents)).toEqual(["executor", "reviewer", "triage"]);
  });

  it("keeps provisioning the other roles when a name is claimed during creation", async () => {
    const agents: Agent[] = [];
    const store = fakeStore(agents, { claimDuringCreate: MERGER });

    await expect(store.provisionBuiltinWorkflowRoleAgents()).resolves.toHaveLength(3);
    expect(ownerRoles(agents)).toEqual(["executor", "reviewer", "triage"]);
  });

  it("uses the canonical names on a clean project", async () => {
    const agents: Agent[] = [];
    const store = fakeStore(agents);

    const owners = await store.provisionBuiltinWorkflowRoleAgents();

    expect(owners.map((owner) => owner.name).sort()).toEqual(
      Object.values(BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULTS).map((definition) => definition.name).sort(),
    );
  });
});
