/*
FNXC:ReviewLevelPreset 2026-07-19-10:20 (U8 / R6 / KTD-11):
Unit coverage for the reviewLevel creation-time preset mapper. The per-level step
sets are the R6 contract; the explicit-wins + colliding-id cases lock KTD-11
(preset ids flow through the same optional-group id pass-through the creation paths
use, so a preset id colliding with a legacy template id stays identity-stable).
*/
import { describe, expect, it } from "vitest";
import { resolveReviewLevelSteps, applyReviewLevelPreset } from "../review-level-preset.js";
import { PLAN_REVIEW_GROUP_ID } from "../builtin-plan-review-group.js";
import { CODE_REVIEW_GROUP_ID } from "../builtin-code-review-group.js";
import { BROWSER_VERIFICATION_GROUP_ID } from "../builtin-browser-verification-group.js";

type PresetInput = { reviewLevel?: number; enabledWorkflowSteps?: string[]; description?: string };
const preset = (input: PresetInput): PresetInput => applyReviewLevelPreset(input);

describe("resolveReviewLevelSteps — R6 level mapping", () => {
  it("level 0 → no optional groups", () => {
    expect(resolveReviewLevelSteps(0)).toEqual([]);
  });
  it("level 1 → code-review", () => {
    expect(resolveReviewLevelSteps(1)).toEqual([CODE_REVIEW_GROUP_ID]);
  });
  it("level 2 → plan-review + code-review", () => {
    expect(resolveReviewLevelSteps(2)).toEqual([PLAN_REVIEW_GROUP_ID, CODE_REVIEW_GROUP_ID]);
  });
  it("level 3 → plan-review + browser-verification + code-review", () => {
    expect(resolveReviewLevelSteps(3)).toEqual([
      PLAN_REVIEW_GROUP_ID,
      BROWSER_VERIFICATION_GROUP_ID,
      CODE_REVIEW_GROUP_ID,
    ]);
  });
  it("unknown / out-of-range levels map to the empty set (never silently enable a gate)", () => {
    expect(resolveReviewLevelSteps(99)).toEqual([]);
    expect(resolveReviewLevelSteps(-1)).toEqual([]);
  });
});

describe("applyReviewLevelPreset — normalization (explicit wins)", () => {
  it("derives enabledWorkflowSteps from reviewLevel when none is provided", () => {
    expect(preset({ reviewLevel: 2 }).enabledWorkflowSteps).toEqual([
      PLAN_REVIEW_GROUP_ID,
      CODE_REVIEW_GROUP_ID,
    ]);
  });

  it("leaves input untouched when reviewLevel is absent", () => {
    const input: PresetInput = { description: "x" };
    expect(preset(input)).toBe(input);
    expect(preset(input).enabledWorkflowSteps).toBeUndefined();
  });

  it("explicit enabledWorkflowSteps ALWAYS wins over reviewLevel (including explicit empty opt-out)", () => {
    expect(preset({ reviewLevel: 3, enabledWorkflowSteps: [CODE_REVIEW_GROUP_ID] }).enabledWorkflowSteps).toEqual([CODE_REVIEW_GROUP_ID]);
    // explicit [] is an opt-out and must survive the preset
    expect(preset({ reviewLevel: 3, enabledWorkflowSteps: [] }).enabledWorkflowSteps).toEqual([]);
  });

  it("does not mutate the argument", () => {
    const input: PresetInput = { reviewLevel: 1 };
    const out = preset(input);
    expect(out).not.toBe(input);
    expect((input as { enabledWorkflowSteps?: string[] }).enabledWorkflowSteps).toBeUndefined();
  });

  it("colliding id (KTD-11): a preset id equal to a legacy template id is passed through verbatim, not remapped", () => {
    // The preset emits the canonical optional-group ids as-is; the creation path's
    // resolveEnabledWorkflowSteps + optionalGroupIdSet pass-through keeps them
    // identity-stable. Here we assert the mapper never rewrites/aliases the id.
    const out = preset({ reviewLevel: 1 });
    expect(out.enabledWorkflowSteps).toEqual([CODE_REVIEW_GROUP_ID]);
    expect(out.enabledWorkflowSteps?.[0]).toBe("code-review");
  });
});
