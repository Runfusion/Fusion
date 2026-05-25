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

  // Guard against StrictMode double-effect path rewrites.
  const pathRewroteRef = useRef(false);

  // Track whether the currently open detail modal came from a deep-link.
  const deepLinkTaskIdRef = useRef<string | null>(null);

  // Avoid duplicate not-found toasts in StrictMode double-effect runs.
  const projectNotFoundToastRef = useRef<string | null>(null);

  // Ensure project switching from ?project= only happens once per project value.
  const projectSwitchAppliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pathRewroteRef.current) {
      const pathMatch = window.location.pathname.match(/^\/tasks\/([A-Z]+-\d+)\/?$/);
      if (pathMatch) {
        const taskIdFromPath = pathMatch[1];
        if (/^[A-Z]+-\d+$/.test(taskIdFromPath)) {
          const params = new URLSearchParams(window.location.search);
          params.set("task", taskIdFromPath);
          const query = params.toString();
          const existingState = window.history.state ?? {};
          window.history.replaceState(existingState, "", query ? `/?${query}` : "/");
          pathRewroteRef.current = true;
        }
      }
    }

    const params = new URLSearchParams(window.location.search);
    const projectParam = params.get("project");
    const taskId = params.get("task");

    if (projectsLoading) return;

    let taskProjectId = projectId;

    if (projectParam) {
      const matchingProject = projects.find((project) => project.id === projectParam);
      if (!matchingProject) {
        if (projectNotFoundToastRef.current !== projectParam) {
          addToast(`Project '${projectParam}' not found`, "error");
          projectNotFoundToastRef.current = projectParam;
        }
        return;
      }

      projectNotFoundToastRef.current = null;
      taskProjectId = matchingProject.id;

      if (
        currentProject?.id !== matchingProject.id
        && projectSwitchAppliedRef.current !== matchingProject.id
      ) {
        setCurrentProject(matchingProject);
        projectSwitchAppliedRef.current = matchingProject.id;
      }
    } else {
      projectNotFoundToastRef.current = null;
      projectSwitchAppliedRef.current = null;
    }

    if (!taskId) return;

    if (deepLinkFetchedRef.current) return;
    deepLinkFetchedRef.current = true;

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
      const existingState = window.history.state ?? {};
      window.history.replaceState(
        existingState,
        "",
        query ? `${window.location.pathname}?${query}` : window.location.pathname,
      );
      deepLinkTaskIdRef.current = null;
    }

    closeTaskDetail();
  }, [closeTaskDetail]);

  return { handleDetailClose };
}
