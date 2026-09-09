import type { TaskStore } from "@fusion/core";
import type { PrInfo } from "@fusion/core";
import { prMonitorLog } from "../logger.js";
import { resolveTerminalColumnsFor } from "../executor.js";
import { resolveWorkflowIrForTask, columnsWithFlag } from "@fusion/core";

/*
FNXC:PullRequestReview 2026-07-26-00:00:
PR-feedback follow-ups inline one dedup rule: never file a second card for the same PR number under the same parent while one is still open. Workflow Complete columns are excluded so a later close/reopen can legitimately file a fresh card.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-19:15 (the SECOND copy of the same dedup, converted with the first):
Byte-identical to `eval-followups.ts`'s constant and used for the same question — "is an earlier follow-up
for this parent still open?" — so it had the same defect: on a renamed board a FINISHED follow-up read as
open, the dedup matched it forever, and no fresh PR-feedback card was ever filed.

Converting one and leaving the other is the FN-6115 -> FN-6118 -> FN-6123 shape, so both move together and
both now call the shared `resolveTerminalColumnsFor` instead of carrying a private terminal list.
*/

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
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-18:20 (engine):
      TWO lifecycle literals on this path, and only ONE of them is countable.

      The GATE (`!== "in-review"`) silently dropped a GitHub "changes requested" review on any board
      whose review lane is renamed: no steering comment was recorded and the card never went back to
      work, so a human reviewer's feedback vanished with a log line nobody reads. That is the counted one.

      The DESTINATION below (`moveTask(taskId, "in-progress")`) is a call argument, so the census cannot
      see it — the same pairing as the branch-worktree auto-requeue (#2797). Converting the gate alone
      would let the handler admit the review and then attempt a move into a lane the board may not
      declare, which `moveTask` rejects. They convert together or not at all.

      Both fall back to the legacy ids: `resolveWorkflowIrForTask` degrades to the BUILT-IN IR rather
      than throwing, so a board whose workflow cannot be read behaves exactly as before.
      */
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-18:55 (#2807 review — greptile P1 "broad review-lane
      admission"):
      MERGE-ORCHESTRATION ONLY, not the three-flag review union. The first version admitted any column
      carrying `mergeOrchestration` OR `mergeBlocker` OR `humanReview`; on a workflow that puts those on
      SEPARATE columns that is a widening, not a conversion — a card parked in a plan-review or
      human-approval lane would be bounced into wip by a PR review that has nothing to do with it.

      The literal this replaced admitted exactly ONE lane, and the faithful resolution is the one role
      that means "this is the PR/merge stage": `mergeOrchestration`. That is also what
      `resolveLifecycleColumns` keys its `review` role on, so this handler and the core resolver agree.

      Known consequence, and it is the pre-existing behaviour rather than a regression: a custom workflow
      whose review lane carries ONLY `human-review` resolves nothing here and falls back to the legacy
      `in-review`. Widening to cover it is the gap recorded in
      `notification-renamed-lifecycle-columns.test.ts`, and it belongs in the shared resolver rather than
      being invented per-handler.
      */
      const reviewLanes = new Set<string>(["in-review"]);
      let wipTarget = "in-progress";
      try {
        const ir = await resolveWorkflowIrForTask(this.store, taskId);
        if (ir) {
          for (const id of columnsWithFlag(ir, "mergeOrchestration")) reviewLanes.add(id);
          const wipLanes = columnsWithFlag(ir, "countsTowardWip");
          if (wipLanes.length > 0) wipTarget = wipLanes[0];
        }
      } catch { /* degraded: legacy ids */ }
      if (!reviewLanes.has(task.column)) {
        prMonitorLog.log(`Task ${taskId} not in a review lane (${task.column}), skipping changes-requested handling`);
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
      await this.store.moveTask(taskId, wipTarget);
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
      const openTasks = await this.store.listTasks({ slim: true }).catch(() => []);
      /* Cheap identity filters first; only real candidates pay a workflow resolution. */
      const candidates = openTasks.filter(
        (task) =>
          task.id !== originalTaskId &&
          task.sourceParentTaskId === originalTaskId &&
          task.sourceMetadata?.prNumber === prInfo.number,
      );
      let existing: (typeof candidates)[number] | undefined;
      for (const task of candidates) {
        const terminal = await resolveTerminalColumnsFor(this.store, task.id);
        if (!terminal.includes(task.column)) { existing = task; break; }
      }

      if (existing) {
        prMonitorLog.log(`Reused follow-up task ${existing.id} for PR #${prInfo.number}`);
        return;
      }

      const task = await this.store.createTask({
        title: `Follow-up: Address PR #${prInfo.number} feedback`,
        description,
        /* FNXC:WorkflowLifecycleColumns 2026-07-29-20:15 (U11): no explicit column —
           `createTaskImpl` resolves the WORKFLOW'S intake column, and `input.column` would
           override it. Hard-coding `"triage"` created the card in a column the default
           lineage no longer declares (#2515), i.e. straight into the stranded state. */
        dependencies: [originalTaskId],
        source: {
          sourceType: "api",
          sourceParentTaskId: originalTaskId,
          sourceMetadata: { prNumber: prInfo.number, prUrl: prInfo.url },
        },
      });
      prMonitorLog.log(`Created follow-up task ${task.id} for PR #${prInfo.number}`);
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
