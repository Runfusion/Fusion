import { describe, expect, it } from "vitest";
import { resolveDuplicateTargetWorkflowId } from "../task-store/duplicate-workflow-selection.js";

const selectableWorkflowIds = ["wf-a", "wf-b"];

describe("resolveDuplicateTargetWorkflowId", () => {
  it("uses an explicitly requested selectable workflow", () => {
    expect(resolveDuplicateTargetWorkflowId({
      requestedWorkflowId: "wf-b",
      sourceWorkflowId: "wf-a",
      selectableWorkflowIds,
    })).toEqual({ workflowId: "wf-b" });
  });

  it("rejects an explicitly requested unknown workflow", () => {
    expect(resolveDuplicateTargetWorkflowId({
      requestedWorkflowId: "wf-retired",
      sourceWorkflowId: "wf-a",
      selectableWorkflowIds,
    })).toEqual({ rejection: "unknown-workflow", requestedWorkflowId: "wf-retired" });
  });

  it("treats a blank explicit request as absent", () => {
    expect(resolveDuplicateTargetWorkflowId({
      requestedWorkflowId: "  ",
      sourceWorkflowId: "wf-a",
      selectableWorkflowIds,
    })).toEqual({ workflowId: "wf-a" });
  });

  it("inherits a selectable source workflow", () => {
    expect(resolveDuplicateTargetWorkflowId({
      sourceWorkflowId: "wf-a",
      selectableWorkflowIds,
    })).toEqual({ workflowId: "wf-a" });
  });

  it("falls back to the project default when the source workflow is not selectable", () => {
    expect(resolveDuplicateTargetWorkflowId({
      sourceWorkflowId: "wf-disabled",
      selectableWorkflowIds,
    })).toEqual({});
  });

  it("falls back to the project default when the source has no workflow", () => {
    expect(resolveDuplicateTargetWorkflowId({ selectableWorkflowIds })).toEqual({});
  });
});
