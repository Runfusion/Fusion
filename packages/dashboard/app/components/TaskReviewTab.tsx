import "./TaskReviewTab.css";
import type { Task, TaskDetail } from "@fusion/core";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
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
const DIRECT_MODE_EMPTY_MESSAGE = "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.";
const REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY = "fn-task-review-markdown";

type ReviewState = NonNullable<TaskDetail["reviewState"]>;
type ReviewItem = ReviewState["items"][number];
type AddressingRecord = ReviewState["addressing"][number];

type DisplayReviewItem = {
  id: string;
  summary: string;
  body: string;
  path?: string;
  createdAt?: string;
  status: "queued" | "in-progress" | "addressed" | "failed";
  addressing?: AddressingRecord;
  item?: ReviewItem;
};

function readBooleanPref(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "true";
  } catch {
    return defaultValue;
  }
}

function writeBooleanPref(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // ignore storage failures (quota, private mode, etc.)
  }
}

const markdownComponents: Components = {
  pre: ({ children, ...props }) => (
    <pre
      {...props}
      style={{
        overflowX: "auto",
        maxWidth: "100%",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <table
      {...props}
      style={{
        display: "block",
        overflowX: "auto",
        maxWidth: "100%",
      }}
    >
      {children}
    </table>
  ),
};

function formatTimestamp(value?: string): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function formatRefreshSource(source?: "manual" | "auto" | "initial-load"): string {
  if (source === "manual") return "Manual";
  if (source === "auto") return "Background";
  return "Initial load";
}

function getDisplayReviewItems(review: ReviewState): DisplayReviewItem[] {
  const addressingById = new Map(review.addressing.map((record) => [record.itemId, record] as const));
  const items = review.items.map((item) => {
    const addressing = addressingById.get(item.id);
    return {
      id: item.id,
      summary: item.summary ?? item.body.slice(0, 120),
      body: item.body,
      path: item.path,
      createdAt: item.createdAt,
      status: addressing?.status ?? "queued",
      addressing,
      item,
    } satisfies DisplayReviewItem;
  });

  const existingIds = new Set(items.map((item) => item.id));
  const snapshots = review.addressing
    .filter((record) => !existingIds.has(record.itemId) && record.snapshot)
    .map((record) => ({
      id: record.itemId,
      summary: record.snapshot?.summary ?? record.itemId,
      body: record.snapshot?.body ?? record.snapshot?.summary ?? record.itemId,
      path: record.snapshot?.filePath,
      createdAt: record.selectedAt,
      status: record.status,
      addressing: record,
    } satisfies DisplayReviewItem));

  return [...items, ...snapshots];
}

export function TaskReviewTab({ task, projectId, onTaskUpdated, addToast }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [review, setReview] = useState(task.reviewState ?? null);
  const [renderMarkdown, setRenderMarkdown] = useState<boolean>(() => readBooleanPref(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY, true));

  const canRevise = selected.length > 0 && !revising;
  const isPrMode = review?.source === "pull-request";
  const displayItems = useMemo(() => (review ? getDisplayReviewItems(review) : []), [review]);

  useEffect(() => {
    writeBooleanPref(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY, renderMarkdown);
  }, [renderMarkdown]);

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
      return `${prSummary?.reviewDecision ?? "REVIEW_REQUIRED"} · ${displayItems.length} review item(s)`;
    }
    const reviewerSummary = review.summary as { summary?: string } | undefined;
    return `${reviewerSummary?.summary ?? "reviewer-agent"} · ${displayItems.length} review item(s)`;
  }, [review, displayItems.length]);

  const decisionLabel = !review
    ? undefined
    : review.source === "pull-request"
      ? (review.summary as { reviewDecision?: string } | undefined)?.reviewDecision
      : (review.summary as { verdict?: string } | undefined)?.verdict;

  const refreshStatus = refreshing ? "refreshing" : (review?.refreshStatus ?? "ready");
  const refreshToneClass = refreshStatus === "error"
    ? "status-dot status-dot--error"
    : refreshStatus === "refreshing"
      ? "status-dot status-dot--pending"
      : "status-dot status-dot--online";

  const toggleSelected = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));

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
      const selectedItems: SelectedReviewItem[] = displayItems
        .filter((item) => selected.includes(item.id))
        .map((item) => {
          if (!item.item) {
            return {
              id: item.id,
              source: review.source === "pull-request" ? "pr-review" : "reviewer-agent",
              threadId: item.addressing?.snapshot?.threadId,
              filePath: item.addressing?.snapshot?.filePath,
              lineNumber: item.addressing?.snapshot?.lineNumber,
              author: item.addressing?.snapshot?.authorLogin,
              summary: item.summary,
              body: item.body,
              url: item.addressing?.snapshot?.url,
            };
          }

          const itemRecord = item.item as unknown as Record<string, unknown>;
          return {
            id: item.item.id,
            source: review.source === "pull-request" ? "pr-review" : "reviewer-agent",
            threadId: typeof itemRecord.threadId === "string" ? itemRecord.threadId : undefined,
            filePath: item.item.path,
            lineNumber: typeof itemRecord.line === "number" ? itemRecord.line : undefined,
            author: item.item.author?.login,
            summary: item.item.summary ?? item.item.body.slice(0, 120),
            body: item.item.body,
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
          {decisionLabel ? <span className={`task-review-tab__decision task-review-tab__decision--${decisionLabel}`}>{decisionLabel}</span> : null}
        </div>
        <div className="task-review-tab__actions">
          <button
            className="btn btn-sm"
            onClick={() => setRenderMarkdown((prev) => !prev)}
            aria-pressed={renderMarkdown}
            data-testid="task-review-markdown-toggle"
            title={renderMarkdown ? "Show raw text" : "Show formatted markdown"}
          >
            {renderMarkdown ? "Markdown" : "Plain"}
          </button>
          <button className="btn btn-sm" onClick={onRefresh} disabled={refreshing || loading}>{refreshing ? "Refreshing…" : "Refresh"}</button>
          <button className="btn btn-primary btn-sm" disabled={!canRevise} onClick={onRevise}>{revising ? "Queueing…" : "Request revision"}</button>
        </div>
      </div>
      <div className="task-review-tab__meta task-review-tab__refresh-meta" aria-live="polite">
        <span className={refreshToneClass} aria-hidden="true" />
        <span>{refreshStatus === "error" ? "Refresh failed" : refreshStatus === "refreshing" ? "Refreshing" : "Up to date"} · Last refreshed: {formatTimestamp(review?.lastRefreshedAt)} · {formatRefreshSource(review?.refreshSource)}</span>
      </div>
      {loading ? <div className="task-review-tab__meta">Loading review data…</div> : null}
      {!loading && error ? <div className="task-review-tab__error">{error}</div> : null}
      {!loading && !error && !isPrMode && displayItems.length === 0 ? <div className="task-review-tab__empty">{emptyMessage ?? DIRECT_MODE_EMPTY_MESSAGE}</div> : null}
      {!loading && !error && displayItems.length > 0 ? (
        <ul className="task-review-tab__list">
          {displayItems.map((item) => {
            const checkboxId = `task-review-item-${item.id}`;

            return (
              <li key={item.id} className="task-review-tab__item card">
                <div className="task-review-tab__item-inner">
                  <label htmlFor={checkboxId} className="task-review-tab__direct-item task-review-tab__direct-item--selectable">
                    <div className="task-review-tab__summary-wrap">
                      <input id={checkboxId} type="checkbox" checked={selected.includes(item.id)} onChange={() => toggleSelected(item.id)} />
                      <span className="task-review-tab__item-summary">{item.path ? `${item.path}: ` : ""}{item.summary}</span>
                      <span className={`task-review-tab__status task-review-tab__status--${item.status}`}>{item.status}</span>
                    </div>
                    <div className="task-review-tab__meta">{formatTimestamp(item.createdAt)}</div>
                    {item.addressing ? (
                      <div className="task-review-tab__meta">Selected: {formatTimestamp(item.addressing.selectedAt)}{item.addressing.startedAt ? ` · Started: ${formatTimestamp(item.addressing.startedAt)}` : ""}{item.addressing.completedAt ? ` · Completed: ${formatTimestamp(item.addressing.completedAt)}` : ""}{item.addressing.error ? ` · Error: ${item.addressing.error}` : ""}</div>
                    ) : null}
                  </label>
                  {renderMarkdown ? (
                    <div className="task-review-tab__body markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {item.body}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <pre className="task-review-tab__body">{item.body}</pre>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {isPrMode && !loading && !error && displayItems.length === 0 ? <div className="task-review-tab__empty">No review items yet.</div> : null}
    </div>
  );
}
