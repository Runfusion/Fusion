/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * GitLab import client API peeled from legacy.ts.
 */

import type { Task } from "@fusion/core";
import { api } from "./client.js";
import { withProjectId } from "./health.js";

// --- GitLab Import API ---

export interface GitLabImportItem {
  resourceKind: "project_issue" | "group_issue" | "merge_request";
  id?: number;
  iid: number;
  projectId?: number;
  projectPath?: string;
  groupId?: number | string;
  groupPath?: string;
  title: string;
  description: string | null;
  webUrl: string;
  state: string;
  author?: { username?: string; name?: string } | null;
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  commentsCount?: number;
  sourceBranch?: string;
  targetBranch?: string;
  draft?: boolean;
}

export function apiFetchGitLabProjectIssues(project: string, limit?: number, labels?: string[], state?: string): Promise<GitLabImportItem[]> {
  return api<GitLabImportItem[]>("/gitlab/project/issues/fetch", { method: "POST", body: JSON.stringify({ project, limit, labels, state }) });
}

export function apiFetchGitLabGroupIssues(group: string, limit?: number, labels?: string[], state?: string): Promise<GitLabImportItem[]> {
  return api<GitLabImportItem[]>("/gitlab/group/issues/fetch", { method: "POST", body: JSON.stringify({ group, limit, labels, state }) });
}

export function apiFetchGitLabMergeRequests(project: string, limit?: number, labels?: string[], state?: string): Promise<GitLabImportItem[]> {
  return api<GitLabImportItem[]>("/gitlab/merge-requests/fetch", { method: "POST", body: JSON.stringify({ project, limit, labels, state }) });
}

export function apiImportGitLabProjectIssue(project: string, iid: number, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/gitlab/project/issues/import", projectId), { method: "POST", body: JSON.stringify({ project, iid }) });
}

export function apiImportGitLabGroupIssue(issue: GitLabImportItem, group?: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/gitlab/group/issues/import", projectId), { method: "POST", body: JSON.stringify({ issue, group }) });
}

export function apiImportGitLabMergeRequest(project: string, iid: number, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId("/gitlab/merge-requests/import", projectId), { method: "POST", body: JSON.stringify({ project, iid }) });
}

export function apiBatchImportGitLab(items: Array<Record<string, unknown>>, projectId?: string): Promise<{ results: Array<{ success: boolean; taskId?: string; error?: string; iid?: number }> }> {
  return api<{ results: Array<{ success: boolean; taskId?: string; error?: string; iid?: number }> }>(withProjectId("/gitlab/batch-import", projectId), { method: "POST", body: JSON.stringify({ items }) });
}

