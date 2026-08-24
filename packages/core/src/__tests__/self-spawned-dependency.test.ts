import { describe, expect, it } from "vitest";
import { detectSelfSpawnedDependency } from "../task-store/errors.js";

describe("detectSelfSpawnedDependency", () => {
  it("identifies only dependencies spawned by the task", () => {
    expect(detectSelfSpawnedDependency("FN-1", [
      { id: "FN-CHILD", sourceParentTaskId: "FN-1" },
      { id: "FN-OTHER", sourceParentTaskId: "FN-2" },
    ])).toEqual({ dependencyId: "FN-CHILD" });
  });

  it("ignores missing and unrelated parent links", () => {
    expect(detectSelfSpawnedDependency("FN-1", [
      { id: "FN-NO-PARENT" },
      { id: "FN-OTHER", sourceParentTaskId: "FN-2" },
    ])).toBeNull();
  });
});
