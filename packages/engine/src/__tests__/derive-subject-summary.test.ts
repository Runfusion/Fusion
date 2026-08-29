import { describe, expect, it } from "vitest";
import { deriveDeterministicSubjectSummary } from "../merger.js";

describe("deriveDeterministicSubjectSummary", () => {
  it("returns null on empty input", () => {
    expect(deriveDeterministicSubjectSummary("")).toBeNull();
    expect(deriveDeterministicSubjectSummary("   \n  ")).toBeNull();
  });

  it("uses the only line as the summary", () => {
    expect(deriveDeterministicSubjectSummary("- feat(X): add widget")).toBe("add widget");
  });

  it("prefers the lowest-numbered Step commit over the most recent revision", () => {
    // Order is most-recent-first, mimicking what the merger feeds in.
    const log = [
      "- fix(FN-3617): align mailbox modal css with design tokens",
      "- feat(FN-3617): complete Step 4 — document Claude manual OAuth flow",
      "- test(FN-3617): complete Step 2 — cover Anthropic manual-code UX",
      "- feat(FN-3617): complete Step 1 — switch Anthropic OAuth to manual code",
    ].join("\n");
    expect(deriveDeterministicSubjectSummary(log)).toBe(
      "switch Anthropic OAuth to manual code (+3 more)",
    );
  });

  it("falls back to the oldest commit when no Step headlines are present", () => {
    const log = [
      "- chore: lint",
      "- fix: handle null",
      "- feat: add foo",
    ].join("\n");
    expect(deriveDeterministicSubjectSummary(log)).toBe("add foo (+2 more)");
  });

  it("handles plain hyphen separator in Step lines", () => {
    const log = [
      "- feat: complete Step 2 - second thing",
      "- feat: complete Step 1 - first thing",
    ].join("\n");
    expect(deriveDeterministicSubjectSummary(log)).toBe("first thing (+1 more)");
  });

  it("handles em-dash separator in Step lines", () => {
    const log = [
      "- feat: complete Step 2 — second thing",
      "- feat: complete Step 1 — first thing",
    ].join("\n");
    expect(deriveDeterministicSubjectSummary(log)).toBe("first thing (+1 more)");
  });
});
