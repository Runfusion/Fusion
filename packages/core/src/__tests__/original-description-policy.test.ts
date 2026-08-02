/*
FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
Unit coverage for deterministic ## Original Description injection used by non-AI
generateSpecifiedPrompt and AI-planning finalize hygiene.

FNXC:OriginalDescriptionInPrompt 2026-07-15-00:40:
Also covers embedded-H2 operator text so description updates cannot duplicate or
corrupt PROMPT.md when the raw request contains lines like `## Required behavior`.
*/
import { describe, expect, it } from "vitest";
import { computePlanApprovalFingerprint } from "../plan-approval.js";
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

  it("uses the first H2 for an unmarked section when operator text is unavailable", () => {
    const bodyWithUnknownH2 = "Intro\n\n## Required behavior\n\n- do the thing";
    const unmarked = sampleSpec({ withOriginal: true, originalBody: bodyWithUnknownH2, marked: false });
    expect(extractOriginalDescriptionBody(unmarked)).toBe("Intro");
  });

  it("preserves a custom section after an unmarked non-empty description", () => {
    const prompt = `# Task: FN-8659\n\n## Original Description\n\n${SAMPLE_DESC}\n\n## Product Overview\n\nCustom planner context.\n\n## Before → After Transformation\n\n- before\n`;
    const once = applyOriginalDescription(prompt, SAMPLE_DESC);

    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, SAMPLE_DESC)).toBe(once);
  });

  it("preserves a custom section after an unmarked empty description", () => {
    const prompt = "# Task: FN-8659\n\n## Original Description\n\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n";
    const once = applyOriginalDescription(prompt, "   ");

    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, "   ")).toBe(once);
  });

  it("preserves a custom section whose title collides with operator prose", () => {
    const description = "Operator context:\n## Product Overview\nKeep this as prose.";
    const prompt = `# Task: FN-8659\n\n## Original Description\n\n${description}\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n`;
    const once = applyOriginalDescription(prompt, description);

    expect(once).toContain(`${ORIGINAL_DESCRIPTION_START_MARKER}\n${description}\n${ORIGINAL_DESCRIPTION_END_MARKER}`);
    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("inserts Original Description above a leading custom section", () => {
    const prompt = "# Task: FN-8659\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n";
    const once = applyOriginalDescription(prompt, SAMPLE_DESC);

    expect(once.indexOf(ORIGINAL_DESCRIPTION_HEADING)).toBeLessThan(once.indexOf("## Product Overview"));
    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, SAMPLE_DESC)).toBe(once);
  });

  it("keeps marker-bounded sections unchanged", () => {
    const marked = sampleSpec({ withOriginal: true, originalBody: SAMPLE_DESC, marked: true });
    expect(applyOriginalDescription(marked, SAMPLE_DESC)).toBe(marked);
  });

  it("uses the allowlist-priority tiebreak after alignment failure", () => {
    const prompt = "# Task: FN-8659\n\n## Original Description\n\nPlanner rewrite has no matching opening line.\n\n## Mission\n\nEarlier lower-priority heading.\n\n## Before → After Transformation\n\nChosen by allowlist priority.\n";
    const once = applyOriginalDescription(prompt, "Operator opening line.");

    // FNXC:OriginalDescriptionInPrompt 2026-08-01-05:18: Historical priority selects the later
    // Before heading, so the earlier Mission remains in the unmarked body being replaced.
    expect(once).not.toContain("Earlier lower-priority heading.");
    expect(once).toContain("## Before → After Transformation\n\nChosen by allowlist priority.");
    expect(once.indexOf(ORIGINAL_DESCRIPTION_END_MARKER)).toBeLessThan(
      once.indexOf("## Before → After Transformation"),
    );
    expect(applyOriginalDescription(once, "Operator opening line.")).toBe(once);
  });

  it("does not trust unsafe partial alignment before an embedded operator H2", () => {
    const description = "Opening line.\n\n## Mission\n\nThis is operator prose.";
    const prompt = "# Task: FN-8659\n\n## Original Description\n\nOpening line.\n\nPlanner changed this line.\n\n## Mission\n\nThis is operator prose.\n\n## Product Overview\n\nCustom planner context.\n\n## Before → After Transformation\n\nStructural boundary.\n";
    const once = applyOriginalDescription(prompt, description);

    // The unmatched description still has an H2, so the legacy tiebreak—not Mission—sets the bound.
    expect(once.indexOf(ORIGINAL_DESCRIPTION_END_MARKER)).toBeLessThan(
      once.indexOf("## Before → After Transformation"),
    );
    expect(once).not.toContain("Planner changed this line.");
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("uses safe partial alignment after every embedded operator H2 was consumed", () => {
    const description = "Opening line.\n\n## Mission\n\nOperator prose after the H2.";
    const prompt = "# Task: FN-8659\n\n## Original Description\n\nOpening line.\n\n## Mission\n\nPlanner divergence after the embedded H2.\n\n## Product Overview\n\nCustom planner context.\n\n## Before → After Transformation\n\nStructural boundary.\n";
    const once = applyOriginalDescription(prompt, description);

    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(once.indexOf(ORIGINAL_DESCRIPTION_END_MARKER)).toBeLessThan(
      once.indexOf("## Product Overview"),
    );
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("keeps an embedded operator H2 inside the aligned body before a custom section", () => {
    const description = "Opening line.\n\n## Mission\n\nThis is operator prose.";
    const prompt = `# Task: FN-8659\n\n## Original Description\n\n${description}\n\n## Product Overview\n\nCustom planner context.\n\n## Before → After Transformation\n\nStructural boundary.\n`;
    const once = applyOriginalDescription(prompt, description);

    expect(extractOriginalDescriptionBody(once, description)).toBe(description);
    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("anchors insertion above a colliding leading custom heading", () => {
    const description = "Operator context:\n## Product Overview\nKeep this as prose.";
    const prompt = "# Task: FN-8659\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n";
    const once = applyOriginalDescription(prompt, description);

    expect(once.indexOf(ORIGINAL_DESCRIPTION_HEADING)).toBeLessThan(once.indexOf("## Product Overview"));
    expect(once).toContain("## Product Overview\n\nCustom planner context.");
    expect(applyOriginalDescription(once, description)).toBe(once);
  });

  it("keeps hygiene-before-fingerprint stable across a second pass", () => {
    const planner = `# Task: FN-8659\n\n## Original Description\n\n${SAMPLE_DESC}\n\n## Product Overview\n\nCustom planner context.\n\n## Mission\n\nShip it.\n`;
    const once = applyOriginalDescription(planner, SAMPLE_DESC);
    const twice = applyOriginalDescription(once, SAMPLE_DESC);

    expect(computePlanApprovalFingerprint(twice)).toBe(computePlanApprovalFingerprint(once));
    expect(twice).toBe(once);
  });
});
