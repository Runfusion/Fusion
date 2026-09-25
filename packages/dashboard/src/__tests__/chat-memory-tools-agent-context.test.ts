import { describe, expect, it, vi, beforeEach } from "vitest";

/*
FNXC:ChatAgentMemory 2026-09-22-02:20:
Greptile finding #2 on the compaction-gate PR: both direct and room chat called
`createMemoryTools` WITHOUT the `agentMemory` context, so `fn_memory_search` skipped agent
memory entirely and `fn_memory_get` fell through to the project-memory lookup. With the
RUFU-182 budget an oversized agent-memory body is replaced in the prompt by an index that
tells the model to recall via these tools — a blind recall path made the index a dead end.
These tests pin that the chat toolset forwards the bound agent's memory to the tools.
*/

const mockCreateMemoryTools = vi.fn(() => [] as unknown[]);

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    createMemoryTools: (...args: unknown[]) => mockCreateMemoryTools(...args) as never,
  };
});

const { createChatFusionToolset } = await import("../chat.js");

function makeTaskStore() {
  return {
    getSettings: async () => ({ experimentalFeatures: {} }),
  };
}

function makeAgentStore(agent: { id: string; name: string; memory: string | null } | null, opts?: { throwOnGet?: boolean }) {
  return {
    getAgent: async () => {
      if (opts?.throwOnGet) throw new Error("store unavailable");
      return agent;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateMemoryTools.mockReturnValue([]);
});

describe("createChatFusionToolset — agent-memory recall context", () => {
  it("forwards the bound agent's memory context to createMemoryTools when an agent is bound", async () => {
    await createChatFusionToolset({
      taskStore: makeTaskStore() as never,
      agentStore: makeAgentStore({ id: "agent-1", name: "Scout", memory: "vault body" }) as never,
      rootDir: "/tmp/does-not-matter",
      agentId: "agent-1",
    });

    expect(mockCreateMemoryTools).toHaveBeenCalledTimes(1);
    const options = mockCreateMemoryTools.mock.calls[0][2] as
      | { agentMemory?: { agentId?: string; agentName?: string; memory?: string | null } }
      | undefined;
    expect(options?.agentMemory).toEqual({ agentId: "agent-1", agentName: "Scout", memory: "vault body" });
  });

  it("keeps recall project-scoped when no agent is bound to the chat", async () => {
    await createChatFusionToolset({
      taskStore: makeTaskStore() as never,
      agentStore: makeAgentStore({ id: "agent-1", name: "Scout", memory: "vault body" }) as never,
      rootDir: "/tmp/does-not-matter",
    });

    const options = mockCreateMemoryTools.mock.calls[0][2] as { agentMemory?: unknown } | undefined;
    expect(options?.agentMemory).toBeUndefined();
  });

  it("degrades to project-scoped recall instead of failing the tool build when the agent lookup throws", async () => {
    await createChatFusionToolset({
      taskStore: makeTaskStore() as never,
      agentStore: makeAgentStore(null, { throwOnGet: true }) as never,
      rootDir: "/tmp/does-not-matter",
      agentId: "agent-1",
    });

    const options = mockCreateMemoryTools.mock.calls[0][2] as { agentMemory?: unknown } | undefined;
    expect(options?.agentMemory).toBeUndefined();
  });
});
