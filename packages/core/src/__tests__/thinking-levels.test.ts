import { describe, expect, it } from "vitest";

import { THINKING_LEVELS } from "../types.js";

describe("THINKING_LEVELS", () => {
  it("includes xhigh and max after high for maximum reasoning effort", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
