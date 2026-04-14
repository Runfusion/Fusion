import { useCallback, useEffect, useRef } from "react";
import type { TaskDetail } from "@fusion/core";
import { fetchTaskDetail, type ProjectInfo } from "../api";
import type { ToastType } from "./useToast";

interface UseDeepLinkOptions {
  projectId?: string;
  projects: ProjectInfo[];
  projectsLoading: boolean;
  currentProject: ProjectInfo | null;
  setCurrentProject: (project: ProjectInfo) => void;
  addToast: (message: string, type?: ToastType) => void;
  openTaskDetail: (task: TaskDetail) => void;
  closeTaskDetail: () => void;
}

export interface UseDeepLinkResult {
  /**
   * Call when the task detail modal closes.
   * Cleans ?task=... from URL if the modal was opened via deep-link.
   */
  handleDetailClose: () => void;
}

/**
 * Handles task deep-link behavior (?project=...&task=...).
 */
export function useDeepLink(options: UseDeepLinkOptions): UseDeepLinkResult {
  const {
    projectId,
    projects,
    projectsLoading,
    currentProject,
    setCurrentProject,
    addToast,
    openTaskDetail,
    closeTaskDetail,
  } = options;

  // Prevent duplicate fetches when project switching causes the effect to re-run.
  const deepLinkFetchedRef = useRef(false);

  // Track whether the currently open detail modal came from a deep-link.
  const deepLinkTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectParam = params.get("project");
    const taskId = params.get("task");

    if (!taskId) return;
    if (projectsLoading) return;

    if (projectParam) {
      const matchingProject = projects.find((project) => project.id === projectParam);
      if (!matchingProject) {
        addToast(`Project '${projectParam}' not found`, "error");
        return;
      }

      if (currentProject?.id !== matchingProject.id) {
        setCurrentProject(matchingProject);
      }
    }

    if (deepLinkFetchedRef.current) return;
    deepLinkFetchedRef.current = true;

    const taskProjectId = projectParam ?? projectId;
    fetchTaskDetail(taskId, taskProjectId)
      .then((detail) => {
        openTaskDetail(detail);
        deepLinkTaskIdRef.current = taskId;
      })
      .catch(() => {
        addToast(`Task ${taskId} not found`, "error");
      });
  }, [
    projectId,
    projects,
    projectsLoading,
    currentProject,
    setCurrentProject,
    addToast,
    openTaskDetail,
    // deepLinkFetchedRef intentionally excluded - it's a mutable ref, not state
  ]);

  const handleDetailClose = useCallback(() => {
    if (deepLinkTaskIdRef.current) {
      const params = new URLSearchParams(window.location.search);
      params.delete("task");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        query ? `${window.location.pathname}?${query}` : window.location.pathname,
      );
      deepLinkTaskIdRef.current = null;
    }

    closeTaskDetail();
  }, [closeTaskDetail]);

  return { handleDetailClose };
}
