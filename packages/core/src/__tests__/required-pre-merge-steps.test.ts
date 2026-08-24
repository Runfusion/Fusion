import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";

describe("resolveRequiredPreMergeStepIds", () => {
  it("includes default-on pre-merge groups when no explicit selection exists", () => {
    expect(resolveRequiredPreMergeStepIds(BUILTIN_CODING_WORKFLOW_IR, undefined))
      .toEqual(new Set(["plan-review", "code-review"]));
  });

  it("honours an explicit empty selection and excludes post-merge groups", () => {
    expect(resolveRequiredPreMergeStepIds(BUILTIN_CODING_WORKFLOW_IR, [])).toEqual(new Set());
    expect(resolveRequiredPreMergeStepIds(
      BUILTIN_CODING_WORKFLOW_IR,
      ["post-merge-verification"],
    )).toEqual(new Set());
  });

  it("includes explicitly enabled pre-merge groups regardless of their default", () => {
    expect(resolveRequiredPreMergeStepIds(
      BUILTIN_CODING_WORKFLOW_IR,
      ["browser-verification"],
    )).toEqual(new Set(["browser-verification"]));
  });
});
