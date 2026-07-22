import { describe, expect, it } from "vitest";

import { parseExplicitDuplicateMarker } from "../duplicates/explicit-duplicate-marker.js";

const FULL_PROMPT = `# Task: FN-5211 - Example

## Mission
This is a duplicate-handling task, but it is a full spec body.

- Implement the fix
- Verify the result
`;

describe("parseExplicitDuplicateMarker", () => {
  it("parses a canonical marker", () => {
    expect(parseExplicitDuplicateMarker("DUPLICATE: FN-5211")).toEqual({
      canonicalId: "FN-5211",
    });
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(parseExplicitDuplicateMarker("   duplicate: fn-5211\n")).toEqual({
      canonicalId: "FN-5211",
    });
  });

  it("parses a backtick-wrapped marker", () => {
    expect(parseExplicitDuplicateMarker("`DUPLICATE: FN-5211`")).toEqual({
      canonicalId: "FN-5211",
    });
  });

  it("parses a bold-wrapped marker", () => {
    expect(parseExplicitDuplicateMarker("**DUPLICATE: FN-5211**")).toEqual({
      canonicalId: "FN-5211",
    });
  });

  it("parses a marker padded by blank lines", () => {
    expect(parseExplicitDuplicateMarker("\n\n\nDUPLICATE: FN-5211\n\n")).toEqual({
      canonicalId: "FN-5211",
    });
  });

  it("parses a fenced marker", () => {
    expect(parseExplicitDuplicateMarker("```text\nDUPLICATE: FN-5211\n```")).toEqual({
      canonicalId: "FN-5211",
    });
  });

  it("rejects a full prompt body that merely mentions duplicate", () => {
    expect(parseExplicitDuplicateMarker(FULL_PROMPT)).toBeNull();
  });

  it("rejects extra prose after the marker", () => {
    expect(parseExplicitDuplicateMarker("DUPLICATE: FN-5211\n\nSee also FN-5212")).toBeNull();
  });

  it("rejects multiple markers", () => {
    expect(parseExplicitDuplicateMarker("DUPLICATE: FN-5211\nDUPLICATE: FN-5212")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseExplicitDuplicateMarker("   ")).toBeNull();
  });

  it("rejects non-FN identifiers", () => {
    expect(parseExplicitDuplicateMarker("DUPLICATE: NOT-1234")).toBeNull();
  });
});
