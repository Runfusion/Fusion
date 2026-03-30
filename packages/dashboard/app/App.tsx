import { useState, useCallback, useEffect } from "react";
import type { TaskDetail, TaskCreateInput, Task } from "@kb/core";
import { fetchConfig, fetchSettings, fetchAuthStatus, updateSettings } from "./api";
import { Header } from "./components/Header";
import { Board } from "./components/Board";
import { ListView } from "./components/ListView";
import { TaskDetailModal } from "./components/TaskDetailModal";
import { TerminalModal } from "./components/TerminalModal";
import { SettingsModal } from "./components/SettingsModal";
import type { SectionId } from "./components/SettingsModal";
import { ToastContainer } from "./components/ToastContainer";
import { GitHubImportModal } from "./components/GitHubImportModal";
import { GitManagerModal } from "./components/GitManagerModal";
import { useTasks } from "./hooks/useTasks";
import { ToastProvider, useToast } from "./hooks/useToast";

function AppInner() {
  const [isCreating, setIsCreating] = useState(false);
  const [detailTask, setDetailTask] = useState<TaskDetail | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [githubImportOpen, setGitHubImportOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId | undefined>(undefined);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
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
  const [githubTokenConfigured, setGithubTokenConfigured] = useState(false);
  const { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask, updateTask, duplicateTask, archiveTask, unarchiveTask } = useTasks();

  useEffect(() => {
    fetchConfig()
      .then((cfg) => setMaxConcurrent(cfg.maxConcurrent))
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
  const { toasts, addToast, removeToast } = useToast();

  // Persist view preference to localStorage
  useEffect(() => {
    localStorage.setItem("kb-dashboard-view", view);
  }, [view]);

  const handleChangeView = useCallback((newView: "board" | "list") => {
    setView(newView);
  }, []);

  const handleCreateOpen = useCallback(() => setIsCreating(true), []);
  const handleCancelCreate = useCallback(() => setIsCreating(false), []);

  const handleCreateTask = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      const task = await createTask({ ...input, column: "triage" });
      setIsCreating(false);
      return task;
    },
    [createTask],
  );

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

  // Filter tasks to get only in-progress tasks for terminal
  const inProgressTasks = tasks.filter((t) => t.column === "in-progress");
  return (
    <>
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenGitHubImport={() => setGitHubImportOpen(true)}
        onToggleTerminal={handleToggleTerminal}
        inProgressCount={inProgressTasks.length}
        globalPaused={globalPaused}
        enginePaused={enginePaused}
        onToggleGlobalPause={handleToggleGlobalPause}
        onToggleEnginePause={handleToggleEnginePause}
        view={view}
        onChangeView={handleChangeView}
      />
      {view === "board" ? (
        <Board
          tasks={tasks}
          maxConcurrent={maxConcurrent}
          onMoveTask={moveTask}
          onOpenDetail={handleDetailOpen}
          addToast={addToast}
          isCreating={isCreating}
          onCancelCreate={handleCancelCreate}
          onCreateTask={handleCreateTask}
          onNewTask={handleCreateOpen}
          autoMerge={autoMerge}
          onToggleAutoMerge={handleToggleAutoMerge}
          globalPaused={globalPaused}
          onUpdateTask={updateTask}
          onArchiveTask={archiveTask}
          onUnarchiveTask={unarchiveTask}
        />
      ) : (
        <ListView
          tasks={tasks}
          onMoveTask={moveTask}
          onOpenDetail={handleDetailOpen}
          addToast={addToast}
          globalPaused={globalPaused}
          isCreating={isCreating}
          onCancelCreate={handleCancelCreate}
          onCreateTask={handleCreateTask}
          onNewTask={handleCreateOpen}
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
        />
      )}
      <GitHubImportModal
        isOpen={githubImportOpen}
        onClose={() => setGitHubImportOpen(false)}
        onImport={handleGitHubImport}
        tasks={tasks}
      />
      <TerminalModal
        isOpen={terminalOpen}
        onClose={handleTerminalClose}
        tasks={inProgressTasks}
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
