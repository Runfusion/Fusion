import { useCallback, useState } from "react";
import { Link, Clock } from "lucide-react";
import type { Task, TaskDetail, Column } from "@hai/core";
import { fetchTaskDetail } from "../api";
import type { ToastType } from "../hooks/useToast";

const COLUMN_COLOR_MAP: Record<Column, string> = {
  triage: "rgba(210,153,34,0.15)",
  todo: "rgba(88,166,255,0.15)",
  "in-progress": "rgba(188,140,255,0.15)",
  "in-review": "rgba(63,185,80,0.15)",
  done: "rgba(139,148,158,0.15)",
};

const COLUMN_TEXT_COLOR_MAP: Record<Column, string> = {
  triage: "var(--triage)",
  todo: "var(--todo)",
  "in-progress": "var(--in-progress)",
  "in-review": "var(--in-review)",
  done: "var(--done)",
};

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "specifying"]);

interface TaskCardProps {
  task: Task;
  queued?: boolean;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
}

export function TaskCard({ task, queued, onOpenDetail, addToast }: TaskCardProps) {
  const [dragging, setDragging] = useState(false);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }, [task.id]);

  const handleDragEnd = useCallback(() => {
    setDragging(false);
  }, []);

  const handleClick = useCallback(async () => {
    try {
      const detail = await fetchTaskDetail(task.id);
      onOpenDetail(detail);
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onOpenDetail, addToast]);

  const cardClass = `card${dragging ? " dragging" : ""}${queued ? " queued" : ""}`;

  return (
    <div
      className={cardClass}
      data-id={task.id}
      draggable={!queued}
      onDragStart={queued ? undefined : handleDragStart}
      onDragEnd={queued ? undefined : handleDragEnd}
      onClick={handleClick}
    >
      {task.status && (
        <span
          className={`card-status-badge${ACTIVE_STATUSES.has(task.status) ? " pulsing" : ""}`}
          style={{
            background: COLUMN_COLOR_MAP[task.column],
            color: COLUMN_TEXT_COLOR_MAP[task.column],
          }}
        >
          {task.status}
        </span>
      )}
      <span className="card-id">{task.id}</span>
      <div className="card-title">
        {task.title || (task.description ? task.description.slice(0, 60) + (task.description.length > 60 ? "…" : "") : task.id)}
      </div>
      {task.steps.length > 0 && (() => {
        const completedSteps = task.steps.filter(s => s.status === "done").length;
        const totalSteps = task.steps.length;
        return (
          <div className="card-progress">
            <div className="card-progress-bar">
              <div
                className="card-progress-fill"
                style={{
                  width: `${(completedSteps / totalSteps) * 100}%`,
                  backgroundColor: COLUMN_TEXT_COLOR_MAP[task.column],
                }}
              />
            </div>
            <span className="card-progress-label">{completedSteps}/{totalSteps}</span>
          </div>
        );
      })()}
      {((task.dependencies && task.dependencies.length > 0) || queued) && (
        <div className="card-meta">
          {task.dependencies && task.dependencies.length > 0 && (
            <span className="card-dep-badge">
              <Link size={12} style={{ verticalAlign: 'middle' }} /> {task.dependencies.length} dep{task.dependencies.length > 1 ? "s" : ""}
            </span>
          )}
          {queued && <span className="queued-badge"><Clock size={12} style={{ verticalAlign: 'middle' }} /> Queued</span>}
        </div>
      )}
    </div>
  );
}
