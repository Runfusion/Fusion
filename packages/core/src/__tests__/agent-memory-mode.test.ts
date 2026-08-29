import { describe, expect, it } from "vitest";
import type { Agent, GlobalSettings } from "../types.js";
import { resolveAgentMemoryInclusionMode } from "../agents/agent-memory-mode.js";

function makeAgent(mode?: unknown): Agent {
  return {
    id: "agent-1",
    name: "Agent 1",
    role: "executor",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    runtimeConfig: mode === undefined ? {} : { agentMemoryInclusionMode: mode },
  };
}

describe("resolveAgentMemoryInclusionMode", () => {
  it("prefers per-agent override over global", () => {
    const result = resolveAgentMemoryInclusionMode({
      agent: makeAgent("off"),
      globalSettings: { agentMemoryInclusionMode: "full" } as GlobalSettings,
    });
    expect(result).toEqual({ mode: "off", source: "agent" });
  });

  it("prefers global over default", () => {
    const result = resolveAgentMemoryInclusionMode({
      agent: makeAgent(),
      globalSettings: { agentMemoryInclusionMode: "off" } as GlobalSettings,
    });
    expect(result).toEqual({ mode: "off", source: "global" });
  });

  it("falls back to full default", () => {
    const result = resolveAgentMemoryInclusionMode({ agent: makeAgent() });
    expect(result).toEqual({ mode: "full", source: "default" });
  });

  it("ignores invalid values and falls through", () => {
    const result = resolveAgentMemoryInclusionMode({
      agent: makeAgent("bad"),
      globalSettings: { agentMemoryInclusionMode: "index" } as GlobalSettings,
    });
    expect(result).toEqual({ mode: "index", source: "global" });
  });
});
