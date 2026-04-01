import { useCallback, useMemo, useState } from "react";
import type { Task, TaskComment } from "@fusion/core";
import { addComment, addTaskComment, updateTaskComment, deleteTaskComment } from "../api";
import type { ToastType } from "../hooks/useToast";

type CommentType = "user" | "steering";

interface TaskCommentsProps {
  task: Task;
  onTaskUpdated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
  currentAuthor?: string;
}

function formatCommentTimestamp(comment: TaskComment): string {
  const timestamp = comment.updatedAt || comment.createdAt;
  const label = new Date(timestamp).toLocaleString();
  return comment.updatedAt ? `${label} (edited)` : label;
}

function formatRelativeTimestamp(iso: string): string {
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

const MAX_LENGTH = 2000;

export function TaskComments({ task, onTaskUpdated, addToast, currentAuthor = "user" }: TaskCommentsProps) {
  const [draft, setDraft] = useState("");
  const [commentType, setCommentType] = useState<CommentType>("user");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Unified comments from task.comments (includes migrated steering comments)
  const comments = useMemo(() => task.comments || [], [task.comments]);

  // Legacy steering comments (if any still exist on the task)
  const steeringComments = useMemo(() => task.steeringComments || [], [task.steeringComments]);

  // All comments combined, sorted newest first
  const allComments = useMemo(() => {
    const combined = [...comments, ...steeringComments];
    return combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [comments, steeringComments]);

  // Determine if a comment is a steering/AI guidance comment
  const isSteeringComment = useCallback((comment: TaskComment): boolean => {
    // Check if from the steeringComments array
    if (steeringComments.some(sc => sc.id === comment.id)) return true;
    // Check if the author indicates it's an agent/AI comment
    if (comment.author === "agent" || comment.author === "system") return true;
    return false;
  }, [steeringComments]);

  const handleAddComment = useCallback(async () => {
    const text = draft.trim();
    if (!text || text.length > MAX_LENGTH || submitting) return;

    setSubmitting(true);
    try {
      let updated: Task;
      if (commentType === "steering") {
        updated = await addComment(task.id, text);
      } else {
        updated = await addTaskComment(task.id, text, currentAuthor);
      }
      setDraft("");
      onTaskUpdated?.(updated);
      addToast("Comment added", "success");
    } catch (error: any) {
      addToast(error.message || "Failed to add comment", "error");
    } finally {
      setSubmitting(false);
    }
  }, [draft, commentType, submitting, task.id, currentAuthor, onTaskUpdated, addToast]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void handleAddComment();
      }
    },
    [handleAddComment]
  );

  async function handleSaveEdit(commentId: string) {
    const text = editingText.trim();
    if (!text) return;
    setSubmitting(true);
    try {
      const updated = await updateTaskComment(task.id, commentId, text);
      setEditingId(null);
      setEditingText("");
      onTaskUpdated?.(updated);
      addToast("Comment updated", "success");
    } catch (error: any) {
      addToast(error.message || "Failed to update comment", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(commentId: string) {
    setDeletingId(commentId);
    try {
      const updated = await deleteTaskComment(task.id, commentId);
      onTaskUpdated?.(updated);
      addToast("Comment deleted", "success");
    } catch (error: any) {
      addToast(error.message || "Failed to delete comment", "error");
    } finally {
      setDeletingId(null);
    }
  }

  const isValid = draft.trim().length > 0 && draft.length <= MAX_LENGTH;

  return (
    <div className="detail-section">
      <h4>Comments</h4>

      {allComments.length === 0 ? (
        <div className="detail-log-empty">No comments yet.</div>
      ) : (
        <div className="detail-activity-list">
          {allComments.map((comment) => {
            const isSteering = isSteeringComment(comment);
            const canEdit = !isSteering && comment.author === currentAuthor;
            const isEditing = editingId === comment.id;
            return (
              <div key={comment.id} className="detail-log-entry">
                <div className="detail-log-header" style={{ justifyContent: "space-between", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {isSteering ? (
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "var(--accent-secondary, #8b5cf6)",
                          color: "#fff",
                          fontWeight: 500,
                        }}
                        data-testid="ai-guidance-badge"
                      >
                        AI Guidance
                      </span>
                    ) : (
                      <strong>{comment.author}</strong>
                    )}
                    <span className="detail-log-timestamp">
                      {isSteering
                        ? formatRelativeTimestamp(comment.createdAt)
                        : formatCommentTimestamp(comment)}
                    </span>
                  </div>
                  {canEdit && !isEditing ? (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-sm" onClick={() => {
                        setEditingId(comment.id);
                        setEditingText(comment.text);
                      }}>
                        Edit
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => void handleDelete(comment.id)}
                        disabled={deletingId === comment.id}
                      >
                        {deletingId === comment.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  ) : null}
                </div>
                {isEditing ? (
                  <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                    <textarea
                      value={editingText}
                      onChange={(event) => setEditingText(event.target.value)}
                      rows={3}
                      className="spec-editor-feedback"
                    />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setEditingId(null);
                          setEditingText("");
                        }}
                        disabled={submitting}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => void handleSaveEdit(comment.id)}
                        disabled={submitting || !editingText.trim()}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="detail-log-outcome"
                    style={{
                      whiteSpace: "pre-wrap",
                      ...(isSteering ? {
                        borderLeft: "3px solid var(--accent-secondary, #8b5cf6)",
                        paddingLeft: "12px",
                      } : {}),
                    }}
                  >
                    {comment.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {/* Comment type selector */}
        <div style={{ display: "flex", gap: 4 }}>
          <button
            className={`btn btn-sm${commentType === "user" ? " btn-primary" : ""}`}
            onClick={() => setCommentType("user")}
            type="button"
          >
            Comment
          </button>
          <button
            className={`btn btn-sm${commentType === "steering" ? " btn-primary" : ""}`}
            onClick={() => setCommentType("steering")}
            type="button"
          >
            AI Guidance
          </button>
        </div>
        {commentType === "steering" && (
          <p style={{ fontSize: "12px", opacity: 0.7, margin: 0 }}>
            AI Guidance comments are injected into the task execution context to guide the agent.
          </p>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder={commentType === "steering"
            ? "Add guidance for the AI agent… (Ctrl+Enter to submit)"
            : "Add a comment… (Ctrl+Enter to submit)"}
          className="spec-editor-feedback"
          maxLength={MAX_LENGTH}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: "12px",
              opacity: draft.length > MAX_LENGTH ? 0.9 : 0.5,
              color: draft.length > MAX_LENGTH ? "var(--error, #ef4444)" : "inherit",
            }}
          >
            {draft.length} / {MAX_LENGTH}
          </span>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void handleAddComment()}
            disabled={!isValid || submitting}
          >
            {submitting ? "Posting…" : commentType === "steering" ? "Add Guidance" : "Add Comment"}
          </button>
        </div>
      </div>
    </div>
  );
}
