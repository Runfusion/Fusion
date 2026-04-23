import { useState, useCallback } from "react";
import { GitPullRequest, ExternalLink, RefreshCw, Plus, MessageSquare, CircleDot, XCircle, GitMerge } from "lucide-react";
import type { PrInfo } from "@fusion/core";
import { createPr, refreshPrStatus, type PrRefreshResponse } from "../api";
import type { ToastType } from "../hooks/useToast";

interface PrSectionProps {
  taskId: string;
  projectId?: string;
  prInfo?: PrInfo;
  automationStatus?: string | null;
  autoMerge?: boolean;
  prAuthAvailable: boolean;
  onPrCreated: (prInfo: PrInfo) => void;
  onPrUpdated: (prInfo: PrInfo) => void;
  addToast: (message: string, type?: ToastType) => void;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  open: <CircleDot size={16} />,
  closed: <XCircle size={16} />,
  merged: <GitMerge size={16} />,
};

export function PrSection({
  taskId,
  projectId,
  prInfo,
  automationStatus,
  autoMerge = false,
  prAuthAvailable,
  onPrCreated,
  onPrUpdated,
  addToast,
}: PrSectionProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshState, setRefreshState] = useState<PrRefreshResponse | null>(null);

  const handleCreate = useCallback(async () => {
    if (!prTitle.trim()) return;

    setIsCreating(true);
    try {
      const newPr = await createPr(taskId, {
        title: prTitle.trim(),
        body: prBody.trim() || undefined,
      }, projectId);
      onPrCreated(newPr);
      setShowCreateForm(false);
      setPrTitle("");
      setPrBody("");
      addToast(`Created PR #${newPr.number}`, "success");
    } catch (err: any) {
      addToast(err.message || "Failed to create PR", "error");
    } finally {
      setIsCreating(false);
    }
  }, [taskId, prTitle, prBody, projectId, onPrCreated, addToast]);

  const handleRefresh = useCallback(async () => {
    if (!prInfo) return;

    setIsRefreshing(true);
    try {
      const updated = await refreshPrStatus(taskId, projectId);
      setRefreshState(updated);
      onPrUpdated(updated.prInfo);
      addToast("PR status refreshed", "success");
    } catch (err: any) {
      addToast(err.message || "Failed to refresh PR", "error");
    } finally {
      setIsRefreshing(false);
    }
  }, [taskId, prInfo, projectId, onPrUpdated, addToast]);

  // No PR yet - show create button or automation state
  if (!prInfo) {
    if (automationStatus === "creating-pr") {
      return (
        <div className="pr-section">
          <h4>
            <GitPullRequest size={16} className="pr-section-icon" />
            Pull Request
          </h4>
          <div className="pr-hint pr-hint--muted">
            fn is creating a pull request automatically for this task.
          </div>
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
          <div className="pr-hint pr-hint--muted">
            Auto-merge will handle this task automatically.
          </div>
        </div>
      );
    }

    if (showCreateForm) {
      return (
        <div className="pr-section">
          <h4>
            <GitPullRequest size={16} className="pr-section-icon" />
            Create Pull Request
          </h4>
          <div className="pr-form">
            <input
              type="text"
              placeholder="PR title"
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              disabled={isCreating}
              className="pr-input"
            />
            <textarea
              placeholder="PR description (optional)"
              value={prBody}
              onChange={(e) => setPrBody(e.target.value)}
              disabled={isCreating}
              className="pr-textarea"
              rows={3}
            />
            <div className="pr-actions">
              <button
                className="btn btn-sm"
                onClick={() => setShowCreateForm(false)}
                disabled={isCreating}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCreate}
                disabled={!prTitle.trim() || isCreating}
              >
                {isCreating ? "Creating…" : "Create PR"}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="pr-section">
        <h4>
          <GitPullRequest size={16} className="pr-section-icon" />
          Pull Request
        </h4>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowCreateForm(true)}
          disabled={!prAuthAvailable}
          title={prAuthAvailable ? "Create a PR for this task" : "PR auth unavailable — run 'gh auth login'"}
        >
          <Plus size={14} className="pr-section-icon--sm" />
          Create PR
        </button>
        {!prAuthAvailable && (
          <div className="pr-hint pr-hint--subtle">
            Run <code>gh auth login</code> to enable PR creation.
          </div>
        )}
      </div>
    );
  }

  // PR exists - show PR card
  const statusIcon = STATUS_ICONS[prInfo.status] ?? <CircleDot size={16} />;
  const blockingReasons = refreshState?.blockingReasons ?? [];

  return (
    <div className="pr-section">
      <h4>
        <GitPullRequest size={16} className="pr-section-icon" />
        Pull Request
      </h4>
      <div
        className={`pr-card pr-card--status-${prInfo.status}`}
      >
        <div className="pr-header">
          <span className="pr-status-icon">{statusIcon}</span>
          <span
            className={`pr-status-badge pr-status-badge--${prInfo.status}`}
          >
            {prInfo.status}
          </span>
          <span className="pr-number">#{prInfo.number}</span>
          <div className="pr-spacer" />
          <button
            className="btn btn-sm pr-refresh-btn"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh PR status"
          >
            <RefreshCw size={14} style={{ verticalAlign: "middle", opacity: isRefreshing ? 0.5 : 1 }} />
          </button>
        </div>
        <div className="pr-title">{prInfo.title}</div>
        <div className="pr-meta">
          <span>{prInfo.headBranch}</span>
          <span className="pr-meta-arrow">→</span>
          <span>{prInfo.baseBranch}</span>
        </div>
        {automationStatus === "merging-pr" && (
          <div className="pr-hint pr-hint--info">
            fn is merging this pull request automatically.
          </div>
        )}
        {automationStatus === "awaiting-pr-checks" && (
          <div className="pr-hint pr-hint--info">
            {blockingReasons.length > 0
              ? `Waiting for: ${blockingReasons.join("; ")}`
              : "Waiting for required checks or review feedback before auto-merge."}
          </div>
        )}
        {prInfo.status === "merged" && (
          <div className="pr-hint pr-hint--info">
            This PR is merged. fn will finish local cleanup and move the task to Done.
          </div>
        )}
        <div className="pr-footer">
          {prInfo.commentCount > 0 && (
            <span className="pr-comments">
              <MessageSquare size={14} />
              {prInfo.commentCount}
            </span>
          )}
          <a
            href={prInfo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="pr-link"
          >
            <ExternalLink size={14} />
            View on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
