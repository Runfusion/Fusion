/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Task steer/spec revision client API peeled from legacy.ts.
 */

import type { Task } from "@fusion/core";
import { api } from "./client.js";
import { withProjectId } from "./health.js";

export function addSteeringComment(id: string, text: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/steer`, projectId), {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function requestSpecRevision(id: string, feedback: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/spec/revise`, projectId), {
    method: "POST",
    body: JSON.stringify({ feedback }),
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


