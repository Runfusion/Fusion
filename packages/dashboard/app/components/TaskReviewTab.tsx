import "./TaskReviewTab.css";
import { getErrorMessage, type Task, type TaskDetail } from "@fusion/core";
import { resolveEffectiveAutoMerge } from "../../../core/src/task-merge";
import { GitPullRequest } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { fetchTaskReview, refreshTaskReview, reviseTaskReviewItems, updateTask } from "../api";
import type { SelectedReviewItem } from "../api";
import type { ToastType } from "../hooks/useToast";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";
import { LoadingSpinner } from "./LoadingSpinner";

interface Props {
  task: Task | TaskDetail;
  projectId?: string;
  onTaskUpdated?: (task: Task) => void;
  onRequestCreatePr?: () => void;
  prAuthAvailable?: boolean;
  autoMergeEnabled?: boolean;
  addToast: (message: string, type?: ToastType) => void;
}

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
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  code: ({ children, ...props }) => <code {...props}>{linkifyReactChildren(children)}</code>,
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
      {linkifyReactChildren(children)}
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

function formatTimestamp(value?: string, t?: (key: string, defaultValue: string) => string): string {
  if (!value) return t?.("taskReview.never", "Never") ?? "Never";
  return new Date(value).toLocaleString();
}

function formatRefreshSource(source?: "manual" | "auto" | "initial-load", t?: (key: string, defaultValue: string) => string): string {
  if (source === "manual") return t?.("taskReview.refreshSourceManual", "Manual") ?? "Manual";
  if (source === "auto") return t?.("taskReview.refreshSourceBackground", "Background") ?? "Background";
  return t?.("taskReview.refreshSourceInitialLoad", "Initial load") ?? "Initial load";
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

export function TaskReviewTab({
  task,
  projectId,
  onTaskUpdated,
  onRequestCreatePr,
  prAuthAvailable,
  autoMergeEnabled = false,
  addToast,
}: Props) {
  const { t } = useTranslation("app");
  const [selected, setSelected] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [review, setReview] = useState(task.reviewState ?? null);
  const [renderMarkdown, setRenderMarkdown] = useState<boolean>(() => readBooleanPref(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY, true));
  const [autoMergePreference, setAutoMergePreference] = useState<"follow-default" | "on" | "off">(
    task.autoMerge === true ? "on" : task.autoMerge === false ? "off" : "follow-default",
  );
  const [isSavingAutoMergePreference, setIsSavingAutoMergePreference] = useState(false);

  const canRevise = selected.length > 0 && !revising;
  const isPrMode = review?.source === "pull-request";
  const displayItems = useMemo(() => (review ? getDisplayReviewItems(review) : []), [review]);

  useEffect(() => {
    writeBooleanPref(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY, renderMarkdown);
  }, [renderMarkdown]);

  useEffect(() => {
    setAutoMergePreference(task.autoMerge === true ? "on" : task.autoMerge === false ? "off" : "follow-default");
  }, [task.autoMerge]);

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
        setError(t("taskReview.loadError", "Failed to load review data."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, projectId, t]);

  const summaryText = useMemo(() => {
    if (!review) return t("taskReview.noCapturedFeedback", "No review feedback captured yet.");
    if (review.source === "pull-request") {
      const prSummary = review.summary as { reviewDecision?: string } | undefined;
      return t("taskReview.prSummaryLine", "{{decision}} · {{count}} review item(s)", {
        decision: prSummary?.reviewDecision ?? "REVIEW_REQUIRED",
        count: displayItems.length,
      });
    }
    const reviewerSummary = review.summary as { summary?: string } | undefined;
    return t("taskReview.reviewerSummaryLine", "{{reviewer}} · {{count}} review item(s)", {
      reviewer: reviewerSummary?.summary ?? "reviewer-agent",
      count: displayItems.length,
    });
  }, [review, displayItems.length, t]);

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
        const refreshMessage = result.reviewState.refreshError ?? t("taskReview.refreshDataFailed", "Failed to refresh review data.");
        setError(refreshMessage);
        addToast(refreshMessage, "error");
        return;
      }
      addToast(t("taskReview.refreshed", "Review refreshed"), "success");
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : t("taskReview.loadError", "Failed to load review data.");
      setError(message);
      addToast(message, "error");
    } finally {
      setRefreshing(false);
    }
  };

  const onAutoMergePreferenceChange = async (nextPreference: "follow-default" | "on" | "off") => {
    const previousPreference = autoMergePreference;
    setAutoMergePreference(nextPreference);
    setIsSavingAutoMergePreference(true);

    try {
      const autoMerge = nextPreference === "follow-default" ? null : nextPreference === "on";
      const updatedTask = await updateTask(task.id, { autoMerge }, projectId);
      setAutoMergePreference(updatedTask.autoMerge === true ? "on" : updatedTask.autoMerge === false ? "off" : "follow-default");
      onTaskUpdated?.(updatedTask);
      addToast(t("taskReview.autoMergePreferenceUpdated", "Per-task auto-merge preference updated"), "success");
    } catch (updateError) {
      setAutoMergePreference(previousPreference);
      addToast(t("taskReview.updateFailed", "Failed to update {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(updateError) }), "error");
    } finally {
      setIsSavingAutoMergePreference(false);
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
      addToast(t("taskReview.revisionStarted", "Same-task AI revision started from selected review feedback"), "success");
    } catch (reviseError) {
      const message = reviseError instanceof Error ? reviseError.message : t("taskReview.revisionQueueFailed", "Failed to queue revision");
      setError(message);
      addToast(message, "error");
    } finally {
      setRevising(false);
    }
  };

  const effectiveAutoMerge = resolveEffectiveAutoMerge({ autoMerge: task.autoMerge }, { autoMerge: autoMergeEnabled });
  const effectiveAutoMergeLabel = effectiveAutoMerge ? t("taskReview.autoMergeOn", "Auto-merge on") : t("taskReview.autoMergeOff", "Auto-merge off");

  return (
    <div className="task-review-tab">
      <div className="task-review-tab__header">
        <div className="task-review-tab__summary-wrap">
          <div className="task-review-tab__summary-group">
            <p className="task-review-tab__summary">{summaryText}</p>
            {decisionLabel ? <span className={`task-review-tab__decision task-review-tab__decision--${decisionLabel}`}>{decisionLabel}</span> : null}
          </div>
        </div>
        <div className="task-review-tab__actions">
          <div className="task-review-tab__auto-merge-control">
            <label htmlFor="task-review-auto-merge-select" className="form-label">{t("taskReview.perTaskAutoMerge", "Per-task auto-merge")}</label>
            <select
              id="task-review-auto-merge-select"
              className="select"
              value={autoMergePreference}
              onChange={(event) => void onAutoMergePreferenceChange(event.target.value as "follow-default" | "on" | "off")}
              disabled={isSavingAutoMergePreference}
              data-testid="task-review-auto-merge-select"
            >
              <option value="follow-default">{t("taskReview.followDefault", "Follow default")}</option>
              <option value="on">{t("taskReview.autoMergeOn", "Auto-merge on")}</option>
              <option value="off">{t("taskReview.autoMergeOff", "Auto-merge off")}</option>
            </select>
            <div className="task-review-tab__meta" data-testid="task-review-auto-merge-effective-hint">
              {task.column === "in-review"
                ? t("taskReview.effectiveFrozen", "Effective: {{label}} — frozen on entry to review", { label: effectiveAutoMergeLabel })
                : t("taskReview.effective", "Effective: {{label}}", { label: effectiveAutoMergeLabel })}
            </div>
          </div>
          {task.column === "in-review" && !task.prInfo && prAuthAvailable === true && !effectiveAutoMerge && typeof onRequestCreatePr === "function" ? (
            <button className="btn btn-sm" onClick={() => onRequestCreatePr?.()} data-testid="task-review-create-pr">
              <GitPullRequest />
              {t("taskReview.createPr", "Create PR")}
            </button>
          ) : null}
          <button
            className="btn btn-sm"
            onClick={() => setRenderMarkdown((prev) => !prev)}
            aria-pressed={renderMarkdown}
            data-testid="task-review-markdown-toggle"
            title={renderMarkdown ? t("taskReview.showRawText", "Show raw text") : t("taskReview.showMarkdown", "Show formatted markdown")}
          >
            {renderMarkdown ? t("taskReview.markdown", "Markdown") : t("taskReview.plain", "Plain")}
          </button>
          <button className="btn btn-sm" onClick={onRefresh} disabled={refreshing || loading}>{refreshing ? t("taskReview.refreshing", "Refreshing…") : t("taskReview.refresh", "Refresh")}</button>
          <button className="btn btn-primary btn-sm" disabled={!canRevise} onClick={onRevise}>{revising ? t("taskReview.queueing", "Queueing…") : t("taskReview.requestRevision", "Request revision")}</button>
        </div>
      </div>
      <div className="task-review-tab__meta task-review-tab__refresh-meta" aria-live="polite">
        <span className={refreshToneClass} aria-hidden="true" />
        <span>{t("taskReview.refreshStatusLine", "{{status}} · Last refreshed: {{timestamp}} · {{source}}", {
          status: refreshStatus === "error" ? t("taskReview.refreshFailed", "Refresh failed") : refreshStatus === "refreshing" ? t("taskReview.refreshing", "Refreshing") : t("taskReview.upToDate", "Up to date"),
          timestamp: formatTimestamp(review?.lastRefreshedAt, t),
          source: formatRefreshSource(review?.refreshSource, t),
        })}</span>
      </div>
      {loading ? <div className="task-review-tab__meta"><LoadingSpinner label={t("taskReview.loadingData", "Loading review data…")} /></div> : null}
      {!loading && error ? <div className="task-review-tab__error">{error}</div> : null}
      {!loading && !error && !isPrMode && displayItems.length === 0 ? <div className="task-review-tab__empty">{emptyMessage ?? t("taskReview.noFeedbackDirect", "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.")}</div> : null}
      {!loading && !error && displayItems.length > 0 ? (
        <ul className="task-review-tab__list">
          {displayItems.map((item) => {
            const checkboxId = `task-review-item-checkbox-${item.id}`;

            return (
              <li key={item.id} className="task-review-tab__item card">
                <div className="task-review-tab__item-inner">
                  <label htmlFor={checkboxId} className="task-review-tab__direct-item task-review-tab__direct-item--selectable">
                    <div className="task-review-tab__item-header">
                      <div className="task-review-tab__item-selection">
                        <input id={checkboxId} type="checkbox" checked={selected.includes(item.id)} onChange={() => toggleSelected(item.id)} />
                        <span className="task-review-tab__item-summary">{item.path ? `${item.path}: ` : ""}{item.summary}</span>
                      </div>
                      <span className={`task-review-tab__status task-review-tab__status--${item.status}`}>{item.status}</span>
                    </div>
                  </label>
                  <div className="task-review-tab__item-meta-list">
                    <div className="task-review-tab__meta">{formatTimestamp(item.createdAt, t)}</div>
                    {item.addressing ? (
                      <div className="task-review-tab__meta">
                        {t("taskReview.selectedAt", "Selected: {{timestamp}}", { timestamp: formatTimestamp(item.addressing.selectedAt, t) })}
                        {item.addressing.startedAt ? t("taskReview.startedAtSep", " · Started: {{timestamp}}", { timestamp: formatTimestamp(item.addressing.startedAt, t) }) : ""}
                        {item.addressing.completedAt ? t("taskReview.completedAtSep", " · Completed: {{timestamp}}", { timestamp: formatTimestamp(item.addressing.completedAt, t) }) : ""}
                        {item.addressing.error ? t("taskReview.errorSep", " · Error: {{message}}", { message: item.addressing.error }) : ""}
                      </div>
                    ) : null}
                  </div>
                  {renderMarkdown ? (
                    <div className="task-review-tab__body markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {item.body}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <pre className="task-review-tab__body">{linkifyFilePaths(item.body)}</pre>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {isPrMode && !loading && !error && displayItems.length === 0 ? <div className="task-review-tab__empty">{t("taskReview.noReviewItems", "No review items yet.")}</div> : null}
    </div>
  );
}
