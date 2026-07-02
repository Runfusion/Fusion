import type { GlobalSettings, ProjectSettings, Task, TaskGitLabTrackedItem, TaskStore } from "@fusion/core";
import { GitLabClient } from "./gitlab.js";
import { resolveGitlabAuth } from "./gitlab-auth.js";

export type GitLabLifecycleTarget = {
  kind: "project_issue" | "group_issue" | "merge_request";
  project: string | number;
  iid: number;
  label: string;
  url?: string;
};

export async function resolveGitLabClient(store: TaskStore): Promise<{ ok: true; client: GitLabClient } | { ok: false; message: string }> {
  const projectSettings = await store.getSettings() as ProjectSettings;
  const globalSettings = (await store.getGlobalSettingsStore?.()?.getSettings?.() ?? {}) as Partial<GlobalSettings>;
  const resolution = resolveGitlabAuth({ projectSettings, globalSettings });
  if (!resolution.ok) return { ok: false, message: resolution.message };
  return { ok: true, client: new GitLabClient(resolution.auth) };
}

export function resolveGitLabTarget(task: Pick<Task, "gitlabTracking" | "sourceIssue" | "source">): GitLabLifecycleTarget | null {
  const item = task.gitlabTracking?.item;
  if (item) return resolveGitLabTargetFromItem(item);

  const meta = task.source?.sourceMetadata && typeof task.source.sourceMetadata === "object"
    ? task.source.sourceMetadata as Record<string, unknown>
    : undefined;
  if (task.sourceIssue?.provider !== "gitlab" || !meta) return null;
  const kind = meta.resourceType === "merge_request" ? "merge_request" : meta.resourceType === "group_issue" ? "group_issue" : "project_issue";
  const iid = typeof meta.iid === "number" ? meta.iid : task.sourceIssue.issueNumber;
  const project = typeof meta.projectId === "number" ? meta.projectId : typeof meta.projectPath === "string" ? meta.projectPath : task.sourceIssue.repository;
  if (!Number.isInteger(iid) || !project) return null;
  return { kind, project, iid, label: formatGitLabTargetLabel(kind, project, iid), url: task.sourceIssue.url };
}

export function resolveGitLabTargetFromItem(item: TaskGitLabTrackedItem): GitLabLifecycleTarget | null {
  const project = item.projectId ?? item.projectPath;
  if (!project || !Number.isInteger(item.iid)) return null;
  return { kind: item.kind, project, iid: item.iid, label: formatGitLabTargetLabel(item.kind, project, item.iid), url: item.url };
}

export function formatGitLabTargetLabel(kind: GitLabLifecycleTarget["kind"], project: string | number, iid: number): string {
  const marker = kind === "merge_request" ? "!" : "#";
  return `${String(project)}${marker}${iid}`;
}

export async function safeLogGitLabEntry(store: TaskStore, taskId: string, message: string, details: string): Promise<void> {
  try {
    await store.logEntry(taskId, message, details);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes(`Task ${taskId} not found`)) {
      console.warn(`[gitlab-lifecycle] Unable to write log entry for deleted task ${taskId}: ${message}`);
      return;
    }
    throw error;
  }
}
