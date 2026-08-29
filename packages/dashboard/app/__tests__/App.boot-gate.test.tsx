import { describe, expect, it } from "vitest";
import { shouldShowFirstEverBootLoader } from "../App";

describe("App boot gate", () => {
  it("shows loader only when projects are loading and no projects are present", () => {
    expect(shouldShowFirstEverBootLoader(true, 0)).toBe(true);
    expect(shouldShowFirstEverBootLoader(false, 1)).toBe(false);
    expect(shouldShowFirstEverBootLoader(true, 1)).toBe(false);
  });
});
