import type { MessageMetadata } from "../types/messaging/messages.js";

export const TASK_RECOMMENDATION_NOTICE_KIND = "task-recommendation-notice";
export const ARTIFACT_NOTICE_METADATA_KEY = "artifactId";
export const DASHBOARD_INBOX_CATEGORIES = ["message", "recommendation", "artifact"] as const;

export type DashboardInboxCategory = (typeof DASHBOARD_INBOX_CATEGORIES)[number];

export function isDashboardInboxCategory(value: unknown): value is DashboardInboxCategory {
  return typeof value === "string" && (DASHBOARD_INBOX_CATEGORIES as readonly string[]).includes(value);
}

/*
FNXC:InboxCategories 2026-09-06-03:16:
Only an untyped artifact-registration notice may leave the ordinary dashboard inbox based on artifactId. Structural mail and messages with another kind remain ordinary mail even if they later acquire an artifactId, so new metadata cannot silently make operator correspondence inaccessible.
*/
export function classifyDashboardInboxMessage(metadata?: MessageMetadata): DashboardInboxCategory {
  if (metadata?.kind === TASK_RECOMMENDATION_NOTICE_KIND) {
    return "recommendation";
  }

  const artifactId = metadata?.[ARTIFACT_NOTICE_METADATA_KEY];
  if (
    metadata?.kind === undefined
    && metadata?.mailKind !== "report"
    && metadata?.mailKind !== "approval"
    && typeof artifactId === "string"
    && artifactId.trim().length > 0
  ) {
    return "artifact";
  }

  return "message";
}
