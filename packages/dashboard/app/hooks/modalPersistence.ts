import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";

// Storage keys — each modal type has independent storage
export const STORED_PLANNING_KEY = "kb-planning-last-description";
export const STORED_PLANNING_ACTIVE_SESSION_KEY = "kb-planning-active-session";
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

/*
FNXC:PlanningMode 2026-07-20-12:00:
Embedded Planning unmounts whenever main-content navigation leaves its view. FN-8437 keeps the last active interview id project-scoped, matching Chat's active-session persistence, so a return during generation can rehydrate through the modal's single loadSession path.
*/
export function savePlanningActiveSession(sessionId: string, projectId?: string): void {
  setScopedItem(STORED_PLANNING_ACTIVE_SESSION_KEY, sessionId, projectId);
}

export function getPlanningActiveSession(projectId?: string): string {
  return getScopedItem(STORED_PLANNING_ACTIVE_SESSION_KEY, projectId) || "";
}

export function clearPlanningActiveSession(projectId?: string): void {
  removeScopedItem(STORED_PLANNING_ACTIVE_SESSION_KEY, projectId);
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
  /*
  FNXC:GitHubImport 2026-07-15-16:30:
  Hide imported is a per-project view preference: it filters already-imported candidates without persisting fetched data or changing import state.
  */
  hideImported?: boolean;
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
      hideImported: typeof p.hideImported === "boolean" ? p.hideImported : undefined,
    };
  } catch {
    return null;
  }
}

export function clearGitHubImportState(projectId?: string): void {
  removeScopedItem(STORED_GITHUB_IMPORT_KEY, projectId);
}

// Command Center / Dev Server cheap-view persistence

/*
FNXC:CommandCenter 2026-07-22-13:40:
FN remount-churn fix R12: CommandCenter fully unmounts on main-content navigation (it is intentionally NOT kept alive), so its cheap UI state — active sub-tab and date range — persists per project like the GitHub import state above. Only restorable selection state is stored; fetched analytics re-derive on remount. A fresh project (nothing stored) keeps today's defaults, and an unknown/removed tab id falls back to overview at the consumer.
*/
export const STORED_COMMAND_CENTER_KEY = "kb-dashboard-command-center-state";

export interface CommandCenterPersistedState {
  activeTab: string;
  range: { from: string | null; to: string | null; preset: string };
}

export function saveCommandCenterState(state: CommandCenterPersistedState, projectId?: string): void {
  try {
    setScopedItem(STORED_COMMAND_CENTER_KEY, JSON.stringify(state), projectId);
  } catch {
    // Best-effort persistence; ignore storage failures.
  }
}

export function getCommandCenterState(projectId?: string): CommandCenterPersistedState | null {
  try {
    const raw = getScopedItem(STORED_COMMAND_CENTER_KEY, projectId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    const range = p.range as Record<string, unknown> | undefined;
    if (typeof p.activeTab !== "string" || !range || typeof range !== "object" || typeof range.preset !== "string") return null;
    return {
      activeTab: p.activeTab,
      range: {
        from: typeof range.from === "string" ? range.from : null,
        to: typeof range.to === "string" ? range.to : null,
        preset: range.preset,
      },
    };
  } catch {
    return null;
  }
}

/*
FNXC:DevServer 2026-07-22-13:40:
FN remount-churn fix R12: DevServerView also unmounts on navigation; the selected script/task target and a typed-but-unsent command survive the round-trip per project. Log pagination/scroll intentionally does not persist (logs re-derive live). A fresh project gets defaults.
*/
export const STORED_DEV_SERVER_KEY = "kb-dashboard-dev-server-state";

export interface DevServerPersistedState {
  selectedScript: string | null;
  selectedTaskId: string | null;
  commandInput: string;
}

export function saveDevServerState(state: DevServerPersistedState, projectId?: string): void {
  try {
    setScopedItem(STORED_DEV_SERVER_KEY, JSON.stringify(state), projectId);
  } catch {
    // Best-effort persistence; ignore storage failures.
  }
}

export function getDevServerState(projectId?: string): DevServerPersistedState | null {
  try {
    const raw = getScopedItem(STORED_DEV_SERVER_KEY, projectId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    return {
      selectedScript: typeof p.selectedScript === "string" ? p.selectedScript : null,
      selectedTaskId: typeof p.selectedTaskId === "string" ? p.selectedTaskId : null,
      commandInput: typeof p.commandInput === "string" ? p.commandInput : "",
    };
  } catch {
    return null;
  }
}
