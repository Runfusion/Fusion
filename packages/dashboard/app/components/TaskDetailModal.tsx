import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, TaskDetail, TaskAttachment, Column, MergeResult, PrInfo } from "@kb/core";
import { COLUMN_LABELS, VALID_TRANSITIONS } from "@kb/core";
import { uploadAttachment, deleteAttachment, updateTask, pauseTask, unpauseTask, fetchTaskDetail, requestSpecRevision, approvePlan, rejectPlan, refineTask } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useAgentLogs } from "../hooks/useAgentLogs";
import { AgentLogViewer } from "./AgentLogViewer";
import { SteeringTab } from "./SteeringTab";
import { ModelSelectorTab } from "./ModelSelectorTab";
import { PrSection } from "./PrSection";

interface ModelSelection {
  provider?: string;
  modelId?: string;
}

function normalizeModelField(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function getExecutorSelection(task: Task | TaskDetail): ModelSelection {
  return {
    provider: normalizeModelField(task.modelProvider),
    modelId: normalizeModelField(task.modelId),
  };
}

function getValidatorSelection(task: Task | TaskDetail): ModelSelection {
  return {
    provider: normalizeModelField(task.validatorModelProvider),
    modelId: normalizeModelField(task.validatorModelId),
  };
}

function getStepStatusColor(status: string): string {
  switch (status) {
    case "done":
      return "var(--color-success, #3fb950)";
    case "in-progress":
      return "var(--todo, #58a6ff)";
    case "skipped":
      return "var(--text-dim, #484f58)";
    case "pending":
    default:
      return "var(--border, #30363d)";
  }
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TaskDetailModalProps {
  task: TaskDetail;
  tasks?: Task[];
  onClose: () => void;
  onOpenDetail: (task: TaskDetail) => void; // For clicking dependencies
  onMoveTask: (id: string, column: Column) => Promise<Task>;
  onDeleteTask: (id: string) => Promise<Task>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
  githubTokenConfigured?: boolean;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const EDITABLE_COLUMNS: Set<Column> = new Set(["triage", "todo"]);

export function TaskDetailModal({
  task,
  tasks = [],
  onClose,
  onOpenDetail,
  onMoveTask,
  onDeleteTask,
  onMergeTask,
  onRetryTask,
  onDuplicateTask,
  addToast,
  githubTokenConfigured,
}: TaskDetailModalProps) {
  const [activeTab, setActiveTab] = useState<"definition" | "activity" | "agent-log" | "steering" | "model">("definition");
  const [attachments, setAttachments] = useState<TaskAttachment[]>(task.attachments || []);
  const [uploading, setUploading] = useState(false);
  const [dependencies, setDependencies] = useState<string[]>(task.dependencies || []);
  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [isSavingSpec, setIsSavingSpec] = useState(false);
  const [isRequestingRevision, setIsRequestingRevision] = useState(false);
  const [isEditingSpec, setIsEditingSpec] = useState(false);
  const [specEditContent, setSpecEditContent] = useState(task.prompt || "");
  const [specFeedback, setSpecFeedback] = useState("");
  const [showRefineModal, setShowRefineModal] = useState(false);
  const [refineFeedback, setRefineFeedback] = useState("");
  const [isRefining, setIsRefining] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title || "");
  const [editDescription, setEditDescription] = useState(task.description || "");
  const [isSaving, setIsSaving] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Reset edit state when task changes
  useEffect(() => {
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setIsEditing(false);
  }, [task.id, task.title, task.description]);

  // Reset dependency search when dropdown closes
  useEffect(() => {
    if (!showDepDropdown) {
      setDepSearch("");
    }
  }, [showDepDropdown]);

  // Reset spec edit state when task changes
  useEffect(() => {
    setIsEditingSpec(false);
    setSpecEditContent(task.prompt || "");
    setSpecFeedback("");
  }, [task.id, task.prompt]);

  // Auto-focus title when entering edit mode
  useEffect(() => {
    if (isEditing) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditing]);

  // Check if task can be edited
  const canEdit = EDITABLE_COLUMNS.has(task.column) && !isSaving;
  const hasChanges = editTitle !== (task.title || "") || editDescription !== (task.description || "");

  const enterEditMode = useCallback(() => {
    if (!canEdit) return;
    setIsEditing(true);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
  }, [canEdit, task.title, task.description]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
  }, [task.title, task.description]);

  const handleSave = useCallback(async () => {
    if (!hasChanges) {
      exitEditMode();
      return;
    }

    setIsSaving(true);
    try {
      await updateTask(task.id, {
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
  }, [task.id, editTitle, editDescription, hasChanges, exitEditMode, addToast]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Move focus to description textarea
      const textarea = document.querySelector('.modal-edit-textarea') as HTMLTextAreaElement;
      textarea?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    }
  }, [exitEditMode]);

  const handleDescKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    }
  }, [handleSave, exitEditMode]);

  const handleDescChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
    // Auto-resize textarea
    const el = e.target;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { entries: agentLogEntries, loading: agentLogLoading } = useAgentLogs(
    task.id,
    activeTab === "agent-log",
  );
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditing) onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, isEditing]);

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

  const handleMerge = useCallback(() => {
    if (!confirm(`Merge ${task.id} into the current branch?`)) return;
    onClose();
    addToast(`Merging ${task.id}...`, "info");
    onMergeTask(task.id)
      .then((result) => {
        const msg = result.merged
          ? `Merged ${task.id} (branch: ${result.branch})`
          : `Closed ${task.id} (${result.error || "no branch to merge"})`;
        addToast(msg, "success");
      })
      .catch((err: any) => {
        addToast(err.message, "error");
      });
  }, [task.id, onMergeTask, onClose, addToast]);

  const handleRetry = useCallback(async () => {
    if (!onRetryTask) return;
    try {
      await onRetryTask(task.id);
      onClose();
      addToast(`Retrying ${task.id}...`, "info");
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onRetryTask, onClose, addToast]);

  const handleDuplicate = useCallback(async () => {
    if (!onDuplicateTask) return;
    if (!confirm(`Duplicate ${task.id}? This will create a new task in Triage with the same description and prompt.`)) return;
    try {
      const newTask = await onDuplicateTask(task.id);
      onClose();
      addToast(`Duplicated ${task.id} → ${newTask.id}`, "success");
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onDuplicateTask, onClose, addToast]);

  const handleTogglePause = useCallback(async () => {
    try {
      if (task.paused) {
        await unpauseTask(task.id);
        addToast(`Unpaused ${task.id}`, "success");
      } else {
        await pauseTask(task.id);
        addToast(`Paused ${task.id}`, "success");
      }
      onClose();
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, task.paused, onClose, addToast]);

  const handleApprovePlan = useCallback(async () => {
    try {
      await approvePlan(task.id);
      addToast(`Plan approved — ${task.id} moved to Todo`, "success");
      onClose();
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onClose, addToast]);

  const handleRejectPlan = useCallback(async () => {
    if (!confirm("Reject this plan? The specification will be discarded and regenerated.")) return;
    try {
      await rejectPlan(task.id);
      addToast(`Plan rejected — ${task.id} returned to Triage for re-specification`, "info");
      onClose();
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onClose, addToast]);

  const handleOpenRefineModal = useCallback(() => {
    setShowRefineModal(true);
    setRefineFeedback("");
  }, []);

  const handleCloseRefineModal = useCallback(() => {
    setShowRefineModal(false);
    setRefineFeedback("");
    setIsRefining(false);
  }, []);

  const handleSubmitRefine = useCallback(async () => {
    if (!refineFeedback.trim()) {
      addToast("Please enter feedback describing what needs refinement", "error");
      return;
    }
    if (refineFeedback.length > 2000) {
      addToast("Feedback must be 2000 characters or less", "error");
      return;
    }
    setIsRefining(true);
    try {
      const newTask = await refineTask(task.id, refineFeedback.trim());
      addToast(`Refinement task created: ${newTask.id}`, "success");
      onClose();
    } catch (err: any) {
      addToast(err.message, "error");
    } finally {
      setIsRefining(false);
    }
  }, [task.id, refineFeedback, addToast, onClose]);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const attachment = await uploadAttachment(task.id, file);
      setAttachments((prev) => [...prev, attachment]);
      addToast("Screenshot attached", "success");
    } catch (err: any) {
      addToast(err.message, "error");
    } finally {
      setUploading(false);
    }
  }, [task.id, addToast]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [uploadFile]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            uploadFile(file);
            return;
          }
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [uploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith("image/")) {
        uploadFile(file);
        return;
      }
    }
  }, [uploadFile]);

  const handleDeleteAttachment = useCallback(async (filename: string) => {
    try {
      await deleteAttachment(task.id, filename);
      setAttachments((prev) => prev.filter((a) => a.filename !== filename));
      addToast("Attachment deleted", "info");
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, addToast]);

  const handleAddDep = useCallback(async (depId: string) => {
    const newDeps = [...dependencies, depId];
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps });
    } catch (err: any) {
      setDependencies(dependencies);
      addToast(err.message, "error");
    }
  }, [task.id, dependencies, addToast]);

  const handleRemoveDep = useCallback(async (e: React.MouseEvent, depId: string) => {
    e.stopPropagation(); // Prevent triggering dependency click
    const newDeps = dependencies.filter((d) => d !== depId);
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps });
    } catch (err: any) {
      setDependencies(dependencies);
      addToast(err.message, "error");
    }
  }, [task.id, dependencies, addToast]);

  const handleDepClick = useCallback(async (depId: string) => {
    try {
      const detail = await fetchTaskDetail(depId);
      onOpenDetail(detail);
    } catch (err: any) {
      addToast(`Failed to load dependency ${depId}`, "error");
    }
  }, [onOpenDetail, addToast]);

  // Spec save handlers (must be declared before functions that use them)
  const handleSaveSpec = useCallback(async (newContent: string) => {
    setIsSavingSpec(true);
    try {
      await updateTask(task.id, { prompt: newContent });
      addToast("Spec updated", "success");
      // Update local task data
      task.prompt = newContent;
    } catch (err: any) {
      addToast(err.message, "error");
      throw err;
    } finally {
      setIsSavingSpec(false);
    }
  }, [task, addToast]);

  const handleRequestSpecRevision = useCallback(async (feedback: string) => {
    setIsRequestingRevision(true);
    try {
      await requestSpecRevision(task.id, feedback);
      addToast("AI revision requested. Task moved to triage.", "success");
      // Task has been moved to triage, close modal
      onClose();
    } catch (err: any) {
      if (err.message?.includes("in-review") || err.message?.includes("done")) {
        addToast("Cannot request revision: Task must be in 'todo' or 'in-progress' column.", "error");
      } else {
        addToast(err.message, "error");
      }
    } finally {
      setIsRequestingRevision(false);
    }
  }, [task.id, addToast, onClose]);

  // Spec editing handlers (depend on handleSaveSpec and handleRequestSpecRevision)
  const enterSpecEditMode = useCallback(() => {
    setIsEditingSpec(true);
    setSpecEditContent(task.prompt || "");
    setSpecFeedback("");
  }, [task.prompt]);

  const exitSpecEditMode = useCallback(() => {
    setIsEditingSpec(false);
    setSpecEditContent(task.prompt || "");
    setSpecFeedback("");
  }, [task.prompt]);

  const handleSaveSpecFromEdit = useCallback(async () => {
    if (specEditContent === (task.prompt || "")) {
      exitSpecEditMode();
      return;
    }
    await handleSaveSpec(specEditContent);
    setIsEditingSpec(false);
  }, [specEditContent, task.prompt, handleSaveSpec, exitSpecEditMode]);

  const handleRequestRevisionFromEdit = useCallback(async () => {
    if (!specFeedback.trim()) return;
    await handleRequestSpecRevision(specFeedback.trim());
  }, [specFeedback, handleRequestSpecRevision]);

  // Keyboard shortcuts for spec edit mode
  const handleSpecTextareaKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      exitSpecEditMode();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSaveSpecFromEdit();
    }
  }, [exitSpecEditMode, handleSaveSpecFromEdit]);

  const availableTasks = tasks
    .filter((t) => t.id !== task.id && !dependencies.includes(t.id))
    .sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return bNum - aNum;
    });

  const transitions = VALID_TRANSITIONS[task.column] || [];
  const prAutomationStatusLabels: Record<string, string> = {
    "creating-pr": "Creating PR…",
    "awaiting-pr-checks": "Awaiting PR checks",
    "merging-pr": "Merging PR…",
  };
  const prAutomationLabel = task.status ? prAutomationStatusLabels[task.status] : undefined;

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
      <div className="modal modal-lg" onDragOver={handleDragOver} onDrop={handleDrop}>
        <div className="modal-header">
          <div className="detail-title-row">
            <span className="detail-id">{task.id}</span>
            <span className={`detail-column-badge badge-${task.column}`}>
              {COLUMN_LABELS[task.column]}
            </span>
          </div>
          <div className="modal-header-actions">
            {!isEditing && canEdit && (
              <button
                className="modal-edit-btn"
                onClick={enterEditMode}
                title="Edit task"
                aria-label="Edit task"
              >
                <Pencil size={14} />
              </button>
            )}
            <button className="modal-close" onClick={onClose}>
              &times;
            </button>
          </div>
        </div>
        <div className="detail-body">
          {isEditing ? (
            <div className="modal-edit-form">
              <input
                ref={titleInputRef}
                type="text"
                className="modal-edit-input"
                placeholder="Task title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                disabled={isSaving}
              />
              <textarea
                className="modal-edit-textarea"
                placeholder="Task description"
                value={editDescription}
                onChange={handleDescChange}
                onKeyDown={handleDescKeyDown}
                disabled={isSaving}
                rows={3}
              />
              <div className="modal-edit-actions">
                <button
                  className="btn btn-sm"
                  onClick={exitEditMode}
                  disabled={isSaving}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSave}
                  disabled={!hasChanges || isSaving}
                >
                  {isSaving ? "Saving…" : "Save"}
                </button>
              </div>
              <div className="modal-edit-hint">
                <kbd>Ctrl+Enter</kbd> to save · <kbd>Escape</kbd> to cancel
              </div>
            </div>
          ) : (
            <>
              <h2 className="detail-title">{task.title || task.description}</h2>
              <div className="detail-meta">
                Created {new Date(task.createdAt).toLocaleDateString()} · Updated{" "}
                {new Date(task.updatedAt).toLocaleDateString()}
              </div>
            </>
          )}
          {task.status === "failed" && task.error && (
            <div className="detail-error-alert">
              <span className="detail-error-icon">⚠</span>
              <div className="detail-error-content">
                <div className="detail-error-title">Task Failed</div>
                <div className="detail-error-message">{task.error}</div>
              </div>
            </div>
          )}
          {!isEditing && (
            <>
          <div className="detail-tabs">
            <button
              className={`detail-tab${activeTab === "definition" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("definition")}
            >
              Definition
            </button>
            <button
              className={`detail-tab${activeTab === "activity" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("activity")}
            >
              Activity
            </button>
            <button
              className={`detail-tab${activeTab === "agent-log" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("agent-log")}
            >
              Agent Log
            </button>
            <button
              className={`detail-tab${activeTab === "steering" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("steering")}
            >
              Steering
            </button>
            <button
              className={`detail-tab${activeTab === "model" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("model")}
            >
              Model
            </button>
          </div>
          {activeTab === "model" ? (
            <div className="detail-section">
              <ModelSelectorTab task={task} addToast={addToast} />
            </div>
          ) : activeTab === "agent-log" ? (
            <div className="detail-section">
              <AgentLogViewer
                entries={agentLogEntries}
                loading={agentLogLoading}
                executorModel={getExecutorSelection(task)}
                validatorModel={getValidatorSelection(task)}
              />
            </div>
          ) : activeTab === "steering" ? (
            <SteeringTab task={task} addToast={addToast} />
          ) : activeTab === "activity" ? (
            <div className="detail-section detail-activity">
              <h4>Activity</h4>
              {task.log && task.log.length > 0 ? (
                <div className="detail-activity-list">
                  {[...task.log].reverse().map((entry, i) => (
                    <div key={i} className="detail-log-entry">
                      <div className="detail-log-header">
                        <span className="detail-log-timestamp">
                          {formatTimestamp(entry.timestamp)}
                        </span>
                        <span className="detail-log-action">{entry.action}</span>
                      </div>
                      {entry.outcome && (
                        <div className="detail-log-outcome">{entry.outcome}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="detail-log-empty">(no activity)</div>
              )}
            </div>
          ) : (
          <>
          {/* Summary section - only for done tasks with summary */}
          {task.column === "done" && task.summary && (
            <div className="detail-section detail-summary">
              <h4>Summary</h4>
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {task.summary}
                </ReactMarkdown>
              </div>
            </div>
          )}
          <div className="detail-section detail-step-progress">
            <h4>Progress</h4>
            {task.steps && task.steps.length > 0 ? (
              <div className="step-progress-wrapper">
                <div className="step-progress-bar">
                  {task.steps.map((step, index) => (
                    <div
                      key={index}
                      className={`step-progress-segment step-progress-segment--${step.status}`}
                      data-tooltip={`${step.name} (${step.status})`}
                      style={{ backgroundColor: getStepStatusColor(step.status) }}
                    />
                  ))}
                </div>
                <span className="step-progress-label">
                  {task.steps.filter(s => s.status === "done").length}/{task.steps.length} steps
                </span>
              </div>
            ) : (
              <div className="step-progress-empty">(no steps defined)</div>
            )}
          </div>
          <div className="detail-section">
            {isEditingSpec ? (
              <div className="spec-editor-edit-mode">
                <textarea
                  className="spec-editor-textarea"
                  value={specEditContent}
                  onChange={(e) => setSpecEditContent(e.target.value)}
                  onKeyDown={handleSpecTextareaKeyDown}
                  disabled={isSavingSpec}
                  placeholder="Enter task specification in Markdown..."
                  rows={12}
                />
                <div className="spec-editor-actions-row">
                  <button
                    className="btn btn-sm"
                    onClick={exitSpecEditMode}
                    disabled={isSavingSpec}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveSpecFromEdit()}
                    disabled={specEditContent === (task.prompt || "") || isSavingSpec}
                  >
                    {isSavingSpec ? "Saving…" : "Save"}
                  </button>
                </div>
                <div className="spec-editor-hint">
                  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to save · <kbd>Escape</kbd> to cancel
                </div>
                {/* AI Revision Section */}
                <div className="spec-editor-revision">
                  <h4>Ask AI to Revise</h4>
                  <p className="spec-editor-revision-help">
                    Provide feedback for the AI to improve this specification. The task will move to triage for re-specification.
                  </p>
                  <textarea
                    className="spec-editor-feedback"
                    value={specFeedback}
                    onChange={(e) => setSpecFeedback(e.target.value)}
                    placeholder="e.g., 'Add more details about error handling', 'Split this into smaller steps', 'Include tests for the API endpoints'..."
                    disabled={isRequestingRevision}
                    rows={4}
                    maxLength={2000}
                  />
                  <div className="spec-editor-revision-actions">
                    <span className="spec-editor-char-count">
                      {specFeedback.length}/2000
                    </span>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleRequestRevisionFromEdit()}
                      disabled={!specFeedback.trim() || isRequestingRevision}
                    >
                      {isRequestingRevision ? "Requesting…" : "Request AI Revision"}
                    </button>
                  </div>
                </div>
              </div>
            ) : task.prompt ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {task.prompt.replace(/^#\s+[^\n]*\n+/, "")}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="detail-prompt">(no prompt)</div>
            )}
            {!isEditingSpec && (
              <div style={{ marginTop: "12px" }}>
                <button className="btn btn-sm" onClick={enterSpecEditMode}>
                  Edit
                </button>
              </div>
            )}
          </div>
          <div className="detail-section">
            <h4>Attachments</h4>
            {attachments.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginBottom: "8px" }}>
                {attachments.map((a) => (
                  <div
                    key={a.filename}
                    style={{
                      position: "relative",
                      border: "1px solid var(--border, #333)",
                      borderRadius: "6px",
                      padding: "4px",
                      background: "var(--bg-secondary, #1a1a2e)",
                    }}
                  >
                    <a
                      href={`/api/tasks/${task.id}/attachments/${a.filename}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <img
                        src={`/api/tasks/${task.id}/attachments/${a.filename}`}
                        alt={a.originalName}
                        style={{ maxWidth: "150px", maxHeight: "100px", display: "block", borderRadius: "4px" }}
                      />
                    </a>
                    <div style={{ fontSize: "11px", marginTop: "4px", opacity: 0.7 }}>
                      {a.originalName} ({formatBytes(a.size)})
                    </div>
                    <button
                      onClick={() => handleDeleteAttachment(a.filename)}
                      style={{
                        position: "absolute",
                        top: "2px",
                        right: "2px",
                        background: "rgba(0,0,0,0.6)",
                        color: "#fff",
                        border: "none",
                        borderRadius: "50%",
                        width: "20px",
                        height: "20px",
                        cursor: "pointer",
                        fontSize: "12px",
                        lineHeight: "20px",
                        textAlign: "center",
                        padding: 0,
                      }}
                      title="Delete attachment"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ opacity: 0.5, marginBottom: "8px" }}>(no attachments)</div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleUpload}
              style={{ display: "none" }}
            />
            <button
              className="btn btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : "Attach Screenshot"}
            </button>
          </div>
          <div className="detail-deps">
            <h4>Dependencies</h4>
            {dependencies.length > 0 ? (
              <ul className="detail-dep-list">
                {dependencies.map((dep) => (
                  <li key={dep} className="detail-dep-item">
                    <span
                      className="detail-dep-link"
                      onClick={() => handleDepClick(dep)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleDepClick(dep);
                        }
                      }}
                      role="link"
                      tabIndex={0}
                      title={`Click to view ${dep}`}
                    >
                      {dep}
                    </span>
                    <button
                      className="dep-remove-btn"
                      onClick={(e) => handleRemoveDep(e, dep)}
                      title={`Remove dependency ${dep}`}
                      style={{
                        marginLeft: "6px",
                        background: "none",
                        border: "none",
                        color: "var(--text-secondary, #888)",
                        cursor: "pointer",
                        fontSize: "14px",
                        padding: "0 4px",
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div style={{ opacity: 0.5, marginBottom: "8px" }}>(no dependencies)</div>
            )}
            <div className="dep-trigger-wrap" style={{ position: "relative" }}>
              <button
                type="button"
                className="btn btn-sm dep-trigger"
                onClick={() => {
                  if (showDepDropdown) setDepSearch("");
                  setShowDepDropdown((v) => !v);
                }}
              >
                Add Dependency
              </button>
              {showDepDropdown && (() => {
                const term = depSearch.toLowerCase();
                const filtered = term
                  ? availableTasks.filter((t) =>
                      t.id.toLowerCase().includes(term) ||
                      (t.title && t.title.toLowerCase().includes(term)) ||
                      (t.description && t.description.toLowerCase().includes(term))
                    )
                  : availableTasks;
                return (
                  <div className="dep-dropdown">
                    <input
                      className="dep-dropdown-search"
                      placeholder="Search tasks…"
                      autoFocus
                      value={depSearch}
                      onChange={(e) => setDepSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {filtered.length === 0 ? (
                      <div className="dep-dropdown-empty">No available tasks</div>
                    ) : (
                      filtered.map((t) => (
                        <div
                          key={t.id}
                          className="dep-dropdown-item"
                          onClick={() => {
                            handleAddDep(t.id);
                            setShowDepDropdown(false);
                          }}
                        >
                          <span className="dep-dropdown-id">{t.id}</span>
                          <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
          {/* PR Section - only for in-review tasks */}
          {task.column === "in-review" && (
            <PrSection
              taskId={task.id}
              prInfo={task.prInfo}
              automationStatus={task.status ?? null}
              hasGitHubToken={githubTokenConfigured ?? false}
              onPrCreated={(prInfo) => {
                // Update task locally to show new PR
                (task as TaskDetail).prInfo = prInfo;
                addToast(`PR #${prInfo.number} created`, "success");
              }}
              onPrUpdated={(prInfo) => {
                (task as TaskDetail).prInfo = prInfo;
              }}
              addToast={addToast}
            />
          )}
          </>
          )}
          </>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-danger btn-sm" onClick={handleDelete}>
            Delete
          </button>
          {onDuplicateTask && (
            <button className="btn btn-sm" onClick={handleDuplicate}>
              Duplicate
            </button>
          )}
          {(task.column === "done" || task.column === "in-review") && (
            <button className="btn btn-sm" onClick={handleOpenRefineModal}>
              Refine
            </button>
          )}
          {task.status === "failed" && onRetryTask && (
            <button className="btn btn-warning btn-sm" onClick={handleRetry}>
              Retry
            </button>
          )}
          {task.column !== "done" && (
            <button className="btn btn-sm" onClick={handleTogglePause}>
              {task.paused ? "Unpause" : "Pause"}
            </button>
          )}
          {/* Approve/Reject Plan buttons for tasks awaiting approval */}
          {task.column === "triage" && task.status === "awaiting-approval" && task.prompt && (
            <>
              <button className="btn btn-primary btn-sm" onClick={handleApprovePlan}>
                Approve Plan
              </button>
              <button className="btn btn-danger btn-sm" onClick={handleRejectPlan}>
                Reject Plan
              </button>
            </>
          )}
          <div style={{ flex: 1 }} />
          {task.column === "in-review" ? (
            <>
              <button className="btn btn-sm" onClick={() => handleMove("in-progress")}>
                Back to In Progress
              </button>
              {prAutomationLabel ? (
                <button className="btn btn-primary btn-sm" disabled>
                  {prAutomationLabel}
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={handleMerge}>
                  Merge &amp; Close
                </button>
              )}
            </>
          ) : (
            transitions.map((col) => (
              <button key={col} className="btn btn-sm" onClick={() => handleMove(col)}>
                Move to {COLUMN_LABELS[col]}
              </button>
            ))
          )}
        </div>
        {showRefineModal && (
          <div
            className="modal-overlay open"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0, 0, 0, 0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 100,
            }}
            onClick={handleCloseRefineModal}
          >
            <div
              className="modal"
              style={{ maxWidth: "500px", width: "90%", margin: "0" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h3 style={{ margin: 0 }}>Refine</h3>
                <button className="modal-close" onClick={handleCloseRefineModal}>
                  &times;
                </button>
              </div>
              <div className="detail-body">
                <p style={{ marginBottom: "12px", opacity: 0.8 }}>
                  Describe what needs to be refined or improved...
                </p>
                <textarea
                  value={refineFeedback}
                  onChange={(e) => setRefineFeedback(e.target.value)}
                  placeholder="Enter your feedback here..."
                  rows={6}
                  style={{
                    width: "100%",
                    padding: "12px",
                    borderRadius: "6px",
                    border: "1px solid var(--border, #30363d)",
                    background: "var(--bg-primary, #0d1117)",
                    color: "var(--text-primary, #c9d1d9)",
                    fontSize: "14px",
                    resize: "vertical",
                    minHeight: "120px",
                  }}
                  maxLength={2000}
                  autoFocus
                />
                <div style={{ marginTop: "8px", textAlign: "right", fontSize: "12px", opacity: 0.6 }}>
                  {refineFeedback.length}/2000 characters
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn btn-sm" onClick={handleCloseRefineModal} disabled={isRefining}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSubmitRefine}
                  disabled={!refineFeedback.trim() || isRefining}
                >
                  {isRefining ? "Creating..." : "Create Refinement Task"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
