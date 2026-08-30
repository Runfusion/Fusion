import { describe, expect, it } from "vitest";
import { restoreOptionalStepsOnFastExit } from "../fastModeOptionalSteps";

describe("restoreOptionalStepsOnFastExit", () => {
  it("returns a populated baseline in its original order and ignores default-on ids", () => {
    const baseline = ["code-review", "plan-review"];
    const currentEnabledIds = ["code-review"];
    const defaultOnIds = ["browser-verification"];

    expect(restoreOptionalStepsOnFastExit(baseline, currentEnabledIds, defaultOnIds)).toEqual([
      "code-review",
      "plan-review",
    ]);
    expect(baseline).toEqual(["code-review", "plan-review"]);
    expect(currentEnabledIds).toEqual(["code-review"]);
    expect(defaultOnIds).toEqual(["browser-verification"]);
  });

  it("uses default-on ids when no trustworthy pre-Fast baseline exists", () => {
    expect(restoreOptionalStepsOnFastExit(null, [], ["code-review", "plan-review"])).toEqual([
      "code-review",
      "plan-review",
    ]);
  });

  it("treats an empty baseline as an explicit selection rather than a default-on fallback", () => {
    expect(restoreOptionalStepsOnFastExit([], ["manual-smoke"], ["code-review"])).toEqual([
      "manual-smoke",
    ]);
  });

  it("deduplicates ids shared by the baseline and Fast-mode selection", () => {
    expect(restoreOptionalStepsOnFastExit(["code-review"], ["code-review"], [])).toEqual([
      "code-review",
    ]);
  });

  it("appends Fast-mode additions after the restored baseline", () => {
    expect(
      restoreOptionalStepsOnFastExit(
        ["code-review", "plan-review"],
        ["browser-verification", "manual-smoke"],
        [],
      ),
    ).toEqual(["code-review", "plan-review", "browser-verification", "manual-smoke"]);
  });

  it("returns an empty selection for all-empty inputs", () => {
    expect(restoreOptionalStepsOnFastExit([], [], [])).toEqual([]);
  });
});
