import { useCallback, useEffect } from "react";
import type { Task, TaskDetail, Column } from "@hai/core";
import { COLUMN_LABELS, VALID_TRANSITIONS } from "@hai/core";
import type { ToastType } from "../hooks/useToast";

interface TaskDetailModalProps {
  task: TaskDetail;
  onClose: () => void;
  onMoveTask: (id: string, column: Column) => Promise<Task>;
  onDeleteTask: (id: string) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
}

export function TaskDetailModal({
  task,
  onClose,
  onMoveTask,
  onDeleteTask,
  addToast,
}: TaskDetailModalProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleMove = useCallback(
    async (column: Column) => {
      try {
        await onMoveTask(task.id, column);
        onClose();
        addToast(`Moved to ${COLUMN_LABELS[column]}`, "success");
      } catch (err: any) {
        addToast(err.message, "error");
      }
    },
    [task.id, onMoveTask, onClose, addToast],
  );

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete ${task.id}?`)) return;
    try {
      await onDeleteTask(task.id);
      onClose();
      addToast(`Deleted ${task.id}`, "info");
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onDeleteTask, onClose, addToast]);

  const transitions = VALID_TRANSITIONS[task.column] || [];

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <div className="detail-title-row">
            <span className="detail-id">{task.id}</span>
            <span className={`detail-column-badge badge-${task.column}`}>
              {COLUMN_LABELS[task.column]}
            </span>
          </div>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="detail-body">
          <h2 className="detail-title">{task.title}</h2>
          <div className="detail-meta">
            Created {new Date(task.createdAt).toLocaleDateString()} · Updated{" "}
            {new Date(task.updatedAt).toLocaleDateString()}
          </div>
          <div className="detail-section">
            <h4>PROMPT.md</h4>
            <pre className="detail-prompt">{task.prompt || "(no prompt)"}</pre>
          </div>
          {task.dependencies && task.dependencies.length > 0 && (
            <div className="detail-deps">
              <h4>Dependencies</h4>
              <ul className="detail-dep-list">
                {task.dependencies.map((dep) => (
                  <li key={dep}>{dep}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-danger btn-sm" onClick={handleDelete}>
            Delete
          </button>
          <div style={{ flex: 1 }} />
          {transitions.map((col) => (
            <button key={col} className="btn btn-sm" onClick={() => handleMove(col)}>
              Move to {COLUMN_LABELS[col]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
