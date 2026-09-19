import { describe, expect, it } from "vitest";
import { classifyAgentSkill, formatAgentSkillBadgeLabel } from "../agentSkills";

const discovered = [
  { id: "source::skills/enabled/SKILL.md", name: "Enabled", enabled: true },
  { id: "source::skills/disabled/SKILL.md", name: "Disabled", enabled: false },
] as any[];

describe("classifyAgentSkill", () => {
  it.each([
    ["source::skills/enabled/SKILL.md", discovered, false, "auto-available", "source::skills/enabled/SKILL.md"],
    ["source::skills/disabled/SKILL.md", discovered, true, "disabled", "source::skills/disabled/SKILL.md"],
    ["missing", discovered, false, "unknown", undefined],
    ["missing", [], true, "unknown", undefined],
    ["missing", null, false, "pending", undefined],
  ] as const)("classifies %s consistently", (id, skills, forced, state, resolvedSkillId) => {
    const result = classifyAgentSkill(id, skills, { forced });
    expect(result.state).toBe(state);
    expect(result.forced).toBe(forced);
    expect(result.resolvedSkillId).toBe(resolvedSkillId);
  });

  it.each([
    "enabled",
    "skills/enabled/SKILL.md",
    "legacy-source::skills/enabled/SKILL.md",
  ])("resolves compatible legacy reference %s to its canonical discovered ID", (storedReference) => {
    expect(classifyAgentSkill(storedReference, discovered, { forced: true })).toMatchObject({
      state: "auto-available",
      resolvedSkillId: "source::skills/enabled/SKILL.md",
    });
  });

  it("prefers an enabled equivalent when duplicate legacy candidates differ in availability", () => {
    const duplicates = [
      { id: "old::skills/review/SKILL.md", name: "Review", enabled: false },
      { id: "new::skills/review/SKILL.md", name: "Review", enabled: true },
    ] as any[];

    expect(classifyAgentSkill("review", duplicates, { forced: true })).toMatchObject({
      state: "auto-available",
      resolvedSkillId: "new::skills/review/SKILL.md",
    });
  });

  it("keeps an exact disabled canonical ID disabled despite an enabled equivalent", () => {
    const candidates = [
      { id: "disabled::skills/review/SKILL.md", name: "Review", enabled: false },
      { id: "enabled::skills/review/SKILL.md", name: "Review", enabled: true },
    ] as any[];

    expect(classifyAgentSkill("disabled::skills/review/SKILL.md", candidates, { forced: true })).toMatchObject({
      state: "disabled",
      resolvedSkillId: "disabled::skills/review/SKILL.md",
    });
  });

  it("keeps skill-path labels readable", () => {
    expect(formatAgentSkillBadgeLabel(".agents/skills/testing/SKILL.md")).toBe("testing");
  });
});
