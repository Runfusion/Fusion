import { describe, expect, it } from "vitest";

import {
  isWorkflowDefinitionIdPrimaryKeyCollision,
  maxWorkflowDefinitionSequence,
} from "../task-store/workflow-definitions.js";

describe("workflow definition id allocator helpers", () => {
  it("finds only numeric WF ids in the global occupancy set", () => {
    expect(maxWorkflowDefinitionSequence([])).toBe(0);
    expect(maxWorkflowDefinitionSequence(["WF-001", "WF-010", "custom-flow", "WF-abc"])).toBe(10);
  });

  it("accepts only workflow-id primary-key unique errors for retry", () => {
    expect(isWorkflowDefinitionIdPrimaryKeyCollision({
      code: "23505",
      constraint: "workflows_pkey",
    })).toBe(true);
    expect(isWorkflowDefinitionIdPrimaryKeyCollision(new Error("UNIQUE constraint failed: workflows.id"))).toBe(true);
    expect(isWorkflowDefinitionIdPrimaryKeyCollision({
      code: "23505",
      constraint: "some_other_unique",
    })).toBe(false);
    expect(isWorkflowDefinitionIdPrimaryKeyCollision(new Error("network unavailable"))).toBe(false);
  });
});
