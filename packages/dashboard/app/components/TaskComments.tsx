import { useMemo, useState } from "react";
import type { Task, TaskComment } from "@fusion/core";
import { addSteeringComment, addTaskComment, updateTaskComment, deleteTaskComment } from "../api";
import type { ToastType } from "../hooks/useToast";

const MAX_COMMENT_LENGTH = 2000;

interface TaskCommentsProps {
  task: Task;
  onTaskUpdated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
  currentAuthor?: string;
}

type CommentType = "comment" | "guidance";

function formatCommentTimestamp(comment: TaskComment): string {
  const timestamp = comment.updatedAt || comment.createdAt;
  const label = new Date(timestamp).toLocaleString();
  return comment.updatedAt ? `${label} (edited)` : label;
}

function isAIGuidanceComment(author: string): boolean {
  return author === "agent" || author === "system";
}

export function TaskComments({ task, onTaskUpdated, addToast, currentAuthor = "user" }: TaskCommentsProps) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [commentType, setCommentType] = useState<CommentType>("comment");

  // Sort comments by createdAt descending (newest first)
  const comments = useMemo(() => {
    return [...(task.comments || [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [task.comments]);

  const isOverLimit = draft.length > MAX_COMMENT_LENGTH;

  async function handleAddComment() {
    const text = draft.trim();
    if (!text) return;
    setSubmitting(true);
    try {
      if (commentType === "guidance") {
        const updated = await addSteeringComment(task.id, text);
        setDraft("");
        onTaskUpdated?.(updated);
        addToast("AI Guidance added", "success");
      } else {
        const updated = await addTaskComment(task.id, text, currentAuthor);
        setDraft("");
        onTaskUpdated?.(updated);
        addToast("Comment added", "success");
      }
    } catch (error: any) {
      addToast(error.message || "Failed to add comment", "error");
    } finally {
      setSubmitting(false);
    }
  }

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

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void handleAddComment();
    }
  }

  const placeholder = commentType === "guidance" ? "Add guidance for the AI agent" : "Add a comment";
  const buttonLabel = commentType === "guidance" ? "Add Guidance" : "Add Comment";

  return (
    <div className="detail-section">
      <h4>Comments</h4>
      {comments.length === 0 ? (
        <div className="detail-log-empty">No comments yet.</div>
      ) : (
        <div className="detail-activity-list">
          {comments.map((comment) => {
            const canEdit = comment.author === currentAuthor;
            const isEditing = editingId === comment.id;
            const isAIGuidance = isAIGuidanceComment(comment.author);
            return (
              <div key={comment.id} className="detail-log-entry">
                <div className="detail-log-header comments-header-row">
                  <div className="comments-author-row">
                    {isAIGuidance ? (
                      <span className="ai-guidance-badge" data-testid="ai-guidance-badge">AI Guidance</span>
                    ) : (
                      <strong>{comment.author}</strong>
                    )}
                    <span className="detail-log-timestamp">
                      {formatCommentTimestamp(comment)}
                    </span>
                  </div>
                  {canEdit && !isEditing ? (
                    <div className="comments-actions-row">
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
                  <div className="comments-edit-form">
                    <textarea
                      value={editingText}
                      onChange={(event) => setEditingText(event.target.value)}
                      rows={3}
                      className="spec-editor-feedback"
                    />
                    <div className="comments-edit-actions">
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
                  <div className="detail-log-outcome comments-outcome-text">
                    {comment.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="comments-compose-form">
        <div className="comments-type-toggle">
          <button
            className={`btn btn-sm ${commentType === "comment" ? "btn-primary" : ""}`}
            onClick={() => setCommentType("comment")}
          >
            Comment
          </button>
          <button
            className={`btn btn-sm ${commentType === "guidance" ? "btn-primary" : ""}`}
            onClick={() => setCommentType("guidance")}
          >
            AI Guidance
          </button>
        </div>
        {commentType === "guidance" && (
          <div className="comments-guidance-hint">
            AI Guidance comments are injected into the task execution context
          </div>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder={placeholder}
          className="spec-editor-feedback"
        />
        <div className="comments-footer-row">
          <span className={`comments-char-count${isOverLimit ? " comments-char-count--over" : ""}`}>
            {draft.length} / {MAX_COMMENT_LENGTH}
          </span>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void handleAddComment()}
            disabled={submitting || !draft.trim() || isOverLimit}
          >
            {submitting ? "Posting…" : buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
