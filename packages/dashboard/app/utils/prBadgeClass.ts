import type { PrInfo } from "@fusion/core";

type PrBadgeClassInput = Pick<PrInfo, "status" | "isDraft" | "draft" | "mergeable">;

type PrBadgeModifierClass =
  | "card-github-badge--conflicting"
  | "card-github-badge--draft"
  | "card-github-badge--open"
  | "card-github-badge--merged"
  | "card-github-badge--closed";

/**
 * FNXC:PRBadgeStatusColor 2026-06-27-00:00:
 * PR badges must use one status-color source of truth across TaskCard's multi-PR link and GitHubBadge's single-PR link. Match GitHub's live PR conventions: open=green, draft=gray, merged=purple, closed=red, and open conflicts/blocks=red-caution while checks stay in their separate sub-badge.
 */
export function getPrBadgeModifierClass(prInfo: PrBadgeClassInput): PrBadgeModifierClass {
  if (prInfo.status === "open" && (prInfo.mergeable === "conflicting" || prInfo.mergeable === "blocked")) {
    return "card-github-badge--conflicting";
  }

  if (prInfo.status === "draft" || (prInfo.status === "open" && (prInfo.draft ?? prInfo.isDraft))) {
    return "card-github-badge--draft";
  }

  if (prInfo.status === "merged") return "card-github-badge--merged";
  if (prInfo.status === "closed") return "card-github-badge--closed";
  return "card-github-badge--open";
}
