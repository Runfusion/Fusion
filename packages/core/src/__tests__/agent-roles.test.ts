import { describe, expect, it } from "vitest";
import { normalizeAgentRoles } from "../types/agents/agents.js";

describe("normalizeAgentRoles", () => {
  it("deduplicates tags into the canonical capability order", () => {
    expect(normalizeAgentRoles(["custom", "executor", "executor", "triage"])).toEqual([
      "triage",
      "executor",
      "custom",
    ]);
  });

  it("accepts a singular compatibility role once", () => {
    expect(normalizeAgentRoles(undefined, "reviewer")).toEqual(["reviewer"]);
  });

  it("rejects absent and unknown role tags", () => {
    expect(() => normalizeAgentRoles([], undefined)).toThrow("requires at least one role");
    expect(() => normalizeAgentRoles(["not-a-role"])).toThrow("unknown capability");
  });
});
