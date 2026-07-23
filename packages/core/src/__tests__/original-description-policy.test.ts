/*
FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
Unit coverage for deterministic ## Original Description injection used by non-AI
generateSpecifiedPrompt and AI-planning finalize hygiene.

FNXC:OriginalDescriptionInPrompt 2026-07-15-00:40:
Also covers embedded-H2 operator text so description updates cannot duplicate or
corrupt PROMPT.md when the raw request contains lines like `## Required behavior`.
*/
import { describe, expect, it } from "vitest";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_HEADING,
  ORIGINAL_DESCRIPTION_START_MARKER,
  applyOriginalDescription,
  buildOriginalDescriptionSection,
  extractOriginalDescriptionBody,
} from "../tasks/original-description-policy.js";

const SAMPLE_DESC = "Fix the board blank state when autoMerge is off on mobile Android.";

function sampleSpec(opts?: { withOriginal?: boolean; originalBody?: string; marked?: boolean }): string {
  let original = "";
  if (opts?.withOriginal) {
    const body = opts.originalBody ?? "paraphrased planner text";
    if (opts.marked) {
      original =
        `${ORIGINAL_DESCRIPTION_HEADING}\n\n` +
        `${ORIGINAL_DESCRIPTION_START_MARKER}\n` +
        `${body}\n` +
        `${ORIGINAL_DESCRIPTION_END_MARKER}\n\n`;
    } else {
      original = `${ORIGINAL_DESCRIPTION_HEADING}\n\n${body}\n\n`;
    }
  }
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
  it("builds a marked section with a single trailing newline", () => {
    const section = buildOriginalDescriptionSection(SAMPLE_DESC);
    expect(section).toContain(ORIGINAL_DESCRIPTION_START_MARKER);
    expect(section).toContain(ORIGINAL_DESCRIPTION_END_MARKER);
    expect(section).toContain(SAMPLE_DESC);
    expect(section.startsWith(`${ORIGINAL_DESCRIPTION_HEADING}\n\n`)).toBe(true);
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
    expect(extractOriginalDescriptionBody(injected)).toBe(SAMPLE_DESC);
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
    expect(extractOriginalDescriptionBody(injected)).toBe(multi);
    // Verbatim body must not strip operator markdown-looking lines
    expect(injected).toContain("Please fix ## Mission drift.");
    expect(injected).toContain("- **Created:** in body text");
  });

  it("replaces a paraphrased Original Description with the verbatim task description", () => {
    const withParaphrase = sampleSpec({ withOriginal: true, originalBody: "planner rewrote this" });
    const injected = applyOriginalDescription(withParaphrase, SAMPLE_DESC);

    expect(extractOriginalDescriptionBody(injected)).toBe(SAMPLE_DESC);
    expect(injected).not.toContain("planner rewrote this");
    expect(injected.match(/## Original Description/g)).toHaveLength(1);
  });

  it("is idempotent when the section already matches with markers", () => {
    const once = applyOriginalDescription(sampleSpec(), SAMPLE_DESC);
    const twice = applyOriginalDescription(once, SAMPLE_DESC);
    expect(twice).toBe(once);
  });

  it("appends the section when the prompt has no ## headings", () => {
    const bare = "# FN-1: Title\n\nSome body without sections.\n";
    const injected = applyOriginalDescription(bare, SAMPLE_DESC);
    expect(injected).toContain(ORIGINAL_DESCRIPTION_HEADING);
    expect(extractOriginalDescriptionBody(injected)).toBe(SAMPLE_DESC);
    expect(injected.indexOf(ORIGINAL_DESCRIPTION_HEADING)).toBeGreaterThan(injected.indexOf("# FN-1"));
  });

  it("returns empty input unchanged", () => {
    expect(applyOriginalDescription("", SAMPLE_DESC)).toBe("");
  });

  /*
  FNXC:OriginalDescriptionInPrompt 2026-07-15-00:40:
  Greptile P1: embedded H2 in the operator description must not end the section.
  A description update must replace the full body without leaving a duplicated suffix.
  */
  it("does not corrupt PROMPT.md when the description contains embedded ## headings", () => {
    const withEmbeddedH2 = [
      "Please keep this request intact.",
      "",
      "## Required behavior",
      "",
      "- blank board stays fixed",
      "- mobile Android included",
      "",
      "## Mission",
      "",
      "Note: this H2 is operator prose, not the PROMPT Mission section.",
    ].join("\n");

    // Planner-written section without markers, body already contains embedded H2s.
    const plannerWritten = sampleSpec({
      withOriginal: true,
      originalBody: withEmbeddedH2,
      marked: false,
    });

    // First apply pins markers and full body (including embedded ## Mission prose).
    const once = applyOriginalDescription(plannerWritten, withEmbeddedH2);
    expect(extractOriginalDescriptionBody(once)).toBe(withEmbeddedH2);
    expect(once).toContain(ORIGINAL_DESCRIPTION_START_MARKER);
    expect(once.match(/## Original Description/g)).toHaveLength(1);
    // One ## Mission inside the marked body + one structural PROMPT Mission section.
    expect(once.match(/^## Mission\s*$/gm)?.length).toBe(2);
    expect(once).toContain("## Before → After Transformation");
    // Structural Mission is outside the markers.
    const endMarkerIdx = once.indexOf(ORIGINAL_DESCRIPTION_END_MARKER);
    expect(once.indexOf("Implement the fix across desktop and mobile", endMarkerIdx)).toBeGreaterThan(
      endMarkerIdx,
    );

    // Description update (greptile corruption path): new text with more H2s.
    const updated = [
      withEmbeddedH2,
      "",
      "## Extra section from operator",
      "more text",
    ].join("\n");
    const twice = applyOriginalDescription(once, updated);
    expect(extractOriginalDescriptionBody(twice)).toBe(updated);
    expect(twice.match(/## Original Description/g)).toHaveLength(1);
    expect(twice.match(/^## Mission\s*$/gm)?.length).toBe(2);
    // No duplicated leftover suffix from the previous body.
    expect(twice.split("## Required behavior").length - 1).toBe(1);
    expect(twice.split("Note: this H2 is operator prose").length - 1).toBe(1);
    expect(twice.split("## Extra section from operator").length - 1).toBe(1);
  });

  it("treats unmarked planner sections ending at structural headings only", () => {
    const bodyWithUnknownH2 = "Intro\n\n## Required behavior\n\n- do the thing";
    const unmarked = sampleSpec({ withOriginal: true, originalBody: bodyWithUnknownH2, marked: false });
    // Extract must include ## Required behavior (not a structural heading).
    expect(extractOriginalDescriptionBody(unmarked)).toBe(bodyWithUnknownH2);
  });
});
