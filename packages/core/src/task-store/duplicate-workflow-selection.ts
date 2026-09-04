export type DuplicateWorkflowSelectionRejection = {
  rejection: "unknown-workflow";
  requestedWorkflowId: string;
};

export type DuplicateWorkflowSelectionResolution =
  | { workflowId?: string }
  | DuplicateWorkflowSelectionRejection;

export class DuplicateWorkflowSelectionError extends Error {
  readonly requestedWorkflowId: string;

  constructor(requestedWorkflowId: string) {
    super(`Workflow "${requestedWorkflowId}" is not available for task duplication`);
    this.name = "DuplicateWorkflowSelectionError";
    this.requestedWorkflowId = requestedWorkflowId;
  }
}

export function resolveDuplicateTargetWorkflowId({
  requestedWorkflowId,
  sourceWorkflowId,
  selectableWorkflowIds,
}: {
  requestedWorkflowId?: string | null;
  sourceWorkflowId?: string;
  selectableWorkflowIds: Iterable<string>;
}): DuplicateWorkflowSelectionResolution {
  const selectable = new Set(selectableWorkflowIds);
  const requested = requestedWorkflowId?.trim();

  if (requested) {
    return selectable.has(requested)
      ? { workflowId: requested }
      : { rejection: "unknown-workflow", requestedWorkflowId: requested };
  }

  if (sourceWorkflowId && selectable.has(sourceWorkflowId)) {
    return { workflowId: sourceWorkflowId };
  }

  return {};
}
