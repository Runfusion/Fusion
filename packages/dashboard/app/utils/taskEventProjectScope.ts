/*
FNXC:TaskEventProjectScope 2026-09-01-06:16:
Dashboard task identity is `(projectId, taskId)`, even though core Task rows deliberately omit a
project field. Missing event identity is accepted for legacy and unscoped streams; only a known,
different project is foreign and must be discarded before it reaches client state.
*/
export function readTaskEventProjectId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const envelope = payload as { projectId?: unknown; task?: { projectId?: unknown } };
  return typeof envelope.projectId === "string"
    ? envelope.projectId
    : typeof envelope.task?.projectId === "string"
      ? envelope.task.projectId
      : undefined;
}

export function stripTaskEventProjectId<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const { projectId: _projectId, task, ...rest } = payload as Record<string, unknown>;
  return {
    ...rest,
    ...(task && typeof task === "object" && !Array.isArray(task)
      ? { task: stripTaskEventProjectId(task) }
      : task === undefined ? {} : { task }),
  } as T;
}

export function isForeignTaskEvent(eventProjectId: string | undefined, hookProjectId: string | undefined): boolean {
  return eventProjectId !== undefined && hookProjectId !== undefined && eventProjectId !== hookProjectId;
}
