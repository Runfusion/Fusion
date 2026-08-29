import { memo, useEffect } from "react";
import type { IssueInfo, PrInfo, TaskGitLabTracking } from "@fusion/core";
import { useBadgeWebSocket } from "../hooks/useBadgeWebSocket";
import { GitHubBadge } from "./GitHubBadge";
import { GitLabBadge } from "./GitLabBadge";

export function pickPreferredBadge<T extends { lastCheckedAt?: string }>(
  liveValue: T | null | undefined,
  liveTimestamp: string | undefined,
  taskValue: T | undefined,
  taskTimestamp: string | undefined,
): T | undefined {
  if (liveValue == null) {
    return taskValue;
  }

  if (!liveTimestamp) {
    return taskValue ?? liveValue;
  }

  if (!taskTimestamp || liveTimestamp >= taskTimestamp) {
    return liveValue;
  }

  return taskValue;
}

interface TaskCardBadgeProps {
  taskId: string;
  prInfo?: PrInfo;
  issueInfo?: IssueInfo;
  gitlabTracking?: TaskGitLabTracking;
  updatedAt: string;
  isInViewport: boolean;
  projectId?: string;
}

function TaskCardBadgeComponent({ taskId, prInfo, issueInfo, gitlabTracking, updatedAt, isInViewport, projectId }: TaskCardBadgeProps) {
  const { badgeUpdates, subscribeToBadge, unsubscribeFromBadge } = useBadgeWebSocket(projectId);
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
  }, [hasGitHubBadge, isInViewport, projectId, subscribeToBadge, taskId, unsubscribeFromBadge]);

  const liveBadgeData = badgeUpdates.get(`${projectId ?? "default"}:${taskId}`);
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

  if (!livePrInfo && !liveIssueInfo && !gitlabTracking?.item) {
    return null;
  }

  return (
    <>
      <GitHubBadge prInfo={livePrInfo} issueInfo={liveIssueInfo} />
      <GitLabBadge item={gitlabTracking?.item} />
    </>
  );
}

export const TaskCardBadge = memo(TaskCardBadgeComponent);
TaskCardBadge.displayName = "TaskCardBadge";
