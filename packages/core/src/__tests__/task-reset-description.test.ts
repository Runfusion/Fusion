import { describe, expect, it } from "vitest";
import { resolveResetDescription } from "../task-store/reset-lifecycle.js";

describe("resolveResetDescription", () => {
  it("returns a trimmed non-empty override", () => {
    expect(resolveResetDescription("original", "  corrected request  ")).toBe("corrected request");
  });

  it.each([undefined, "", "   \n\t  "])("preserves the current description for %j", (override) => {
    expect(resolveResetDescription("original", override)).toBe("original");
  });

  it("preserves an undefined current description without an override", () => {
    expect(resolveResetDescription(undefined)).toBeUndefined();
  });

  it("does not truncate a long override", () => {
    const description = "x".repeat(5_000);
    expect(resolveResetDescription("original", description)).toBe(description);
  });
});
