/*
FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
Unit coverage for deterministic ## Original Description injection used by non-AI
generateSpecifiedPrompt and AI-planning finalize hygiene.
*/
import { describe, expect, it } from "vitest";
import {
  ORIGINAL_DESCRIPTION_HEADING,
  applyOriginalDescription,
  buildOriginalDescriptionSection,
} from "../original-description-policy.js";

const SAMPLE_DESC = "Fix the board blank state when autoMerge is off on mobile Android.";

function sampleSpec(opts?: { withOriginal?: boolean; originalBody?: string }): string {
  const original = opts?.withOriginal
    ? `${ORIGINAL_DESCRIPTION_HEADING}\n\n${opts.originalBody ?? "paraphrased planner text"}\n\n`
    : "";
  return `# Task: FN-1000 - Fix blank board

**Created:** 2026-07-14
**Size:** M

${original}## Before → After Transformation

- **Before:** blank board
- **After:** board shows tasks

## Mission

Implement the fix across desktop and mobile.
`;
}

describe("original description policy", () => {
  it("builds a section with a single trailing newline", () => {
    const section = buildOriginalDescriptionSection(SAMPLE_DESC);
    expect(section).toBe(`${ORIGINAL_DESCRIPTION_HEADING}\n\n${SAMPLE_DESC}\n`);
    expect(section.endsWith("\n")).toBe(true);
    expect(section.endsWith("\n\n")).toBe(false);
  });

  it("inserts ## Original Description after title/metadata and before other ## sections", () => {
    const injected = applyOriginalDescription(sampleSpec(), SAMPLE_DESC);

    const titleIdx = injected.indexOf("# Task: FN-1000");
    const originalIdx = injected.indexOf(ORIGINAL_DESCRIPTION_HEADING);
    const transformIdx = injected.indexOf("## Before → After Transformation");
    const missionIdx = injected.indexOf("## Mission");

    expect(titleIdx).toBeGreaterThan(-1);
    expect(originalIdx).toBeGreaterThan(titleIdx);
    expect(transformIdx).toBeGreaterThan(originalIdx);
    expect(missionIdx).toBeGreaterThan(transformIdx);
    expect(injected).toContain(SAMPLE_DESC);
    expect(injected.match(/## Original Description/g)).toHaveLength(1);
  });

  it("preserves the operator description verbatim including multi-line and markdown-like text", () => {
    const multi = [
      "Please fix ## Mission drift.",
      "",
      "Also handle:",
      "- empty state",
      "- **Created:** in body text",
    ].join("\n");

    const injected = applyOriginalDescription(sampleSpec(), multi);
    const start = injected.indexOf(ORIGINAL_DESCRIPTION_HEADING);
    const end = injected.indexOf("## Before → After Transformation");
    const section = injected.slice(start, end);
    expect(section).toContain(multi);
    // Verbatim body must not strip operator markdown-looking lines
    expect(section).toContain("Please fix ## Mission drift.");
    expect(section).toContain("- **Created:** in body text");
  });

  it("replaces a paraphrased Original Description with the verbatim task description", () => {
    const withParaphrase = sampleSpec({ withOriginal: true, originalBody: "planner rewrote this" });
    const injected = applyOriginalDescription(withParaphrase, SAMPLE_DESC);

    expect(injected).toContain(SAMPLE_DESC);
    expect(injected).not.toContain("planner rewrote this");
    expect(injected.match(/## Original Description/g)).toHaveLength(1);
  });

  it("is idempotent when the section already matches", () => {
    const once = applyOriginalDescription(sampleSpec(), SAMPLE_DESC);
    const twice = applyOriginalDescription(once, SAMPLE_DESC);
    expect(twice).toBe(once);
  });

  it("appends the section when the prompt has no ## headings", () => {
    const bare = "# FN-1: Title\n\nSome body without sections.\n";
    const injected = applyOriginalDescription(bare, SAMPLE_DESC);
    expect(injected).toContain(ORIGINAL_DESCRIPTION_HEADING);
    expect(injected).toContain(SAMPLE_DESC);
    expect(injected.indexOf(ORIGINAL_DESCRIPTION_HEADING)).toBeGreaterThan(injected.indexOf("# FN-1"));
  });

  it("returns empty input unchanged", () => {
    expect(applyOriginalDescription("", SAMPLE_DESC)).toBe("");
  });
});
