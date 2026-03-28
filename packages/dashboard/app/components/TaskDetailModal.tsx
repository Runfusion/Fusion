import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, TaskDetail, TaskAttachment, Column, MergeResult } from "@kb/core";
import { COLUMN_LABELS, VALID_TRANSITIONS } from "@kb/core";
import { uploadAttachment, deleteAttachment, updateTask, pauseTask, unpauseTask } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useAgentLogs } from "../hooks/useAgentLogs";
import { AgentLogViewer } from "./AgentLogViewer";

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
  onMoveTask: (id: string, column: Column) => Promise<Task>;
  onDeleteTask: (id: string) => Promise<Task>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function TaskDetailModal({
  task,
  tasks = [],
  onClose,
  onMoveTask,
  onDeleteTask,
  onMergeTask,
  onRetryTask,
  addToast,
}: TaskDetailModalProps) {
  const [activeTab, setActiveTab] = useState<"definition" | "agent-log">("definition");
  const [attachments, setAttachments] = useState<TaskAttachment[]>(task.attachments || []);
  const [uploading, setUploading] = useState(false);
  const [dependencies, setDependencies] = useState<string[]>(task.dependencies || []);
  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  useEffect(() => {
    if (!showDepDropdown) setDepSearch("");
  }, [showDepDropdown]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { entries: agentLogEntries, loading: agentLogLoading } = useAgentLogs(
    task.id,
    activeTab === "agent-log",
  );
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

  const handleRemoveDep = useCallback(async (depId: string) => {
    const newDeps = dependencies.filter((d) => d !== depId);
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps });
    } catch (err: any) {
      setDependencies(dependencies);
      addToast(err.message, "error");
    }
  }, [task.id, dependencies, addToast]);

  const availableTasks = tasks
    .filter((t) => t.id !== task.id && !dependencies.includes(t.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const transitions = VALID_TRANSITIONS[task.column] || [];

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
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="detail-body">
          <h2 className="detail-title">{task.title || task.description}</h2>
          <div className="detail-meta">
            Created {new Date(task.createdAt).toLocaleDateString()} · Updated{" "}
            {new Date(task.updatedAt).toLocaleDateString()}
          </div>
          <div className="detail-tabs">
            <button
              className={`detail-tab${activeTab === "definition" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("definition")}
            >
              Definition
            </button>
            <button
              className={`detail-tab${activeTab === "agent-log" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("agent-log")}
            >
              Agent Log
            </button>
          </div>
          {activeTab === "agent-log" ? (
            <div className="detail-section">
              <AgentLogViewer entries={agentLogEntries} loading={agentLogLoading} />
            </div>
          ) : (
          <>
          <div className="detail-section">
            {task.prompt ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {task.prompt.replace(/^#\s+[^\n]*\n+/, "")}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="detail-prompt">(no prompt)</div>
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
                  <li key={dep}>
                    {dep}
                    <button
                      className="dep-remove-btn"
                      onClick={() => handleRemoveDep(dep)}
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
                onClick={() => setShowDepDropdown((v) => !v)}
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
          </>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-danger btn-sm" onClick={handleDelete}>
            Delete
          </button>
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
          <div style={{ flex: 1 }} />
          {task.column === "in-review" ? (
            <>
              <button className="btn btn-sm" onClick={() => handleMove("in-progress")}>
                Back to In Progress
              </button>
              <button className="btn btn-primary btn-sm" onClick={handleMerge}>
                Merge &amp; Close
              </button>
            </>
          ) : (
            transitions.map((col) => (
              <button key={col} className="btn btn-sm" onClick={() => handleMove(col)}>
                Move to {COLUMN_LABELS[col]}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
