import { GitPullRequest, CircleDot } from "lucide-react";
import type { IssueInfo, PrInfo } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";

interface GitHubBadgeProps {
  prInfo?: PrInfo;
  issueInfo?: IssueInfo;
  onIssueRefresh?: () => void;
  addToast?: (message: string, type?: ToastType) => void;
}

function getIssueModifierClass(state: string, stateReason?: string): string {
  if (state === "open") return "card-github-badge--open";
  if (stateReason === "completed") return "card-github-badge--completed";
  if (stateReason === "not_planned") return "card-github-badge--not-planned";
  return "card-github-badge--closed";
}

export function GitHubBadge({ prInfo, issueInfo, onIssueRefresh: _onIssueRefresh }: GitHubBadgeProps) {
  const handlePrClick = () => {
    if (prInfo?.url) {
      window.open(prInfo.url, "_blank", "noopener,noreferrer");
    }
  };

  const handleIssueClick = () => {
    if (issueInfo?.url) {
      window.open(issueInfo.url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <>
      {prInfo && (
        <span
          className={`card-github-badge card-github-badge--${prInfo.status}`}
          title={`PR #${prInfo.number}: ${prInfo.title}`}
          onClick={handlePrClick}
        >
          <GitPullRequest size={12} />
          <span>#{prInfo.number}</span>
        </span>
      )}
      {issueInfo && (
        <span
          className={`card-github-badge ${getIssueModifierClass(issueInfo.state, issueInfo.stateReason)}`}
          title={`Issue #${issueInfo.number}: ${issueInfo.title}`}
          onClick={handleIssueClick}
        >
          <CircleDot size={12} />
          <span>#{issueInfo.number}</span>
        </span>
      )}
    </>
  );
}
