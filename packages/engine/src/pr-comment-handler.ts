import type { TaskStore } from "@fusion/core";
import type { PrInfo } from "@fusion/core";
import { prMonitorLog } from "./logger.js";
import { createAutomatedFollowup } from "./verification-followup-dedup.js";

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

    // Build comment text
    const text = this.buildCommentText(prInfo, comment, hasCodeSuggestions);

    try {
      await this.store.addTaskComment(taskId, text, "agent");
      await this.upsertReviewItem(taskId, prInfo, comment, "queued");
      prMonitorLog.log(`Added comment for PR review #${comment.id}`);
    } catch (err) {
      prMonitorLog.error(`Failed to add comment for ${taskId}:`, err);
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
   * Build comment text from PR review comment.
   */
  private buildCommentText(
    prInfo: PrInfo,
    comment: PrComment,
    hasCodeSuggestions: boolean
  ): string {
    const lines: string[] = [];

    lines.push(`**PR Review Feedback** from @${comment.user.login}`);
    lines.push(`**PR:** #${prInfo.number} (${prInfo.status})`);
    if (prInfo.status !== "open") {
      lines.push(`**Note:** This PR is already ${prInfo.status}. Treat the feedback as follow-up work.`);
    }
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
   * Handle "changes requested" PR review state.
   * Moves the task back to in-progress with reviewer feedback as a steering comment,
   * closing the feedback loop so the agent can address the requested changes.
   */
  async handleChangesRequested(
    taskId: string,
    prInfo: PrInfo,
    reviewerLogin: string,
    reviewBody: string,
  ): Promise<void> {
    try {
      const task = await this.store.getTask(taskId);
      if (task.column !== "in-review") {
        prMonitorLog.log(`Task ${taskId} not in-review (${task.column}), skipping changes-requested handling`);
        return;
      }

      // Add reviewer feedback as a steering comment
      const feedbackText = [
        `**Changes Requested** by @${reviewerLogin} on PR #${prInfo.number}`,
        "",
        reviewBody ? reviewBody.slice(0, 800) : "(no review body)",
        "",
        "Please address the requested changes and update the PR.",
      ].join("\n");

      await this.store.addTaskComment(taskId, feedbackText, "agent");
      await this.upsertReviewItem(
        taskId,
        prInfo,
        {
          id: Date.now(),
          body: reviewBody || "(no review body)",
          user: { login: reviewerLogin },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          html_url: prInfo.url,
        },
        "queued",
      );
      await this.store.moveTask(taskId, "in-progress");
      await this.store.logEntry(
        taskId,
        `PR #${prInfo.number}: changes requested by @${reviewerLogin} — moved back to in-progress`,
      );
      prMonitorLog.log(`Task ${taskId} moved to in-progress after changes requested on PR #${prInfo.number}`);
    } catch (err) {
      prMonitorLog.error(`Failed to handle changes-requested for ${taskId}:`, err);
    }
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
      const result = await createAutomatedFollowup(this.store, {
        kind: "pr-comment",
        parentTaskId: originalTaskId,
        extraMatchKeys: { prNumber: prInfo.number },
        createInput: {
          title: `Follow-up: Address PR #${prInfo.number} feedback`,
          description,
          column: "triage",
          dependencies: [originalTaskId],
          source: {
            sourceType: "api",
            sourceParentTaskId: originalTaskId,
            sourceMetadata: { prNumber: prInfo.number, prUrl: prInfo.url },
          },
        },
      });

      if (result.outcome === "created") {
        prMonitorLog.log(`Created follow-up task ${result.task.id} for PR #${prInfo.number}`);
      } else {
        prMonitorLog.log(`Reused follow-up task ${result.existingTaskId} for PR #${prInfo.number}`);
      }
    } catch (err) {
      prMonitorLog.error(`Failed to create follow-up task:`, err);
    }
  }

  private async upsertReviewItem(
    taskId: string,
    prInfo: PrInfo,
    comment: PrComment,
    status: "queued" | "in-progress" | "addressed" | "failed",
  ): Promise<void> {
    const task = await this.store.getTask(taskId);
    const now = new Date().toISOString();
    const current = task.review ?? {
      mode: "pull-request",
      source: "github-pr",
      decision: "pending",
      items: [],
      selectedItemIds: [],
    };
    const itemId = `gh-comment-${comment.id}`;
    const existingIndex = current.items.findIndex((item: { id: string }) => item.id === itemId);
    const nextItem = {
      id: itemId,
      source: "github-pr" as const,
      status,
      summary: comment.body.trim().slice(0, 160) || `Feedback from @${comment.user.login}`,
      body: comment.body,
      reviewer: comment.user.login,
      commentUrl: comment.html_url,
      createdAt: comment.created_at,
      updatedAt: now,
    };
    const nextItems = [...current.items];
    if (existingIndex >= 0) {
      nextItems[existingIndex] = { ...nextItems[existingIndex], ...nextItem };
    } else {
      nextItems.push(nextItem);
    }

    const currentReviewState = task.reviewState ?? {
      source: "pull-request" as const,
      items: [],
      addressing: [],
    };
    const existingReviewStateIndex = currentReviewState.items.findIndex((item) => item.id === itemId);
    const nextReviewStateItem = {
      id: itemId,
      githubCommentId: comment.id,
      body: comment.body,
      author: { login: comment.user.login },
      createdAt: comment.created_at,
      updatedAt: now,
      htmlUrl: comment.html_url,
      source: "github-pr" as const,
    };
    const nextReviewStateItems = [...currentReviewState.items];
    if (existingReviewStateIndex >= 0) {
      nextReviewStateItems[existingReviewStateIndex] = { ...nextReviewStateItems[existingReviewStateIndex], ...nextReviewStateItem };
    } else {
      nextReviewStateItems.push(nextReviewStateItem);
    }

    await this.store.updateTask(taskId, {
      review: {
        ...current,
        mode: "pull-request",
        source: "github-pr",
        summary: `PR #${prInfo.number} feedback items: ${nextItems.length}`,
        latestRefreshAt: now,
        items: nextItems,
      },
      reviewState: {
        ...currentReviewState,
        source: "pull-request",
        summary: currentReviewState.summary,
        items: nextReviewStateItems,
      },
    });
  }
}
