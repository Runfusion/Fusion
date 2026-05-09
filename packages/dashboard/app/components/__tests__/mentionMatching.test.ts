import { describe, expect, it } from "vitest";
import { matchesAgentMentionFilter, normalizeMentionToken } from "../mentionMatching";

describe("mentionMatching", () => {
  it("normalizes spaces and hyphens into underscores", () => {
    expect(normalizeMentionToken(" John Doe-Agent ")).toBe("john_doe_agent");
  });

  it.each([
    ["John Doe", "john_d"],
    ["John-Doe", "john_d"],
    ["John Doe", "john doe"],
  ])("matches %s with filter %s", (agentName, filter) => {
    expect(matchesAgentMentionFilter(agentName, filter)).toBe(true);
  });

  it("returns false when filter does not match", () => {
    expect(matchesAgentMentionFilter("John Doe", "alpha")).toBe(false);
  });
});
