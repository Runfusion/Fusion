import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findGeneratedOriginalDescriptionEnd,
  stripGeneratedOriginalDescription,
} from "../tasks/original-description-region.js";
import {
  ORIGINAL_DESCRIPTION_END_MARKER,
  ORIGINAL_DESCRIPTION_START_MARKER,
} from "../tasks/original-description-policy.js";

const heading = "## Original Description";

function marked(body: string, successor = ""): string {
  return [heading, "", ORIGINAL_DESCRIPTION_START_MARKER, body, ORIGINAL_DESCRIPTION_END_MARKER, successor]
    .filter((line, index) => line !== "" || index > 0)
    .join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("generated Original Description region", () => {
  it.each([
    "## What This Delivers\n\n- Clear operator value.",
    "## Before → After Transformation\n\n- Before: old.\n- After: new.",
    "## Review Level: 2 (Plan and Code)",
    "## Mission\n\nBuild safely.",
    "",
  ])("accepts a generated end marker before %s", (successor) => {
    const prompt = marked("Operator request.", successor ? `\n${successor}` : "");
    const start = prompt.indexOf(ORIGINAL_DESCRIPTION_START_MARKER);
    expect(findGeneratedOriginalDescriptionEnd(prompt, start)).toBe(prompt.indexOf(ORIGINAL_DESCRIPTION_END_MARKER));
  });

  it("rejects an unknown successor heading and warns without exposing prompt content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = marked("Operator request.", "\n## Why\n\nOperator-owned context.");

    expect(findGeneratedOriginalDescriptionEnd(prompt, prompt.indexOf(ORIGINAL_DESCRIPTION_START_MARKER))).toBe(-1);
    expect(stripGeneratedOriginalDescription(prompt)).toBe(prompt);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("## Why");
    expect(warn.mock.calls[0]?.[0]).not.toContain("Operator-owned context.");
  });

  it("warns when a start marker has no end marker", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = `${heading}\n\n${ORIGINAL_DESCRIPTION_START_MARKER}\nOperator request.\n## Mission`;

    expect(stripGeneratedOriginalDescription(prompt)).toBe(prompt);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("## Mission");
  });

  it("strips an empty marked body before a known successor without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = marked("", "\n## What This Delivers\n\n- Value.");

    expect(stripGeneratedOriginalDescription(prompt)).toBe("\n\n## What This Delivers\n\n- Value.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the bounded generated end marker when operator prose contains a literal marker", () => {
    const prompt = marked(
      `Literal ${ORIGINAL_DESCRIPTION_END_MARKER} remains operator prose.\n\n## Do NOT\n\nOperator constraint.`,
      "\n## What This Delivers\n\n- Value.",
    );

    expect(stripGeneratedOriginalDescription(prompt)).toBe("\n\n## What This Delivers\n\n- Value.");
  });

  it("leaves unmarked legacy prompts untouched without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prompt = "## Original Description\n\nLegacy prose.\n\n## Mission\n\nBuild safely.";

    expect(stripGeneratedOriginalDescription(prompt)).toBe(prompt);
    expect(warn).not.toHaveBeenCalled();
  });
});
