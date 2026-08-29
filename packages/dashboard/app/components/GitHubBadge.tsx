import { GitPullRequest, CircleDot, CheckCircle2, XCircle, Clock } from "lucide-react";
import type { IssueInfo, PrInfo } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { getPrBadgeModifierClass } from "../utils/prBadgeClass";

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
  const prIsDraft = prInfo?.status === "draft" || (prInfo?.status === "open" && (prInfo.draft ?? prInfo.isDraft));
  const prModifierClass = prInfo ? getPrBadgeModifierClass(prInfo) : null;
  const checkRollup = prInfo?.checkRollup;
  const checkClass = checkRollup && checkRollup !== "none" ? `card-github-badge__check card-github-badge__check--${checkRollup}` : null;
  const checkTitle = checkRollup && checkRollup !== "none" ? ` — checks: ${checkRollup}` : "";
  const prTitle = prInfo
    ? `PR #${prInfo.number}${prIsDraft ? " (draft)" : ""}: ${prInfo.title}${checkTitle}`
    : "";

  return (
    <>
      {prInfo && (
        <a
          className={`card-github-badge ${prModifierClass}`}
          title={prTitle}
          href={prInfo.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <GitPullRequest size={10} />
          <span>#{prInfo.number}</span>
          {checkClass && checkRollup === "success" && (
            <span className={checkClass}>
              <CheckCircle2 size={10} />
            </span>
          )}
          {checkClass && checkRollup === "failure" && (
            <span className={checkClass}>
              <XCircle size={10} />
            </span>
          )}
          {checkClass && checkRollup === "pending" && (
            <span className={checkClass}>
              <Clock size={10} />
            </span>
          )}
        </a>
      )}
      {issueInfo && (
        <a
          className={`card-github-badge ${getIssueModifierClass(issueInfo.state, issueInfo.stateReason)}`}
          title={`Issue #${issueInfo.number}: ${issueInfo.title}`}
          href={issueInfo.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <CircleDot size={10} />
          <span>#{issueInfo.number}</span>
        </a>
      )}
    </>
  );
}
