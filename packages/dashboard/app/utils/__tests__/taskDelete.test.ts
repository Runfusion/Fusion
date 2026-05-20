import { describe, expect, it } from "vitest";
import { extractDependencyDeleteConflict, extractLineageDeleteConflict } from "../taskDelete";

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

describe("extractLineageDeleteConflict", () => {
  it("returns lineage child ids from details.code payload", () => {
    const err = Object.assign(new Error("conflict"), {
      details: { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-3", "FN-4", 5] },
    });

    expect(extractLineageDeleteConflict(err)).toEqual({ lineageChildIds: ["FN-3", "FN-4"] });
  });

  it("returns null for missing details", () => {
    expect(extractLineageDeleteConflict(new Error("failed"))).toBeNull();
  });

  it("returns null for the wrong conflict code", () => {
    const err = Object.assign(new Error("conflict"), {
      details: { code: "TASK_HAS_DEPENDENTS", lineageChildIds: ["FN-3"] },
    });

    expect(extractLineageDeleteConflict(err)).toBeNull();
  });

  it("returns null when lineageChildIds is not an array", () => {
    const err = Object.assign(new Error("conflict"), {
      details: { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: "FN-3" },
    });

    expect(extractLineageDeleteConflict(err)).toBeNull();
  });

  it("returns null for non-Error inputs", () => {
    expect(extractLineageDeleteConflict(null)).toBeNull();
    expect(extractLineageDeleteConflict({ details: { code: "TASK_HAS_LINEAGE_CHILDREN", lineageChildIds: ["FN-3"] } })).toBeNull();
    expect(extractLineageDeleteConflict("boom")).toBeNull();
  });
});
