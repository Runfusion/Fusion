import { useCallback, useEffect, useMemo, useState } from "react";
import { GitPullRequest, ExternalLink, RefreshCw, Plus, MessageSquare, CircleDot, XCircle, GitMerge } from "lucide-react";
import { getErrorMessage, type DirectMergeCommitStrategy } from "@fusion/core";
import { fetchPrReviews, mergePr, reclaimPrConflict, refreshPrStatus, setAutoMergeOnGreen, type PrCheckStatus, type PrInfo, type PrRefreshResponse, type PrReviewsResponse } from "../api";
import { usePrChecksStream } from "../hooks/usePrChecksStream";
import { PrChecksList } from "./PrChecksList";
import type { ToastType } from "../hooks/useToast";
import { linkifyFilePaths } from "../utils/filePathLinkify";
import "./PrPanel.css";

interface PrPanelProps {
  taskId: string;
  projectId?: string;
  prInfo?: PrInfo;
  automationStatus?: string | null;
  taskColumn?: string;
  autoMerge?: boolean;
  isManualPrFlow?: boolean;
  prAuthAvailable: boolean;
  onPrUpdated: (prInfo: PrInfo) => void;
  onRequestCreatePr?: () => void;
  directMergeCommitStrategy?: DirectMergeCommitStrategy;
  addToast: (message: string, type?: ToastType) => void;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  open: <CircleDot size={16} />,
  closed: <XCircle size={16} />,
  merged: <GitMerge size={16} />,
};

type PrCheckState = PrCheckStatus["state"];

const PASSING_STATES = new Set<PrCheckState>(["success", "neutral", "skipped"]);
const FAILING_STATES = new Set<PrCheckState>(["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure"]);
const PENDING_STATES = new Set<PrCheckState>(["pending", "stale"]);

function getReviewTone(reviewDecision: PrRefreshResponse["reviewDecision"]): "success" | "error" | "warning" | "muted" {
  if (reviewDecision === "APPROVED") return "success";
  if (reviewDecision === "CHANGES_REQUESTED") return "error";
  if (reviewDecision === "REVIEW_REQUIRED") return "warning";
  return "muted";
}

export function PrPanel({
  taskId,
  projectId,
  prInfo,
  automationStatus,
  taskColumn,
  autoMerge = false,
  isManualPrFlow = false,
  prAuthAvailable,
  onPrUpdated,
  onRequestCreatePr,
  directMergeCommitStrategy = "auto",
  addToast,
}: PrPanelProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshState, setRefreshState] = useState<PrRefreshResponse | null>(null);
  const [reviewsState, setReviewsState] = useState<PrReviewsResponse | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [isReclaimingConflict, setIsReclaimingConflict] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<"merge" | "squash" | "rebase">(
    directMergeCommitStrategy === "always-rebase"
      ? "rebase"
      : directMergeCommitStrategy === "always-squash"
        ? "squash"
        : "squash",
  );

  useEffect(() => {
    if (!prInfo) {
      setReviewsState(null);
      return;
    }
    void fetchPrReviews(taskId, projectId)
      .then((data) => setReviewsState(data))
      .catch(() => setReviewsState(null));
  }, [taskId, projectId, prInfo]);

  const handleRefresh = useCallback(async () => {
    if (!prInfo) return;

    setIsRefreshing(true);
    try {
      const updated = await refreshPrStatus(taskId, projectId);
      setRefreshState(updated);
      onPrUpdated(updated.prInfo);
      const latestReviews = await fetchPrReviews(taskId, projectId);
      setReviewsState(latestReviews);
      addToast("PR status refreshed", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to refresh PR", "error");
    } finally {
      setIsRefreshing(false);
    }
  }, [taskId, projectId, prInfo, onPrUpdated, addToast]);

  const handleMerge = useCallback(async () => {
    if (!prInfo) return;
    setIsMerging(true);
    try {
      const result = await mergePr(taskId, mergeStrategy, projectId);
      onPrUpdated(result.prInfo);
      addToast("Pull request merged", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to merge pull request", "error");
    } finally {
      setIsMerging(false);
    }
  }, [addToast, mergeStrategy, onPrUpdated, prInfo, projectId, taskId]);

  const handleAutoMergeToggle = useCallback(async (enabled: boolean) => {
    if (!prInfo) return;
    try {
      const result = await setAutoMergeOnGreen(taskId, enabled, mergeStrategy, projectId);
      onPrUpdated(result.prInfo);
      addToast(enabled ? "Auto-merge enabled" : "Auto-merge disabled", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to update auto-merge", "error");
    }
  }, [addToast, mergeStrategy, onPrUpdated, prInfo, projectId, taskId]);

  if (!prInfo) {
    if (automationStatus === "creating-pr") {
      return (
        <div className="pr-section">
          <h4>
            <GitPullRequest size={16} className="pr-section-icon" />
            Pull Request
          </h4>
          <div className="pr-hint pr-hint--muted">fn is creating a pull request automatically for this task.</div>
        </div>
      );
    }

    if (autoMerge) {
      return (
        <div className="pr-section">
          <h4>
            <GitPullRequest size={16} className="pr-section-icon" />
            Pull Request
          </h4>
          <div className="pr-hint pr-hint--muted">Auto-merge will handle this task automatically.</div>
        </div>
      );
    }

    const createDisabled = !prAuthAvailable || !onRequestCreatePr;

    return (
      <div className="pr-section">
        <h4>
          <GitPullRequest size={16} className="pr-section-icon" />
          Pull Request
        </h4>
        <button
          className="btn btn-primary btn-sm"
          onClick={onRequestCreatePr}
          disabled={createDisabled}
          title={prAuthAvailable ? "Create a PR for this task" : "PR auth unavailable — run 'gh auth login'"}
        >
          <Plus />
          Create PR
        </button>
        {isManualPrFlow && <div className="pr-hint pr-hint--subtle">Use the footer action to run PR-first completion for this task.</div>}
        {(!prAuthAvailable || !onRequestCreatePr) && (
          <div className="pr-hint pr-hint--subtle">
            Run <code>gh auth login</code> to enable PR creation.
          </div>
        )}
      </div>
    );
  }

  const statusIcon = STATUS_ICONS[prInfo.status] ?? <CircleDot size={16} />;
  const blockingReasons = refreshState?.blockingReasons ?? [];
  const checks = refreshState?.checks;
  const reviewDecision = refreshState?.reviewDecision ?? reviewsState?.snapshot.decision ?? prInfo.lastReviewDecision ?? null;
  const groupedReviews = useMemo(() => {
    const grouped = new Map<string, Array<PrReviewsResponse["snapshot"]["items"][number]>>();
    for (const item of reviewsState?.snapshot.items ?? []) {
      const key = item.author.login;
      const list = grouped.get(key) ?? [];
      list.push(item);
      grouped.set(key, list);
    }
    return Array.from(grouped.entries());
  }, [reviewsState]);

  const checkSummary = useMemo(() => {
    if (!checks) return "unknown" as const;
    if (checks.some((check) => FAILING_STATES.has(check.state))) return "failure" as const;
    if (checks.some((check) => PENDING_STATES.has(check.state))) return "pending" as const;
    if (checks.some((check) => PASSING_STATES.has(check.state))) return "success" as const;
    return "unknown" as const;
  }, [checks]);

  const streamChecks = usePrChecksStream({
    taskId,
    projectId,
    prNumber: prInfo.number,
    enabled: prInfo.status !== "merged" && prInfo.status !== "closed",
    initialChecks: checks ?? [],
    initialRollup: checkSummary,
    initialLastCheckedAt: prInfo.lastCheckedAt,
  });
  const mergeReady = (refreshState?.mergeReady ?? false) && prInfo.status === "open";
  const blockingReasonsTitle = (refreshState?.blockingReasons ?? []).join("; ");
  const showMergeControls = prInfo.status === "open" && (prInfo.draft ?? prInfo.isDraft) !== true;
  const hasConflictBlockingReason = blockingReasons.some((reason) => reason.toLowerCase().includes("conflict"));
  const showConflictHint = prInfo.mergeable === "conflicting" || hasConflictBlockingReason;

  return (
    <div className="pr-section">
      <h4>
        <GitPullRequest size={16} className="pr-section-icon" />
        Pull Request
      </h4>
      <div className={`pr-card pr-card--status-${prInfo.status}`}>
        <div className="pr-header">
          <span className="pr-status-icon">{statusIcon}</span>
          <span className={`pr-status-badge pr-status-badge--${prInfo.status}`}>{prInfo.status}</span>
          <span className="pr-number">#{prInfo.number}</span>
          <div className="pr-spacer" />
          <button className="btn btn-sm pr-refresh-btn" onClick={handleRefresh} disabled={isRefreshing} title="Refresh PR status">
            <RefreshCw size={14} className={isRefreshing ? "spin pr-panel-refresh-icon--muted" : undefined} />
          </button>
        </div>
        <div className="pr-title">{prInfo.title}</div>
        <div className="pr-meta">
          <span>{prInfo.headBranch}</span>
          <span className="pr-meta-arrow">→</span>
          <span>{prInfo.baseBranch}</span>
        </div>

        {prInfo.status !== "merged" && prInfo.status !== "closed" ? (
          <PrChecksList
            checks={streamChecks.checks}
            rollup={streamChecks.rollup}
            lastCheckedAt={streamChecks.lastCheckedAt}
            loading={streamChecks.loading}
            error={streamChecks.error}
            onRefresh={() => {
              void streamChecks.refresh();
            }}
          />
        ) : null}

        <div className="pr-panel-section">
          <div className="pr-panel-row-label">Review</div>
          {reviewDecision ? (
            <span className={`pr-panel-review-badge pr-panel-review-badge--${getReviewTone(reviewDecision)}`}>{reviewDecision}</span>
          ) : (
            <span className="pr-panel-tone-muted">No reviews yet</span>
          )}
        </div>

        <div className="pr-panel-section">
          <div className="pr-panel-row-label">Reviews</div>
          {groupedReviews.length === 0 ? <span className="pr-panel-tone-muted">No review comments synced yet</span> : null}
          {groupedReviews.map(([reviewer, items]) => (
            <div key={reviewer} className="pr-panel-review-thread">
              <div className="pr-panel-review-thread-header">
                <strong>@{reviewer}</strong>
                <span className={`pr-panel-review-badge pr-panel-review-badge--${getReviewTone((items.at(-1)?.state as PrRefreshResponse["reviewDecision"]) ?? "REVIEW_REQUIRED")}`}>
                  {items.at(-1)?.state ?? "COMMENTED"}
                </span>
              </div>
              {items.map((item) => (
                <a key={item.id} href={item.htmlUrl} target="_blank" rel="noreferrer" className="pr-panel-review-item">
                  {linkifyFilePaths(item.body, { keyPrefix: item.id })}
                </a>
              ))}
            </div>
          ))}
        </div>

        {showMergeControls ? (
          <div className="pr-panel-section">
            <div className="pr-panel-row-label">Merge</div>
            <div className="pr-merge-controls">
              <select className="select" value={mergeStrategy} onChange={(event) => setMergeStrategy(event.target.value as "merge" | "squash" | "rebase")}>
                <option value="merge">merge</option>
                <option value="squash">squash</option>
                <option value="rebase">rebase</option>
              </select>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleMerge}
                disabled={!mergeReady || isMerging}
                title={mergeReady ? "Merge pull request" : blockingReasonsTitle || "Refresh PR status to check merge readiness"}
              >
                Merge pull request
              </button>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={Boolean(prInfo.autoMergeOnGreen)}
                  onChange={(event) => {
                    void handleAutoMergeToggle(event.currentTarget.checked);
                  }}
                />
                Auto-merge when green
              </label>
            </div>
            {prInfo.lastMergeError ? (
              <div className="pr-merge-error">
                <span>{prInfo.lastMergeError}</span>
                <button className="btn btn-sm" onClick={handleMerge} disabled={isMerging}>Retry</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {showConflictHint ? (
          <div className="pr-hint pr-hint--conflict">
            Merge conflict detected. Resolve/rebase branch and retry reclaim.
            <button
              className="btn btn-sm"
              onClick={async () => {
                setIsReclaimingConflict(true);
                try {
                  const result = await reclaimPrConflict(taskId, projectId);
                  if (result.queued) {
                    addToast("Conflict reclaim queued", "success");
                    const updated = await refreshPrStatus(taskId, projectId);
                    setRefreshState(updated);
                    onPrUpdated(updated.prInfo);
                  } else {
                    addToast(result.reason ?? "Conflict reclaim unavailable", "warning");
                  }
                } catch (err) {
                  addToast(getErrorMessage(err) || "Failed to queue conflict reclaim", "error");
                } finally {
                  setIsReclaimingConflict(false);
                }
              }}
              disabled={isReclaimingConflict}
            >
              Retry conflict reclaim
            </button>
          </div>
        ) : null}

        {(prInfo.draft ?? prInfo.isDraft) === true && prInfo.status === "open" ? (
          <div className="pr-hint pr-hint--warning">Ready for review required before merging.</div>
        ) : null}

        {reviewDecision === "CHANGES_REQUESTED" && taskColumn === "todo" && (
          <div className="pr-hint pr-hint--warning">Auto-moved to Todo — reviewer feedback ready</div>
        )}

        {automationStatus === "merging-pr" && <div className="pr-hint pr-hint--info">fn is merging this pull request automatically.</div>}
        {automationStatus === "awaiting-pr-checks" && (
          <div className="pr-hint pr-hint--info">
            {blockingReasons.length > 0
              ? `Waiting for: ${blockingReasons.join("; ")}`
              : "Waiting for required checks or review feedback before auto-merge."}
          </div>
        )}
        {prInfo.status === "merged" && (
          <div className="pr-hint pr-hint--success">Merged — task moved to Done</div>
        )}

        <div className="pr-footer">
          <span className="pr-comments">
            <MessageSquare size={14} />
            {prInfo.commentCount}
            {prInfo.lastCommentAt ? <span className="pr-panel-comment-time">Last: {new Date(prInfo.lastCommentAt).toLocaleString()}</span> : null}
          </span>
          <a href={prInfo.url} target="_blank" rel="noopener noreferrer" className="pr-link">
            <ExternalLink size={14} />
            View on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
