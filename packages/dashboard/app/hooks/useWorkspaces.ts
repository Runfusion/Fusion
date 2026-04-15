import { useEffect, useState } from "react";
import { fetchWorkspaces, type WorkspaceTaskInfo } from "../api";

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

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspaces() {
      try {
        const response = await fetchWorkspaces(projectId);
        if (cancelled) {
          return;
        }

        setProjectName(getProjectName(response.project));
        setWorkspaces(response.tasks.map(mapTaskWorkspace));
        setError(null);
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message || "Failed to load workspaces");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadWorkspaces();
    const intervalId = window.setInterval(() => {
      void loadWorkspaces();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [projectId]);

  return {
    projectName,
    workspaces,
    loading,
    error,
  };
}
