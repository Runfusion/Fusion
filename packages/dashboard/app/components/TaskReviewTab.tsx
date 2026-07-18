import "./TaskReviewTab.css";
import { getErrorMessage, isReviewArtifact, type PrCheckStatus, type Task, type TaskDetail, type TaskReviewSummary } from "@fusion/core";
import { resolveEffectiveAutoMerge } from "../../../core/src/task-merge";
import { Bot, ExternalLink, GitPullRequest, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { addressPrFeedback, fetchTaskReview, refreshTaskReview, reviseTaskReviewItems, updateTask } from "../api";
import type { SelectedReviewItem } from "../api";
import type { ToastType } from "../hooks/useToast";
import { linkifyFilePaths } from "../utils/filePathLinkify";
import { resolveReviewCommentAuthor } from "../utils/githubCommentAuthor";
import { canStartPrFeedbackAddressing, getTaskPrimaryPrInfo } from "../utils/prFeedback";
import { ArtifactsGallery } from "./ArtifactsGallery";
import { LoadingSpinner } from "./LoadingSpinner";
import { MailboxMessageContent } from "./MailboxMessageContent";
import { useArtifacts } from "../hooks/useArtifacts";

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
type AuthorTypeFilter = "all" | "human" | "bot";

const AUTHOR_TYPE_FILTERS: AuthorTypeFilter[] = ["all", "human", "bot"];

type ReviewState = NonNullable<TaskDetail["reviewState"]>;
type ReviewItem = ReviewState["items"][number];
type AddressingRecord = ReviewState["addressing"][number];

type DisplayReviewItem = {
  id: string;
  summary: string;
  body: string;
  author?: string;
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

const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

/*
FNXC:TaskReview 2026-06-27-00:00:
Review comments can include GitHub template comments. Plain-text mode must hide the same `<!-- -->` content as the shared sanitized markdown renderer so switching modes never leaks hidden reviewer templates.
*/
function stripHtmlComments(value: string): string {
  return value.replace(HTML_COMMENT_PATTERN, "").trim();
}

function formatTimestamp(value?: string, t?: (key: string, defaultValue: string) => string): string {
  if (!value) return t?.("taskReview.never", "Never") ?? "Never";
  return new Date(value).toLocaleString();
}

function formatRefreshSource(source?: "manual" | "auto" | "initial-load", t?: (key: string, defaultValue: string) => string): string {
  if (source === "manual") return t?.("taskReview.refreshSourceManual", "Manual") ?? "Manual";
  if (source === "auto") return t?.("taskReview.refreshSourceBackground", "Background") ?? "Background";
  return t?.("taskReview.refreshSourceInitialLoad", "Initial load") ?? "Initial load";
}

function summarizeChecks(checks: PrCheckStatus[] | undefined, t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string): string {
  const safeChecks = checks ?? [];
  if (safeChecks.length === 0) return t("taskReview.noChecksReported", "No checks reported");
  const requiredChecks = safeChecks.filter((check) => check.required).length;
  const successfulChecks = safeChecks.filter((check) => check.state === "success").length;
  const blockingChecks = safeChecks.filter((check) => check.required && check.state !== "success" && check.state !== "skipped" && check.state !== "neutral").length;
  return t("taskReview.checksSummary", "{{successful}}/{{total}} checks passing · {{required}} required · {{blocking}} blocking", {
    successful: successfulChecks,
    total: safeChecks.length,
    required: requiredChecks,
    blocking: blockingChecks,
  });
}

function getCheckTone(check: PrCheckStatus): "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" {
  if (check.state === "success" || check.state === "skipped" || check.state === "neutral") return "APPROVED";
  if (check.state === "pending" || check.state === "stale") return "REVIEW_REQUIRED";
  return "CHANGES_REQUESTED";
}

function getDisplayReviewItems(review: ReviewState): DisplayReviewItem[] {
  const addressingById = new Map(review.addressing.map((record) => [record.itemId, record] as const));
  const items = review.items.map((item) => {
    const addressing = addressingById.get(item.id);
    return {
      id: item.id,
      summary: item.summary ?? item.body.slice(0, 120),
      body: item.body,
      author: item.author?.login,
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
      author: record.snapshot?.authorLogin,
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
  const [authorTypeFilter, setAuthorTypeFilter] = useState<AuthorTypeFilter>("all");
  const [brokenAvatars, setBrokenAvatars] = useState<Set<string>>(new Set());
  const [autoMergePreference, setAutoMergePreference] = useState<"follow-default" | "on" | "off">(
    task.autoMerge === true ? "on" : task.autoMerge === false ? "off" : "follow-default",
  );
  const [isSavingAutoMergePreference, setIsSavingAutoMergePreference] = useState(false);
  const [addressingPrFeedback, setAddressingPrFeedback] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(max-width: 768px)").matches === true);
  const { artifacts } = useArtifacts({ projectId, taskId: task.id });
  const reviewArtifacts = useMemo(() => artifacts.filter(isReviewArtifact), [artifacts]);

  useEffect(() => {
    const query = typeof window === "undefined" ? undefined : window.matchMedia?.("(max-width: 768px)");
    if (!query) return;
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const isPrMode = review?.source === "pull-request";
  const prSummary = isPrMode ? review?.summary as TaskReviewSummary | undefined : undefined;
  const displayItems = useMemo(() => (review ? getDisplayReviewItems(review) : []), [review]);
  const filteredDisplayItems = useMemo(() => {
    if (authorTypeFilter === "all") return displayItems;
    return displayItems.filter((item) => {
      const authorInfo = resolveReviewCommentAuthor(item.author, { reviewSource: review?.source });
      return authorTypeFilter === "bot" ? authorInfo.authorIsBot : !authorInfo.authorIsBot;
    });
  }, [authorTypeFilter, displayItems]);
  const visibleItemIds = useMemo(() => new Set(filteredDisplayItems.map((item) => item.id)), [filteredDisplayItems]);
  const canRevise = selected.length > 0 && !revising;
  const canAddressPrFeedback = isPrMode
    && Boolean(getTaskPrimaryPrInfo(task))
    && (task.column === "in-review" || task.column === "in-progress")
    && (canStartPrFeedbackAddressing(task) || displayItems.length > 0);

  useEffect(() => {
    writeBooleanPref(REVIEW_MARKDOWN_TOGGLE_STORAGE_KEY, renderMarkdown);
  }, [renderMarkdown]);

  useEffect(() => {
    /*
    FNXC:TaskReview 2026-06-27-00:00:
    Author-type filtering makes hidden review comments non-actionable. Prune selected ids to the currently visible Human/Bot/All set so Request revision never submits an item the user filtered out of view.
    */
    setSelected((current) => current.filter((id) => visibleItemIds.has(id)));
  }, [visibleItemIds]);

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

  const onAddressPrFeedback = async () => {
    try {
      setError(null);
      setAddressingPrFeedback(true);
      const result = await addressPrFeedback(task.id, projectId);
      onTaskUpdated?.(result.task);
      addToast(t("taskReview.addressPrFeedbackStarted", "Addressing PR feedback — AI session started"), "success");
    } catch (addressError) {
      const message = addressError instanceof Error ? addressError.message : t("taskReview.addressPrFeedbackFailed", "Failed to start PR feedback session");
      setError(message);
      addToast(message, "error");
    } finally {
      setAddressingPrFeedback(false);
    }
  };

  const onRevise = async () => {
    try {
      if (!review) return;
      setError(null);
      setRevising(true);
      const selectedItems: SelectedReviewItem[] = filteredDisplayItems
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
            url: item.item.htmlUrl ?? (typeof itemRecord.url === "string" ? itemRecord.url : undefined),
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

  const renderAuthorFilter = displayItems.length > 0 ? (
    <div className="task-review-tab__comments-filter" data-testid="task-review-comments-filter" role="group" aria-label={t("taskReview.filterCommentsAriaLabel", "Filter review comments by author type")}>
      {AUTHOR_TYPE_FILTERS.map((mode) => (
        <button
          key={mode}
          type="button"
          className={`task-review-tab__comments-filter-chip ${authorTypeFilter === mode ? "active" : ""}`}
          aria-pressed={authorTypeFilter === mode}
          data-filter={mode}
          onClick={() => setAuthorTypeFilter(mode)}
        >
          {mode === "all"
            ? t("taskReview.filterAll", "All")
            : mode === "human"
              ? t("taskReview.filterHuman", "Human")
              : t("taskReview.filterBot", "Bot")}
        </button>
      ))}
    </div>
  ) : null;

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
          {canAddressPrFeedback ? (
            <>
              {/*
              FNXC:TaskReviewPrFeedback 2026-06-28-00:00:
              The Review tab must expose the same gated Address PR feedback action as task cards when PR comments or CHANGES_REQUESTED make feedback actionable. Route the click through the lifecycle API so the ce-resolve-pr-feedback steering prompt is visible in Chat and can wake the assigned agent.
              */}
              <button
                className="btn btn-sm"
                onClick={() => void onAddressPrFeedback()}
                disabled={addressingPrFeedback}
                data-testid="task-review-address-pr-feedback"
              >
                <Bot />
                {addressingPrFeedback ? t("taskReview.addressingPrFeedback", "Addressing…") : t("taskReview.addressPrFeedback", "Address PR feedback")}
              </button>
            </>
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
      {/*
        FNXC:TaskReviewTab 2026-06-27-23:38:
        PR-linked tasks need Review-tab context that is already present in the GitHub review payload: decision, reviewers, checks, blockers, and per-item author/state/GitHub links. Keep this branch gated to pull-request mode so reviewer-agent reviews retain their established direct-mode layout.
      */}
      {reviewArtifacts.length > 0 ? (
        <section className="task-review-tab__review-artifacts" aria-label={t("taskReview.reviewArtifacts", "Review artifacts")} data-testid="task-review-artifacts">
          <h2 className="task-review-tab__pr-summary-label">{t("taskReview.reviewArtifacts", "Review artifacts")}</h2>
          <ArtifactsGallery
            artifacts={reviewArtifacts}
            projectId={projectId}
            isMobile={isMobile}
            addToast={addToast}
            onOpenTask={() => {}}
          />
        </section>
      ) : null}
      {isPrMode ? (
        <section className="task-review-tab__pr-summary" aria-label={t("taskReview.prSummaryAria", "Pull request review summary")}>
          <div className="task-review-tab__pr-summary-section">
            <div className="task-review-tab__pr-summary-label">{t("taskReview.reviewers", "Reviewers")}</div>
            {prSummary?.reviewers?.length ? (
              <ul className="task-review-tab__pill-list" aria-label={t("taskReview.reviewers", "Reviewers")}>
                {prSummary.reviewers.map((reviewer) => (
                  <li key={`${reviewer.login}-${reviewer.state}`} className="task-review-tab__pill-list-item">
                    <span className="task-review-tab__reviewer-login">{reviewer.login}</span>
                    <span className={`task-review-tab__decision task-review-tab__decision--${reviewer.state}`}>{reviewer.state}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="task-review-tab__meta">{t("taskReview.noReviewers", "No reviewers reported")}</div>
            )}
          </div>
          <div className="task-review-tab__pr-summary-section">
            <div className="task-review-tab__pr-summary-label">{t("taskReview.checks", "Checks")}</div>
            <div className="task-review-tab__meta">{summarizeChecks(prSummary?.checks, t)}</div>
            {prSummary?.checks?.length ? (
              <ul className="task-review-tab__pill-list" aria-label={t("taskReview.checks", "Checks")}>
                {prSummary.checks.map((check) => (
                  <li key={`${check.name}-${check.state}`} className="task-review-tab__pill-list-item">
                    <span className="task-review-tab__check-name">{check.name}</span>
                    <span className={`task-review-tab__decision task-review-tab__decision--${getCheckTone(check)}`}>{check.state}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {prSummary?.blockingReasons?.length ? (
            <div className="task-review-tab__pr-summary-section">
              <div className="task-review-tab__pr-summary-label">{t("taskReview.blockingReasons", "Blocking reasons")}</div>
              <ul className="task-review-tab__blockers">
                {prSummary.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
      {loading ? <div className="task-review-tab__meta"><LoadingSpinner label={t("taskReview.loadingData", "Loading review data…")} /></div> : null}
      {!loading && error ? <div className="task-review-tab__error">{error}</div> : null}
      {!loading && !error && !isPrMode && displayItems.length === 0 ? <div className="task-review-tab__empty">{emptyMessage ?? t("taskReview.noFeedbackDirect", "No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.")}</div> : null}
      {!loading && !error && renderAuthorFilter}
      {!loading && !error && displayItems.length > 0 && filteredDisplayItems.length > 0 ? (
        <ul className="task-review-tab__list">
          {filteredDisplayItems.map((item) => {
            const checkboxId = `task-review-item-checkbox-${item.id}`;
            const authorInfo = resolveReviewCommentAuthor(item.author, { reviewSource: review?.source });
            const authorType = authorInfo.authorIsBot ? "bot" : "human";
            const avatarKey = `${item.id}:${authorInfo.author}`;
            const showAvatarImg = Boolean(authorInfo.authorAvatarUrl && !brokenAvatars.has(avatarKey));
            const prAuthor = isPrMode ? item.item?.author?.login ?? item.addressing?.snapshot?.authorLogin : undefined;
            const prState = isPrMode ? item.item?.state : undefined;
            const prUrl = isPrMode ? item.item?.htmlUrl ?? item.addressing?.snapshot?.url : undefined;
            const summaryPrefix = item.path && !isPrMode ? `${item.path}: ` : "";

            return (
              <li key={item.id} className="task-review-tab__item card" data-review-comment-author-type={authorType}>
                <div className="task-review-tab__item-inner">
                  <label htmlFor={checkboxId} className="task-review-tab__direct-item task-review-tab__direct-item--selectable">
                    <div className="task-review-tab__item-header">
                      <div className="task-review-tab__item-selection">
                        <input id={checkboxId} type="checkbox" checked={selected.includes(item.id)} onChange={() => toggleSelected(item.id)} />
                        <span className="task-review-tab__item-summary">{summaryPrefix}{item.summary}</span>
                      </div>
                      <span className={`task-review-tab__status task-review-tab__status--${item.status}`}>{item.status}</span>
                    </div>
                  </label>
                  {/*
                  FNXC:TaskReview 2026-06-27-00:00:
                  Every Review-tab item needs visible author provenance across PR live items, reviewer-agent items, and snapshot-only addressing records. Render a deterministic avatar image only for human GitHub logins; missing authors and bots use generic icons so there is never an empty or broken avatar shell.
                  */}
                  <div className="task-review-tab__comment-meta">
                    <span className="task-review-tab__comment-avatar" aria-hidden="true" data-testid="task-review-comment-avatar">
                      {showAvatarImg ? (
                        <img
                          src={authorInfo.authorAvatarUrl}
                          alt={t("taskReview.avatarAlt", "{{author}} avatar", { author: authorInfo.author })}
                          className="task-review-tab__comment-avatar-img"
                          onError={() => setBrokenAvatars((prev) => new Set(prev).add(avatarKey))}
                        />
                      ) : authorInfo.authorIsBot ? (
                        <Bot size={16} aria-hidden="true" />
                      ) : (
                        <User size={16} aria-hidden="true" />
                      )}
                    </span>
                    <span className="task-review-tab__comment-author">{authorInfo.author}</span>
                    <span className={`task-review-tab__comment-type-badge task-review-tab__comment-type-badge--${authorType}`} data-review-comment-author-type={authorType}>
                      {authorInfo.authorIsBot ? <Bot size={11} aria-hidden="true" /> : <User size={11} aria-hidden="true" />}
                      <span>{authorInfo.authorIsBot ? t("taskReview.bot", "Bot") : t("taskReview.human", "Human")}</span>
                    </span>
                    <time className="task-review-tab__comment-time" dateTime={item.createdAt} title={item.createdAt}>{formatTimestamp(item.createdAt, t)}</time>
                  </div>
                  <div className="task-review-tab__item-meta-list">
                    {isPrMode ? (
                      <div className="task-review-tab__pr-item-meta" aria-label={t("taskReview.prItemMeta", "Pull request review item metadata")}>
                        {prAuthor ? <span className="task-review-tab__meta">{t("taskReview.itemAuthor", "Author: {{author}}", { author: prAuthor })}</span> : null}
                        {prState ? <span className={`task-review-tab__decision task-review-tab__decision--${prState}`}>{prState}</span> : null}
                        <span className="task-review-tab__meta">{formatTimestamp(item.createdAt, t)}</span>
                        {item.path ? <span className="task-review-tab__meta">{item.path}</span> : null}
                        {prUrl ? (
                          <a className="task-review-tab__github-link" href={prUrl} target="_blank" rel="noopener noreferrer">
                            {t("taskReview.viewOnGitHub", "View on GitHub")}
                            <ExternalLink aria-hidden="true" />
                          </a>
                        ) : null}
                      </div>
                    ) : (
                      <div className="task-review-tab__meta">{formatTimestamp(item.createdAt, t)}</div>
                    )}
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
                    <MailboxMessageContent className="task-review-tab__body markdown-body" content={item.body} testId="task-review-comment-body" />
                  ) : (
                    <pre className="task-review-tab__body" data-testid="task-review-comment-body">{linkifyFilePaths(stripHtmlComments(item.body))}</pre>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!loading && !error && displayItems.length > 0 && filteredDisplayItems.length === 0 ? <div className="task-review-tab__empty">{t("taskReview.noItemsForFilter", "No review items match the filter.")}</div> : null}
      {isPrMode && !loading && !error && displayItems.length === 0 ? <div className="task-review-tab__empty">{t("taskReview.noReviewItems", "No review items yet.")}</div> : null}
    </div>
  );
}
