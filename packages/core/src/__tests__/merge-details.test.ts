import { describe, expect, it } from "vitest";

import type { MergeDetails } from "../types";

describe("MergeDetails", () => {
  it("exposes optional rebaseBaseSha for rebase merge range attribution", () => {
    const details: MergeDetails = {
      commitSha: "abc123",
      rebaseBaseSha: "def456",
    };

    expect(details.rebaseBaseSha).toBe("def456");
  });
});
