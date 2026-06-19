import { useCallback, useEffect, useRef, useState } from "react";
import type { ThemeMode } from "@fusion/core";
import type { ProjectInfo } from "../api";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";
import { getPluginViewId, isPluginViewId, isPluginViewRegistered } from "../plugins/pluginViewRegistry";

export type ViewMode = "overview" | "project";
export type BuiltInTaskView = "board" | "list" | "graph" | "agents" | "missions" | "chat" | "documents" | "research" | "evals" | "goalsView" | "skills" | "mailbox" | "insights" | "memory" | "command-center" | "secrets" | "devserver" | "dev-server" | "stash-recovery" | "pull-requests";
export type PluginTaskView = `plugin:${string}:${string}`;
export type TaskView = BuiltInTaskView | PluginTaskView;

const BUILT_IN_TASK_VIEWS: readonly BuiltInTaskView[] = [
  "board",
  "list",
  "graph",
  "agents",
  "missions",
  "chat",
  "documents",
  "research",
  "evals",
  "goalsView",

  "skills",
  "mailbox",
  "insights",
  "memory",
  "command-center",
  "secrets",
  "devserver",
  "dev-server",
  "stash-recovery",
  "pull-requests",
];

function isBuiltInTaskView(value: string | null): value is BuiltInTaskView {
  return value !== null && BUILT_IN_TASK_VIEWS.includes(value as BuiltInTaskView);
}

function isTaskView(value: string | null): value is TaskView {
  return value !== null && (isBuiltInTaskView(value) || isPluginViewId(value));
}

const LEGACY_ROADMAPS_PLUGIN_VIEW = getPluginViewId("fusion-plugin-roadmap", "roadmaps");

function normalizeTaskView(value: TaskView): TaskView {
  return value === "devserver" ? "dev-server" : value;
}

function migrateLegacyRoadmapsView(value: string): TaskView {
  if (value !== "roadmaps") {
    return "board";
  }
  return isPluginViewRegistered("fusion-plugin-roadmap", "roadmaps") ? LEGACY_ROADMAPS_PLUGIN_VIEW : "board";
}

/*
FNXC:ViewState 2026-06-19-00:00:
FN-6702 removed the top-level Reliability task view after moving the page into Command Center. Persisted or linked legacy `reliability` values must land users on `command-center` instead of falling back to the board or becoming invalid.
*/
function migrateLegacyReliabilityView(value: string | null): TaskView | null {
  return value === "reliability" ? "command-center" : null;
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
    const legacyReliabilityView = migrateLegacyReliabilityView(saved);
    if (legacyReliabilityView) return legacyReliabilityView;
    if (saved === "roadmaps") return migrateLegacyRoadmapsView(saved);
    if (isTaskView(saved)) return saved;
    return "board";
  });
  const hasHydratedScopedTaskViewRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem("kb-dashboard-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    const saved = getScopedItem("kb-dashboard-task-view", currentProject?.id);
    const legacyReliabilityView = migrateLegacyReliabilityView(saved);
    if (legacyReliabilityView) {
      setTaskView(legacyReliabilityView);
    } else if (saved === "roadmaps") {
      setTaskView(migrateLegacyRoadmapsView(saved));
    } else if (isTaskView(saved)) {
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
    if (typeof window === "undefined") {
      return;
    }

    const viewParam = new URLSearchParams(window.location.search).get("view");
    const legacyReliabilityView = migrateLegacyReliabilityView(viewParam);
    if (legacyReliabilityView) {
      setTaskView(legacyReliabilityView);
    } else if (viewParam && isTaskView(viewParam)) {
      setTaskView(normalizeTaskView(viewParam));
    }
  }, []);

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
