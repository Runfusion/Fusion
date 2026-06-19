import { describe, expect, it } from "vitest";
import { parseAwaitInputSentinel } from "../executor.js";

describe("parseAwaitInputSentinel (U6)", () => {
  it("extracts the question from a well-formed sentinel block", () => {
    const out = [
      "Here is some planning preamble.",
      "===FUSION_AWAIT_INPUT===",
      "Which auth provider should this use — Auth0 or Cognito?",
      "===END_FUSION_AWAIT_INPUT===",
      "trailing text",
    ].join("\n");
    expect(parseAwaitInputSentinel(out)).toBe("Which auth provider should this use — Auth0 or Cognito?");
  });

  it("preserves a multi-line question body", () => {
    const out = "===FUSION_AWAIT_INPUT===\nPick one:\n1. A\n2. B\n===END_FUSION_AWAIT_INPUT===";
    expect(parseAwaitInputSentinel(out)).toBe("Pick one:\n1. A\n2. B");
  });

  it("returns null when there is no sentinel", () => {
    expect(parseAwaitInputSentinel("just a normal plan, no questions")).toBeNull();
  });

  it("returns null for undefined/empty output", () => {
    expect(parseAwaitInputSentinel(undefined)).toBeNull();
    expect(parseAwaitInputSentinel("")).toBeNull();
  });

  it("returns null for an empty sentinel body", () => {
    expect(parseAwaitInputSentinel("===FUSION_AWAIT_INPUT===\n   \n===END_FUSION_AWAIT_INPUT===")).toBeNull();
  });

  it("ignores an unterminated sentinel", () => {
    expect(parseAwaitInputSentinel("===FUSION_AWAIT_INPUT===\nno closing marker")).toBeNull();
  });
});
