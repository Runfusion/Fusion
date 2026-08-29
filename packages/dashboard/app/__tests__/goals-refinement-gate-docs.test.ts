import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_TRIGGER_EVIDENCE = [
  "Operator friction",
  "Prompt-budget or context-window pressure from goal injection",
  "Unclear prioritization or unclear mission ↔ goal ownership",
  "Free-text success-metric limitations that fail agent reasoning",
  "The hard 5-active-goal cap proving too tight",
  "Reporting or visibility gaps",
] as const;

const REQUIRED_ACTIVATION_RULE_SNIPPETS = [
  "written rationale",
  "real usage evidence",
  "FN-5963 conditional refinement trigger evidence pack/template",
  "`fn_slice_activate` for `SL-MP32LAJW-0009-RHJQ`",
] as const;

const REQUIRED_NO_AUTOMATIC_REFINEMENT_SNIPPETS = [
  "does **not** authorize automatic follow-on work",
  "No structured `successMetric` schema work starts automatically.",
  "No focus-set concept starts automatically.",
  "No reporting or visibility expansion starts automatically.",
  "Without the written rationale and evidence trigger above, Slice 4 remains pending and unspecified.",
] as const;

describe("Goals refinement gate doc", () => {
  it("documents the evidence categories, written-rationale activation rule, and no-auto-refinement constraint", () => {
    const doc = readFileSync(
      resolve(__dirname, "../../../../docs/goals-refinement-gate.md"),
      "utf-8",
    );

    expect(doc).toContain("# Goals Refinement Gate");
    expect(doc).toContain("[← Docs index](./README.md)");

    for (const snippet of REQUIRED_TRIGGER_EVIDENCE) {
      expect(doc).toContain(snippet);
    }

    for (const snippet of REQUIRED_ACTIVATION_RULE_SNIPPETS) {
      expect(doc).toContain(snippet);
    }

    for (const snippet of REQUIRED_NO_AUTOMATIC_REFINEMENT_SNIPPETS) {
      expect(doc).toContain(snippet);
    }
  });
});
