import { useCallback, useEffect, useState } from "react";
import type { ThemeMode } from "@fusion/core";
import type { ProjectInfo } from "../api";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";

export type ViewMode = "overview" | "project";
export type TaskView = "board" | "list" | "agents" | "missions" | "chat";

interface UseViewStateOptions {
  projectsLoading: boolean;
  currentProjectLoading: boolean;
  currentProject: ProjectInfo | null;
  projectsLength: number;
  setupWizardOpen: boolean;
  openSetupWizard: () => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
}

export interface UseViewStateResult {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  taskView: TaskView;
  setTaskView: (view: TaskView) => void;
  handleChangeTaskView: (newView: TaskView) => void;
  handleToggleTheme: () => void;
}

export function useViewState(options: UseViewStateOptions): UseViewStateResult {
  const {
    projectsLoading,
    currentProjectLoading,
    currentProject,
    projectsLength,
    setupWizardOpen,
    openSetupWizard,
    themeMode,
    setThemeMode,
  } = options;

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem("kb-dashboard-view-mode");
      if (saved === "overview" || saved === "project") return saved;
    }
    return "overview";
  });

  const [taskView, setTaskView] = useState<TaskView>(() => {
    const saved = getScopedItem("kb-dashboard-task-view");
    if (saved === "board" || saved === "list" || saved === "agents" || saved === "missions" || saved === "chat") return saved;
    return "board";
  });

  useEffect(() => {
    window.localStorage.setItem("kb-dashboard-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    const saved = getScopedItem("kb-dashboard-task-view", currentProject?.id);
    if (saved === "board" || saved === "list" || saved === "agents" || saved === "missions" || saved === "chat") {
      setTaskView(saved);
      return;
    }
    setTaskView("board");
  }, [currentProject?.id]);

  useEffect(() => {
    setScopedItem("kb-dashboard-task-view", taskView, currentProject?.id);
  }, [currentProject?.id, taskView]);

  useEffect(() => {
    if (projectsLoading || currentProjectLoading) return;

    if (currentProject && viewMode === "overview") {
      setViewMode("project");
    }
  }, [projectsLoading, currentProjectLoading, currentProject, viewMode]);

  useEffect(() => {
    if (projectsLoading || currentProjectLoading) return;
    if (setupWizardOpen) return;
    if (projectsLength > 0 || currentProject) return;

    const timer = window.setTimeout(() => {
      openSetupWizard();
    }, 500);

    return () => window.clearTimeout(timer);
  }, [
    projectsLoading,
    projectsLength,
    currentProjectLoading,
    currentProject,
    setupWizardOpen,
    openSetupWizard,
  ]);

  const handleChangeTaskView = useCallback((newView: TaskView) => {
    setTaskView(newView);
  }, []);

  const handleToggleTheme = useCallback(() => {
    const cycle: ThemeMode[] = ["dark", "light", "system"];
    const currentIndex = cycle.indexOf(themeMode);
    const nextMode = cycle[(currentIndex + 1) % cycle.length];
    setThemeMode(nextMode);
  }, [themeMode, setThemeMode]);

  return {
    viewMode,
    setViewMode,
    taskView,
    setTaskView,
    handleChangeTaskView,
    handleToggleTheme,
  };
}
