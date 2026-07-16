import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";

const { createResolvedAgentSessionMock, promptWithFallbackMock } = vi.hoisted(() => ({
  createResolvedAgentSessionMock: vi.fn(async () => ({
    session: {
      dispose: vi.fn(),
    },
  })),
  promptWithFallbackMock: vi.fn(async () => undefined),
}));

vi.mock("../agent-session-helpers.js", () => ({
  createResolvedAgentSession: createResolvedAgentSessionMock,
  resolveMergerSessionModel: vi.fn((settings: Settings) => ({
    provider: settings.defaultProvider,
    modelId: settings.defaultModelId,
  })),
  // FNXC:EngineTestDrift 2026-07-11-22:30:
  // pr-response-run-ops resolves the merger lane thinking level via
  // resolveMergerThinkingLevel (Settings-ThinkingLevel precedence, 2026-07-10).
  // The mock must surface it or every PR-response run throws on the missing
  // export. Neutral undefined return — no test asserts on thinking level.
  resolveMergerThinkingLevel: vi.fn(() => undefined),
  resolveMergerFallbackThinkingLevel: vi.fn((settings: Settings) => settings.mergerFallbackThinkingLevel ?? settings.fallbackThinkingLevel),
}));

vi.mock("../pi.js", () => ({
  promptWithFallback: promptWithFallbackMock,
}));

import { makePrResponseAgentRunner } from "../pr-response-run-ops.js";

const settings = {
  defaultProvider: "anthropic",
  defaultModelId: "claude-sonnet-4-5",
} as Settings;

function createStore(enabled: boolean): TaskStore {
  return {
    async getSettingsByScope() {
      return {
        global: { mcpServers: { enabled: true, servers: [] } },
        project: {
          mcpServers: {
            enabled,
            servers: enabled
              ? [
                  {
                    name: "pr-response-tools",
                    transport: "stdio",
                    command: "node",
                    env: { MCP_TOKEN: { secretRef: "pr-token", scope: "project" } },
                  },
                ]
              : [],
          },
        },
      };
    },
    async getSecretsStore() {
      return {
        async revealSecret(id: string) {
          expect(id).toBe("pr-token");
          return { key: id, plaintextValue: "materialized-pr-secret" };
        },
      };
    },
  } as unknown as TaskStore;
}

async function runRunner(store?: TaskStore) {
  const runner = makePrResponseAgentRunner(settings, "FN-7077", "/tmp/fusion-pr-response", store);
  await runner({
    prompt: "Resolve review threads",
    systemPrompt: "System",
    threads: [{ id: "thread-1" }],
  });
}

describe("PR response MCP forwarding", () => {
  beforeEach(() => {
    createResolvedAgentSessionMock.mockClear();
    promptWithFallbackMock.mockClear();
  });

  it("forwards materialized MCP servers into the PR-response merger agent", async () => {
    await runRunner(createStore(true));

    expect(createResolvedAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionPurpose: "merger",
      tools: "coding",
      mcpServers: [
        expect.objectContaining({
          name: "pr-response-tools",
          env: { MCP_TOKEN: "materialized-pr-secret" },
        }),
      ],
    }));
  });

  it("forwards an empty MCP array when PR-response MCP is disabled", async () => {
    await runRunner(createStore(false));

    expect(createResolvedAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: [],
    }));
  });

  it("keeps PR-response sessions working without a store", async () => {
    await runRunner(undefined);

    expect(createResolvedAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: undefined,
    }));
  });
});
