import { useCallback, useState } from "react";
import { Link, Clock, Layers, GitPullRequest } from "lucide-react";
import type { Task, TaskDetail, Column } from "@kb/core";
import { fetchTaskDetail, uploadAttachment } from "../api";
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
  globalPaused?: boolean;
  tasks?: Task[]; // All tasks for dependency lookup
}

export function TaskCard({ task, queued, onOpenDetail, addToast, globalPaused, tasks = [] }: TaskCardProps) {
  const [dragging, setDragging] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }, [task.id]);

  const handleDragEnd = useCallback(() => {
    setDragging(false);
  }, []);

  const isFileDrag = useCallback((e: React.DragEvent) => {
    return e.dataTransfer.types.includes("Files");
  }, []);

  const handleFileDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setFileDragOver(true);
  }, [isFileDrag]);

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDragOver(false);
  }, [isFileDrag]);

  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      try {
        await uploadAttachment(task.id, file);
        addToast(`Attached ${file.name} to ${task.id}`, "success");
      } catch (err: any) {
        addToast(`Failed to attach ${file.name}: ${err.message}`, "error");
      }
    }
  }, [task.id, isFileDrag, addToast]);

  const handleClick = useCallback(async () => {
    try {
      const detail = await fetchTaskDetail(task.id);
      onOpenDetail(detail);
    } catch (err: any) {
      addToast("Failed to load task details", "error");
    }
  }, [task.id, onOpenDetail, addToast]);

  const handleDepClick = useCallback(async (e: React.MouseEvent, depId: string) => {
    e.stopPropagation(); // Prevent card click
    try {
      const detail = await fetchTaskDetail(depId);
      onOpenDetail(detail);
    } catch (err: any) {
      addToast(`Failed to load dependency ${depId}`, "error");
    }
  }, [onOpenDetail, addToast]);

  const isFailed = task.status === "failed";
  const isPaused = task.paused === true;
  const isAgentActive = !globalPaused && !queued && !isFailed && !isPaused && (task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string));
  const isDraggable = !queued && !isPaused;
  const cardClass = `card${dragging ? " dragging" : ""}${queued ? " queued" : ""}${isAgentActive ? " agent-active" : ""}${isFailed ? " failed" : ""}${isPaused ? " paused" : ""}${fileDragOver ? " file-drop-target" : ""}`;

  return (
    <div
      className={cardClass}
      data-id={task.id}
      draggable={isDraggable}
      onDragStart={isDraggable ? handleDragStart : undefined}
      onDragEnd={isDraggable ? handleDragEnd : undefined}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onClick={handleClick}
    >
      <div className="card-header">
        <span className="card-id">{task.id}</span>
        {isPaused && (
          <span
            className="card-status-badge"
            style={{ background: "rgba(139,148,158,0.2)", color: "var(--text-secondary, #888)" }}
          >
            paused
          </span>
        )}
        {!isPaused && task.status && task.status !== "queued" && (
          <span
            className={`card-status-badge${ACTIVE_STATUSES.has(task.status) ? " pulsing" : ""}${isFailed ? " failed" : ""}`}
            style={isFailed
              ? { background: "rgba(218,54,51,0.15)", color: "#da3633" }
              : { background: COLUMN_COLOR_MAP[task.column], color: COLUMN_TEXT_COLOR_MAP[task.column] }
            }
          >
            {task.status}
          </span>
        )}
        {/* PR Status Indicator for in-review tasks */}
        {task.column === "in-review" && task.prInfo && (
          <span
            className="card-pr-badge"
            title={`PR #${task.prInfo.number}: ${task.prInfo.status}`}
            style={{
              background: task.prInfo.status === "merged"
                ? "rgba(188,140,255,0.2)"
                : task.prInfo.status === "closed"
                  ? "rgba(139,148,158,0.2)"
                  : "rgba(63,185,80,0.2)",
              color: task.prInfo.status === "merged"
                ? "#bc8cff"
                : task.prInfo.status === "closed"
                  ? "#8b949e"
                  : "#3fb950",
              fontSize: "11px",
              padding: "2px 6px",
              borderRadius: "10px",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <GitPullRequest size={12} />
            #{task.prInfo.number}
          </span>
        )}
      </div>
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
      {((task.dependencies && task.dependencies.length > 0) || queued || task.status === "queued" || task.blockedBy) && (
        <div className="card-meta">
      {task.dependencies && task.dependencies.length > 0 && (
        <div className="card-dep-list">
          {task.dependencies.map((depId) => (
            <span
              key={depId}
              className="card-dep-badge clickable"
              onClick={(e) => handleDepClick(e, depId)}
              title={`Click to view ${depId}`}
            >
              <Link size={12} style={{ verticalAlign: 'middle' }} /> {depId}
            </span>
          ))}
        </div>
      )}
          {task.blockedBy && (
            <span className="card-scope-badge" data-tooltip={`Blocked by ${task.blockedBy} (file overlap)`}>
              <Layers size={12} style={{ verticalAlign: 'middle' }} /> {task.blockedBy}
            </span>
          )}
          {(queued || task.status === "queued") && <span className="queued-badge"><Clock size={12} style={{ verticalAlign: 'middle' }} /> Queued</span>}
        </div>
      )}
    </div>
  );
}
