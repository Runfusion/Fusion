import { describe, expect, it } from "vitest";
import { getSupportedSkillInstallTargets, SHIPPED_SKILL_NAMES } from "../skill-installation.js";

describe("bundled skill installation", () => {
  it("declares a home-directory target for every shipped skill and client", () => {
    const targets = getSupportedSkillInstallTargets("/tmp/fusion-skill-home");
    expect(SHIPPED_SKILL_NAMES).toEqual(["fusion", "computer-use"]);
    for (const skillName of SHIPPED_SKILL_NAMES) {
      expect(targets.filter((target) => target.skillName === skillName)).toHaveLength(3);
    }
  });
});
