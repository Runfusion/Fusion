import type { TaskStore } from "@kb/core";
import type { PrInfo } from "@kb/core";
import { prMonitorLog } from "./logger.js";

interface PrComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
}

/**
 * Analyzes PR comments for actionable feedback and creates
 * steering comments or follow-up tasks.
 */
export class PrCommentHandler {
  // Keywords that suggest actionable feedback
  private readonly ACTION_KEYWORDS = [
    "fix",
    "change",
    "update",
    "remove",
    "add",
    "should",
    "need to",
    "needs to",
    "please",
    "consider",
    "suggest",
    "recommend",
  ];

  // Non-actionable patterns to filter out
  private readonly NON_ACTIONABLE_PATTERNS = [
    /^\s*lgtm\s*$/i,
    /^\s*looks? good\s*$/i,
    /^\s*thanks?\s*$/i,
    /^\s*thank you\s*$/i,
    /^\s*nice\s*$/i,
    /^\s*great\s*$/i,
    /^\s*awesome\s*$/i,
    /^\s*👍\s*$/,
    /^\s*✅\s*$/,
  ];

  constructor(private store: TaskStore) {}

  /**
   * Process new PR comments for a task.
   * Called by PrMonitor when new comments are detected.
   */
  async handleNewComments(
    taskId: string,
    prInfo: PrInfo,
    comments: PrComment[]
  ): Promise<void> {
    for (const comment of comments) {
      await this.processComment(taskId, prInfo, comment);
    }
  }

  private async processComment(
    taskId: string,
    prInfo: PrInfo,
    comment: PrComment
  ): Promise<void> {
    // Skip non-actionable comments
    if (this.isNonActionable(comment.body)) {
      prMonitorLog.log(`Skipping non-actionable comment #${comment.id}`);
      return;
    }

    // Check if comment contains actionable feedback
    const isActionable = this.isActionable(comment.body);
    const hasCodeSuggestions = this.hasCodeBlock(comment.body);

    if (!isActionable && !hasCodeSuggestions) {
      prMonitorLog.log(`Comment #${comment.id} does not contain actionable feedback`);
      return;
    }

    // Build steering comment text
    const text = this.buildSteeringText(prInfo, comment, hasCodeSuggestions);

    try {
      await this.store.addSteeringComment(taskId, text, "agent");
      prMonitorLog.log(`Added steering comment for PR review #${comment.id}`);
    } catch (err) {
      prMonitorLog.error(`Failed to add steering comment for ${taskId}:`, err);
    }
  }

  /**
   * Check if a comment is non-actionable (LGTM, thanks, etc.)
   */
  private isNonActionable(body: string): boolean {
    const trimmed = body.trim();
    return this.NON_ACTIONABLE_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Check if a comment contains actionable feedback keywords.
   */
  private isActionable(body: string): boolean {
    const lowerBody = body.toLowerCase();
    return this.ACTION_KEYWORDS.some((keyword) => lowerBody.includes(keyword));
  }

  /**
   * Check if a comment contains code blocks suggesting changes.
   */
  private hasCodeBlock(body: string): boolean {
    // Look for code blocks (``` or `code`)
    return /```[\s\S]*?```/.test(body) || /`[^`]+`/.test(body);
  }

  /**
   * Build steering comment text from PR review comment.
   */
  private buildSteeringText(
    prInfo: PrInfo,
    comment: PrComment,
    hasCodeSuggestions: boolean
  ): string {
    const lines: string[] = [];

    lines.push(`**PR Review Feedback** from @${comment.user.login}`);
    lines.push(`**PR:** #${prInfo.number} (${prInfo.status})`);
    lines.push("");

    // Truncate comment body if too long
    const maxBodyLength = 500;
    let body = comment.body.trim();
    if (body.length > maxBodyLength) {
      body = body.slice(0, maxBodyLength) + "...";
    }
    lines.push(body);
    lines.push("");

    if (hasCodeSuggestions) {
      lines.push("💡 This comment contains code suggestions. Please review and apply if appropriate.");
    }

    lines.push(`[View on GitHub](${comment.html_url})`);

    return lines.join("\n");
  }

  /**
   * Create a follow-up task when a PR is closed with unaddressed feedback.
   * This is called when a PR is merged or closed.
   */
  async createFollowUpTask(
    originalTaskId: string,
    prInfo: PrInfo,
    unaddressedComments: PrComment[]
  ): Promise<void> {
    if (unaddressedComments.length === 0) return;

    const summary = unaddressedComments
      .map((c) => `- @${c.user.login}: ${c.body.slice(0, 100).trim()}${c.body.length > 100 ? "..." : ""}`)
      .join("\n");

    const description = `Follow-up for ${originalTaskId}

PR #${prInfo.number} was ${prInfo.status} with unaddressed feedback:

${summary}

Please review the PR comments and address any remaining issues.`;

    try {
      const task = await this.store.createTask({
        title: `Follow-up: Address PR #${prInfo.number} feedback`,
        description,
        column: "triage",
        dependencies: [originalTaskId],
      });

      prMonitorLog.log(`Created follow-up task ${task.id} for PR #${prInfo.number}`);
    } catch (err) {
      prMonitorLog.error(`Failed to create follow-up task:`, err);
    }
  }
}
