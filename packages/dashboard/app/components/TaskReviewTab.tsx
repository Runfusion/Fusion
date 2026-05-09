import "./TaskReviewTab.css";
import type { Task, TaskDetail } from "@fusion/core";
import { useEffect, useMemo, useState } from "react";
import { fetchTaskReview, refreshTaskReview, reviseTaskReviewItems } from "../api";
import type { SelectedReviewItem } from "../api";
import type { ToastType } from "../hooks/useToast";

interface Props {
  task: Task | TaskDetail;
  projectId?: string;
  onTaskUpdated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
}

const REVIEW_LOAD_ERROR_MESSAGE = "Failed to load review data.";
const DIRECT_MODE_EMPTY_MESSAGE =
  "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.";

function formatTimestamp(value?: string): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function formatRefreshSource(source?: "manual" | "auto" | "initial-load"): string {
  if (source === "manual") return "Manual";
  if (source === "auto") return "Background";
  return "Initial load";
}

type ReviewItem = NonNullable<TaskDetail["reviewState"]>["items"][number];

function getItemStatus(review: NonNullable<TaskDetail["reviewState"]>, item: ReviewItem): "queued" | "in-progress" | "addressed" | "failed" {
  return review.addressing.find((record) => record.itemId === item.id)?.status ?? "queued";
}

export function TaskReviewTab({ task, projectId, onTaskUpdated, addToast }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [review, setReview] = useState(task.reviewState ?? null);

  const canRevise = selected.length > 0 && !revising;
  const isPrMode = review?.source === "pull-request";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchTaskReview(task.id, projectId)
      .then((result) => {
        if (cancelled) return;
        setReview(result.reviewState);
        setEmptyMessage(result.emptyMessage ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setError(REVIEW_LOAD_ERROR_MESSAGE);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, projectId]);

  const summaryText = useMemo(() => {
    if (!review) return "No review feedback captured yet.";
    if (review.source === "pull-request") {
      const prSummary = review.summary as { reviewDecision?: string } | undefined;
      return `${prSummary?.reviewDecision ?? "REVIEW_REQUIRED"} · ${review.items.length} review item(s)`;
    }
    const reviewerSummary = review.summary as { summary?: string } | undefined;
    return `${reviewerSummary?.summary ?? "reviewer-agent"} · ${review.items.length} review item(s)`;
  }, [review]);

  const decisionLabel = !review
    ? undefined
    : review.source === "pull-request"
      ? (review.summary as { reviewDecision?: string } | undefined)?.reviewDecision
      : (review.summary as { verdict?: string } | undefined)?.verdict;

  const refreshStatus = refreshing ? "refreshing" : (review?.refreshStatus ?? "ready");
  const refreshToneClass =
    refreshStatus === "error"
      ? "status-dot status-dot--error"
      : refreshStatus === "refreshing"
        ? "status-dot status-dot--pending"
        : "status-dot status-dot--online";
  const refreshLabel =
    refreshStatus === "error"
      ? "Refresh failed"
      : refreshStatus === "refreshing"
        ? "Refreshing"
        : "Up to date";

  const toggleSelected = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  };

  const onRefresh = async () => {
    try {
      setError(null);
      setRefreshing(true);
      const result = await refreshTaskReview(task.id, projectId);
      setReview(result.reviewState);
      onTaskUpdated?.({ ...task, reviewState: result.reviewState, prInfo: result.prInfo ?? task.prInfo } as Task);
      if (result.reviewState.refreshStatus === "error") {
        const refreshMessage = result.reviewState.refreshError ?? "Failed to refresh review data.";
        setError(refreshMessage);
        addToast(refreshMessage, "error");
        return;
      }
      setError(null);
      addToast("Review refreshed", "success");
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : REVIEW_LOAD_ERROR_MESSAGE;
      setError(message);
      addToast(message, "error");
    } finally {
      setRefreshing(false);
    }
  };

  const onRevise = async () => {
    try {
      if (!review) return;
      setError(null);
      setRevising(true);
      const selectedItems: SelectedReviewItem[] = review.items
        .filter((item) => selected.includes(item.id))
        .map((item) => {
          const itemRecord = item as unknown as Record<string, unknown>;
          return {
            id: item.id,
            source: review.source === "pull-request" ? "pr-review" : "reviewer-agent",
            threadId: typeof itemRecord.threadId === "string" ? itemRecord.threadId : undefined,
            filePath: item.path,
            lineNumber: typeof itemRecord.line === "number" ? itemRecord.line : undefined,
            author: item.author?.login,
            summary: item.summary ?? item.body.slice(0, 120),
            body: item.body,
            url: typeof itemRecord.url === "string" ? itemRecord.url : undefined,
          };
        });
      const result = await reviseTaskReviewItems(task.id, selectedItems, projectId);
      setReview(result.reviewState);
      onTaskUpdated?.({ ...result.task, reviewState: result.reviewState } as Task);
      setSelected([]);
      addToast("Same-task AI revision started from selected review feedback", "success");
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
          <button className="btn btn-sm" onClick={onRefresh} disabled={refreshing || loading}>{refreshing ? "Refreshing…" : "Refresh"}</button>
          <button className="btn btn-primary btn-sm" disabled={!canRevise} onClick={onRevise}>{revising ? "Queueing…" : "Request revision"}</button>
        </div>
      </div>
      <div className="task-review-tab__meta task-review-tab__refresh-meta" aria-live="polite">
        <span className={refreshToneClass} aria-hidden="true" />
        <span>{refreshLabel} · Last refreshed: {formatTimestamp(review?.lastRefreshedAt)} · {formatRefreshSource(review?.refreshSource)}</span>
      </div>
      {loading ? <div className="task-review-tab__meta">Loading review data…</div> : null}
      {!loading && error ? <div className="task-review-tab__error">{error}</div> : null}
      {!loading && !error && !isPrMode && review?.items?.length === 0 ? (
        <div className="task-review-tab__empty">{emptyMessage ?? DIRECT_MODE_EMPTY_MESSAGE}</div>
      ) : null}
      {isPrMode && review?.summary && "reviewers" in review.summary && review.summary.reviewers?.length ? (
        <ul className="task-review-tab__reviewers">
          {review.summary.reviewers.map((reviewer) => (
            <li key={`${reviewer.login}-${reviewer.state}`} className="task-review-tab__reviewer">@{reviewer.login} · {reviewer.state}</li>
          ))}
        </ul>
      ) : null}
      {isPrMode && review?.summary && "blockingReasons" in review.summary && review.summary.blockingReasons?.length ? (
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
      ) : null}
      {!loading && !error && !isPrMode && review?.items?.length ? (
        <ul className="task-review-tab__list">
          {review.items
            .slice()
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .map((item) => {
              const status = getItemStatus(review, item);
              return (
                <li key={item.id} className="task-review-tab__item card">
                  <label className="task-review-tab__direct-item task-review-tab__direct-item--selectable">
                    <div className="task-review-tab__summary-wrap">
                      <input
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        onChange={() => toggleSelected(item.id)}
                      />
                      <span className="task-review-tab__decision">reviewer-agent</span>
                      {item.reviewType ? <span className="task-review-tab__meta">{item.reviewType} review</span> : null}
                      {typeof item.step === "number" ? <span className="task-review-tab__meta">Step {item.step}</span> : null}
                      {item.verdict ? <span className="task-review-tab__decision">{item.verdict}</span> : null}
                      <span className={`task-review-tab__status task-review-tab__status--${status}`}>{status}</span>
                    </div>
                    {item.summary ? <p className="task-review-tab__summary">{item.summary}</p> : null}
                    <div className="task-review-tab__meta">{formatTimestamp(item.createdAt)}</div>
                    <pre className="task-review-tab__body">{item.body}</pre>
                  </label>
                </li>
              );
            })}
        </ul>
      ) : null}
      {isPrMode && !loading && !error && !review?.items?.length ? <div className="task-review-tab__empty">No review items yet.</div> : null}
    </div>
  );
}
