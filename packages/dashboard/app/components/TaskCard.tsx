import { memo, useCallback, useState, useRef, useEffect, useMemo } from "react";
import { Link, Clock, Layers, Pencil, ChevronDown, Folder } from "lucide-react";
import type { Task, TaskDetail, Column, PrInfo, IssueInfo } from "@fusion/core";
import { fetchTaskDetail, uploadAttachment } from "../api";
import { GitHubBadge } from "./GitHubBadge";
import { pickPreferredBadge } from "./TaskCardBadge";
import { useBadgeWebSocket } from "../hooks/useBadgeWebSocket";
import { getFreshBatchData } from "../hooks/useBatchBadgeFetch";
import { useSessionFiles } from "../hooks/useSessionFiles";
import { useTaskDiffStats } from "../hooks/useTaskDiffStats";
import { isTaskStuck } from "../utils/taskStuck";
import type { ToastType } from "../hooks/useToast";

const COLUMN_COLOR_MAP: Record<Column, string> = {
  triage: "rgba(210,153,34,0.15)",
  todo: "rgba(88,166,255,0.15)",
  "in-progress": "rgba(188,140,255,0.15)",
  "in-review": "rgba(63,185,80,0.15)",
  done: "rgba(139,148,158,0.15)",
  archived: "rgba(120,120,120,0.1)",
};

const COLUMN_TEXT_COLOR_MAP: Record<Column, string> = {
  triage: "var(--triage)",
  todo: "var(--todo)",
  "in-progress": "var(--in-progress)",
  "in-review": "var(--in-review)",
  done: "var(--done)",
  archived: "var(--text-secondary)",
};

const EDITABLE_COLUMNS: Set<Column> = new Set(["triage", "todo"]);

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "specifying"]);

interface TaskCardProps {
  task: Task;
  projectId?: string;
  queued?: boolean;
  onOpenDetail: (task: TaskDetail) => void;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[] }
  ) => Promise<Task>;
  onArchiveTask?: (id: string) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  onOpenDetailWithTab?: (task: TaskDetail, initialTab: "changes") => void;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
}

function areTaskBadgeInfosEqual(
  previous: PrInfo | IssueInfo | undefined,
  next: PrInfo | IssueInfo | undefined,
): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;

  const previousKeys = Object.keys(previous) as Array<keyof typeof previous>;
  const nextKeys = Object.keys(next) as Array<keyof typeof next>;

  if (previousKeys.length !== nextKeys.length) return false;

  return previousKeys.every((key) => previous[key] === next[key]);
}

function areTaskStepsEqual(previous: Task["steps"], next: Task["steps"]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((step, index) => step.name === next[index]?.name && step.status === next[index]?.status);
}

function areTaskDependenciesEqual(previous: string[], next: string[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((dependency, index) => dependency === next[index]);
}

// Keep this comparator aligned with the fields TaskCard renders directly and the
// task metadata that influences child badge freshness/subscriptions.
function areTaskCardPropsEqual(previous: TaskCardProps, next: TaskCardProps): boolean {
  const previousTask = previous.task;
  const nextTask = next.task;

  return (
    previous.queued === next.queued &&
    previous.projectId === next.projectId &&
    previous.globalPaused === next.globalPaused &&
    previous.taskStuckTimeoutMs === next.taskStuckTimeoutMs &&
    previous.onOpenDetail === next.onOpenDetail &&
    previous.addToast === next.addToast &&
    previous.onUpdateTask === next.onUpdateTask &&
    previous.onArchiveTask === next.onArchiveTask &&
    previous.onUnarchiveTask === next.onUnarchiveTask &&
    previous.onOpenDetailWithTab === next.onOpenDetailWithTab &&
    previousTask.id === nextTask.id &&
    previousTask.title === nextTask.title &&
    previousTask.description === nextTask.description &&
    previousTask.column === nextTask.column &&
    previousTask.columnMovedAt === nextTask.columnMovedAt &&
    previousTask.updatedAt === nextTask.updatedAt &&
    previousTask.createdAt === nextTask.createdAt &&
    previousTask.status === nextTask.status &&
    previousTask.paused === nextTask.paused &&
    previousTask.error === nextTask.error &&
    previousTask.size === nextTask.size &&
    previousTask.blockedBy === nextTask.blockedBy &&
    previousTask.worktree === nextTask.worktree &&
    previousTask.baseBranch === nextTask.baseBranch &&
    previousTask.breakIntoSubtasks === nextTask.breakIntoSubtasks &&
    previousTask.currentStep === nextTask.currentStep &&
    previousTask.modelProvider === nextTask.modelProvider &&
    previousTask.modelId === nextTask.modelId &&
    previousTask.validatorModelProvider === nextTask.validatorModelProvider &&
    previousTask.validatorModelId === nextTask.validatorModelId &&
    previousTask.reviewLevel === nextTask.reviewLevel &&
    previousTask.mergeRetries === nextTask.mergeRetries &&
    JSON.stringify(previousTask.attachments ?? []) === JSON.stringify(nextTask.attachments ?? []) &&
    JSON.stringify(previousTask.comments ?? []) === JSON.stringify(nextTask.comments ?? []) &&
    areTaskDependenciesEqual(previousTask.dependencies, nextTask.dependencies) &&
    areTaskStepsEqual(previousTask.steps, nextTask.steps) &&
    areTaskBadgeInfosEqual(previousTask.prInfo, nextTask.prInfo) &&
    areTaskBadgeInfosEqual(previousTask.issueInfo, nextTask.issueInfo)
  );
}

function TaskCardComponent({
  task,
  projectId,
  queued,
  onOpenDetail,
  addToast,
  globalPaused,
  onUpdateTask,
  onArchiveTask,
  onUnarchiveTask,
  onOpenDetailWithTab,
  taskStuckTimeoutMs,
}: TaskCardProps) {
  const [dragging, setDragging] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editDescription, setEditDescription] = useState(task.description || "");
  const [isSaving, setIsSaving] = useState(false);
  const [showSteps, setShowSteps] = useState(
    task.column === "in-progress" ||
    (task.column === "triage" && task.steps.some(s => s.status === "done" || s.status === "skipped"))
  );

  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const touchOpenHandledRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [isInViewport, setIsInViewport] = useState(false);
  const { badgeUpdates, subscribeToBadge, unsubscribeFromBadge } = useBadgeWebSocket();

  // Touch gesture detection refs
  const touchStartPosRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const hasTouchMovedRef = useRef(false);

  const isInteractiveTarget = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest("button, a, input, textarea, select, label, [role='button']");
  }, []);

  // Reset edit state when task changes
  useEffect(() => {
    setEditDescription(task.description || "");
  }, [task.id, task.description]);

  // Auto-focus and auto-resize description textarea when entering edit mode
  useEffect(() => {
    if (isEditing && descTextareaRef.current) {
      const el = descTextareaRef.current;
      el.focus();
      // Apply the same resize logic used in handleDescChange so the textarea
      // opens at the correct height for existing long descriptions without
      // requiring the user to type first.
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [isEditing]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setIsInViewport(true);
      return;
    }

    const element = cardRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsInViewport(entry?.isIntersecting ?? true);
      },
      { rootMargin: "200px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [isEditing, task.id]);

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
        await uploadAttachment(task.id, file, projectId);
        addToast(`Attached ${file.name} to ${task.id}`, "success");
      } catch (err: any) {
        addToast(`Failed to attach ${file.name}: ${err.message}`, "error");
      }
    }
  }, [task.id, isFileDrag, addToast]);

  const handleClick = useCallback(async () => {
    if (isEditing) return; // Don't open detail when editing
    try {
      const detail = await fetchTaskDetail(task.id, projectId);
      onOpenDetail(detail);
    } catch {
      addToast("Failed to load task details", "error");
    }
  }, [task.id, onOpenDetail, addToast, isEditing]);

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if (touchOpenHandledRef.current) {
      touchOpenHandledRef.current = false;
      return;
    }
    if (isInteractiveTarget(e.target)) return;
    void handleClick();
  }, [handleClick, isInteractiveTarget]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    hasTouchMovedRef.current = false;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartPosRef.current) return;
    
    const touch = e.touches[0];
    if (!touch) return;
    
    const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
    
    // If moved beyond threshold, mark as moved (scrolling/dragging)
    if (dx > TOUCH_MOVE_THRESHOLD || dy > TOUCH_MOVE_THRESHOLD) {
      hasTouchMovedRef.current = true;
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (isInteractiveTarget(e.target)) return;
    
    // Check if this was a valid tap (not a scroll)
    if (!touchStartPosRef.current) return;
    
    const touchDuration = Date.now() - touchStartPosRef.current.time;
    const isQuickTap = touchDuration < TOUCH_TAP_MAX_DURATION;
    const isStationary = !hasTouchMovedRef.current;
    
    // Only open modal for quick taps that didn't move significantly
    if (isQuickTap && isStationary) {
      touchOpenHandledRef.current = true;
      void handleClick();
    }
    
    // Reset touch tracking
    touchStartPosRef.current = null;
    hasTouchMovedRef.current = false;
  }, [handleClick, isInteractiveTarget]);

  const handleDepClick = useCallback(async (e: React.MouseEvent, depId: string) => {
    e.stopPropagation(); // Prevent card click
    try {
      const detail = await fetchTaskDetail(depId, projectId);
      onOpenDetail(detail);
    } catch (err: any) {
      addToast(`Failed to load dependency ${depId}`, "error");
    }
  }, [onOpenDetail, addToast]);

  const isFailed = task.status === "failed";
  const isPaused = task.paused === true;
  const isStuck = isTaskStuck(task, taskStuckTimeoutMs);
  const isAwaitingApproval = task.column === "triage" && task.status === "awaiting-approval";
  const isArchived = task.column === "archived";
  const isAgentActive = !globalPaused && !queued && !isFailed && !isPaused && !isStuck && !isAwaitingApproval && (task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string));
  const isDraggable = !queued && !isPaused && !isEditing && !isArchived; // Disable drag during edit or if archived

  // Check if this card can be edited inline
  const canEdit = EDITABLE_COLUMNS.has(task.column) && !isAgentActive && !isPaused && !queued && onUpdateTask;
  const hasGitHubBadge = Boolean(task.prInfo || task.issueInfo);

  useEffect(() => {
    if (!hasGitHubBadge || !isInViewport) {
      unsubscribeFromBadge(task.id);
      return;
    }

    subscribeToBadge(task.id);
    return () => {
      unsubscribeFromBadge(task.id);
    };
  }, [hasGitHubBadge, isInViewport, subscribeToBadge, task.id, unsubscribeFromBadge]);

  const liveBadgeData = badgeUpdates.get(task.id);
  const { files: sessionFiles, loading: sessionFilesLoading } = useSessionFiles(task.id, task.worktree, task.column, projectId);
  const { stats: diffStats } = useTaskDiffStats(task.id, task.column, task.mergeDetails?.commitSha, projectId);

  // Get fresh batch data if available
  const batchData = useMemo(() => getFreshBatchData(task.id, projectId), [task.id, projectId]);

  // Pick the freshest data among WebSocket, batch, and task data
  const livePrInfo = useMemo(() => {
    const wsData = liveBadgeData?.prInfo;
    const wsTimestamp = liveBadgeData?.timestamp;
    const batchInfo = batchData?.result?.prInfo;
    const batchTimestamp = batchData?.timestamp ? new Date(batchData.timestamp).toISOString() : undefined;
    const taskInfo = task.prInfo;
    const taskTimestamp = task.prInfo?.lastCheckedAt ?? task.updatedAt;

    // Compare all three sources and pick the freshest
    let bestData = pickPreferredBadge<PrInfo>(wsData, wsTimestamp, taskInfo, taskTimestamp);
    let bestTimestamp = wsTimestamp && wsTimestamp >= taskTimestamp ? wsTimestamp : taskTimestamp;

    if (batchInfo && batchTimestamp) {
      if (!bestTimestamp || batchTimestamp > bestTimestamp) {
        bestData = batchInfo;
      }
    }

    return bestData;
  }, [liveBadgeData, batchData, task.prInfo, task.updatedAt]);

  const liveIssueInfo = useMemo(() => {
    const wsData = liveBadgeData?.issueInfo;
    const wsTimestamp = liveBadgeData?.timestamp;
    const batchInfo = batchData?.result?.issueInfo;
    const batchTimestamp = batchData?.timestamp ? new Date(batchData.timestamp).toISOString() : undefined;
    const taskInfo = task.issueInfo;
    const taskTimestamp = task.issueInfo?.lastCheckedAt ?? task.updatedAt;

    // Compare all three sources and pick the freshest
    let bestData = pickPreferredBadge<IssueInfo>(wsData, wsTimestamp, taskInfo, taskTimestamp);
    let bestTimestamp = wsTimestamp && wsTimestamp >= taskTimestamp ? wsTimestamp : taskTimestamp;

    if (batchInfo && batchTimestamp) {
      if (!bestTimestamp || batchTimestamp > bestTimestamp) {
        bestData = batchInfo;
      }
    }

    return bestData;
  }, [liveBadgeData, batchData, task.issueInfo, task.updatedAt]);

  const enterEditMode = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!canEdit || isSaving) return;
    setIsEditing(true);
    setEditDescription(task.description || "");
  }, [canEdit, isSaving, task.description]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setEditDescription(task.description || "");
  }, [task.description]);

  const hasChanges = useCallback(() => {
    return editDescription !== (task.description || "");
  }, [editDescription, task.description]);

  const saveChanges = useCallback(async () => {
    if (!onUpdateTask || isSaving) return;
    if (!hasChanges()) {
      exitEditMode();
      return;
    }

    setIsSaving(true);
    try {
      await onUpdateTask(task.id, {
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
  }, [onUpdateTask, task.id, editDescription, isSaving, hasChanges, exitEditMode, addToast]);

  const handleDescKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void saveChanges();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    }
  }, [saveChanges, exitEditMode]);

  const handleBlur = useCallback(() => {
    // Small delay to allow focus to move before checking if we should save or cancel
    setTimeout(() => {
      const activeElement = document.activeElement;
      const isFocusInEditArea =
        activeElement === descTextareaRef.current ||
        activeElement?.closest(".card-editing-content");

      if (!isFocusInEditArea) {
        if (hasChanges()) {
          void saveChanges();
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

  const handleArchiveClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onArchiveTask) return;

    void onArchiveTask(task.id).then(() => {
      addToast(`Archived ${task.id}`, "success");
    }).catch((err: any) => {
      addToast(`Failed to archive ${task.id}: ${err.message}`, "error");
    });
  }, [addToast, onArchiveTask, task.id]);

  const handleUnarchiveClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onUnarchiveTask) return;

    void onUnarchiveTask(task.id).then(() => {
      addToast(`Unarchived ${task.id}`, "success");
    }).catch((err: any) => {
      addToast(`Failed to unarchive ${task.id}: ${err.message}`, "error");
    });
  }, [addToast, onUnarchiveTask, task.id]);

  const handleOpenFiles = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const detail = await fetchTaskDetail(task.id, projectId);
      onOpenDetailWithTab?.(detail, "changes");
    } catch {
      addToast("Failed to load task details", "error");
    }
  }, [task.id, projectId, onOpenDetailWithTab, addToast]);

  const handleToggleSteps = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setShowSteps((current) => !current);
  }, []);

  const cardClass = `card${dragging ? " dragging" : ""}${queued ? " queued" : ""}${isAgentActive ? " agent-active" : ""}${isFailed ? " failed" : ""}${isPaused ? " paused" : ""}${isStuck ? " stuck" : ""}${isAwaitingApproval ? " awaiting-approval" : ""}${fileDragOver ? " file-drop-target" : ""}${isEditing ? " card-editing" : ""}${isSaving ? " card-saving" : ""}`;

  if (isEditing) {
    return (
      <div
        ref={cardRef}
        className={cardClass}
        data-id={task.id}
        onDoubleClick={handleDoubleClick}
      >
        <div className="card-editing-content">
          <textarea
            ref={descTextareaRef}
            className="card-edit-desc-textarea"
            placeholder="Task description"
            value={editDescription}
            onChange={handleDescChange}
            onKeyDown={handleDescKeyDown}
            onBlur={handleBlur}
            disabled={isSaving}
            rows={4}
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
      ref={cardRef}
      className={cardClass}
      data-id={task.id}
      draggable={isDraggable}
      onDragStart={isDraggable ? handleDragStart : undefined}
      onDragEnd={isDraggable ? handleDragEnd : undefined}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onClick={handleCardClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
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
            className={`card-status-badge${isAwaitingApproval ? " awaiting-approval" : ""}${ACTIVE_STATUSES.has(task.status) ? " pulsing" : ""}${isFailed ? " failed" : ""}${isStuck ? " stuck" : ""}`}
            style={isAwaitingApproval
              ? { background: "rgba(210,153,34,0.2)", color: "var(--triage)" }
              : isFailed
                ? { background: "rgba(218,54,51,0.15)", color: "#da3633" }
                : { background: COLUMN_COLOR_MAP[task.column], color: COLUMN_TEXT_COLOR_MAP[task.column] }
            }
          >
            {isStuck ? "Stuck" : isAwaitingApproval ? "Awaiting Approval" : task.status}
          </span>
        )}
        {isStuck && (isPaused || !task.status || task.status === "queued") && (
          <span className="card-status-badge stuck">
            Stuck
          </span>
        )}
        {hasGitHubBadge && (
          <GitHubBadge
            prInfo={livePrInfo}
            issueInfo={liveIssueInfo}
          />
        )}
        <div className="card-header-actions">
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
          {task.column === "done" && onArchiveTask && (
            <button
              className="card-archive-btn"
              onClick={handleArchiveClick}
              title="Archive task"
              aria-label="Archive task"
            >
              Archive
            </button>
          )}
          {task.column === "archived" && onUnarchiveTask && (
            <button
              className="card-unarchive-btn"
              onClick={handleUnarchiveClick}
              title="Unarchive task"
              aria-label="Unarchive task"
            >
              Unarchive
            </button>
          )}
          {task.size && (
            <span className={`card-size-badge size-${task.size.toLowerCase()}`}>
              {task.size}
            </span>
          )}
        </div>
      </div>
      {isFailed && task.error && (
        <div className="card-error" title={task.error}>
          <span className="card-error-icon">⚠</span>
          <span className="card-error-text">{task.error.length > 60 ? task.error.slice(0, 60) + "…" : task.error}</span>
        </div>
      )}
      <div className="card-title" title={task.title || task.description || undefined}>
        {truncate(task.title, MAX_TITLE_LENGTH) || truncate(task.description, MAX_TITLE_LENGTH) || task.id}
      </div>
      {task.steps.length > 0 && (() => {
        const completedSteps = task.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
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
              onClick={handleToggleSteps}
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
      {task.worktree && (task.column === "in-progress" || task.column === "in-review") && (
        <button
          type="button"
          className="card-session-files"
          onClick={handleOpenFiles}
          disabled={!onOpenDetailWithTab}
        >
          <Folder size={12} />
          <span>
            {sessionFilesLoading ? "Checking files…" : `${sessionFiles.length} files changed`}
          </span>
        </button>
      )}
      {task.column === "done" && (() => {
        // Prefer diff stats from the same endpoint the modal uses so the
        // count is always consistent with the Changes tab.
        const diffCount = diffStats?.filesChanged;
        const mergedCount = task.mergeDetails?.filesChanged;
        const displayCount = diffCount ?? mergedCount;
        if (displayCount != null && displayCount > 0) {
          return (
            <button
              type="button"
              className="card-session-files"
              onClick={handleOpenFiles}
              disabled={!onOpenDetailWithTab}
            >
              <Folder size={12} />
              <span>{displayCount} files changed</span>
            </button>
          );
        }
        const modifiedCount = task.modifiedFiles?.length;
        if (modifiedCount != null && modifiedCount > 0) {
          return (
            <button
              type="button"
              className="card-session-files"
              onClick={handleOpenFiles}
              disabled={!onOpenDetailWithTab}
            >
              <Folder size={12} />
              <span>{modifiedCount} files changed</span>
            </button>
          );
        }
        if (task.worktree && sessionFiles.length > 0) {
          return (
            <button
              type="button"
              className="card-session-files"
              onClick={handleOpenFiles}
              disabled={!onOpenDetailWithTab}
            >
              <Folder size={12} />
              <span>
                {sessionFilesLoading ? "Checking files…" : `${sessionFiles.length} files changed`}
              </span>
            </button>
          );
        }
        return null;
      })()}
      {((task.dependencies && task.dependencies.length > 0) || queued || task.status === "queued" || task.blockedBy) && (
        <div className="card-meta">
          {task.dependencies && task.dependencies.length > 0 && (
            <div className="card-dep-list">
              {task.dependencies.map((depId) => (
                <span
                  key={depId}
                  className="card-dep-badge clickable"
                  onClick={(e) => void handleDepClick(e, depId)}
                  title={`Click to view ${depId}`}
                >
                  <Link size={12} style={{ verticalAlign: "middle" }} /> {depId}
                </span>
              ))}
            </div>
          )}
          {task.blockedBy && (
            <span className="card-scope-badge" data-tooltip={`Blocked by ${task.blockedBy} (file overlap)`}>
              <Layers size={12} style={{ verticalAlign: "middle" }} /> {task.blockedBy}
            </span>
          )}
          {(queued || task.status === "queued") && <span className="queued-badge"><Clock size={12} style={{ verticalAlign: "middle" }} /> Queued</span>}
        </div>
      )}
    </div>
  );
}

const TOUCH_MOVE_THRESHOLD = 10; // pixels
const TOUCH_TAP_MAX_DURATION = 300; // milliseconds
const MAX_TITLE_LENGTH = 140;

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export const TaskCard = memo(TaskCardComponent, areTaskCardPropsEqual);
TaskCard.displayName = "TaskCard";
