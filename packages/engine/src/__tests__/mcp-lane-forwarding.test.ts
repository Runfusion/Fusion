import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ResolvedMcpServerDefinition } from "@fusion/core";

const { createFnAgentMock } = vi.hoisted(() => ({
  createFnAgentMock: vi.fn(async () => ({
    session: {
      prompt: vi.fn(async () => undefined),
      dispose: vi.fn(),
    },
  })),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: createFnAgentMock,
  promptWithFallback: vi.fn(async () => undefined),
  describeModel: vi.fn(() => "mock-model"),
}));

import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";

const mcpServers: ResolvedMcpServerDefinition[] = [
  {
    name: "docs",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    env: { MCP_TOKEN: "materialized-secret" },
  },
];

async function createLaneSession(sessionPurpose: "executor" | "reviewer" | "validation" | "merger" | "heartbeat") {
  return createResolvedAgentSession({
    sessionPurpose,
    cwd: "/tmp/fusion-test-worktree",
    systemPrompt: `You are the ${sessionPurpose} lane`,
    tools: "readonly",
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4",
    mcpServers,
  });
}

describe("MCP lane forwarding", () => {
  beforeEach(() => {
    createFnAgentMock.mockClear();
  });

  it.each([
    ["executor"],
    ["reviewer"],
    ["validation"],
    ["merger"],
    ["heartbeat"],
  ] as const)("forwards materialized MCP servers through the shared %s lane runtime seam", async (sessionPurpose) => {
    await createLaneSession(sessionPurpose);

    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers,
      systemPrompt: `You are the ${sessionPurpose} lane`,
    }));
  });

  it("passes mcpServers through the shared helper seam used by workflow-node and summarization callers", async () => {
    await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/fusion-test-worktree",
      systemPrompt: "Workflow model node and summarization lanes share this helper.",
      tools: "readonly",
      defaultProvider: "anthropic",
      mcpServers,
      runtimeContext: { lane: "workflow-node+summarization" },
    });

    expect(createFnAgentMock).toHaveBeenCalledTimes(1);
    expect(createFnAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers,
      runtimeContext: expect.objectContaining({ lane: "workflow-node+summarization" }),
    }));
  });

  it("does not send mock-provider sessions through the pi createFnAgent seam", async () => {
    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      cwd: "/tmp/fusion-test-worktree",
      systemPrompt: "Mock providers are MCP-incapable.",
      tools: "readonly",
      defaultProvider: "mock",
      defaultModelId: "scripted",
      mcpServers,
    });

    expect(createFnAgentMock).not.toHaveBeenCalled();
    expect(result.runtimeId).toBe("mock");
  });
});
