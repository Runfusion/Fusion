import { describe, expect, it } from "vitest";
import { classifyAgentSkill, formatAgentSkillBadgeLabel } from "../agentSkills";

const discovered = [
  { id: "enabled", name: "Enabled", enabled: true },
  { id: "disabled", name: "Disabled", enabled: false },
  { id: "enabled", name: "Duplicate", enabled: false },
] as any[];

describe("classifyAgentSkill", () => {
  it.each([
    ["enabled", discovered, false, "auto-available"],
    ["enabled", discovered, true, "auto-available"],
    ["disabled", discovered, false, "disabled"],
    ["disabled", discovered, true, "disabled"],
    ["missing", discovered, false, "unknown"],
    ["missing", [], true, "unknown"],
    ["missing", null, false, "pending"],
  ] as const)("classifies %s consistently", (id, skills, forced, state) => {
    const result = classifyAgentSkill(id, skills, { forced });
    expect(result.state).toBe(state);
    expect(result.forced).toBe(forced);
  });

  it("keeps skill-path labels readable", () => {
    expect(formatAgentSkillBadgeLabel(".agents/skills/testing/SKILL.md")).toBe("testing");
  });
});
