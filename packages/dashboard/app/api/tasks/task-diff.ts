/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Task diff and commit association client API peeled from legacy.ts.
 */
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

// ── Task Diff API ──────────────────────────────────────────────────────────

/** Task diff information */
export interface TaskDiff {
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    patch: string;
  }>;
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

/** Fetch diff for a task's changes */
export function fetchTaskDiff(taskId: string, worktree?: string, projectId?: string): Promise<TaskDiff> {
  const params = new URLSearchParams();
  if (worktree) params.set("worktree", worktree);
  if (projectId) params.set("projectId", projectId);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<TaskDiff>(`/tasks/${encodeURIComponent(taskId)}/diff${query}`);
}

export interface TaskCommitAssociationRow {
  commitSha: string;
  commitSubject: string;
  authoredAt: string;
  matchedBy: "canonical-lineage-trailer" | "legacy-task-id-trailer" | "legacy-subject" | "manual-reconciliation";
  confidence: "canonical" | "legacy" | "ambiguous";
  taskIdSnapshot: string;
  note?: string;
}

export interface TaskCommitAssociationsResponse {
  taskId: string;
  lineageId: string | null;
  associations: TaskCommitAssociationRow[];
}

/** Fetch lineage commit associations for a task */
export function fetchTaskCommitAssociations(taskId: string, projectId?: string): Promise<TaskCommitAssociationsResponse> {
  return api<TaskCommitAssociationsResponse>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/commit-associations`, projectId));
}

/** Individual file diff */
export interface TaskFileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  oldPath?: string;
}

/** Fetch file diffs for a task */
export function fetchTaskFileDiffs(taskId: string, projectId?: string): Promise<TaskFileDiff[]> {
  return api<TaskFileDiff[]>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/file-diffs`, projectId));
}
