import { describe, expect, it } from "vitest";
import type { WorkflowIr } from "@fusion/core";
import {
  parseRequiredArtifactMissingValue,
  requiredArtifactMissingValue,
  workflowEntryArtifacts,
} from "../required-workflow-artifacts.js";

describe("required workflow artifact contracts", () => {
  it("treats planning-owned and step-source declarations as workflow-entry inputs", () => {
    const ir = {
      version: "v2",
      name: "artifact inputs",
      columns: [],
      nodes: [],
      edges: [],
      artifacts: [
        { key: "PROMPT.md", producedBy: "planning", role: "step-source" },
        { key: "manual-context", producedBy: "manual", role: "context" },
        { key: "steps", role: "step-source" },
      ],
    } as unknown as WorkflowIr;

    expect(workflowEntryArtifacts(ir).map((artifact) => artifact.key)).toEqual(["PROMPT.md", "steps"]);
  });

  it("round-trips a deduplicated typed missing-artifact failure", () => {
    const value = requiredArtifactMissingValue(["PROMPT.md", "PROMPT.md", "steps"]);
    expect(value).toBe("required-artifact-missing:PROMPT.md,steps");
    expect(parseRequiredArtifactMissingValue(value)).toEqual(["PROMPT.md", "steps"]);
    expect(parseRequiredArtifactMissingValue("failed")).toBeNull();
  });
});
