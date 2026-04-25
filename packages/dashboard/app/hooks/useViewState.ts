import { useCallback, useEffect, useRef, useState } from "react";
import type { ThemeMode } from "@fusion/core";
import type { ProjectInfo } from "../api";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";

export type ViewMode = "overview" | "project";
export type TaskView = "board" | "list" | "agents" | "missions" | "chat" | "documents" | "roadmaps" | "skills" | "mailbox" | "insights" | "memory" | "devserver" | "dev-server";

const TASK_VIEWS: readonly TaskView[] = [
  "board",
  "list",
  "agents",
  "missions",
  "chat",
  "documents",
  "roadmaps",
  "skills",
  "mailbox",
  "insights",
  "memory",
  "devserver",
  "dev-server",
];

function isTaskView(value: string | null): value is TaskView {
  return value !== null && TASK_VIEWS.includes(value as TaskView);
}

function normalizeTaskView(value: TaskView): TaskView {
  return value === "devserver" ? "dev-server" : value;
}

interface UseViewStateOptions {
  projectsLoading: boolean;
  projectsError: string | null;
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
    projectsError,
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
    if (isTaskView(saved)) return saved;
    return "board";
  });
  const hasHydratedScopedTaskViewRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem("kb-dashboard-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    const saved = getScopedItem("kb-dashboard-task-view", currentProject?.id);
    if (isTaskView(saved)) {
      const preserveLegacyOnFirstScopedHydration =
        !hasHydratedScopedTaskViewRef.current && saved === "devserver";

      setTaskView(preserveLegacyOnFirstScopedHydration ? "devserver" : normalizeTaskView(saved));
    } else {
      setTaskView("board");
    }

    if (currentProject?.id) {
      hasHydratedScopedTaskViewRef.current = true;
    }
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
    if (projectsError) return;
    if (projectsLength > 0 || currentProject) return;

    const timer = window.setTimeout(() => {
      openSetupWizard();
    }, 500);

    return () => window.clearTimeout(timer);
  }, [
    projectsLoading,
    projectsError,
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
