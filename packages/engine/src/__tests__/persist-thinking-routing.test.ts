import { describe, expect, it, vi, beforeEach } from "vitest";
import { isEphemeralAgent, resolvePersistAgentThinkingLog, type GlobalSettings } from "@fusion/core";
import { AgentLogger } from "../agents/agent-logger.js";

vi.mock("../agents/agent-logger.js", () => ({
  AgentLogger: vi.fn(),
}));

function createLoggerForAgent(agent: { metadata?: Record<string, unknown> }, settings: Partial<GlobalSettings>) {
  const ephemeral = isEphemeralAgent(agent);
  return new AgentLogger({
    persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral }),
  });
}

describe("thinking persistence routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const permanentAgent = { metadata: { type: "permanent" } };
  const ephemeralAgent = { metadata: { agentKind: "task-worker" } };

  it.each([
    {
      name: "both off",
      settings: { persistAgentThinkingLogPermanent: false, persistAgentThinkingLogEphemeral: false },
      expectedPermanent: false,
      expectedEphemeral: false,
    },
    {
      name: "permanent only",
      settings: { persistAgentThinkingLogPermanent: true, persistAgentThinkingLogEphemeral: false },
      expectedPermanent: true,
      expectedEphemeral: false,
    },
    {
      name: "ephemeral only",
      settings: { persistAgentThinkingLogPermanent: false, persistAgentThinkingLogEphemeral: true },
      expectedPermanent: false,
      expectedEphemeral: true,
    },
    {
      name: "legacy fallback",
      settings: { persistAgentThinkingLog: true },
      expectedPermanent: true,
      expectedEphemeral: true,
    },
  ])("routes %s", ({ settings, expectedPermanent, expectedEphemeral }) => {
    createLoggerForAgent(permanentAgent, settings);
    createLoggerForAgent(ephemeralAgent, settings);

    const calls = vi.mocked(AgentLogger).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ persistAgentThinkingLog: expectedPermanent });
    expect(calls[1]?.[0]).toMatchObject({ persistAgentThinkingLog: expectedEphemeral });
  });
});
