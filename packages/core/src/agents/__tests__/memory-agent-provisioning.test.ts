import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agent-store.js";
import { BUILTIN_MEMORY_AGENT_DEFAULT, BUILTIN_MEMORY_AGENT_FALLBACK_NAME, BUILTIN_MEMORY_AGENT_NAME, BUILTIN_MEMORY_AGENT_PROVENANCE_KEY } from "../memory-agent-defaults.js";
import type { Agent } from "../../types/agents/agents.js";

const heartbeatConfig = (enabled: boolean) => ({ enabled, autoClaimRelevantTasks: false, heartbeatIntervalMs: 3_600_000 });
const agent = (name: string, metadata: Record<string, unknown> = {}, runtimeConfig: Record<string, unknown> = { enabled: true }): Agent => ({ id: name.toLowerCase().replaceAll(/[^a-z]/g, ""), name, role: "custom", roles: ["custom"], state: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata, runtimeConfig } as Agent);
const memoryOwner = (enabled: boolean): Agent => ({
  ...agent(BUILTIN_MEMORY_AGENT_NAME, { [BUILTIN_MEMORY_AGENT_PROVENANCE_KEY]: true }, heartbeatConfig(enabled)),
  title: BUILTIN_MEMORY_AGENT_DEFAULT.title,
  instructionsText: BUILTIN_MEMORY_AGENT_DEFAULT.instructionsText,
  soul: BUILTIN_MEMORY_AGENT_DEFAULT.soul,
  bundleConfig: { ...BUILTIN_MEMORY_AGENT_DEFAULT.bundleConfig, files: [...BUILTIN_MEMORY_AGENT_DEFAULT.bundleConfig.files] },
});
function fakeStore(agents: Agent[]) {
  const store = new AgentStore({ rootDir: process.cwd() }); const self = store as unknown as Record<string, unknown>;
  self.listAgents = vi.fn(async () => agents);
  self.findAgentByName = vi.fn(async (name: string) => agents.find((item) => item.name === name) ?? null);
  self.createAgent = vi.fn(async (input: Record<string, unknown>) => {
    const created = { ...agent(input.name as string, input.metadata as Record<string, unknown>, input.runtimeConfig as Record<string, unknown>), ...input, id: (input.name as string).toLowerCase().replaceAll(/[^a-z]/g, ""), role: "custom", state: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as Agent;
    agents.push(created);
    return created;
  });
  self.writeAgent = vi.fn(async (updated: Agent) => {
    const index = agents.findIndex((item) => item.id === updated.id);
    if (index >= 0) agents[index] = updated;
  });
  return store as AgentStore & { createAgent: ReturnType<typeof vi.fn>; writeAgent: ReturnType<typeof vi.fn> };
}

describe("Memory Keeper provisioning", () => {
  it("creates exactly one custom, heartbeat-disabled owner", async () => {
    const store = fakeStore([]); const first = await store.provisionBuiltinMemoryAgent(); const second = await store.provisionBuiltinMemoryAgent();
    expect(first?.id).toBe(second?.id); expect(store.createAgent).toHaveBeenCalledTimes(1);
    expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: BUILTIN_MEMORY_AGENT_NAME, roles: ["custom"], runtimeConfig: expect.objectContaining(heartbeatConfig(false)) }), undefined);
  });

  it("preserves an operator-disabled heartbeat during startup convergence", async () => {
    const owner = memoryOwner(false);
    const store = fakeStore([owner]);
    const result = await store.provisionBuiltinMemoryAgent();
    expect(result?.runtimeConfig).toEqual(heartbeatConfig(false));
    expect(store.writeAgent).not.toHaveBeenCalled();
  });

  it("does not disable an operator-enabled heartbeat during startup convergence", async () => {
    const owner = memoryOwner(true);
    const store = fakeStore([owner]);
    const result = await store.provisionBuiltinMemoryAgent();
    expect(result?.runtimeConfig).toEqual(heartbeatConfig(true));
    expect(store.writeAgent).not.toHaveBeenCalled();
  });

  it("converges a legacy owner without runtime config to the heartbeat-disabled default", async () => {
    const owner = agent(BUILTIN_MEMORY_AGENT_NAME, { [BUILTIN_MEMORY_AGENT_PROVENANCE_KEY]: true });
    delete (owner as { runtimeConfig?: Record<string, unknown> }).runtimeConfig;
    const store = fakeStore([owner]);
    const result = await store.provisionBuiltinMemoryAgent();
    expect(result?.runtimeConfig).toEqual(heartbeatConfig(false));
    expect(store.writeAgent).toHaveBeenCalledWith(expect.objectContaining({ runtimeConfig: heartbeatConfig(false) }), undefined);
  });

  it("uses the fallback name without enabling its heartbeat when the canonical name is operator-owned", async () => {
    const operator = agent(BUILTIN_MEMORY_AGENT_NAME); const store = fakeStore([operator]);
    await store.provisionBuiltinMemoryAgent();
    expect(operator.name).toBe(BUILTIN_MEMORY_AGENT_NAME);
    expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: BUILTIN_MEMORY_AGENT_FALLBACK_NAME, runtimeConfig: expect.objectContaining(heartbeatConfig(false)) }), undefined);
  });

  it("degrades safely when both reserved names are occupied", async () => {
    const store = fakeStore([agent(BUILTIN_MEMORY_AGENT_NAME), agent(BUILTIN_MEMORY_AGENT_FALLBACK_NAME)]);
    await expect(store.provisionBuiltinMemoryAgent()).resolves.toBeNull(); expect(store.createAgent).not.toHaveBeenCalled();
  });
});
