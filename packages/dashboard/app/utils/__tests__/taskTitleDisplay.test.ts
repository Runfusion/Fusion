import { describe, expect, it } from "vitest";
import {
  MAX_DESCRIPTION_FALLBACK_LENGTH,
  getTaskTitleDisplay,
  getTaskTitleDisplayText,
} from "../taskTitleDisplay";

/*
FNXC:TaskTitleDisplay 2026-09-14-17:30:
FN-391 contract, asserted at the single seam every task label passes through: explicit title wins
and is never truncated here; a titleless task shows the first 220 characters of its description
EXACTLY (no suffix); an empty/blank description falls back to the ID so two tasks are still
distinguishable. The bound is read from the exported constant so a silent change to it fails here
rather than in a dozen component suites.
*/
describe("getTaskTitleDisplay", () => {
  it("fixes the description bound at 220 characters", () => {
    expect(MAX_DESCRIPTION_FALLBACK_LENGTH).toBe(220);
  });

  it("prefers a non-blank stored title and never truncates it", () => {
    const title = "t".repeat(500);
    const display = getTaskTitleDisplay({ id: "FN-1", title, description: "ignored" });

    expect(display.source).toBe("title");
    expect(display.text).toBe(title);
    expect(display.fullText).toBe(title);
    expect(display.isBoundedDescription).toBe(false);
  });

  it.each([
    { label: "undefined", title: undefined },
    { label: "null", title: null },
    { label: "whitespace", title: "   " },
  ])("falls back to the description for a $label title", ({ title }) => {
    const display = getTaskTitleDisplay({ id: "FN-2", title, description: "Description fallback" });

    expect(display.source).toBe("description");
    expect(display.text).toBe("Description fallback");
    expect(display.isBoundedDescription).toBe(false);
  });

  it.each([1, 5, 219, 220])("returns a %i-character description unchanged", (length) => {
    const description = "d".repeat(length);
    const display = getTaskTitleDisplay({ id: "FN-3", description });

    expect(display.text).toBe(description);
    expect(display.text).toHaveLength(length);
    expect(display.isBoundedDescription).toBe(false);
  });

  it.each([221, 400, 4000])("bounds a %i-character description to its exact prefix with no suffix", (length) => {
    const description = "d".repeat(length - 1) + "X";
    const display = getTaskTitleDisplay({ id: "FN-4", description });

    expect(display.text).toBe(description.slice(0, 220));
    expect(display.text).toHaveLength(220);
    expect(display.text.endsWith("...")).toBe(false);
    expect(display.text.endsWith("\u2026")).toBe(false);
    expect(display.fullText).toBe(description);
    expect(display.isBoundedDescription).toBe(true);
  });

  it("keeps the full description as tooltip text for a bounded label", () => {
    const description = `${"a".repeat(220)}TAIL`;
    const display = getTaskTitleDisplay({ id: "FN-5", description });

    expect(display.text).not.toContain("TAIL");
    expect(display.fullText).toContain("TAIL");
  });

  it.each([
    { label: "empty", description: "" },
    { label: "blank", description: "   " },
    { label: "undefined", description: undefined },
    { label: "null", description: null },
  ])("falls back to the task ID for a $label description", ({ description }) => {
    const display = getTaskTitleDisplay({ id: "FN-6", description });

    expect(display.source).toBe("id");
    expect(display.text).toBe("FN-6");
    expect(display.isBoundedDescription).toBe(false);
  });

  it("distinguishes two tasks sharing one long description by nothing but their ID fallback", () => {
    const shared = "s".repeat(500);
    expect(getTaskTitleDisplayText({ id: "FN-7", description: shared }))
      .toBe(getTaskTitleDisplayText({ id: "FN-8", description: shared }));
    expect(getTaskTitleDisplayText({ id: "FN-7", description: "" })).toBe("FN-7");
    expect(getTaskTitleDisplayText({ id: "FN-8", description: "" })).toBe("FN-8");
  });

  it("handles multiline descriptions without collapsing them", () => {
    const description = "First line\nSecond line";
    expect(getTaskTitleDisplayText({ id: "FN-9", description })).toBe(description);
  });
});
