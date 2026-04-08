import { useCallback } from "react";
import { updateProject, unregisterProject } from "../api";
import type { ProjectInfo } from "../api";
import type { ViewMode } from "./useViewState";
import type { ToastType } from "./useToast";

interface UseProjectActionsOptions {
  setCurrentProject: (project: ProjectInfo) => void;
  clearCurrentProject: () => void;
  setViewMode: (mode: ViewMode) => void;
  currentProject: ProjectInfo | null;
  refreshProjects: () => Promise<void>;
  toggleFavoriteProvider: (provider: string) => Promise<void>;
  toggleFavoriteModel: (modelId: string) => Promise<void>;
  addToast: (message: string, type: ToastType) => void;
  openSettings: () => void;
  openSetupWizard: () => void;
  closeSetupWizard: () => void;
  closeModelOnboarding: () => void;
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
  const {
    setCurrentProject,
    clearCurrentProject,
    setViewMode,
    currentProject,
    refreshProjects,
    toggleFavoriteProvider,
    toggleFavoriteModel,
    addToast,
    openSettings,
    openSetupWizard,
    closeSetupWizard,
    closeModelOnboarding,
  } = options;

  const handleSelectProject = useCallback((project: ProjectInfo) => {
    setCurrentProject(project);
    setViewMode("project");
  }, [setCurrentProject, setViewMode]);

  const handleViewAllProjects = useCallback(() => {
    clearCurrentProject();
    setViewMode("overview");
  }, [clearCurrentProject, setViewMode]);

  const handleOpenSettings = useCallback(() => {
    openSettings();
  }, [openSettings]);

  const handleAddProject = useCallback(() => {
    openSetupWizard();
  }, [openSetupWizard]);

  const handleSetupComplete = useCallback((project: ProjectInfo) => {
    closeSetupWizard();
    setCurrentProject(project);
    setViewMode("project");
    addToast(`Project ${project.name} registered successfully`, "success");
    void refreshProjects();
  }, [closeSetupWizard, setCurrentProject, setViewMode, addToast, refreshProjects]);

  const handleModelOnboardingComplete = useCallback(() => {
    closeModelOnboarding();
  }, [closeModelOnboarding]);

  const handlePauseProject = useCallback(async (project: ProjectInfo) => {
    try {
      await updateProject(project.id, { status: "paused" });
      addToast(`Project ${project.name} paused`, "success");
      await refreshProjects();
    } catch {
      addToast(`Failed to pause project ${project.name}`, "error");
    }
  }, [addToast, refreshProjects]);

  const handleResumeProject = useCallback(async (project: ProjectInfo) => {
    try {
      await updateProject(project.id, { status: "active" });
      addToast(`Project ${project.name} resumed`, "success");
      await refreshProjects();
    } catch {
      addToast(`Failed to resume project ${project.name}`, "error");
    }
  }, [addToast, refreshProjects]);

  const handleRemoveProject = useCallback(async (project: ProjectInfo) => {
    try {
      await unregisterProject(project.id);
      addToast(`Project ${project.name} removed`, "success");

      if (currentProject?.id === project.id) {
        clearCurrentProject();
        setViewMode("overview");
      }

      await refreshProjects();
    } catch {
      addToast(`Failed to remove project ${project.name}`, "error");
    }
  }, [currentProject, clearCurrentProject, setViewMode, addToast, refreshProjects]);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    try {
      await toggleFavoriteProvider(provider);
    } catch {
      addToast("Failed to update favorites", "error");
    }
  }, [toggleFavoriteProvider, addToast]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    try {
      await toggleFavoriteModel(modelId);
    } catch {
      addToast("Failed to update model favorites", "error");
    }
  }, [toggleFavoriteModel, addToast]);

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
