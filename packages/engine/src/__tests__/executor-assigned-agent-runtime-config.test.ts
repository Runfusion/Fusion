import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { resolveExecutorSessionModel } from "../agents/agent-session-helpers.js";

function createStore() {
  return {
    on: vi.fn(),
    getFusionDir: vi.fn(() => "/worktree/.fusion"),
    /*
    FNXC:EngineTests 2026-07-17-11:45:
    getAuthoritativeAssignedAgent requires store.getAsyncLayer() so the fallback
    AgentStore runs in PostgreSQL backend mode. A missing method throws, is
    swallowed, and the lookup returns null — defeating the runtimeConfig spy.
    */
    getAsyncLayer: vi.fn(() => ({ kind: "test-async-layer" })),
  } as any;
}

describe("TaskExecutor assigned-agent runtimeConfig lookup", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createHarness(runtimeConfig: Record<string, unknown> | undefined) {
    const rootDir = await mkdtemp(join(tmpdir(), "fn-7787-"));
    roots.push(rootDir);
    /*
     * FNXC:PostgresCutover 2026-07-10:
     * Upstream seeded a real sqlite AgentStore; that runtime is removed on
     * this branch (VAL-REMOVAL-005). The invariant under test is the
     * EXECUTOR's fallback from an agents-less execution store to the
     * authoritative project agent store, so spy the AgentStore prototype the
     * executor constructs internally instead of persisting a real agent.
     */
    const agent = {
      id: `agent-${Math.random().toString(16).slice(2)}`,
      name: `executor-${Math.random().toString(16).slice(2)}`,
      role: "executor",
      state: "idle",
      ...(runtimeConfig ? { runtimeConfig } : {}),
    };
    vi.spyOn(AgentStore.prototype, "init").mockResolvedValue(undefined);
    vi.spyOn(AgentStore.prototype, "getAgent").mockImplementation(async (id: string) => (id === agent.id ? (agent as never) : null) as never);
    const worktreeAgentStore = { getAgent: vi.fn().mockResolvedValue(null) };
    const executor = new TaskExecutor(createStore(), rootDir, { agentStore: worktreeAgentStore } as any);
    return { executor: executor as any, agent, worktreeAgentStore };
  }

  it.each([
    [{ model: "anthropic/claude-fable-5", modelProvider: "ignored", modelId: "ignored" }, { provider: "anthropic", modelId: "claude-fable-5" }],
    [{ modelProvider: "anthropic", modelId: "claude-fable-5" }, { provider: "anthropic", modelId: "claude-fable-5" }],
  ])("falls back from an agents-less execution store to the authoritative project agent runtimeConfig %#", async (runtimeConfig, expected) => {
    const { executor, agent, worktreeAgentStore } = await createHarness(runtimeConfig);

    const foundRuntimeConfig = await executor.getAssignedAgentRuntimeConfig(agent.id);

    expect(worktreeAgentStore.getAgent).toHaveBeenCalledWith(agent.id);
    expect(resolveExecutorSessionModel(undefined, undefined, {}, foundRuntimeConfig)).toEqual(expected);
  });

  it("returns undefined when the assigned agent is missing or has no complete runtime model", async () => {
    const { executor, agent } = await createHarness(undefined);

    expect(await executor.getAssignedAgentRuntimeConfig("missing-agent")).toBeUndefined();
    const runtimeConfig = await executor.getAssignedAgentRuntimeConfig(agent.id);
    expect(resolveExecutorSessionModel(undefined, undefined, {}, runtimeConfig)).toEqual({ provider: undefined, modelId: undefined });
  });

  it("keeps configured settings ahead of the assigned agent runtimeConfig", async () => {
    const { executor, agent } = await createHarness({ model: "anthropic/claude-fable-5" });

    const runtimeConfig = await executor.getAssignedAgentRuntimeConfig(agent.id);

    expect(resolveExecutorSessionModel(undefined, undefined, {
      executionProvider: "openai",
      executionModelId: "gpt-4.1",
    }, runtimeConfig)).toEqual({ provider: "openai", modelId: "gpt-4.1" });
  });
});
