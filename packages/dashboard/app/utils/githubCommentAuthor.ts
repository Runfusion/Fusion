export interface ReviewCommentAuthorResolution {
  author: string;
  authorIsBot: boolean;
  authorAvatarUrl?: string;
}

export interface ResolveReviewCommentAuthorOptions {
  reviewSource?: "pull-request" | "reviewer-agent";
}

const KNOWN_AGENT_LOGINS = new Set(["agent", "reviewer-agent", "fusion-agent", "fusion-reviewer", "executor-agent", "triage-agent", "merger-agent"]);

/*
FNXC:TaskReview 2026-06-27-00:00:
Task-detail Review comments only receive a GitHub login from the review backend, so the UI derives the same author shape as the GitHub import preview: `[bot]` suffixes are agents, missing logins render as `unknown`, and human logins get GitHub's deterministic PNG avatar URL.
Bot avatars are intentionally suppressed because synthetic `[bot]` logins often do not resolve to a real avatar; the Review tab renders a generic Bot icon instead of a broken image.

FNXC:TaskReview 2026-06-27-00:00:
Direct reviewer-agent feedback can arrive as `author.login: "reviewer-agent"` or without a login at all. Treat those known reviewer identities as agents so badges, fallback avatars, and Human/Bot filtering do not mislabel AI reviewer feedback as a human GitHub author.
*/
export function resolveReviewCommentAuthor(login?: string | null, options: ResolveReviewCommentAuthorOptions = {}): ReviewCommentAuthorResolution {
  const trimmedLogin = login?.trim() ?? "";
  const author = trimmedLogin || "unknown";
  const normalizedAuthor = author.toLowerCase();
  const authorIsBot = /\[bot\]$/i.test(author)
    || KNOWN_AGENT_LOGINS.has(normalizedAuthor)
    || (options.reviewSource === "reviewer-agent" && author === "unknown");
  const authorAvatarUrl = !authorIsBot && author !== "unknown"
    ? `https://github.com/${encodeURIComponent(author)}.png?size=40`
    : undefined;

  return { author, authorIsBot, authorAvatarUrl };
}
