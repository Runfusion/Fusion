import { describe, expect, it } from "vitest";
import {
  computeSkillId,
  getSkillSettingState,
  parseSkillId,
  resolvePluginSkillEnabled,
} from "../skill-settings.js";

describe("skill-settings", () => {
  it("computes and parses stable skill IDs", () => {
    const id = computeSkillId("plugin:fusion-plugin", "skills/ce-plan/SKILL.md");
    expect(id).toBe("plugin%3Afusion-plugin::skills/ce-plan/SKILL.md");
    expect(parseSkillId(id)).toEqual({
      source: "plugin:fusion-plugin",
      relativePath: "skills/ce-plan/SKILL.md",
    });
    expect(parseSkillId("not-a-skill-id")).toBeNull();
  });

  it("resolves top-level + and - skill entries by path or wildcard ID", () => {
    const skillId = computeSkillId("plugin:fusion-plugin", "skills/ce-plan/SKILL.md");

    expect(getSkillSettingState(skillId, { skills: ["+ce-plan/SKILL.md"] })).toBe("enabled");
    expect(getSkillSettingState(skillId, { skills: ["-skills/ce-plan/SKILL.md"] })).toBe("disabled");
    expect(getSkillSettingState(computeSkillId("*", "skills/ce-plan/SKILL.md"), {
      skills: ["+ce-plan/SKILL.md"],
    })).toBe("enabled");
  });

  it("resolves package-scoped plugin skill entries", () => {
    const skillId = computeSkillId("plugin:fusion-plugin", "skills/ce-plan/SKILL.md");

    expect(getSkillSettingState(skillId, {
      packages: [{ source: "plugin:fusion-plugin", skills: ["+skills/ce-plan/SKILL.md"] }],
    })).toBe("enabled");
    expect(getSkillSettingState(skillId, {
      packages: [{ source: "plugin:fusion-plugin", skills: ["-ce-plan/SKILL.md"] }],
    })).toBe("disabled");
  });

  it("uses project toggles ahead of static plugin defaults", () => {
    expect(resolvePluginSkillEnabled({
      packages: [{ source: "plugin:fusion-plugin", skills: ["+skills/opt-in/SKILL.md"] }],
    }, "fusion-plugin", "opt-in", false)).toBe(true);

    expect(resolvePluginSkillEnabled({
      packages: [{ source: "plugin:fusion-plugin", skills: ["-skills/default-on/SKILL.md"] }],
    }, "fusion-plugin", "default-on", true)).toBe(false);
  });

  it("falls back to static defaults when settings omit the plugin skill", () => {
    expect(resolvePluginSkillEnabled({}, "fusion-plugin", "default-on", undefined)).toBe(true);
    expect(resolvePluginSkillEnabled({}, "fusion-plugin", "default-off", false)).toBe(false);
  });

  it("honors both top-level and package-scoped settings entries", () => {
    expect(resolvePluginSkillEnabled({ skills: ["+skills/top-level/SKILL.md"] }, "fusion-plugin", "top-level", false)).toBe(true);
    expect(resolvePluginSkillEnabled({
      packages: [{ source: "plugin:fusion-plugin", skills: ["-skills/package-level/SKILL.md"] }],
    }, "fusion-plugin", "package-level", true)).toBe(false);
  });
});
