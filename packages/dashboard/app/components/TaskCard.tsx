import { useCallback, useState, useRef, useEffect } from "react";
import { Link, Clock, Layers, GitPullRequest, Pencil, ChevronDown } from "lucide-react";
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

const EDITABLE_COLUMNS: Set<Column> = new Set(["triage", "todo"]);

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "specifying"]);

interface TaskCardProps {
  task: Task;
  queued?: boolean;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  tasks?: Task[]; // All tasks for dependency lookup
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
}

export function TaskCard({
  task,
  queued,
  onOpenDetail,
  addToast,
  globalPaused,
  tasks = [],
  onUpdateTask,
}: TaskCardProps) {
  const [dragging, setDragging] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title || "");
  const [editDescription, setEditDescription] = useState(task.description || "");
  const [isSaving, setIsSaving] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset edit state when task changes
  useEffect(() => {
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
  }, [task.id, task.title, task.description]);

  // Auto-focus on title when entering edit mode
  useEffect(() => {
    if (isEditing) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditing]);

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
    if (isEditing) return; // Don't open detail when editing
    try {
      const detail = await fetchTaskDetail(task.id);
      onOpenDetail(detail);
    } catch (err: any) {
      addToast("Failed to load task details", "error");
    }
  }, [task.id, onOpenDetail, addToast, isEditing]);

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
  const isDraggable = !queued && !isPaused && !isEditing; // Disable drag during edit

  // Check if this card can be edited inline
  const canEdit = EDITABLE_COLUMNS.has(task.column) && !isAgentActive && !isPaused && !queued && onUpdateTask;

  const enterEditMode = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!canEdit || isSaving) return;
    setIsEditing(true);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
  }, [canEdit, isSaving, task.title, task.description]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
  }, [task.title, task.description]);

  const hasChanges = useCallback(() => {
    return editTitle !== (task.title || "") || editDescription !== (task.description || "");
  }, [editTitle, editDescription, task.title, task.description]);

  const saveChanges = useCallback(async () => {
    if (!onUpdateTask || isSaving) return;
    if (!hasChanges()) {
      exitEditMode();
      return;
    }

    setIsSaving(true);
    try {
      await onUpdateTask(task.id, {
        title: editTitle.trim() || undefined,
        description: editDescription.trim() || undefined,
      });
      addToast(`Updated ${task.id}`, "success");
      setIsEditing(false);
    } catch (err: any) {
      addToast(`Failed to update ${task.id}: ${err.message}`, "error");
      // Stay in edit mode on error so user can retry
    } finally {
      setIsSaving(false);
    }
  }, [onUpdateTask, task.id, editTitle, editDescription, isSaving, hasChanges, exitEditMode, addToast]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Move focus to description textarea
      descTextareaRef.current?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    }
  }, [exitEditMode]);

  const handleDescKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveChanges();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    }
  }, [saveChanges, exitEditMode]);

  const handleBlur = useCallback(() => {
    // Small delay to allow focus to move between title and description inputs
    // before checking if we should save or cancel
    setTimeout(() => {
      const activeElement = document.activeElement;
      const isFocusInEditArea =
        activeElement === titleInputRef.current ||
        activeElement === descTextareaRef.current ||
        activeElement?.closest(".card-editing-content");

      if (!isFocusInEditArea) {
        if (hasChanges()) {
          saveChanges();
        } else {
          exitEditMode();
        }
      }
    }, 0);
  }, [hasChanges, saveChanges, exitEditMode]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (canEdit) {
      e.stopPropagation();
      enterEditMode(e);
    }
  }, [canEdit, enterEditMode]);

  const handleEditClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    enterEditMode(e);
  }, [enterEditMode]);

  // Auto-resize textarea (similar to InlineCreateCard)
  const handleDescChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  const cardClass = `card${dragging ? " dragging" : ""}${queued ? " queued" : ""}${isAgentActive ? " agent-active" : ""}${isFailed ? " failed" : ""}${isPaused ? " paused" : ""}${fileDragOver ? " file-drop-target" : ""}${isEditing ? " card-editing" : ""}${isSaving ? " card-saving" : ""}`;

  if (isEditing) {
    return (
      <div
        className={cardClass}
        data-id={task.id}
        onDoubleClick={handleDoubleClick}
      >
        <div className="card-editing-content">
          <input
            ref={titleInputRef}
            type="text"
            className="card-edit-title-input"
            placeholder="Task title (optional)"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            onBlur={handleBlur}
            disabled={isSaving}
          />
          <textarea
            ref={descTextareaRef}
            className="card-edit-desc-textarea"
            placeholder="Task description"
            value={editDescription}
            onChange={handleDescChange}
            onKeyDown={handleDescKeyDown}
            onBlur={handleBlur}
            disabled={isSaving}
            rows={1}
          />
          {isSaving && (
            <div className="card-edit-loading">
              <span className="card-edit-loading-spinner" />
              <span className="card-edit-loading-text">Saving...</span>
            </div>
          )}
        </div>
      </div>
    );
  }

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
      onDoubleClick={handleDoubleClick}
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
        {/* Size Indicator */}
        {task.size && (
          <span className={`card-size-badge size-${task.size.toLowerCase()}`}>
            {task.size}
          </span>
        )}
        {/* Edit button - visible on hover for editable cards */}
        {canEdit && (
          <button
            className="card-edit-btn"
            onClick={handleEditClick}
            title="Edit task"
            aria-label="Edit task"
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
      {task.steps.length > 0 && (() => {
        const completedSteps = task.steps.filter(s => s.status === "done").length;
        const totalSteps = task.steps.length;
        return (
          <>
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
            <button
              type="button"
              className="card-steps-toggle"
              onClick={(e) => {
                e.stopPropagation();
                setShowSteps(!showSteps);
              }}
              aria-expanded={showSteps}
              aria-label={showSteps ? "Hide steps" : "Show steps"}
            >
              <span>{totalSteps} steps</span>
              <ChevronDown
                size={14}
                className={`card-steps-toggle-icon${showSteps ? " expanded" : ""}`}
              />
            </button>
            {showSteps && (
              <div className="card-steps-list">
                {task.steps.map((step, index) => (
                  <div key={index} className="card-step-item">
                    <span
                      className={`card-step-dot card-step-dot--${step.status}`}
                      aria-hidden="true"
                    />
                    <span className={`card-step-name${step.status === "done" ? " completed" : ""}`}>
                      {step.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        );
      })()}
      <div className="card-title">
        {task.title || (task.description ? task.description.slice(0, 60) + (task.description.length > 60 ? "…" : "") : task.id)}
      </div>
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
