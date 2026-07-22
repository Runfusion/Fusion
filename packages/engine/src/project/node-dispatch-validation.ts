export type NodeDispatchValidationResult =
  | { allowed: true }
  | { allowed: false; code: "missing-project-mapping"; reason: string };

export function validateProjectNodeMapping(params: {
  nodeId: string;
  mappedPath: string | undefined;
}): NodeDispatchValidationResult {
  const { nodeId, mappedPath } = params;
  if (typeof mappedPath !== "string" || mappedPath.trim().length === 0) {
    return {
      allowed: false,
      code: "missing-project-mapping",
      reason: `Execution blocked: project has no path mapping for node ${nodeId}`,
    };
  }

  return { allowed: true };
}
