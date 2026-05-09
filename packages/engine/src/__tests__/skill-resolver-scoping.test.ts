import { describe, it, expect } from "vitest";
import { getSkillPurposeFilter } from "../skill-resolver.js";

describe("getSkillPurposeFilter", () => {
  it("returns a pass-all filter for executor sessions", () => {
    const filter = getSkillPurposeFilter("executor");
    expect(filter("any-skill")).toBe(true);
    expect(filter("fusion")).toBe(true);
    expect(filter("deployment")).toBe(true);
  });

  it("filters to review-relevant skills for reviewer sessions", () => {
    const filter = getSkillPurposeFilter("reviewer");
    expect(filter("code-review")).toBe(true);
    expect(filter("security-review")).toBe(true);
    expect(filter("review")).toBe(true);
    expect(filter("deployment")).toBe(false);
    expect(filter("fusion")).toBe(false);
  });

  it("returns a pass-all filter for unknown session purposes", () => {
    const filter = getSkillPurposeFilter("unknown-purpose");
    expect(filter("any-skill")).toBe(true);
  });

  it("filters to minimal skills for heartbeat sessions", () => {
    const filter = getSkillPurposeFilter("heartbeat");
    expect(filter("monitoring")).toBe(true);
    expect(filter("heartbeat")).toBe(true);
    expect(filter("fusion")).toBe(false);
    expect(filter("code-review")).toBe(false);
  });

  it("returns a pass-all filter for triage sessions", () => {
    const filter = getSkillPurposeFilter("triage");
    expect(filter("any-skill")).toBe(true);
    expect(filter("fusion")).toBe(true);
  });
});
