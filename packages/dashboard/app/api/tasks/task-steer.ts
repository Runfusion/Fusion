/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Task steer/spec revision client API peeled from legacy.ts.
 */

import type { Task } from "@fusion/core";
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

export function addSteeringComment(id: string, text: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/steer`, projectId), {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function requestSpecRevision(
  id: string,
  feedback: string,
  projectId?: string,
  options?: { preservePlan?: boolean },
): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/spec/revise`, projectId), {
    method: "POST",
    body: JSON.stringify({ feedback, ...(options?.preservePlan === true ? { preservePlan: true } : {}) }),
  });
}

export function rebuildTaskSpec(id: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/spec/rebuild`, projectId), {
    method: "POST",
  });
}

export function refineTask(id: string, feedback: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/refine`, projectId), {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}

/*
FNXC:TaskFollowUp 2026-09-17-17:30:
FN-513 — request a FOLLOW-UP of a task that is still planning, running, or in review. Its own
endpoint rather than a flag on `refineTask`, so the historical Refine callers keep their exact route
and arguments. The server revalidates eligibility at submit; a stale menu therefore answers 409
rather than creating a child from a source that has already finished.
*/
export function followUpTask(id: string, feedback: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/follow-up`, projectId), {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}


