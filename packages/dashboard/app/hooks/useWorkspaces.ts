import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "@fusion/core";
import { fetchWorkspaces, type WorkspaceTaskInfo } from "../api";
import { useVisibilityAwarePoll } from "./visibilitySuspension";

export interface WorkspaceInfo {
  id: string;
  label: string;
  title?: string;
  worktree?: string;
  kind: "project" | "task";
}

interface UseWorkspacesReturn {
  projectName: string;
  workspaces: WorkspaceInfo[];
  loading: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 10000;

function getProjectName(projectPath: string): string {
  const normalized = projectPath.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || projectPath || "Project Root";
}

function mapTaskWorkspace(task: WorkspaceTaskInfo): WorkspaceInfo {
  return {
    id: task.id,
    label: task.id,
    title: task.title,
    worktree: task.worktree,
    kind: "task",
  };
}

/**
 * Fetch and poll the list of available file browser workspaces.
 */
export function useWorkspaces(projectId?: string): UseWorkspacesReturn {
  const [projectName, setProjectName] = useState("Project Root");
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic context version: bumped whenever the mounted projectId scope changes or the hook unmounts, so
  // a response from a superseded scope can never overwrite the current one (replaces the previous
  // effect-local `cancelled` flag, which no longer exists now that the poll lives outside the effect).
  const contextVersionRef = useRef(0);

  const loadWorkspaces = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;
    const isStale = () => contextVersionRef.current !== versionAtStart;
    try {
      const response = await fetchWorkspaces(projectId);
      if (isStale()) {
        return;
      }

      setProjectName(getProjectName(response.project));
      setWorkspaces(response.tasks.map(mapTaskWorkspace));
      setError(null);
    } catch (err) {
      if (!isStale()) {
        setError(getErrorMessage(err) || "Failed to load workspaces");
      }
    } finally {
      if (!isStale()) {
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    void loadWorkspaces();
    return () => {
      contextVersionRef.current += 1;
    };
  }, [loadWorkspaces]);

  /*
  FNXC:MobileTabRetention 2026-07-26-10:38:
  Workspace listing polling is suspended while the document is hidden. Continuous background fetches are a
  primary reason mobile browsers discard the dashboard tab (the returning user then sees a white-splash cold
  reload); the hidden -> visible edge reloads once so the workspace list is current when looked at.
  */
  useVisibilityAwarePoll(loadWorkspaces, POLL_INTERVAL_MS);

  return {
    projectName,
    workspaces,
    loading,
    error,
  };
}
