import { describe, expect, it } from "vitest";

import {
  parseExplicitDuplicateMarker,
  resolveExplicitDuplicateMarker,
  parseDuplicateMarkerFromSessionText,
  isDuplicateRedirectOnlyPrompt,
  nonExecutableDuplicateRedirectReason,
} from "../duplicates/explicit-duplicate-marker.js";

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

  it("accepts custom task prefixes and normalizes them", () => {
    expect(parseExplicitDuplicateMarker("DUPLICATE: kb-1234")).toEqual({ canonicalId: "KB-1234" });
  });

  it("rejects malformed identifiers", () => {
    expect(parseExplicitDuplicateMarker("DUPLICATE: KB-ABC")).toBeNull();
    expect(parseExplicitDuplicateMarker("DUPLICATE: KB_1234")).toBeNull();
  });

  it("resolves exact prompt/title markers with deterministic source and conflicts", () => {
    expect(resolveExplicitDuplicateMarker("DUPLICATE: kb-123", "DUPLICATE: KB-123")).toEqual({
      marker: { canonicalId: "KB-123" }, source: "prompt", conflict: false,
    });
    expect(resolveExplicitDuplicateMarker(FULL_PROMPT, "DUPLICATE: KB-123")).toEqual({
      marker: { canonicalId: "KB-123" }, source: "title", conflict: false,
    });
    expect(resolveExplicitDuplicateMarker("DUPLICATE: KB-123", "DUPLICATE: FN-123")).toEqual({
      marker: null, source: null, conflict: true,
    });
  });

  it("flags duplicate-only prompt or title content as non-executable for dispatch", () => {
    expect(isDuplicateRedirectOnlyPrompt("DUPLICATE: FN-8676")).toBe(true);
    expect(isDuplicateRedirectOnlyPrompt(FULL_PROMPT, "DUPLICATE: KB-8676")).toBe(true);
    expect(nonExecutableDuplicateRedirectReason("DUPLICATE: FN-8676")).toContain("FN-8676");
    expect(nonExecutableDuplicateRedirectReason(FULL_PROMPT, "DUPLICATE: KB-8676")).toContain("task title");
    expect(isDuplicateRedirectOnlyPrompt(FULL_PROMPT)).toBe(false);
    expect(nonExecutableDuplicateRedirectReason(FULL_PROMPT)).toBeNull();
  });
});

/*
FNXC:DuplicateIntake 2026-07-26-10:40:
Recovery parser for a duplicate verdict announced in the planner's reply instead of written to
PROMPT.md (FN-8600). Narrowness is the whole point: it must catch the real shape without letting a
passing mention hijack a task that has a real spec.
*/
describe("parseDuplicateMarkerFromSessionText", () => {
  it("recovers the verdict from the exact shape FN-8600 produced", () => {
    const reply = [
      "DUPLICATE: FN-8595",
      "",
      "FN-8595 (done) already delivered the mobile favorites section including the per-row star",
      "toggle to favorite/unfavorite projects from mobile. No new PROMPT.md written.",
    ].join("\n");
    expect(parseDuplicateMarkerFromSessionText(reply)).toEqual({ canonicalId: "FN-8595" });
  });

  it("finds the marker when it closes the reply rather than opening it", () => {
    const reply = "Checked fn_task_search and fn_task_show.\n\nDUPLICATE: FN-42\n";
    expect(parseDuplicateMarkerFromSessionText(reply)).toEqual({ canonicalId: "FN-42" });
  });

  it("ignores a marker mentioned inside a sentence", () => {
    const reply = "I considered whether to emit DUPLICATE: FN-1 here but the scope differs, so I wrote a spec.";
    expect(parseDuplicateMarkerFromSessionText(reply)).toBeNull();
  });

  it("takes only the first marker when several ids are listed", () => {
    const reply = "DUPLICATE: FN-1\nDUPLICATE: FN-2\n";
    expect(parseDuplicateMarkerFromSessionText(reply)).toEqual({ canonicalId: "FN-1" });
  });

  it("tolerates wrappers, lowercase, and custom prefixes like the file parser", () => {
    expect(parseDuplicateMarkerFromSessionText("`duplicate: fn-7`")).toEqual({ canonicalId: "FN-7" });
    expect(parseDuplicateMarkerFromSessionText("**DUPLICATE: KB-8**")).toEqual({ canonicalId: "KB-8" });
  });

  it("returns null for empty or marker-free text", () => {
    expect(parseDuplicateMarkerFromSessionText("")).toBeNull();
    expect(parseDuplicateMarkerFromSessionText("   \n  ")).toBeNull();
    expect(parseDuplicateMarkerFromSessionText("Wrote the spec; not a duplicate.")).toBeNull();
  });
});
