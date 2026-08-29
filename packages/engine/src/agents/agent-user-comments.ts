import type { SteeringComment, TaskComment } from "@fusion/core";

const DEFAULT_USER_COMMENT_LIMIT = 20;

function commentTimestamp(comment: TaskComment): string {
  return comment.updatedAt || comment.createdAt;
}

function timestampMs(comment: TaskComment): number {
  const parsed = Date.parse(commentTimestamp(comment));
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteCommentText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return ["> (empty comment)"];
  return normalized.split(/\r?\n/).map((line) => `> ${line}`);
}

function normalizeSteeringComment(comment: SteeringComment): TaskComment {
  return {
    id: comment.id,
    text: comment.text,
    author: comment.author,
    createdAt: comment.createdAt,
  };
}

/**
 * FNXC:AgentSteering 2026-06-22-00:05:
 * Task-detail chat and user comments must reach every agent lane that builds prompts: executor, merger, reviewer, and planner. This helper is the canonical formatter for next-prompt delivery outside the executor's live steering injection path, so merger and reviewer prompts do not drift or duplicate comment logic.
 *
 * FNXC:AgentSteering 2026-06-30-12:28:
 * Reviewer gates are quality gates for explicit operator requirements. Select unified comments plus legacy steering comments here so mandatory Plan Review and optional workflow review nodes receive the same de-duped user-authored context without caller-specific formatting.
 *
 * FNXC:AgentSteering 2026-06-30-13:18:
 * Reviewer callers must request an uncapped selection because older user requirements remain binding quality-gate context; the default limit stays for non-review prompts that need bounded context.
 */
export function selectUserCommentsForAgentContext(
  task: { comments?: TaskComment[]; steeringComments?: SteeringComment[] },
  opts: { limit?: number | null } = {},
): TaskComment[] {
  const limit = opts.limit === null ? null : opts.limit ?? DEFAULT_USER_COMMENT_LIMIT;
  if (limit !== null && limit <= 0) return [];

  const byId = new Map<string, TaskComment>();
  const candidates: TaskComment[] = [
    ...(task.comments ?? []),
    ...(task.steeringComments ?? []).map(normalizeSteeringComment),
  ];

  for (const comment of candidates) {
    if (comment.author !== "user") continue;
    const existing = byId.get(comment.id);
    if (!existing || timestampMs(existing) <= timestampMs(comment)) {
      byId.set(comment.id, comment);
    }
  }

  const sorted = [...byId.values()].sort((a, b) => timestampMs(a) - timestampMs(b));
  return limit === null ? sorted : sorted.slice(-limit);
}

export function buildUserCommentsPromptSection(
  comments: TaskComment[],
  opts: { heading?: string; intro?: string } = {},
): string {
  if (comments.length === 0) return "";

  const heading = opts.heading ?? "## User Comments";
  const intro = opts.intro ?? "The following user comments were posted on this task. Consider and address this user feedback when completing your agent pass.";
  const lines = [heading, "", intro, ""];

  for (const comment of comments) {
    const timestamp = commentTimestamp(comment);
    lines.push(`**${comment.author}** — ${timestamp}`);
    lines.push(...quoteCommentText(comment.text));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
