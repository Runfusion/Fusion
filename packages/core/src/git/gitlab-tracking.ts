import type { TaskGitLabTrackedItem } from "../types.js";

export function formatGitLabTrackedItemRef(item: Pick<TaskGitLabTrackedItem, "kind" | "iid" | "host">): string {
  const marker = item.kind === "merge_request" ? "!" : "#";
  return `${item.host} ${item.kind} ${marker}${item.iid}`;
}

export function isGitLabTrackingStale(item: Pick<TaskGitLabTrackedItem, "staleAt" | "staleReason"> | undefined): boolean {
  return Boolean(item?.staleAt || item?.staleReason);
}
