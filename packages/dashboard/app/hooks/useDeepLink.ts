import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("app");
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

  /*
   * FNXC:DeepLink 2026-07-03-09:50:
   * A project selected/created during onboarding is deep-linked via ?project=<id> before the projects
   * list has revalidated to include it, so an eager "Project not found" toast fired even though the
   * project loads a beat later (operator report: spurious error toast on onboarding project select).
   * Defer the not-found toast behind a grace window keyed to the pending param, and cancel it as soon
   * as the project appears in the list (the effect re-runs when `projects` changes). Only a project
   * that stays absent past the grace window yields the error.
   */
  const PROJECT_NOT_FOUND_GRACE_MS = 3000;
  const projectNotFoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectNotFoundPendingParamRef = useRef<string | null>(null);

  const clearProjectNotFoundTimer = useCallback(() => {
    if (projectNotFoundTimerRef.current !== null) {
      clearTimeout(projectNotFoundTimerRef.current);
      projectNotFoundTimerRef.current = null;
    }
    projectNotFoundPendingParamRef.current = null;
  }, []);

  // Cancel any pending not-found timer on unmount so it never toasts after teardown.
  useEffect(() => () => clearProjectNotFoundTimer(), [clearProjectNotFoundTimer]);

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
        // Arm the deferred not-found toast once per still-missing param; a freshly-created project
        // that arrives within the grace window cancels it via the matched branch below.
        if (
          projectNotFoundToastRef.current !== projectParam &&
          projectNotFoundPendingParamRef.current !== projectParam
        ) {
          clearProjectNotFoundTimer();
          projectNotFoundPendingParamRef.current = projectParam;
          projectNotFoundTimerRef.current = setTimeout(() => {
            addToast(t("deepLink.projectNotFound", "Project '{{id}}' not found", { id: projectParam }), "error");
            projectNotFoundToastRef.current = projectParam;
            projectNotFoundTimerRef.current = null;
            projectNotFoundPendingParamRef.current = null;
          }, PROJECT_NOT_FOUND_GRACE_MS);
        }
        return;
      }

      // Project is present now — cancel any pending not-found toast and clear the one-shot guard.
      clearProjectNotFoundTimer();
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
      clearProjectNotFoundTimer();
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
        addToast(t("deepLink.taskNotFound", "Task {{id}} not found", { id: taskId }), "error");
      });
  }, [
    projectId,
    projects,
    projectsLoading,
    currentProject,
    setCurrentProject,
    addToast,
    openTaskDetail,
    clearProjectNotFoundTimer,
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
