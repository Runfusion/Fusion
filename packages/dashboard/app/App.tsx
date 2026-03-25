import { useState, useCallback, useEffect } from "react";
import type { TaskDetail, TaskCreateInput, Task } from "@hai/core";
import { fetchConfig } from "./api";
import { Header } from "./components/Header";
import { Board } from "./components/Board";
import { TaskDetailModal } from "./components/TaskDetailModal";
import { ToastContainer } from "./components/ToastContainer";
import { useTasks } from "./hooks/useTasks";
import { ToastProvider, useToast } from "./hooks/useToast";

function AppInner() {
  const [isCreating, setIsCreating] = useState(false);
  const [detailTask, setDetailTask] = useState<TaskDetail | null>(null);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const { tasks, createTask, moveTask, deleteTask, mergeTask } = useTasks();

  useEffect(() => {
    fetchConfig()
      .then((cfg) => setMaxConcurrent(cfg.maxConcurrent))
      .catch(() => {/* keep default */});
  }, []);
  const { toasts, addToast, removeToast } = useToast();

  const handleCreateOpen = useCallback(() => setIsCreating(true), []);
  const handleCancelCreate = useCallback(() => setIsCreating(false), []);

  const handleCreateTask = useCallback(
    async (input: TaskCreateInput): Promise<Task> => {
      const task = await createTask({ ...input, column: "todo" });
      setIsCreating(false);
      return task;
    },
    [createTask],
  );

  const handleDetailOpen = useCallback((task: TaskDetail) => {
    setDetailTask(task);
  }, []);

  const handleDetailClose = useCallback(() => setDetailTask(null), []);

  return (
    <>
      <Header onNewTask={handleCreateOpen} />
      <Board
        tasks={tasks}
        maxConcurrent={maxConcurrent}
        onMoveTask={moveTask}
        onOpenDetail={handleDetailOpen}
        addToast={addToast}
        isCreating={isCreating}
        onCancelCreate={handleCancelCreate}
        onCreateTask={handleCreateTask}
      />
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={handleDetailClose}
          onMoveTask={moveTask}
          onDeleteTask={deleteTask}
          onMergeTask={mergeTask}
          addToast={addToast}
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
