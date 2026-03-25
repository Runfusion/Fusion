import { useState, useCallback, useEffect } from "react";
import type { TaskDetail } from "@hai/core";
import { fetchConfig } from "./api";
import { Header } from "./components/Header";
import { Board } from "./components/Board";
import { CreateTaskModal } from "./components/CreateTaskModal";
import { TaskDetailModal } from "./components/TaskDetailModal";
import { ToastContainer } from "./components/ToastContainer";
import { useTasks } from "./hooks/useTasks";
import { ToastProvider, useToast } from "./hooks/useToast";

function AppInner() {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [detailTask, setDetailTask] = useState<TaskDetail | null>(null);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const { tasks, createTask, moveTask, deleteTask, mergeTask } = useTasks();

  useEffect(() => {
    fetchConfig()
      .then((cfg) => setMaxConcurrent(cfg.maxConcurrent))
      .catch(() => {/* keep default */});
  }, []);
  const { toasts, addToast, removeToast } = useToast();

  const handleCreateOpen = useCallback(() => setCreateModalOpen(true), []);
  const handleCreateClose = useCallback(() => setCreateModalOpen(false), []);

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
      />
      {createModalOpen && (
        <CreateTaskModal
          onClose={handleCreateClose}
          onCreateTask={createTask}
          addToast={addToast}
        />
      )}
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
