import { describe, it, expect } from "vitest";
import { getSkillPurposeFilter } from "../skill-resolver.js";

/**
 * Integration-style tests for getSkillPurposeFilter that verify filtering
 * against a realistic set of skill names typical of a Fusion project.
 *
 * The existing skill-resolver-scoping.test.ts tests individual skill names
 * in isolation. These tests verify the aggregate filtering behavior: how
 * many skills each purpose loads from a full project skill set, and that
 * the filter produces sensible subsets.
 */
describe("getSkillPurposeFilter integration", () => {
  // Simulate a realistic set of skill names from a Fusion project
  const ALL_SKILLS = [
    "fusion",
    "code-review",
    "security-review",
    "review",
    "deployment",
    "task-management",
    "monitoring",
    "heartbeat",
    "research",
    "web-search",
  ];

  it("executor loads all skills", () => {
    const filter = getSkillPurposeFilter("executor");
    const loaded = ALL_SKILLS.filter(filter);
    expect(loaded).toEqual(ALL_SKILLS);
  });

  it("reviewer loads only review-related skills", () => {
    const filter = getSkillPurposeFilter("reviewer");
    const loaded = ALL_SKILLS.filter(filter);
    expect(loaded).toEqual(["code-review", "security-review", "review"]);
    expect(loaded).not.toContain("fusion");
    expect(loaded).not.toContain("deployment");
    expect(loaded).not.toContain("monitoring");
  });

  it("heartbeat loads only monitoring-related skills", () => {
    const filter = getSkillPurposeFilter("heartbeat");
    const loaded = ALL_SKILLS.filter(filter);
    expect(loaded).toEqual(["monitoring", "heartbeat"]);
    expect(loaded).not.toContain("fusion");
    expect(loaded).not.toContain("code-review");
  });

  it("triage loads all skills (same as executor)", () => {
    const filter = getSkillPurposeFilter("triage");
    const loaded = ALL_SKILLS.filter(filter);
    expect(loaded).toEqual(ALL_SKILLS);
  });

  it("reviewer filters out the majority of skills", () => {
    const filter = getSkillPurposeFilter("reviewer");
    const loaded = ALL_SKILLS.filter(filter);
    // Reviewer should load significantly fewer skills than total
    expect(loaded.length).toBeLessThan(ALL_SKILLS.length / 2);
  });

  it("heartbeat filters to a minimal subset", () => {
    const filter = getSkillPurposeFilter("heartbeat");
    const loaded = ALL_SKILLS.filter(filter);
    // Heartbeat should have even fewer than reviewer
    expect(loaded.length).toBeLessThanOrEqual(2);
  });

  it("unknown purpose passes all skills through (safe fallback)", () => {
    const filter = getSkillPurposeFilter("some-future-purpose");
    const loaded = ALL_SKILLS.filter(filter);
    expect(loaded).toEqual(ALL_SKILLS);
  });

  it("reviewer and heartbeat produce disjoint sets from the same input", () => {
    const reviewerFilter = getSkillPurposeFilter("reviewer");
    const heartbeatFilter = getSkillPurposeFilter("heartbeat");
    const reviewerSkills = ALL_SKILLS.filter(reviewerFilter);
    const heartbeatSkills = ALL_SKILLS.filter(heartbeatFilter);

    // No skill should appear in both reviewer and heartbeat sets
    const overlap = reviewerSkills.filter((s) => heartbeatSkills.includes(s));
    expect(overlap).toEqual([]);
  });

  it("executor is a superset of all other purpose filters", () => {
    const executorFilter = getSkillPurposeFilter("executor");
    const reviewerFilter = getSkillPurposeFilter("reviewer");
    const heartbeatFilter = getSkillPurposeFilter("heartbeat");

    const executorSkills = new Set(ALL_SKILLS.filter(executorFilter));
    const reviewerSkills = ALL_SKILLS.filter(reviewerFilter);
    const heartbeatSkills = ALL_SKILLS.filter(heartbeatFilter);

    for (const skill of reviewerSkills) {
      expect(executorSkills.has(skill)).toBe(true);
    }
    for (const skill of heartbeatSkills) {
      expect(executorSkills.has(skill)).toBe(true);
    }
  });
});
