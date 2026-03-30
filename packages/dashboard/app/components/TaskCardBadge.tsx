import { memo, useEffect } from "react";
import type { IssueInfo, PrInfo } from "@kb/core";
import { useBadgeWebSocket } from "../hooks/useBadgeWebSocket";
import { GitHubBadge } from "./GitHubBadge";

export function pickPreferredBadge<T extends { lastCheckedAt?: string }>(
  liveValue: T | null | undefined,
  liveTimestamp: string | undefined,
  taskValue: T | undefined,
  taskTimestamp: string | undefined,
): T | undefined {
  if (liveValue === undefined || !liveTimestamp) {
    return taskValue;
  }

  if (!taskTimestamp || liveTimestamp >= taskTimestamp) {
    return liveValue ?? undefined;
  }

  return taskValue;
}

interface TaskCardBadgeProps {
  taskId: string;
  prInfo?: PrInfo;
  issueInfo?: IssueInfo;
  updatedAt: string;
  isInViewport: boolean;
}

function TaskCardBadgeComponent({ taskId, prInfo, issueInfo, updatedAt, isInViewport }: TaskCardBadgeProps) {
  const { badgeUpdates, subscribeToBadge, unsubscribeFromBadge } = useBadgeWebSocket();
  const hasGitHubBadge = Boolean(prInfo || issueInfo);

  useEffect(() => {
    if (!hasGitHubBadge || !isInViewport) {
      unsubscribeFromBadge(taskId);
      return;
    }

    subscribeToBadge(taskId);
    return () => {
      unsubscribeFromBadge(taskId);
    };
  }, [hasGitHubBadge, isInViewport, subscribeToBadge, taskId, unsubscribeFromBadge]);

  const liveBadgeData = badgeUpdates.get(taskId);
  const livePrInfo = pickPreferredBadge<PrInfo>(
    liveBadgeData?.prInfo,
    liveBadgeData?.timestamp,
    prInfo,
    prInfo?.lastCheckedAt ?? updatedAt,
  );
  const liveIssueInfo = pickPreferredBadge<IssueInfo>(
    liveBadgeData?.issueInfo,
    liveBadgeData?.timestamp,
    issueInfo,
    issueInfo?.lastCheckedAt ?? updatedAt,
  );

  if (!livePrInfo && !liveIssueInfo) {
    return null;
  }

  return <GitHubBadge prInfo={livePrInfo} issueInfo={liveIssueInfo} />;
}

export const TaskCardBadge = memo(TaskCardBadgeComponent);
TaskCardBadge.displayName = "TaskCardBadge";
