import type { WorkflowIr, WorkflowIrArtifact } from "@fusion/core";

export const REQUIRED_ARTIFACT_MISSING_PREFIX = "required-artifact-missing:";

export function requiresNonEmptyWorkflowArtifact(artifact: WorkflowIrArtifact): boolean {
  return artifact.producedBy === "planning" || artifact.role === "step-source";
}

export function workflowEntryArtifacts(ir: WorkflowIr): WorkflowIrArtifact[] {
  const artifacts = "artifacts" in ir && Array.isArray(ir.artifacts) ? ir.artifacts : [];
  return artifacts.filter(requiresNonEmptyWorkflowArtifact);
}

export function requiredArtifactMissingValue(keys: readonly string[]): string {
  return `${REQUIRED_ARTIFACT_MISSING_PREFIX}${[...new Set(keys)].join(",")}`;
}

export function parseRequiredArtifactMissingValue(value: string | undefined): string[] | null {
  if (!value?.startsWith(REQUIRED_ARTIFACT_MISSING_PREFIX)) return null;
  const keys = value.slice(REQUIRED_ARTIFACT_MISSING_PREFIX.length)
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.length > 0 ? [...new Set(keys)] : null;
}
