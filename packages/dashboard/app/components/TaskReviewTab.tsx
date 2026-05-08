import "./TaskReviewTab.css";
import type { Task, TaskDetail } from "@fusion/core";
import { useMemo, useState } from "react";
import { refreshTaskReview, reviseTaskReviewItems } from "../api";
import type { ToastType } from "../hooks/useToast";

interface Props {
  task: Task | TaskDetail;
  projectId?: string;
  onTaskUpdated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
}

function formatTimestamp(value?: string): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export function TaskReviewTab({ task, projectId, onTaskUpdated, addToast }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = task.reviewState;
  const canRevise = selected.length > 0 && !revising;
  const isPrMode = review?.source === "pull-request";

  const summaryText = useMemo(() => {
    if (!review) return "No review feedback captured yet.";
    const decision = review.summary?.reviewDecision ?? "REVIEW_REQUIRED";
    return `${decision} · ${review.items.length} review item(s)`;
  }, [review]);

  const decisionLabel = review?.summary?.reviewDecision ?? undefined;

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  };

  const onRefresh = async () => {
    try {
      setError(null);
      setRefreshing(true);
      const result = await refreshTaskReview(task.id, projectId);
      onTaskUpdated?.({ ...task, reviewState: result.reviewState } as Task);
      addToast("Review refreshed", "success");
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : "Failed to refresh review";
      setError(message);
      addToast(message, "error");
    } finally {
      setRefreshing(false);
    }
  };

  const onRevise = async () => {
    try {
      setError(null);
      setRevising(true);
      const result = await reviseTaskReviewItems(task.id, selected, projectId);
      onTaskUpdated?.({ ...result.task, reviewState: result.reviewState } as Task);
      setSelected([]);
      addToast("Queued same-task revision", "success");
    } catch (reviseError) {
      const message = reviseError instanceof Error ? reviseError.message : "Failed to queue revision";
      setError(message);
      addToast(message, "error");
    } finally {
      setRevising(false);
    }
  };

  return (
    <div className="task-review-tab">
      <div className="task-review-tab__header">
        <div className="task-review-tab__summary-wrap">
          <p className="task-review-tab__summary">{summaryText}</p>
          {decisionLabel ? (
            <span className={`task-review-tab__decision task-review-tab__decision--${decisionLabel}`}>{decisionLabel}</span>
          ) : null}
        </div>
        <div className="task-review-tab__actions">
          <button className="btn btn-sm" onClick={onRefresh} disabled={refreshing || !isPrMode}>{refreshing ? "Refreshing…" : "Refresh"}</button>
          <button className="btn btn-primary btn-sm" disabled={!canRevise || !isPrMode} onClick={onRevise}>{revising ? "Queueing…" : "Request revision"}</button>
        </div>
      </div>
      <div className="task-review-tab__meta">Last refreshed: {formatTimestamp(review?.lastRefreshedAt)}</div>
      {error ? <div className="task-review-tab__error">{error}</div> : null}
      {!isPrMode ? (
        <div className="task-review-tab__empty">GitHub PR review details are only available when auto-merge uses Pull Request mode. Reviewer-agent feedback will appear here in direct mode.</div>
      ) : null}
      {isPrMode && review?.summary?.reviewers?.length ? (
        <ul className="task-review-tab__reviewers">
          {review.summary.reviewers.map((reviewer) => (
            <li key={`${reviewer.login}-${reviewer.state}`} className="task-review-tab__reviewer">@{reviewer.login} · {reviewer.state}</li>
          ))}
        </ul>
      ) : null}
      {isPrMode && review?.summary?.blockingReasons?.length ? (
        <ul className="task-review-tab__blockers">
          {review.summary.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
      {isPrMode && review?.items?.length ? (
        <ul className="task-review-tab__list">
          {review.items.map((item) => {
            const status = review?.addressing.find((record) => record.itemId === item.id)?.status ?? "queued";
            return (
              <li key={item.id} className="task-review-tab__item card">
                <label className="task-review-tab__row">
                  <input
                    type="checkbox"
                    checked={selected.includes(item.id)}
                    onChange={() => toggleSelected(item.id)}
                  />
                  <span className="task-review-tab__item-summary">{item.path ? `${item.path}: ` : ""}{item.body}</span>
                  <span className={`task-review-tab__status task-review-tab__status--${status}`}>{status}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : isPrMode ? (
        <div className="task-review-tab__empty">No review items yet.</div>
      ) : null}
    </div>
  );
}
