/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage D — why every mutation context in this file is the MARKER):

This module runs UNATTENDED: a poll/reconcile sweep or a lifecycle hook reacting to an external event,
not a request anyone made. There is no session, no run and no acting agent to derive from, and the only
ids in scope name the task being reconciled — attributing to those would produce audit rows claiming a
task reconciled itself, the same false attribution the engine's self-healing sweeps refused in Stage A.

So each write carries the unattributed marker, counted by the U18 census and ratcheted DOWN.
Whether these lanes get a real SYSTEM actor is U13's decision; it is deliberately not made here.
*/
// FNXC:Identity 2026-08-09-03:04: one-line import on purpose — the U18 census counts any non-`import`-prefixed line naming the marker, so a multi-line import block would score as debt it is not.
import { UNATTRIBUTED_MUTATION_CONTEXT } from "@fusion/core";
import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-gitlab-lifecycle");
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

export type ResolveGitLabTargetOptions = {
  fallbackToSourceOnInvalidTracking?: boolean;
};

/*
FNXC:GitLabCloseOnDelete 2026-08-20-18:40:
Malformed tracking data is inert by default. Only ordinary task deletion opts into source fallback,
mirroring FN-8673's GitHub early-return fix without causing done-close, comment, tracking-state, or
ordinary lifecycle consumers to mutate GitLab items they previously left untouched.
*/
export function resolveGitLabTarget(
  task: Pick<Task, "gitlabTracking" | "sourceIssue" | "source">,
  options: ResolveGitLabTargetOptions = {},
): GitLabLifecycleTarget | null {
  const item = task.gitlabTracking?.item;
  if (item) {
    const trackingTarget = resolveGitLabTargetFromItem(item);
    if (trackingTarget) return trackingTarget;
    if (!options.fallbackToSourceOnInvalidTracking) return null;
  }

  const meta = task.source?.sourceMetadata && typeof task.source.sourceMetadata === "object"
    ? task.source.sourceMetadata as Record<string, unknown>
    : undefined;
  if (task.sourceIssue?.provider !== "gitlab") return null;
  const kind = meta?.resourceType === "merge_request" ? "merge_request" : meta?.resourceType === "group_issue" ? "group_issue" : "project_issue";
  const iid = typeof meta?.iid === "number" ? meta.iid : task.sourceIssue.issueNumber;
  const project = typeof meta?.projectId === "number" ? meta.projectId : typeof meta?.projectPath === "string" ? meta.projectPath : task.sourceIssue.repository;
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
    await store.logEntry(taskId, message, details, UNATTRIBUTED_MUTATION_CONTEXT);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes(`Task ${taskId} not found`)) {
      severityAuditLog.warn(`[gitlab-lifecycle] Unable to write log entry for deleted task ${taskId}: ${message}`);
      return;
    }
    throw error;
  }
}
