/*
FNXC:TaskRecommendations 2026-08-15-22:44:
SCOPE — notices fire only for a new, non-empty recommendation list at an ACCEPTED completion. Do
not invoke this for a rolled-back handoff, `linkTaskRecommendation`, or the create-from-
recommendation route: those only stamp `createdTaskId` on an existing proposal.

BEST-EFFORT + NON-BLOCKING — callers dispatch without awaiting. This is the sole place mailbox
failures may be observed, and it swallows them so recommendation capture and task completion remain
independent from mailbox availability.

MAILBOX ACTIONS — dashboard notices now expose inline Create task controls. Operator-facing prose
still belongs only in content; metadata remains ids, enums, and counts so the dashboard resolves
current recommendation text and link state from the parent task rather than storing a duplicate snapshot.
*/

import { createHash } from "node:crypto";
import { createLogger } from "./process/logger.js";
import type { TaskStore } from "./store.js";
import { DASHBOARD_USER_ID, type MessageCreateInput, type TaskRecommendation } from "./types.js";

const noticeLog = createLogger("task-recommendation-notice");

/** Narrow mailbox seam so core does not need to own or import MessageStore. */
export interface TaskRecommendationNoticeMailbox {
  sendMessageOnce(input: MessageCreateInput, idempotencyKey: string): Promise<unknown>;
}

/*
FNXC:TaskRecommendations 2026-08-13-03:56:
Registration is store-scoped because one process can host multiple projects; a process-global
mailbox could post one project's proposals into another project's operator inbox. Identity-guarded
teardown keeps an old runtime from erasing a newer registration.
*/
const mailboxes = new WeakMap<TaskStore, TaskRecommendationNoticeMailbox>();

export function registerTaskRecommendationNoticeMailbox(
  store: TaskStore,
  mailbox: TaskRecommendationNoticeMailbox,
): () => void {
  mailboxes.set(store, mailbox);
  return () => {
    if (mailboxes.get(store) === mailbox) mailboxes.delete(store);
  };
}

export function getTaskRecommendationNoticeMailbox(
  store: TaskStore,
): TaskRecommendationNoticeMailbox | undefined {
  return mailboxes.get(store);
}

/** Builds the operator-facing content; recommendation prose stays out of metadata. */
export function buildTaskRecommendationNoticeContent(
  task: { id: string; title?: string },
  recommendations: TaskRecommendation[],
): string {
  const title = task.title?.trim();
  const heading = title ? `## Recommendations from ${task.id} — ${title}` : `## Recommendations from ${task.id}`;
  return [
    heading,
    "",
    "These are optional, non-blocking out-of-scope proposals that were **not** executed.",
    "",
    ...recommendations.map((recommendation) => `- **${recommendation.title}** — \`${recommendation.category}\`: ${recommendation.description}`),
    "",
    `Use the **Create task** button beside each recommendation to file it through guarded intake. You can also open ${task.id}'s **Recommendations** tab to review them.`,
  ].join("\n");
}

/*
FNXC:TaskRecommendations 2026-08-13-03:56:
`fn_task_done` is re-runnable after a workflow-step revision and both completion paths can rewrite
the same list. A task-only key would hide a genuinely changed proposal set, while plain send would
spam retries. Hashing sorted recommendation ids dedupes a retry yet notices a real id-set change.
*/
export function buildTaskRecommendationNoticeIdempotencyKey(
  taskId: string,
  recommendations: TaskRecommendation[],
): string {
  const ids = recommendations.map(({ id }) => id).sort().join("\n");
  const digest = createHash("sha256").update(ids, "utf8").digest("hex").slice(0, 16);
  return `task-recommendation-notice:${taskId}:${digest}`;
}

/**
 * Best-effort operator notice. It never throws so a mailbox failure cannot fail accepted completion.
 */
export async function notifyOperatorOfTaskRecommendations(
  store: TaskStore,
  task: { id: string; title?: string },
  recommendations: TaskRecommendation[] | undefined,
  settings: { recommendationMailboxNoticeEnabled?: boolean },
): Promise<boolean> {
  try {
    if (settings.recommendationMailboxNoticeEnabled === false || !recommendations?.length) return false;
    const mailbox = mailboxes.get(store);
    if (!mailbox) return false;
    await mailbox.sendMessageOnce(
      {
        fromId: "system",
        fromType: "system",
        toId: DASHBOARD_USER_ID,
        toType: "user",
        type: "system",
        content: buildTaskRecommendationNoticeContent(task, recommendations),
        metadata: {
          kind: "task-recommendation-notice",
          taskId: task.id,
          recommendationCount: recommendations.length,
          recommendationIds: recommendations.map(({ id }) => id),
          categories: recommendations.map(({ category }) => category),
        },
      },
      buildTaskRecommendationNoticeIdempotencyKey(task.id, recommendations),
    );
    return true;
  } catch (error) {
    noticeLog.warn(
      `Operator recommendation notice failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
