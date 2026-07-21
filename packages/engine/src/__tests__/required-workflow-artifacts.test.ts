import { describe, expect, it } from "vitest";
import type { WorkflowIr } from "@fusion/core";
import {
  parseRequiredArtifactMissingValue,
  requiredArtifactMissingValue,
  isRequiredArtifactReadFailedValue,
  requiredArtifactReadFailedValue,
  workflowEntryArtifacts,
} from "../required-workflow-artifacts.js";

// FNXC:WorkflowArtifacts 2026-07-21-17:00: This suite locks the typed missing/read
// distinction and the non-empty planning/step-source contract used by every gate.
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

  it("keeps storage-read failures distinct from confirmed missing artifacts", () => {
    const value = requiredArtifactReadFailedValue("PROMPT.md");
    expect(value).toBe("required-artifact-read-failed:PROMPT.md");
    expect(isRequiredArtifactReadFailedValue(value)).toBe(true);
    expect(parseRequiredArtifactMissingValue(value)).toBeNull();
  });

  it("round-trips a deduplicated typed missing-artifact failure", () => {
    const value = requiredArtifactMissingValue([" PROMPT.md ", "PROMPT.md", "steps"]);
    expect(value).toBe("required-artifact-missing:PROMPT.md,steps");
    expect(parseRequiredArtifactMissingValue(value)).toEqual(["PROMPT.md", "steps"]);
    expect(parseRequiredArtifactMissingValue("failed")).toBeNull();
  });

  it("rejects an empty missing-artifact payload instead of emitting an unparsable value", () => {
    expect(() => requiredArtifactMissingValue(["", "   "])).toThrow("At least one required artifact key is needed");
  });
});
