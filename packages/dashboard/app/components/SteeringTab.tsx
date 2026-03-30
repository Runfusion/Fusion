import { useState, useCallback } from "react";
import type { TaskDetail } from "@kb/core";
import { addSteeringComment } from "../api";
import type { ToastType } from "../hooks/useToast";

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

interface SteeringTabProps {
  task: TaskDetail;
  addToast: (message: string, type?: ToastType) => void;
}

export function SteeringTab({ task, addToast }: SteeringTabProps) {
  const [comments, setComments] = useState(task.steeringComments || []);
  const [newComment, setNewComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const MAX_LENGTH = 2000;

  const handleSubmit = useCallback(async () => {
    if (!newComment.trim() || newComment.length > MAX_LENGTH || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const updated = await addSteeringComment(task.id, newComment.trim());
      setComments(updated.steeringComments || []);
      setNewComment("");
      addToast("Steering comment added", "success");
    } catch (err: any) {
      addToast(err.message, "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [task.id, newComment, isSubmitting, addToast]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const isValid = newComment.trim().length > 0 && newComment.length <= MAX_LENGTH;

  return (
    <div className="detail-section">
      <h4>Steering Comments</h4>
      <p style={{ fontSize: "13px", opacity: 0.7, marginBottom: "12px" }}>
        Add comments to guide the AI during task execution. These are injected into the execution context.
      </p>

      {comments.length > 0 ? (
        <div className="detail-activity-list" style={{ marginBottom: "16px" }}>
          {[...comments].reverse().map((comment) => (
            <div key={comment.id} className="detail-log-entry">
              <div className="detail-log-header">
                <span
                  className="detail-log-timestamp"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      background:
                        comment.author === "user"
                          ? "var(--accent-primary, #6366f1)"
                          : "var(--accent-secondary, #8b5cf6)",
                      color: "#fff",
                    }}
                  >
                    {comment.author}
                  </span>
                  {formatTimestamp(comment.createdAt)}
                </span>
              </div>
              <div
                style={{
                  marginTop: "4px",
                  padding: "8px 12px",
                  background: "var(--bg-secondary, #1a1a2e)",
                  borderRadius: "6px",
                  border: "1px solid var(--border, #333)",
                  fontSize: "14px",
                  lineHeight: "1.5",
                  whiteSpace: "pre-wrap",
                }}
              >
                {comment.text}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ opacity: 0.5, marginBottom: "16px" }}>(no steering comments yet)</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a steering comment... (Ctrl+Enter to submit)"
          maxLength={MAX_LENGTH}
          rows={4}
          style={{
            width: "100%",
            padding: "12px",
            fontSize: "14px",
            fontFamily: "inherit",
            background: "var(--bg-secondary, #1a1a2e)",
            border: "1px solid var(--border, #333)",
            borderRadius: "6px",
            color: "inherit",
            resize: "vertical",
          }}
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
              opacity: newComment.length > MAX_LENGTH ? 0.9 : 0.5,
              color:
                newComment.length > MAX_LENGTH
                  ? "var(--error, #ef4444)"
                  : "inherit",
            }}
          >
            {newComment.length} / {MAX_LENGTH}
          </span>
          <button
            className="btn btn-sm btn-primary"
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting ? "Adding…" : "Add Steering Comment"}
          </button>
        </div>
      </div>
    </div>
  );
}
