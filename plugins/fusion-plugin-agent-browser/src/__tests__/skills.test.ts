import { describe, expect, it } from "vitest";
import { AGENT_BROWSER_SKILLS } from "../skills.js";

describe("skills", () => {
  it("declares skill metadata", () => {
    expect(AGENT_BROWSER_SKILLS[0]?.skillId).toBe("agent-browser-navigation");
    expect(AGENT_BROWSER_SKILLS[0]?.skillFiles.length).toBeGreaterThan(0);
  });
});
