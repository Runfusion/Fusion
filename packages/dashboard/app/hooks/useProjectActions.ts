import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { pauseProject, resumeProject, unregisterProject } from "../api";
import type { ProjectInfo } from "../api";
import { replaceProjectIdInUrl } from "../utils/projectUrlState";
import type { ViewMode, TaskView } from "./useViewState";
import type { ToastType } from "./useToast";

interface UseProjectActionsOptions {
  setCurrentProject: (project: ProjectInfo) => void;
  clearCurrentProject: () => void;
  setViewMode: (mode: ViewMode) => void;
  setTaskView: (view: TaskView) => void;
  currentProject: ProjectInfo | null;
  refreshProjects: () => Promise<void>;
  toggleFavoriteProvider: (provider: string) => Promise<void>;
  toggleFavoriteModel: (modelId: string) => Promise<void>;
  addToast: (message: string, type: ToastType) => void;
  openSettings: () => void;
  openSetupWizard: () => void;
  closeSetupWizard: () => void;
  closeModelOnboarding: () => void;
  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  Every project-switch entry point (select, view-all, setup-complete) must dismiss
  modals scoped to the previous project so its task detail / planning payloads do not
  render over the newly selected project.
  */
  closeProjectScopedModals: () => void;
}

export interface UseProjectActionsResult {
  handleSelectProject: (project: ProjectInfo) => void;
  handleViewAllProjects: () => void;
  handleOpenSettings: () => void;
  handleAddProject: () => void;
  handleSetupComplete: (project: ProjectInfo) => void;
  handleModelOnboardingComplete: () => void;
  handlePauseProject: (project: ProjectInfo) => Promise<void>;
  handleResumeProject: (project: ProjectInfo) => Promise<void>;
  handleRemoveProject: (project: ProjectInfo) => Promise<void>;
  handleToggleFavorite: (provider: string) => Promise<void>;
  handleToggleModelFavorite: (modelId: string) => Promise<void>;
}

export function useProjectActions(options: UseProjectActionsOptions): UseProjectActionsResult {
  const { t } = useTranslation("app");
  const {
    setCurrentProject,
    clearCurrentProject,
    setViewMode,
    setTaskView,
    currentProject,
    refreshProjects,
    toggleFavoriteProvider,
    toggleFavoriteModel,
    addToast,
    openSettings,
    openSetupWizard,
    closeSetupWizard,
    closeModelOnboarding,
    closeProjectScopedModals,
  } = options;

  const handleSelectProject = useCallback((project: ProjectInfo) => {
    /*
    FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
    Swapping projects must not leave the previous project's modals (task detail, group,
    subtask, git manager, …) rendering over the new project. Re-selecting the already
    current project is a no-op navigation and must NOT dismiss whatever the user has open.
    */
    if (project.id !== currentProject?.id) {
      closeProjectScopedModals();
    }
    replaceProjectIdInUrl(project.id);
    setCurrentProject(project);
    setViewMode("project");
  }, [closeProjectScopedModals, currentProject?.id, setCurrentProject, setViewMode]);

  const handleViewAllProjects = useCallback(() => {
    closeProjectScopedModals();
    replaceProjectIdInUrl(null);
    clearCurrentProject();
    setViewMode("overview");
    setTaskView("command-center");
  }, [clearCurrentProject, closeProjectScopedModals, setViewMode, setTaskView]);

  const handleOpenSettings = useCallback(() => {
    openSettings();
  }, [openSettings]);

  const handleAddProject = useCallback(() => {
    openSetupWizard();
  }, [openSetupWizard]);

  const handleSetupComplete = useCallback((project: ProjectInfo) => {
    closeSetupWizard();
    if (project.id !== currentProject?.id) {
      closeProjectScopedModals();
    }
    replaceProjectIdInUrl(project.id);
    setCurrentProject(project);
    setViewMode("project");
    addToast(t("projects.setup.success", "Project {{name}} registered successfully", { name: project.name }), "success");
    void refreshProjects();
  }, [closeSetupWizard, closeProjectScopedModals, currentProject?.id, setCurrentProject, setViewMode, addToast, refreshProjects, t]);

  const handleModelOnboardingComplete = useCallback(() => {
    closeModelOnboarding();
  }, [closeModelOnboarding]);

  const handlePauseProject = useCallback(async (project: ProjectInfo) => {
    try {
      await pauseProject(project.id);
      addToast(t("projects.actions.pauseSuccess", "Project {{name}} paused", { name: project.name }), "success");
      await refreshProjects();
    } catch {
      addToast(t("projects.actions.pauseError", "Failed to pause project {{name}}", { name: project.name }), "error");
    }
  }, [addToast, refreshProjects, t]);

  const handleResumeProject = useCallback(async (project: ProjectInfo) => {
    try {
      await resumeProject(project.id);
      addToast(t("projects.actions.resumeSuccess", "Project {{name}} resumed", { name: project.name }), "success");
      await refreshProjects();
    } catch {
      addToast(t("projects.actions.resumeError", "Failed to resume project {{name}}", { name: project.name }), "error");
    }
  }, [addToast, refreshProjects, t]);

  const handleRemoveProject = useCallback(async (project: ProjectInfo) => {
    try {
      await unregisterProject(project.id);
      addToast(t("projects.actions.removeSuccess", "Project {{name}} removed", { name: project.name }), "success");

      if (currentProject?.id === project.id) {
        replaceProjectIdInUrl(null);
        clearCurrentProject();
        setViewMode("overview");
      }

      await refreshProjects();
    } catch {
      addToast(t("projects.actions.removeError", "Failed to remove project {{name}}", { name: project.name }), "error");
    }
  }, [currentProject, clearCurrentProject, setViewMode, addToast, refreshProjects, t]);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    try {
      await toggleFavoriteProvider(provider);
    } catch {
      addToast(t("projects.actions.favoritesError", "Failed to update favorites"), "error");
    }
  }, [toggleFavoriteProvider, addToast, t]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    try {
      await toggleFavoriteModel(modelId);
    } catch {
      addToast(t("projects.actions.modelFavoritesError", "Failed to update model favorites"), "error");
    }
  }, [toggleFavoriteModel, addToast, t]);

  return {
    handleSelectProject,
    handleViewAllProjects,
    handleOpenSettings,
    handleAddProject,
    handleSetupComplete,
    handleModelOnboardingComplete,
    handlePauseProject,
    handleResumeProject,
    handleRemoveProject,
    handleToggleFavorite,
    handleToggleModelFavorite,
  };
}
