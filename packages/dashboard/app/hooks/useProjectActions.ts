import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { pauseProject, resumeProject, unregisterProject } from "../api";
import type { ProjectInfo } from "../api";
import { replaceProjectIdInUrl } from "../utils/projectUrlState";
import type { ViewMode, TaskView } from "./useViewState";
import type { ToastType } from "./useToast";
import type { OnboardingCompletionOutcome } from "../components/ModelOnboardingModal";

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
  FNXC:GithubStarAsk 2026-08-19-03:59:
  Fired once onboarding is FINISHED (not dismissed) so the dashboard can make its one post-onboarding
  ask — currently the GitHub star prompt. The prompt owns its own "already asked" state; this hook
  only reports the moment.
  */
  onOnboardingCompleted?: () => void;
  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  Every project-switch entry point (select, view-all, setup-complete) must dismiss
  modals scoped to the previous project so its task detail / planning payloads do not
  render over the newly selected project.
  */
  closeProjectScopedModals: () => void;
  /** Guard project-scope destruction before any URL, project, view, or modal mutation. */
  requestCloseProjectScopedUi?: () => boolean | Promise<boolean>;
}

export interface UseProjectActionsResult {
  handleSelectProject: (project: ProjectInfo) => Promise<boolean>;
  handleViewAllProjects: () => Promise<boolean>;
  handleOpenSettings: () => void;
  handleAddProject: () => void;
  handleSetupComplete: (project: ProjectInfo) => Promise<boolean>;
  handleModelOnboardingComplete: (outcome?: OnboardingCompletionOutcome) => void;
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
    onOnboardingCompleted,
    requestCloseProjectScopedUi,
  } = options;

  const handleSelectProject = useCallback(async (project: ProjectInfo) => {
    /*
    FNXC:AlphaDesktopWindows 2026-09-11-19:35:
    A project boundary must await the shared destructive-close verdict before changing URL, project, view, or scoped modal state. Re-selecting the current project remains a synchronous-effect-free success.
    */
    if (project.id === currentProject?.id) return true;
    if (requestCloseProjectScopedUi && !await requestCloseProjectScopedUi()) return false;
    closeProjectScopedModals();
    replaceProjectIdInUrl(project.id);
    setCurrentProject(project);
    setViewMode("project");
    return true;
  }, [closeProjectScopedModals, currentProject?.id, requestCloseProjectScopedUi, setCurrentProject, setViewMode]);

  const handleViewAllProjects = useCallback(async () => {
    if (requestCloseProjectScopedUi && !await requestCloseProjectScopedUi()) return false;
    closeProjectScopedModals();
    replaceProjectIdInUrl(null);
    clearCurrentProject();
    setViewMode("overview");
    setTaskView("command-center");
    return true;
  }, [clearCurrentProject, closeProjectScopedModals, requestCloseProjectScopedUi, setViewMode, setTaskView]);

  const handleOpenSettings = useCallback(() => {
    openSettings();
  }, [openSettings]);

  const handleAddProject = useCallback(() => {
    openSetupWizard();
  }, [openSetupWizard]);

  const handleSetupComplete = useCallback(async (project: ProjectInfo) => {
    if (project.id !== currentProject?.id && requestCloseProjectScopedUi && !await requestCloseProjectScopedUi()) return false;
    closeSetupWizard();
    if (project.id !== currentProject?.id) closeProjectScopedModals();
    replaceProjectIdInUrl(project.id);
    setCurrentProject(project);
    setViewMode("project");
    addToast(t("projects.setup.success", "Project {{name}} registered successfully", { name: project.name }), "success");
    void refreshProjects();
    return true;
  }, [closeSetupWizard, closeProjectScopedModals, currentProject?.id, requestCloseProjectScopedUi, setCurrentProject, setViewMode, addToast, refreshProjects, t]);

  const handleModelOnboardingComplete = useCallback((outcome?: OnboardingCompletionOutcome) => {
    closeModelOnboarding();
    // FNXC:GithubStarAsk 2026-08-19-03:59: only a finished onboarding earns the star ask; a dismissal does not.
    if (outcome !== "dismissed") onOnboardingCompleted?.();
  }, [closeModelOnboarding, onOnboardingCompleted]);

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
      if (currentProject?.id === project.id && requestCloseProjectScopedUi && !await requestCloseProjectScopedUi()) return;
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
  }, [currentProject, requestCloseProjectScopedUi, clearCurrentProject, setViewMode, addToast, refreshProjects, t]);

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
