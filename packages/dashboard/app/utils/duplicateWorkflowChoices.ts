import type { BoardWorkflowsPayload } from "../api";

export interface DuplicateWorkflowChoices {
  options: Array<{ id: string; name: string }>;
  currentWorkflowId: string;
}

export function resolveDuplicateWorkflowChoices(
  payload: BoardWorkflowsPayload | null | undefined,
  taskId: string,
): DuplicateWorkflowChoices | null {
  if (!payload) return null;

  const options = payload.workflows
    .filter((workflow) => workflow.selectable !== false)
    .sort((a, b) => {
      if (a.id === payload.defaultWorkflowId) return -1;
      if (b.id === payload.defaultWorkflowId) return 1;
      return a.name.localeCompare(b.name);
    })
    .map(({ id, name }) => ({ id, name }));

  if (options.length < 2) return null;

  const selectableIds = new Set(options.map((option) => option.id));
  const taskWorkflowId = payload.taskWorkflowIds[taskId];
  const currentWorkflowId = taskWorkflowId && selectableIds.has(taskWorkflowId)
    ? taskWorkflowId
    : selectableIds.has(payload.defaultWorkflowId)
      ? payload.defaultWorkflowId
      : options[0].id;

  return { options, currentWorkflowId };
}
