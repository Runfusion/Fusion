import { describe, expect, it } from "vitest";

import { primitiveNodeContext } from "../execution/runtime-primitives.js";
import { WorkflowPlanningService } from "../workflows/workflow-planning-service.js";

describe("WorkflowPlanningService", () => {
  it("preserves the graph pre-specified planning result", async () => {
    const service = new WorkflowPlanningService();

    const result = await service.runPlanningSession(
      primitiveNodeContext(
        { runId: "run-1", taskId: "FN-7303", workflowId: "builtin:coding" },
        { id: "planning", kind: "prompt" },
      ),
      { id: "FN-7303" } as never,
    );

    expect(result).toEqual({
      outcome: "success",
      value: "pre-specified",
      data: {
        approved: true,
        artifactKeys: [],
      },
    });
  });
});
