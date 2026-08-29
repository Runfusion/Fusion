import { GitBranch, AlertTriangle } from "lucide-react";
import type { TaskGitLabTrackedItem } from "@fusion/core";

export function formatGitLabBadgeKind(item: Pick<TaskGitLabTrackedItem, "kind">): string {
  if (item.kind === "merge_request") return "MR";
  if (item.kind === "group_issue") return "Group issue";
  return "Issue";
}

export function formatGitLabBadgeMarker(item: Pick<TaskGitLabTrackedItem, "kind" | "iid">): string {
  return `${item.kind === "merge_request" ? "!" : "#"}${item.iid}`;
}

export function GitLabBadge({ item }: { item?: TaskGitLabTrackedItem }) {
  if (!item) return null;
  const stale = Boolean(item.staleAt || item.staleReason);
  const title = `GitLab ${formatGitLabBadgeKind(item)} ${formatGitLabBadgeMarker(item)}${item.title ? `: ${item.title}` : ""}${stale ? ` — stale${item.staleReason ? `: ${item.staleReason}` : ""}` : ""}`;

  return (
    <a
      className={`card-github-badge card-gitlab-badge ${stale ? "card-gitlab-badge--stale" : "card-github-badge--open"}`}
      title={title}
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={title}
      data-testid="card-gitlab-badge"
    >
      {stale ? <AlertTriangle size={10} aria-hidden="true" /> : <GitBranch size={10} aria-hidden="true" />}
      <span>{formatGitLabBadgeMarker(item)}</span>
    </a>
  );
}
