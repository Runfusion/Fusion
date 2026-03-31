import { useState, useCallback, useEffect } from "react";
import type { TaskDetail, TaskCreateInput, Task, ThemeMode } from "@kb/core";
import { fetchConfig, fetchSettings, fetchAuthStatus, updateSettings, fetchModels } from "./api";
import type { ModelInfo } from "./api";
import { Header } from "./components/Header";
import { Board } from "./components/Board";
import { ListView } from "./components/ListView";
import { TaskDetailModal } from "./components/TaskDetailModal";
import { TerminalModal } from "./components/TerminalModal";
import { FileBrowserModal } from "./components/FileBrowserModal";
import { SettingsModal } from "./components/SettingsModal";
import { PlanningModeModal } from "./components/PlanningModeModal";
import type { SectionId } from "./components/SettingsModal";
import { ToastContainer } from "./components/ToastContainer";
import { GitHubImportModal } from "./components/GitHubImportModal";
import { GitManagerModal } from "./components/GitManagerModal";
import { UsageIndicator } from "./components/UsageIndicator";
import { NewTaskModal } from "./components/NewTaskModal";
import { ScheduledTasksModal } from "./components/ScheduledTasksModal";
import { ActivityLogModal } from "./components/ActivityLogModal";
import { useTasks } from "./hooks/useTasks";
import { ToastProvider, useToast } from "./hooks/useToast";
import { useTheme } from "./hooks/useTheme";

function AppInner() {
  const [newTaskModalOpen, setNewTaskModalOpen] = useState(false);
  const [isPlanningOpen, setIsPlanningOpen] = useState(false);
  const [planningInitialPlan, setPlanningInitialPlan] = useState<string | null>(null);
  const [detailTask, setDetailTask] = useState<TaskDetail | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [githubImportOpen, setGitHubImportOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId | undefined>(undefined);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [rootDir, setRootDir] = useState<string>(".");
  const [autoMerge, setAutoMerge] = useState(true);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [enginePaused, setEnginePaused] = useState(false);
  const [view, setView] = useState<"board" | "list">(() => {
    // Initialize from localStorage if available
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("kb-dashboard-view");
      if (saved === "list" || saved === "board") {
        return saved;
      }
    }
    return "board";
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, updateTask, duplicateTask, archiveTask, unarchiveTask, archiveAllDone } = useTasks();

  // Theme management
  const { themeMode, colorTheme, setThemeMode, setColorTheme } = useTheme();

  // Theme toggle handler: cycles Dark → Light → System → Dark
  const handleToggleTheme = useCallback(() => {
    const cycle: ThemeMode[] = ["dark", "light", "system"];
    const currentIndex = cycle.indexOf(themeMode);
    const nextMode = cycle[(currentIndex + 1) % cycle.length];
    setThemeMode(nextMode);
  }, [themeMode, setThemeMode]);

  useEffect(() => {
    fetchConfig()
      .then((cfg) => {
        setMaxConcurrent(cfg.maxConcurrent);
        setRootDir(cfg.rootDir);
      })
      .catch(() => {/* keep default */});
    fetchSettings()
      .then((s) => {
        setAutoMerge(!!s.autoMerge);
        setGlobalPaused(!!s.globalPause);
        setEnginePaused(!!s.enginePaused);
        setGithubTokenConfigured(!!s.githubTokenConfigured);
      })
      .catch(() => {/* keep default */});
    fetchAuthStatus()
      .then(({ providers }) => {
        if (providers.length > 0 && providers.every((p) => !p.authenticated)) {
          setSettingsOpen(true);
          setSettingsInitialSection("authentication");
        }
      })
      .catch(() => {/* fail silently — do not auto-open */});
  }, []);

  // Fetch available models
  useEffect(() => {
    fetchModels()
      .then((models) => setAvailableModels(models))
      .catch(() => {/* keep empty array on failure */});
  }, []);
  const { toasts, addToast, removeToast } = useToast();

  // Persist view preference to localStorage
  useEffect(() => {
    localStorage.setItem("kb-dashboard-view", view);
  }, [view]);

  const handleChangeView = useCallback((newView: "board" | "list") => {
    setView(newView);
  }, []);

  const handleNewTaskOpen = useCallback(() => setNewTaskModalOpen(true), []);
  const handleNewTaskClose = useCallback(() => setNewTaskModalOpen(false), []);

  const handleBoardQuickCreate = useCallback(
    async (input: TaskCreateInput): Promise<void> => {
      await createTask({ ...input, column: "triage" });
    },
    [createTask],
  );

  const handleModalCreate = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      const task = await createTask({ ...input, column: "triage" });
      return task;
    },
    [createTask],
  );

  // Planning mode handlers
  const handlePlanningOpen = useCallback(() => setIsPlanningOpen(true), []);
  const handlePlanningClose = useCallback(() => {
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, []);
  const handlePlanningTaskCreated = useCallback((task: Task) => {
    addToast(`Created ${task.id} from planning mode`, "success");
    setIsPlanningOpen(false);
    setPlanningInitialPlan(null);
  }, [addToast]);

  // Handle planning mode from new task dialog
  const handleNewTaskPlanningMode = useCallback((initialPlan: string) => {
    setPlanningInitialPlan(initialPlan);
    setIsPlanningOpen(true);
  }, []);

  // Usage indicator handlers
  const handleOpenUsage = useCallback(() => setUsageOpen(true), []);
  const handleCloseUsage = useCallback(() => setUsageOpen(false), []);

  // Schedules modal handlers
  const handleOpenSchedules = useCallback(() => setSchedulesOpen(true), []);
  const handleCloseSchedules = useCallback(() => setSchedulesOpen(false), []);

  const handleToggleAutoMerge = useCallback(async () => {
    const next = !autoMerge;
    setAutoMerge(next);
    try {
      await updateSettings({ autoMerge: next });
    } catch {
      setAutoMerge(!next); // revert on failure
    }
  }, [autoMerge]);

  const handleToggleGlobalPause = useCallback(async () => {
    const next = !globalPaused;
    setGlobalPaused(next);
    try {
      await updateSettings({ globalPause: next });
    } catch {
      setGlobalPaused(!next); // revert on failure
    }
  }, [globalPaused]);

  const handleToggleEnginePause = useCallback(async () => {
    const next = !enginePaused;
    setEnginePaused(next);
    try {
      await updateSettings({ enginePaused: next });
    } catch {
      setEnginePaused(!next); // revert on failure
    }
  }, [enginePaused]);

  const handleDetailOpen = useCallback((task: TaskDetail) => {
    setDetailTask(task);
  }, []);

  const handleDetailClose = useCallback(() => setDetailTask(null), []);

  const handleGitHubImport = useCallback((task: Task) => {
    addToast(`Imported ${task.id} from GitHub`, "success");
  }, [addToast]);

  const handleToggleTerminal = useCallback(() => {
    setTerminalOpen((prev) => !prev);
  }, []);

  const handleTerminalClose = useCallback(() => {
    setTerminalOpen(false);
  }, []);

  const handleToggleFiles = useCallback(() => {
    setFilesOpen((prev) => !prev);
  }, []);

  // Activity log handlers
  const handleOpenActivityLog = useCallback(() => setActivityLogOpen(true), []);
  const handleCloseActivityLog = useCallback(() => setActivityLogOpen(false), []);

  return (
    <>
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenGitHubImport={() => setGitHubImportOpen(true)}
        onOpenPlanning={handlePlanningOpen}
        onOpenUsage={handleOpenUsage}
        onOpenActivityLog={handleOpenActivityLog}
        onOpenSchedules={handleOpenSchedules}
        onToggleTerminal={handleToggleTerminal}
        onToggleFiles={handleToggleFiles}
        filesOpen={filesOpen}
        globalPaused={globalPaused}
        enginePaused={enginePaused}
        onToggleGlobalPause={handleToggleGlobalPause}
        onToggleEnginePause={handleToggleEnginePause}
        view={view}
        onChangeView={handleChangeView}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />
      {view === "board" ? (
        <Board
          tasks={tasks}
          maxConcurrent={maxConcurrent}
          onMoveTask={moveTask}
          onOpenDetail={handleDetailOpen}
          addToast={addToast}
          onQuickCreate={handleBoardQuickCreate}
          onNewTask={handleNewTaskOpen}
          autoMerge={autoMerge}
          onToggleAutoMerge={handleToggleAutoMerge}
          globalPaused={globalPaused}
          onUpdateTask={updateTask}
          onArchiveTask={archiveTask}
          onUnarchiveTask={unarchiveTask}
          onArchiveAllDone={archiveAllDone}
          searchQuery={searchQuery}
          availableModels={availableModels}
        />
      ) : (
        // List view now uses the same modal-based create flow as board view.
        <ListView
          tasks={tasks}
          onMoveTask={moveTask}
          onOpenDetail={handleDetailOpen}
          addToast={addToast}
          globalPaused={globalPaused}
          onNewTask={handleNewTaskOpen}
          onQuickCreate={handleBoardQuickCreate}
          availableModels={availableModels}
        />
      )}
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          tasks={tasks}
          onClose={handleDetailClose}
          onOpenDetail={handleDetailOpen}
          onMoveTask={moveTask}
          onDeleteTask={deleteTask}
          onMergeTask={mergeTask}
          onRetryTask={retryTask}
          onDuplicateTask={duplicateTask}
          addToast={addToast}
          githubTokenConfigured={githubTokenConfigured}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            setSettingsInitialSection(undefined);
          }}
          addToast={addToast}
          initialSection={settingsInitialSection}
          themeMode={themeMode}
          colorTheme={colorTheme}
          onThemeModeChange={setThemeMode}
          onColorThemeChange={setColorTheme}
        />
      )}
      <GitHubImportModal
        isOpen={githubImportOpen}
        onClose={() => setGitHubImportOpen(false)}
        onImport={handleGitHubImport}
        tasks={tasks}
      />
      <PlanningModeModal
        isOpen={isPlanningOpen}
        onClose={handlePlanningClose}
        onTaskCreated={handlePlanningTaskCreated}
        tasks={tasks}
        initialPlan={planningInitialPlan ?? undefined}
      />
      <TerminalModal
        isOpen={terminalOpen}
        onClose={handleTerminalClose}
      />
      {filesOpen && (
        <FileBrowserModal
          projectRoot={rootDir}
          isOpen={true}
          onClose={() => setFilesOpen(false)}
        />
      )}
      <UsageIndicator
        isOpen={usageOpen}
        onClose={handleCloseUsage}
      />
      {schedulesOpen && (
        <ScheduledTasksModal
          onClose={handleCloseSchedules}
          addToast={addToast}
        />
      )}
      <NewTaskModal
        isOpen={newTaskModalOpen}
        onClose={handleNewTaskClose}
        tasks={tasks}
        onCreateTask={handleModalCreate}
        addToast={addToast}
        onPlanningMode={handleNewTaskPlanningMode}
      />
      <ActivityLogModal
        isOpen={activityLogOpen}
        onClose={handleCloseActivityLog}
        tasks={tasks}
        onOpenTaskDetail={(taskId) => {
          const task = tasks.find((t) => t.id === taskId);
          if (task) {
            handleDetailOpen(task as TaskDetail);
          }
        }}
      />
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
