import { describe, expect, it } from "vitest";
import { extractDependencyDeleteConflict } from "../taskDelete";

describe("extractDependencyDeleteConflict", () => {
  it("returns dependent ids from details.code payload", () => {
    const err = Object.assign(new Error("conflict"), {
      details: { code: "TASK_HAS_DEPENDENTS", dependentIds: ["FN-1", "FN-2", 3] },
    });

    expect(extractDependencyDeleteConflict(err)).toEqual({ dependentIds: ["FN-1", "FN-2"] });
  });

  it("returns null for missing or invalid details payload", () => {
    const missingDetails = new Error("failed");
    const invalidDetails = Object.assign(new Error("failed"), {
      details: { code: "TASK_HAS_DEPENDENTS", dependentIds: "FN-1" },
    });

    expect(extractDependencyDeleteConflict(missingDetails)).toBeNull();
    expect(extractDependencyDeleteConflict(invalidDetails)).toBeNull();
  });

  it("falls back to parsing ids from message", () => {
    const err = new Error("Cannot delete FN-22 because dependent tasks FN-100 and FN-101 block it; FN-100");

    expect(extractDependencyDeleteConflict(err)).toEqual({ dependentIds: ["FN-100", "FN-101"] });
  });

  it("returns null for non-Error inputs", () => {
    expect(extractDependencyDeleteConflict(null)).toBeNull();
    expect(extractDependencyDeleteConflict({ message: "FN-1 FN-2" })).toBeNull();
    expect(extractDependencyDeleteConflict("boom")).toBeNull();
  });
});
