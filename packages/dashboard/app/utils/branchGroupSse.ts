/*
FNXC:BranchGroupDetails 2026-06-30-18:04:
Branch group summaries derive membership and landed completion from tasks, so dashboard subscribers refetch on each task lifecycle SSE event that can change those values.
*/
export const BRANCH_GROUP_REFRESH_TASK_EVENTS = ["task:created", "task:moved", "task:updated", "task:deleted", "task:merged"] as const;

export type BranchGroupRefreshTaskEvent = typeof BRANCH_GROUP_REFRESH_TASK_EVENTS[number];

export function shouldRefreshBranchGroupForTaskEvent(event: MessageEvent, projectId?: string): boolean {
  if (!projectId) return true;

  try {
    const payload = JSON.parse(event.data) as { projectId?: string; task?: { projectId?: string } };
    const payloadProjectId = payload.projectId ?? payload.task?.projectId;
    return !payloadProjectId || payloadProjectId === projectId;
  } catch {
    return true;
  }
}
