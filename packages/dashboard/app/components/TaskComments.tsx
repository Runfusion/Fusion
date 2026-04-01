import { useMemo, useState } from "react";
import type { Task, TaskComment } from "@kb/core";
import { addTaskComment, updateTaskComment, deleteTaskComment } from "../api";
import type { ToastType } from "../hooks/useToast";

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

export function TaskComments({ task, onTaskUpdated, addToast, currentAuthor = "user" }: TaskCommentsProps) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const comments = useMemo(() => task.comments || [], [task.comments]);

  async function handleAddComment() {
    const text = draft.trim();
    if (!text) return;
    setSubmitting(true);
    try {
      const updated = await addTaskComment(task.id, text, currentAuthor);
      setDraft("");
      onTaskUpdated?.(updated);
      addToast("Comment added", "success");
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
            return (
              <div key={comment.id} className="detail-log-entry">
                <div className="detail-log-header" style={{ justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <strong>{comment.author}</strong>
                    <span className="detail-log-timestamp" style={{ marginLeft: 8 }}>
                      {formatCommentTimestamp(comment)}
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
                  <div className="detail-log-outcome" style={{ whiteSpace: "pre-wrap" }}>
                    {comment.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          placeholder="Add a comment"
          className="spec-editor-feedback"
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-primary btn-sm" onClick={() => void handleAddComment()} disabled={submitting || !draft.trim()}>
            {submitting ? "Posting…" : "Add Comment"}
          </button>
        </div>
      </div>
    </div>
  );
}
