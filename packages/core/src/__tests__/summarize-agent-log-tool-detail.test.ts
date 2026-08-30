import { describe, expect, it } from "vitest";
import type { AgentLogEntry } from "../types.js";
import {
  ARCHIVE_AGENT_LOG_SNIPPET_LIMIT,
  summarizeAgentLog,
} from "../task-store/serialization.js";

function entry(overrides: Partial<AgentLogEntry>): AgentLogEntry {
  return {
    timestamp: "2026-08-29T00:00:00.000Z",
    taskId: "FN-253",
    text: "fn_run_verification",
    type: "tool",
    agent: "executor",
    ...overrides,
  };
}

describe("summarizeAgentLog tool detail ordering", () => {
  it("keeps the tool name before long detail within the existing snippet clamp", () => {
    const summary = summarizeAgentLog([
      entry({ detail: "x".repeat(ARCHIVE_AGENT_LOG_SNIPPET_LIMIT + 100) }),
    ], 1);
    const recent = summary?.split("Recent entries:\n")[1] ?? "";
    const snippet = recent.split(": ")[1] ?? "";

    expect(recent).toContain("fn_run_verification");
    expect(snippet.length).toBeLessThanOrEqual(ARCHIVE_AGENT_LOG_SNIPPET_LIMIT + 3);
  });

  it("falls back to detail when a legacy row has no text", () => {
    const summary = summarizeAgentLog([
      entry({ text: "", detail: "legacy detail" }),
    ], 1);

    expect(summary).toContain("legacy detail");
  });
});
