import { useState, useCallback, useEffect } from "react";
import type { TaskDetail, TaskCreateInput, Task } from "@kb/core";
import { fetchConfig, fetchSettings, fetchAuthStatus, updateSettings } from "./api";
import { Header } from "./components/Header";
import { Board } from "./components/Board";
import { TaskDetailModal } from "./components/TaskDetailModal";
import { SettingsModal } from "./components/SettingsModal";
import type { SectionId } from "./components/SettingsModal";
import { ToastContainer } from "./components/ToastContainer";
import { useTasks } from "./hooks/useTasks";
import { ToastProvider, useToast } from "./hooks/useToast";

function AppInner() {
  const [isCreating, setIsCreating] = useState(false);
  const [detailTask, setDetailTask] = useState<TaskDetail | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId | undefined>(undefined);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [autoMerge, setAutoMerge] = useState(false);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [enginePaused, setEnginePaused] = useState(false);
  const { tasks, createTask, moveTask, deleteTask, mergeTask, retryTask } = useTasks();

  useEffect(() => {
    fetchConfig()
      .then((cfg) => setMaxConcurrent(cfg.maxConcurrent))
      .catch(() => {/* keep default */});
    fetchSettings()
      .then((s) => {
        setAutoMerge(!!s.autoMerge);
        setGlobalPaused(!!s.globalPause);
        setEnginePaused(!!s.enginePaused);
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

  const engineStopped = globalPaused || enginePaused;

  return (
    <>
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        globalPaused={globalPaused}
        enginePaused={enginePaused}
        onToggleGlobalPause={handleToggleGlobalPause}
        onToggleEnginePause={handleToggleEnginePause}
      />
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
        engineStopped={engineStopped}
      />
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          tasks={tasks}
          onClose={handleDetailClose}
          onMoveTask={moveTask}
          onDeleteTask={deleteTask}
          onMergeTask={mergeTask}
          onRetryTask={retryTask}
          addToast={addToast}
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
