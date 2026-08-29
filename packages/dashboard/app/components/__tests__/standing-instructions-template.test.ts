import { describe, expect, it } from "vitest";
import {
  STANDING_INSTRUCTIONS_TEMPLATE,
  hasStandingInstructionsStructure,
  isStandingInstructionsEmpty,
  withStandingInstructionsTemplate,
} from "../agent-presets/standing-instructions-template";

describe("standing-instructions-template", () => {
  it("exports a six-section skeleton", () => {
    expect(hasStandingInstructionsStructure(STANDING_INSTRUCTIONS_TEMPLATE)).toBe(true);
    expect(STANDING_INSTRUCTIONS_TEMPLATE).toContain("## Description");
    expect(STANDING_INSTRUCTIONS_TEMPLATE).toContain("## Collaboration & Escalation");
  });

  it("treats blank/whitespace as empty", () => {
    expect(isStandingInstructionsEmpty("")).toBe(true);
    expect(isStandingInstructionsEmpty("   \n")).toBe(true);
    expect(isStandingInstructionsEmpty("Keep going")).toBe(false);
  });

  it("seeds template only when empty", () => {
    expect(withStandingInstructionsTemplate("")).toBe(STANDING_INSTRUCTIONS_TEMPLATE);
    expect(withStandingInstructionsTemplate("Already filled")).toBe("Already filled");
  });

  it("preserves trailing newline on non-empty body and strips other trailing whitespace", () => {
    expect(withStandingInstructionsTemplate("Already filled\n")).toBe("Already filled\n");
    expect(withStandingInstructionsTemplate("Already filled\n\n")).toBe("Already filled\n");
    expect(withStandingInstructionsTemplate("Already filled  ")).toBe("Already filled");
  });
});
