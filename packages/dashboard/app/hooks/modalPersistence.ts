import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";

// Storage keys — each modal type has independent storage
export const STORED_PLANNING_KEY = "kb-planning-last-description";
export const STORED_SUBTASK_KEY = "kb-subtask-last-description";
export const STORED_MISSION_KEY = "kb-mission-last-goal";
export const STORED_GITHUB_IMPORT_KEY = "kb-dashboard-github-import-state";

// Planning persistence

export function savePlanningDescription(description: string, projectId?: string): void {
  setScopedItem(STORED_PLANNING_KEY, description, projectId);
}

export function getPlanningDescription(projectId?: string): string {
  return getScopedItem(STORED_PLANNING_KEY, projectId) || "";
}

export function clearPlanningDescription(projectId?: string): void {
  removeScopedItem(STORED_PLANNING_KEY, projectId);
}

// Subtask persistence

export function saveSubtaskDescription(description: string, projectId?: string): void {
  setScopedItem(STORED_SUBTASK_KEY, description, projectId);
}

export function getSubtaskDescription(projectId?: string): string {
  return getScopedItem(STORED_SUBTASK_KEY, projectId) || "";
}

export function clearSubtaskDescription(projectId?: string): void {
  removeScopedItem(STORED_SUBTASK_KEY, projectId);
}

// Mission persistence

export function saveMissionGoal(goal: string, projectId?: string): void {
  setScopedItem(STORED_MISSION_KEY, goal, projectId);
}

export function getMissionGoal(projectId?: string): string {
  return getScopedItem(STORED_MISSION_KEY, projectId) || "";
}

export function clearMissionGoal(projectId?: string): void {
  removeScopedItem(STORED_MISSION_KEY, projectId);
}

// GitHub/GitLab import persistence

/*
FNXC:GitHubImport 2026-07-07-00:00:
The embedded Import Tasks view (`GitHubImportModal` rendered with `presentation="embedded"`, constant `isOpen={true}`) fully
unmounts when the user navigates to another main-content view and remounts from scratch on return, so its "reset state on
open" effect previously wiped provider/tab/filter/remote/selection every time. Persist ONLY the cheap, restorable fields
listed below (never the fetched issues/pulls/gitlab lists, loading flags, or detail caches — those re-derive via the
existing auto-load) per-project so returning to the view resumes where the user left off. First-time opens with no
persisted value must keep the existing default-remote auto-detect behavior untouched.
*/
export interface GitHubImportPersistedState {
  provider: "github" | "gitlab";
  activeTab: "issues" | "pulls";
  labels: string;
  selectedRemoteName: string;
  owner: string;
  repo: string;
  gitlabResource: "project_issue" | "group_issue" | "merge_request";
  gitlabProject: string;
  gitlabGroup: string;
  selectedIssueNumber: number | null;
  selectedPullNumber: number | null;
  selectedGitlabKey: string | null;
}

export function saveGitHubImportState(state: GitHubImportPersistedState, projectId?: string): void {
  try {
    setScopedItem(STORED_GITHUB_IMPORT_KEY, JSON.stringify(state), projectId);
  } catch {
    // Best-effort persistence; ignore storage failures (e.g. quota, disabled storage).
  }
}

/**
 * Reads and defensively re-shapes the persisted GitHub/GitLab import state.
 * Returns null when nothing is stored, or when the stored value is corrupt/not an object, so callers can fall back
 * to the existing reset/default-remote-auto-detect behavior exactly as before. Each field is individually validated
 * and defaulted so a partially-corrupt or schema-drifted blob still yields a usable (if partial) restore.
 */
export function getGitHubImportState(projectId?: string): GitHubImportPersistedState | null {
  try {
    const raw = getScopedItem(STORED_GITHUB_IMPORT_KEY, projectId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    return {
      provider: p.provider === "gitlab" ? "gitlab" : "github",
      activeTab: p.activeTab === "pulls" ? "pulls" : "issues",
      labels: typeof p.labels === "string" ? p.labels : "",
      selectedRemoteName: typeof p.selectedRemoteName === "string" ? p.selectedRemoteName : "",
      owner: typeof p.owner === "string" ? p.owner : "",
      repo: typeof p.repo === "string" ? p.repo : "",
      gitlabResource:
        p.gitlabResource === "group_issue" || p.gitlabResource === "merge_request" ? p.gitlabResource : "project_issue",
      gitlabProject: typeof p.gitlabProject === "string" ? p.gitlabProject : "",
      gitlabGroup: typeof p.gitlabGroup === "string" ? p.gitlabGroup : "",
      selectedIssueNumber: typeof p.selectedIssueNumber === "number" ? p.selectedIssueNumber : null,
      selectedPullNumber: typeof p.selectedPullNumber === "number" ? p.selectedPullNumber : null,
      selectedGitlabKey: typeof p.selectedGitlabKey === "string" ? p.selectedGitlabKey : null,
    };
  } catch {
    return null;
  }
}

export function clearGitHubImportState(projectId?: string): void {
  removeScopedItem(STORED_GITHUB_IMPORT_KEY, projectId);
}
