import { useCallback, useEffect, useMemo, useState } from "react";
import { GitPullRequest, ExternalLink, RefreshCw, Plus, MessageSquare, CircleDot, XCircle, GitMerge, ChevronDown, ChevronUp } from "lucide-react";
import { getErrorMessage, type DirectMergeCommitStrategy, type StructuredGhError } from "@fusion/core";
import { fetchPrReviews, mergePr, reclaimPrConflict, refreshPrStatus, setAutoMergeOnGreen, unlinkPr, type PrCheckStatus, type PrInfo, type PrRefreshResponse, type PrReviewsResponse } from "../api";
import { usePrChecksStream } from "../hooks/usePrChecksStream";
import { PrChecksList } from "./PrChecksList";
import type { ToastType } from "../hooks/useToast";
import { linkifyFilePaths } from "../utils/filePathLinkify";
import "./PrPanel.css";

interface PrPanelProps {
  taskId: string;
  projectId?: string;
  prInfo?: PrInfo;
  prInfos?: PrInfo[];
  automationStatus?: string | null;
  taskColumn?: string;
  autoMerge?: boolean;
  isManualPrFlow?: boolean;
  prAuthAvailable: boolean;
  onPrUpdated: (prInfo: PrInfo) => void;
  onPrUnlinked?: (prNumber: number) => void;
  onPrsRefreshed?: (prInfos: PrInfo[]) => void;
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

function getPrRollupState(prInfo: PrInfo): "conflicting" | "failing checks" | "changes_requested" | "draft" | "open" | "merged" | "closed" {
  if (prInfo.mergeable === "conflicting") return "conflicting";
  if (prInfo.lastReviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if ((prInfo.draft ?? prInfo.isDraft) && prInfo.status === "open") return "draft";
  if (prInfo.status === "merged") return "merged";
  if (prInfo.status === "closed") return "closed";
  return "open";
}

const ROLLUP_PRIORITY: Array<ReturnType<typeof getPrRollupState>> = ["conflicting", "failing checks", "changes_requested", "draft", "open", "merged", "closed"];

function getWorstRollupState(prInfos: PrInfo[]): string {
  const states = prInfos.map((prInfo) => getPrRollupState(prInfo));
  return ROLLUP_PRIORITY.find((state) => states.includes(state)) ?? "open";
}

function PrCard({
  taskId,
  projectId,
  prInfo,
  automationStatus,
  taskColumn,
  onPrUpdated,
  onPrUnlinked,
  onPrsRefreshed,
  directMergeCommitStrategy,
  addToast,
}: {
  taskId: string;
  projectId?: string;
  prInfo: PrInfo;
  automationStatus?: string | null;
  taskColumn?: string;
  onPrUpdated: (prInfo: PrInfo) => void;
  onPrUnlinked?: (prNumber: number) => void;
  onPrsRefreshed?: (prInfos: PrInfo[]) => void;
  directMergeCommitStrategy: DirectMergeCommitStrategy;
  addToast: (message: string, type?: ToastType) => void;
}) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshState, setRefreshState] = useState<PrRefreshResponse | null>(null);
  const [reviewsState, setReviewsState] = useState<PrReviewsResponse | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [lastGhError, setLastGhError] = useState<(StructuredGhError & { operation: "refresh" }) | null>(null);
  const [isReclaimingConflict, setIsReclaimingConflict] = useState(false);
  const [conflictsExpanded, setConflictsExpanded] = useState(false);
  const [copiedConflicts, setCopiedConflicts] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<"merge" | "squash" | "rebase">(
    directMergeCommitStrategy === "always-rebase" ? "rebase" : directMergeCommitStrategy === "always-squash" ? "squash" : "squash",
  );

  useEffect(() => {
    void fetchPrReviews(taskId, projectId, prInfo.number)
      .then((data) => setReviewsState(data))
      .catch(() => setReviewsState(null));
  }, [taskId, projectId, prInfo.number]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setLastGhError(null);
    try {
      const updated = await refreshPrStatus(taskId, projectId);
      setRefreshState(updated);
      const refreshedPrInfos = updated.all?.map((entry) => entry.prInfo) ?? [updated.prInfo];
      const targetPr = refreshedPrInfos.find((entry) => entry.number === prInfo.number);
      if (onPrsRefreshed) onPrsRefreshed(refreshedPrInfos);
      if (targetPr) onPrUpdated(targetPr);
      const latestReviews = await fetchPrReviews(taskId, projectId, prInfo.number);
      setReviewsState(latestReviews);
      addToast("PR status refreshed", "success");
    } catch (err) {
      const details = (err as { details?: { githubError?: StructuredGhError } })?.details?.githubError;
      const structured = details ? { ...details, operation: "refresh" as const } : { code: "unknown" as const, message: getErrorMessage(err) || "Failed to refresh PR", retryable: true, action: { kind: "retry" as const }, operation: "refresh" as const };
      setLastGhError(structured);
      addToast(structured.message || "Failed to refresh PR", "error");
    } finally {
      setIsRefreshing(false);
    }
  }, [taskId, projectId, prInfo.number, onPrUpdated, onPrsRefreshed, addToast]);

  const handleMerge = useCallback(async () => {
    setIsMerging(true);
    try {
      const result = await mergePr(taskId, mergeStrategy, projectId, prInfo.number);
      onPrUpdated(result.prInfo);
      addToast("Pull request merged", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to merge pull request", "error");
    } finally {
      setIsMerging(false);
    }
  }, [addToast, mergeStrategy, onPrUpdated, prInfo.number, projectId, taskId]);

  const handleAutoMergeToggle = useCallback(async (enabled: boolean) => {
    try {
      const result = await setAutoMergeOnGreen(taskId, enabled, mergeStrategy, projectId, prInfo.number);
      onPrUpdated(result.prInfo);
      addToast(enabled ? "Auto-merge enabled" : "Auto-merge disabled", "success");
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to update auto-merge", "error");
    }
  }, [addToast, mergeStrategy, onPrUpdated, prInfo.number, projectId, taskId]);

  const handleUnlink = useCallback(async () => {
    if (!window.confirm(`Unlink PR #${prInfo.number} from this task? The PR will not be closed.`)) {
      return;
    }
    await unlinkPr(taskId, prInfo.number, projectId);
    onPrUnlinked?.(prInfo.number);
    addToast(`Unlinked PR #${prInfo.number}`, "success");
  }, [addToast, onPrUnlinked, prInfo.number, projectId, taskId]);

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
  const conflictDiagnostics = refreshState?.conflictDiagnostics ?? prInfo.conflictDiagnostics;

  useEffect(() => {
    setConflictsExpanded((conflictDiagnostics?.conflictingFiles.length ?? 0) > 0);
  }, [conflictDiagnostics?.capturedAt, conflictDiagnostics?.conflictingFiles.length]);

  return (
    <div className={`pr-card pr-card--status-${prInfo.status}`} data-testid={`pr-card-${prInfo.number}`}>
      <div className="pr-header">
        <span className="pr-status-icon">{statusIcon}</span>
        <span className={`pr-status-badge pr-status-badge--${prInfo.status}`}>{prInfo.status}</span>
        <span className="pr-number">#{prInfo.number}</span>
        <div className="pr-spacer" />
        <button className="btn btn-sm pr-refresh-btn" onClick={handleRefresh} disabled={isRefreshing} title="Refresh PR status">
          <RefreshCw size={14} className={isRefreshing ? "spin pr-panel-refresh-icon--muted" : undefined} />
        </button>
        <button className="btn btn-sm" onClick={() => void handleUnlink()}>Unlink</button>
      </div>
      <div className="pr-title">{prInfo.title}</div>
      {lastGhError ? (
        <div className="pr-error" role="alert">
          <div>{lastGhError.message}</div>
          {lastGhError.hint ? <div className="pr-error__hint">{lastGhError.hint}</div> : null}
          <div className="pr-error__actions">
            {lastGhError.action?.kind === "shell" ? <div>Action: run <code>{lastGhError.action.command}</code></div> : null}
            {lastGhError.retryable ? <button className="btn btn-sm pr-error__retry" onClick={() => void handleRefresh()}>Retry</button> : null}
            <button className="btn btn-sm pr-error__dismiss" onClick={() => setLastGhError(null)} aria-label="Dismiss PR error">×</button>
          </div>
        </div>
      ) : null}
      <div className="pr-meta"><span>{prInfo.headBranch}</span><span className="pr-meta-arrow">→</span><span>{prInfo.baseBranch}</span></div>

      {prInfo.status !== "merged" && prInfo.status !== "closed" ? (
        <PrChecksList
          checks={streamChecks.checks}
          rollup={streamChecks.rollup}
          lastCheckedAt={streamChecks.lastCheckedAt}
          loading={streamChecks.loading}
          error={streamChecks.error}
          onRefresh={() => { void streamChecks.refresh(); }}
        />
      ) : null}

      <div className="pr-panel-section"><div className="pr-panel-row-label">Review</div>{reviewDecision ? <span className={`pr-panel-review-badge pr-panel-review-badge--${getReviewTone(reviewDecision)}`}>{reviewDecision}</span> : <span className="pr-panel-tone-muted">No reviews yet</span>}</div>

      <div className="pr-panel-section">
        <div className="pr-panel-row-label">Reviews</div>
        {groupedReviews.length === 0 ? <span className="pr-panel-tone-muted">No review comments synced yet</span> : null}
        {groupedReviews.map(([reviewer, items]) => (
          <div key={reviewer} className="pr-panel-review-thread">
            <div className="pr-panel-review-thread-header"><strong>@{reviewer}</strong><span className={`pr-panel-review-badge pr-panel-review-badge--${getReviewTone((items.at(-1)?.state as PrRefreshResponse["reviewDecision"]) ?? "REVIEW_REQUIRED")}`}>{items.at(-1)?.state ?? "COMMENTED"}</span></div>
            {items.map((item) => <a key={item.id} href={item.htmlUrl} target="_blank" rel="noreferrer" className="pr-panel-review-item">{linkifyFilePaths(item.body, { keyPrefix: item.id })}</a>)}
          </div>
        ))}
      </div>

      {showMergeControls ? (
        <div className="pr-panel-section"><div className="pr-panel-row-label">Merge</div><div className="pr-merge-controls"><select className="select" value={mergeStrategy} onChange={(event) => setMergeStrategy(event.target.value as "merge" | "squash" | "rebase")}><option value="merge">merge</option><option value="squash">squash</option><option value="rebase">rebase</option></select><button className="btn btn-primary btn-sm" onClick={handleMerge} disabled={!mergeReady || isMerging} title={mergeReady ? "Merge pull request" : blockingReasonsTitle || "Refresh PR status to check merge readiness"}>Merge pull request</button><label className="checkbox-label"><input type="checkbox" checked={Boolean(prInfo.autoMergeOnGreen)} onChange={(event) => { void handleAutoMergeToggle(event.currentTarget.checked); }} />Auto-merge when green</label></div>{prInfo.lastMergeError ? <div className="pr-merge-error"><span>{prInfo.lastMergeError}</span><button className="btn btn-sm" onClick={handleMerge} disabled={isMerging}>Retry</button></div> : null}</div>
      ) : null}

      {showConflictHint ? <div className="pr-hint pr-hint--conflict">Merge conflict detected. Resolve/rebase branch and retry reclaim.<button className="btn btn-sm" onClick={async () => { setIsReclaimingConflict(true); try { const result = await reclaimPrConflict(taskId, projectId); if (result.queued) { addToast("Conflict reclaim queued", "success"); const updated = await refreshPrStatus(taskId, projectId); setRefreshState(updated); const targetPr = (updated.all?.map((entry) => entry.prInfo) ?? [updated.prInfo]).find((entry) => entry.number === prInfo.number); if (targetPr) onPrUpdated(targetPr); } else { addToast(result.reason ?? "Conflict reclaim unavailable", "warning"); } } catch (err) { addToast(getErrorMessage(err) || "Failed to queue conflict reclaim", "error"); } finally { setIsReclaimingConflict(false); } }} disabled={isReclaimingConflict}>Retry conflict reclaim</button></div> : null}

      {conflictDiagnostics && (prInfo.mergeable === "conflicting" || hasConflictBlockingReason) ? (
        <div className="pr-conflict-section">
          <div className="pr-conflict-section__header"><button type="button" className="btn btn-sm" onClick={() => setConflictsExpanded((value) => !value)}>{conflictsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Conflicts</button><button type="button" className="btn btn-sm" onClick={() => void handleRefresh()} disabled={isRefreshing}>Re-check conflicts</button></div>
          {conflictsExpanded ? <><ul className="pr-conflict-files">{conflictDiagnostics.conflictingFiles.map((file) => <li key={file}>{linkifyFilePaths(file, { keyPrefix: `pr-conflict-${file}` })}</li>)}</ul><pre className="pr-conflict-commands"><code>{conflictDiagnostics.suggestedCommands.join("\n")}</code></pre><div className="pr-conflict-section__header"><button type="button" className="btn btn-sm" onClick={async () => { await navigator.clipboard.writeText(conflictDiagnostics.suggestedCommands.join("\n")); setCopiedConflicts(true); setTimeout(() => setCopiedConflicts(false), 1200); }}>{copiedConflicts ? "Copied" : "Copy"}</button><span className="pr-panel-tone-muted">Captured: {new Date(conflictDiagnostics.capturedAt).toLocaleString()}</span></div></> : null}
        </div>
      ) : null}

      {reviewDecision === "CHANGES_REQUESTED" && taskColumn === "todo" && <div className="pr-hint pr-hint--warning">Auto-moved to Todo — reviewer feedback ready</div>}
      {automationStatus === "merging-pr" && <div className="pr-hint pr-hint--info">fn is merging this pull request automatically.</div>}
      {automationStatus === "awaiting-pr-checks" && <div className="pr-hint pr-hint--info">{blockingReasons.length > 0 ? `Waiting for: ${blockingReasons.join("; ")}` : "Waiting for required checks or review feedback before auto-merge."}</div>}
      {prInfo.status === "merged" && <div className="pr-hint pr-hint--success">Merged — task moved to Done</div>}

      <div className="pr-footer"><span className="pr-comments"><MessageSquare size={14} />{prInfo.commentCount}{prInfo.lastCommentAt ? <span className="pr-panel-comment-time">Last: {new Date(prInfo.lastCommentAt).toLocaleString()}</span> : null}</span><a href={prInfo.url} target="_blank" rel="noopener noreferrer" className="pr-link"><ExternalLink size={14} />View on GitHub</a></div>
    </div>
  );
}

export function PrPanel({ taskId, projectId, prInfo, prInfos, automationStatus, taskColumn, autoMerge = false, isManualPrFlow = false, prAuthAvailable, onPrUpdated, onPrUnlinked, onPrsRefreshed, onRequestCreatePr, directMergeCommitStrategy = "auto", addToast }: PrPanelProps) {
  const prList = prInfos ?? (prInfo ? [prInfo] : []);

  if (prList.length === 0) {
    if (automationStatus === "creating-pr") {
      return <div className="pr-section"><h4><GitPullRequest size={16} className="pr-section-icon" />Pull Request</h4><div className="pr-hint pr-hint--muted">fn is creating a pull request automatically for this task.</div></div>;
    }
    if (autoMerge) {
      return <div className="pr-section"><h4><GitPullRequest size={16} className="pr-section-icon" />Pull Request</h4><div className="pr-hint pr-hint--muted">Auto-merge will handle this task automatically.</div></div>;
    }
    const createDisabled = !prAuthAvailable || !onRequestCreatePr;
    return <div className="pr-section"><h4><GitPullRequest size={16} className="pr-section-icon" />Pull Request</h4><button className="btn btn-primary btn-sm" onClick={onRequestCreatePr} disabled={createDisabled} data-testid="pr-panel-create-pr" title={prAuthAvailable ? "Create a PR for this task" : "PR auth unavailable — run 'gh auth login'"}><Plus />Create PR</button>{isManualPrFlow && <div className="pr-hint pr-hint--subtle">Use the footer action to run PR-first completion for this task.</div>}{(!prAuthAvailable || !onRequestCreatePr) && <div className="pr-hint pr-hint--subtle">Run <code>gh auth login</code> to enable PR creation.</div>}</div>;
  }

  return (
    <div className="pr-section">
      <h4><GitPullRequest size={16} className="pr-section-icon" />Pull Request</h4>
      {prList.length > 1 ? <div className="pr-panel-summary"><span>{prList.length} pull requests</span><span className="pr-panel-summary-badge">{getWorstRollupState(prList)}</span></div> : null}
      <div className="pr-panel-stack">
        {prList.map((prEntry) => (
          <PrCard
            key={prEntry.number}
            taskId={taskId}
            projectId={projectId}
            prInfo={prEntry}
            automationStatus={automationStatus}
            taskColumn={taskColumn}
            onPrUpdated={onPrUpdated}
            onPrUnlinked={onPrUnlinked}
            onPrsRefreshed={onPrsRefreshed}
            directMergeCommitStrategy={directMergeCommitStrategy}
            addToast={addToast}
          />
        ))}
      </div>
    </div>
  );
}
