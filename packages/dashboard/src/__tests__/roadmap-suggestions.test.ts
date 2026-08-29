import { describe, it, expect } from "vitest";
import { SUGGESTION_TIMEOUT_MS } from "../roadmap-suggestions.js";

describe("roadmap suggestions compatibility exports", () => {
  it("re-exports suggestion timeout from roadmap plugin", () => {
    expect(typeof SUGGESTION_TIMEOUT_MS).toBe("number");
    expect(SUGGESTION_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
