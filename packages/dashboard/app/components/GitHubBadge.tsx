import { GitPullRequest, CircleDot } from "lucide-react";
import type { IssueInfo, PrInfo } from "@kb/core";
import type { ToastType } from "../hooks/useToast";

interface GitHubBadgeProps {
  prInfo?: PrInfo;
  issueInfo?: IssueInfo;
  onIssueRefresh?: () => void;
  addToast?: (message: string, type?: ToastType) => void;
}

// Color scheme for PR and Issue badges
const COLORS = {
  pr: {
    open: { bg: "rgba(63,185,80,0.2)", text: "#3fb950" },
    closed: { bg: "rgba(218,54,51,0.2)", text: "#da3633" },
    merged: { bg: "rgba(188,140,255,0.2)", text: "#bc8cff" },
  },
  issue: {
    open: { bg: "rgba(63,185,80,0.2)", text: "#3fb950" },
    completed: { bg: "rgba(188,140,255,0.2)", text: "#bc8cff" },
    not_planned: { bg: "rgba(248,81,73,0.2)", text: "#f85149" },
    default: { bg: "rgba(139,148,158,0.2)", text: "#8b949e" },
  },
};

function getPrColors(status: string) {
  return COLORS.pr[status as keyof typeof COLORS.pr] ?? COLORS.pr.open;
}

function getIssueColors(state: string, stateReason?: string) {
  if (state === "open") return COLORS.issue.open;
  if (stateReason === "completed") return COLORS.issue.completed;
  if (stateReason === "not_planned") return COLORS.issue.not_planned;
  return COLORS.issue.default;
}

function getIssueModifierClass(state: string, stateReason?: string): string {
  if (state === "open") return "card-github-badge--open";
  if (stateReason === "completed") return "card-github-badge--completed";
  if (stateReason === "not_planned") return "card-github-badge--closed";
  return "";
}

export function GitHubBadge({ prInfo, issueInfo, onIssueRefresh }: GitHubBadgeProps) {
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
          style={{
            background: getPrColors(prInfo.status).bg,
            color: getPrColors(prInfo.status).text,
          }}
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
          style={{
            background: getIssueColors(issueInfo.state, issueInfo.stateReason).bg,
            color: getIssueColors(issueInfo.state, issueInfo.stateReason).text,
          }}
        >
          <CircleDot size={12} />
          <span>#{issueInfo.number}</span>
        </span>
      )}
    </>
  );
}
