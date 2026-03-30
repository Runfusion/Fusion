import { useState, useCallback } from "react";
import { GitPullRequest, ExternalLink, RefreshCw, Plus, MessageSquare } from "lucide-react";
import type { PrInfo } from "@kb/core";
import { createPr, refreshPrStatus, type PrRefreshResponse } from "../api";
import type { ToastType } from "../hooks/useToast";

interface PrSectionProps {
  taskId: string;
  prInfo?: PrInfo;
  automationStatus?: string | null;
  hasGitHubToken: boolean;
  onPrCreated: (prInfo: PrInfo) => void;
  onPrUpdated: (prInfo: PrInfo) => void;
  addToast: (message: string, type?: ToastType) => void;
}

const STATUS_COLORS = {
  open: { bg: "rgba(63,185,80,0.15)", text: "#3fb950", icon: "🔵" },
  closed: { bg: "rgba(218,54,51,0.15)", text: "#da3633", icon: "⚪" },
  merged: { bg: "rgba(188,140,255,0.15)", text: "#bc8cff", icon: "🟣" },
};

export function PrSection({
  taskId,
  prInfo,
  automationStatus,
  hasGitHubToken,
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
      });
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
  }, [taskId, prTitle, prBody, onPrCreated, addToast]);

  const handleRefresh = useCallback(async () => {
    if (!prInfo) return;

    setIsRefreshing(true);
    try {
      const updated = await refreshPrStatus(taskId);
      setRefreshState(updated);
      onPrUpdated(updated.prInfo);
      addToast("PR status refreshed", "success");
    } catch (err: any) {
      addToast(err.message || "Failed to refresh PR", "error");
    } finally {
      setIsRefreshing(false);
    }
  }, [taskId, prInfo, onPrUpdated, addToast]);

  // No PR yet - show create button or automation state
  if (!prInfo) {
    if (automationStatus === "creating-pr") {
      return (
        <div className="pr-section">
          <h4>
            <GitPullRequest size={16} style={{ verticalAlign: "middle", marginRight: 8 }} />
            Pull Request
          </h4>
          <div className="pr-hint" style={{ opacity: 0.8, fontSize: 13 }}>
            kb is creating a pull request automatically for this task.
          </div>
        </div>
      );
    }

    if (showCreateForm) {
      return (
        <div className="pr-section">
          <h4>
            <GitPullRequest size={16} style={{ verticalAlign: "middle", marginRight: 8 }} />
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
          <GitPullRequest size={16} style={{ verticalAlign: "middle", marginRight: 8 }} />
          Pull Request
        </h4>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowCreateForm(true)}
          disabled={!hasGitHubToken}
          title={hasGitHubToken ? "Create a PR for this task" : "GitHub token not configured"}
        >
          <Plus size={14} style={{ verticalAlign: "middle", marginRight: 4 }} />
          Create PR
        </button>
        {!hasGitHubToken && (
          <div className="pr-hint" style={{ marginTop: 8, opacity: 0.7, fontSize: 12 }}>
            Set GITHUB_TOKEN env var to enable PR creation
          </div>
        )}
      </div>
    );
  }

  // PR exists - show PR card
  const statusStyle = STATUS_COLORS[prInfo.status];
  const blockingReasons = refreshState?.blockingReasons ?? [];

  return (
    <div className="pr-section">
      <h4>
        <GitPullRequest size={16} style={{ verticalAlign: "middle", marginRight: 8 }} />
        Pull Request
      </h4>
      <div
        className="pr-card"
        style={{
          border: "1px solid var(--border, #333)",
          borderRadius: 8,
          padding: 12,
          background: statusStyle.bg,
        }}
      >
        <div className="pr-header" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 16 }}>{statusStyle.icon}</span>
          <span
            className="pr-status-badge"
            style={{
              background: statusStyle.bg,
              color: statusStyle.text,
              padding: "2px 8px",
              borderRadius: 12,
              fontSize: 12,
              fontWeight: 500,
              textTransform: "capitalize",
            }}
          >
            {prInfo.status}
          </span>
          <span className="pr-number" style={{ fontSize: 14, opacity: 0.8 }}>
            #{prInfo.number}
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh PR status"
            style={{ padding: "4px 8px" }}
          >
            <RefreshCw size={14} style={{ verticalAlign: "middle", opacity: isRefreshing ? 0.5 : 1 }} />
          </button>
        </div>
        <div className="pr-title" style={{ fontWeight: 500, marginBottom: 8 }}>
          {prInfo.title}
        </div>
        <div className="pr-meta" style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          <span>{prInfo.headBranch}</span>
          <span style={{ margin: "0 8px" }}>→</span>
          <span>{prInfo.baseBranch}</span>
        </div>
        {automationStatus === "merging-pr" && (
          <div className="pr-hint" style={{ marginBottom: 8, fontSize: 12 }}>
            kb is merging this pull request automatically.
          </div>
        )}
        {automationStatus === "awaiting-pr-checks" && (
          <div className="pr-hint" style={{ marginBottom: 8, fontSize: 12 }}>
            {blockingReasons.length > 0
              ? `Waiting for: ${blockingReasons.join("; ")}`
              : "Waiting for required checks or review feedback before auto-merge."}
          </div>
        )}
        {prInfo.status === "merged" && (
          <div className="pr-hint" style={{ marginBottom: 8, fontSize: 12 }}>
            This PR is merged. kb will finish local cleanup and move the task to Done.
          </div>
        )}
        <div className="pr-footer" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {prInfo.commentCount > 0 && (
            <span className="pr-comments" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <MessageSquare size={14} />
              {prInfo.commentCount}
            </span>
          )}
          <a
            href={prInfo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="pr-link"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              color: "var(--link, #58a6ff)",
              textDecoration: "none",
              fontSize: 12,
            }}
          >
            <ExternalLink size={14} />
            View on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
