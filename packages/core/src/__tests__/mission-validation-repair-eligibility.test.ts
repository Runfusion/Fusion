import { describe, expect, it } from "vitest";
import { featureValidationRepairEligibility } from "../missions/mission-types.js";

describe("featureValidationRepairEligibility", () => {
  it("permits clearing only stale blocked badges and unvalidated passed markers", () => {
    expect(featureValidationRepairEligibility({ status: "defined", loopState: "blocked" })).toEqual({ clear: true, reRun: true });
    expect(featureValidationRepairEligibility({ status: "defined", loopState: "needs_fix" })).toEqual({ clear: true, reRun: true });
    expect(featureValidationRepairEligibility({ status: "blocked", loopState: "idle" })).toEqual({ clear: true, reRun: true });
    expect(featureValidationRepairEligibility({ status: "done", loopState: "passed", lastValidatorStatus: "passed" })).toEqual({ clear: true, reRun: false });
    expect(featureValidationRepairEligibility({ status: "done", loopState: "passed", lastValidatorStatus: "passed", lastValidatorRunId: "MVR-001" })).toEqual({ clear: false, reRun: false });
    for (const loopState of ["idle", "implementing", "validating"] as const) {
      expect(featureValidationRepairEligibility({ status: "defined", loopState })).toEqual({ clear: false, reRun: false });
    }
  });
});
