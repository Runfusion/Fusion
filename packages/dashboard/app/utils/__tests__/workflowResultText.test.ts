import { describe, expect, it } from "vitest";
import {
  normalizeWorkflowResultText,
  workflowResultBodyParts,
  workflowResultTextsAreEquivalent,
} from "../workflowResultText";

describe("workflowResultText", () => {
  it("normalizes surrounding and repeated whitespace", () => {
    expect(normalizeWorkflowResultText("  one\n\t two  ")).toBe("one two");
  });

  it.each([
    [undefined, undefined],
    ["", ""],
    [" \n ", "\t"],
  ])("returns no body parts when both fields are blank", (output, notes) => {
    expect(workflowResultBodyParts(output, notes)).toEqual([]);
    expect(workflowResultTextsAreEquivalent(output, notes)).toBe(false);
  });

  it("keeps output when it is the only non-blank field", () => {
    expect(workflowResultBodyParts("  output  ", undefined)).toEqual(["output"]);
  });

  it("keeps notes when they are the only non-blank field", () => {
    expect(workflowResultBodyParts(undefined, "  notes  ")).toEqual(["notes"]);
  });

  it("collapses byte-identical fields", () => {
    expect(workflowResultBodyParts("same", "same")).toEqual(["same"]);
    expect(workflowResultTextsAreEquivalent("same", "same")).toBe(true);
  });

  it("collapses fields equivalent after whitespace normalization", () => {
    expect(workflowResultBodyParts("one\n two", " one   two ")).toEqual(["one\n two"]);
    expect(workflowResultTextsAreEquivalent("one\n two", " one   two ")).toBe(true);
  });

  it("keeps the output when it contains all notes text", () => {
    expect(workflowResultBodyParts("Context then resolution", "resolution")).toEqual(["Context then resolution"]);
  });

  it("keeps the notes when they contain all output text", () => {
    expect(workflowResultBodyParts("resolution", "Context then resolution")).toEqual(["Context then resolution"]);
  });

  it("keeps genuinely different fields in output-first order", () => {
    expect(workflowResultBodyParts("output detail", "review notes")).toEqual(["output detail", "review notes"]);
    expect(workflowResultTextsAreEquivalent("output detail", "review notes")).toBe(false);
  });
});
