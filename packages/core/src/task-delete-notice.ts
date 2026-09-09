/*
FNXC:TaskDeleteNotice 2026-08-20-18:40:
Delete attribution (task-delete-attribution.ts) answered "who deleted this?" only for someone who
later went digging through run-audit rows. The operator's actual complaint was that tasks vanished
from the board with no signal at all. This module closes that loop: when a task is deleted by an
actor that is NOT the operator, a durable notice lands in the operator's mailbox.

SCOPE — the operator chose this deliberately, do not widen it without asking:
  - NOTIFY for `agent-tool` (an AI agent called `fn_task_delete`) and `api-unattributed` (an HTTP
    caller that identified itself as nothing).
  - DO NOT notify for `operator-ui` / `operator-cli` — the operator performed the delete themselves
    and does not need to be told about their own click.
  - DO NOT notify for `engine` — engine deletes are routine automation traffic. The operator
    confirmed that behavior is fine and explicitly does not want the mailbox flooded with it.

HONESTY — `callerKind` is attribution, not authentication (see task-delete-attribution.ts's trust
model). `api-unattributed` means "nothing identified itself", NOT "an automation did it": the
`x-fusion-client` header is self-reported, so a stale browser tab, a curl, or a script all land in
the same bucket. The notice prose must say that plainly and must never imply an agent was involved
when the caller was merely unidentified.

BEST-EFFORT — the delete is the primary operation and the notice is strictly secondary. Every entry
point here swallows its own failures; a mailbox write must never surface as a failed delete, and it
must never run inside the delete transaction (a mailbox INSERT that throws would otherwise roll back
a committed soft-delete). Callers fire it AFTER the transaction commits.

PROSE PLACEMENT — the message body is operator-facing prose and lives in the MAILBOX only. The
`task:deleted` run-audit row still carries ids/counts/outcomes only; nothing here writes to it.

This module is observability/notification only. It adds no delete-blocking, gating, or permission
logic — an unattributed delete still succeeds, the operator just finds out about it.
*/

import { createLogger } from "./process/logger.js";
import type { TaskStore } from "./store.js";
import {
  buildDeleteCallerAuditFields,
  type TaskDeleteAuditContext,
  type TaskDeleteCallerKind,
} from "./task-delete-attribution.js";
import { DASHBOARD_USER_ID, type MessageCreateInput } from "./types.js";

const noticeLog = createLogger("task-delete-notice");

/**
 * FNXC:TaskDeleteNotice 2026-07-26-16:10:
 * The caller classes the operator wants to hear about. Kept as an exported constant (rather than
 * inlined in the predicate) so a test can assert the closed set against
 * `TASK_DELETE_CALLER_KINDS` and fail loudly if a new caller kind is added without a notify
 * decision being made for it.
 */
export const NOTIFIED_TASK_DELETE_CALLER_KINDS: readonly TaskDeleteCallerKind[] = [
  "agent-tool",
  "api-unattributed",
];

/** True when a delete by `callerKind` warrants an operator mailbox notice. */
export function shouldNotifyOperatorOfDelete(callerKind: TaskDeleteCallerKind): boolean {
  return NOTIFIED_TASK_DELETE_CALLER_KINDS.includes(callerKind);
}

/**
 * FNXC:TaskDeleteNotice 2026-07-26-16:10:
 * Minimal mailbox seam. Core cannot import the engine and does not own a MessageStore, so the
 * dependency is narrowed to the single method actually used. `MessageStore` structurally satisfies
 * this, and a test fake is two lines.
 */
export interface TaskDeleteNoticeMailbox {
  sendMessageOnce(input: MessageCreateInput, idempotencyKey: string): Promise<unknown>;
}

/*
FNXC:TaskDeleteNotice 2026-07-26-16:10:
Store-scoped registration keeps one notifier per TaskStore. A process can host several
projects; a process-global mailbox would post one project's delete into another project's inbox.
The unregister closure is identity-guarded so a torn-down runtime cannot erase a newer one's
registration. An unregistered store degrades silently to "no notice" — losing a notice is
acceptable, losing a delete is not.
*/
const mailboxes = new WeakMap<TaskStore, TaskDeleteNoticeMailbox>();

export function registerTaskDeleteNoticeMailbox(
  store: TaskStore,
  mailbox: TaskDeleteNoticeMailbox,
): () => void {
  mailboxes.set(store, mailbox);
  return () => {
    if (mailboxes.get(store) === mailbox) mailboxes.delete(store);
  };
}

export function getTaskDeleteNoticeMailbox(store: TaskStore): TaskDeleteNoticeMailbox | undefined {
  return mailboxes.get(store);
}

/** Pre-delete snapshot the notice describes. Captured before the row is mutated to `archived`. */
export interface TaskDeleteNoticeSnapshot {
  id: string;
  title?: string;
  /** The live column the task occupied before soft deletion wrote its historical sentinel. */
  previousColumn?: string;
  previousStatus?: string | null;
}

/**
 * FNXC:TaskDeleteNotice 2026-07-26-16:10:
 * Per-kind actor sentence. `api-unattributed` deliberately does NOT name an agent: the only true
 * statement about that caller is that nothing identified itself.
 */
function describeActor(callerKind: TaskDeleteCallerKind, callerTaskId: string | null): string {
  if (callerKind === "agent-tool") {
    return callerTaskId
      ? `An AI agent deleted it with the \`fn_task_delete\` tool while working on ${callerTaskId}.`
      : "An AI agent deleted it with the `fn_task_delete` tool. The calling task was not recorded.";
  }
  return [
    "The caller did not identify itself, so Fusion recorded it as `api-unattributed`.",
    "That is not evidence an automation did this: the `x-fusion-client` header is self-reported,",
    "so an unidentified caller can equally be a script, a stale browser tab, or a direct API call.",
    "All that is known is that nothing claimed responsibility.",
  ].join(" ");
}

/** Build the operator-facing mailbox body. Prose lives here and in the mailbox row only. */
export function buildTaskDeleteNoticeContent(
  task: TaskDeleteNoticeSnapshot,
  callerKind: TaskDeleteCallerKind,
  callerTaskId: string | null,
): string {
  const title = task.title?.trim();
  const heading = title ? `**${task.id} — ${title}** was deleted` : `**${task.id}** was deleted`;
  const where = task.previousColumn
    ? `It was in the \`${task.previousColumn}\` column${task.previousStatus ? ` (status \`${task.previousStatus}\`)` : ""} before the delete.`
    : "Its column before the delete was not recorded.";
  return [
    `${heading} — not by you.`,
    "",
    describeActor(callerKind, callerTaskId),
    where,
    "",
    `Caller class: \`${callerKind}\`${callerTaskId ? `, calling task: \`${callerTaskId}\`` : ""}.`,
    "The task is soft-deleted, so it can still be inspected or restored from the archive.",
  ].join("\n");
}

/*
FNXC:TaskDeleteNotice 2026-07-26-16:10:
`sendMessageOnce` rather than `sendMessage`, chosen for one concrete duplicate window: the PG
`deleteTaskBackendImpl` is reachable WITHOUT the per-task lock (only `deleteTaskIf` wraps it), so two
concurrent deletes of the same id can both pass the `task.deletedAt` short-circuit and both commit.
A plain send would post the same disappearance twice. The deterministic
`task-delete-notice:<taskId>` key lets the DB's conflict handling arbitrate instead, and a task id is
deleted at most once so the key can never collapse two genuinely distinct events.
*/
export function buildTaskDeleteNoticeIdempotencyKey(taskId: string): string {
  return `task-delete-notice:${taskId}`;
}

/**
 * FNXC:TaskDeleteNotice 2026-07-26-16:10:
 * Best-effort operator notice for a non-operator delete. NEVER throws and NEVER rejects — the
 * returned promise resolves to whether a notice was actually written, purely so tests can assert
 * the invariant. Call this only after the delete transaction has committed.
 */
export async function notifyOperatorOfNonOperatorDelete(
  store: TaskStore,
  task: TaskDeleteNoticeSnapshot,
  auditContext: TaskDeleteAuditContext | undefined,
): Promise<boolean> {
  try {
    // Resolve through the same helper the audit row uses so the notice can never claim a different
    // caller class than the persisted `task:deleted` metadata.
    const { callerKind, callerTaskId } = buildDeleteCallerAuditFields(auditContext);
    if (!shouldNotifyOperatorOfDelete(callerKind)) return false;
    const mailbox = mailboxes.get(store);
    if (!mailbox) return false;
    await mailbox.sendMessageOnce(
      {
        fromId: "system",
        fromType: "system",
        toId: DASHBOARD_USER_ID,
        toType: "user",
        type: "system",
        content: buildTaskDeleteNoticeContent(task, callerKind, callerTaskId),
        // Ids/enums only here too — the prose is the `content` field, not metadata.
        metadata: {
          kind: "task-delete-notice",
          taskId: task.id,
          callerKind,
          ...(callerTaskId ? { callerTaskId } : {}),
          ...(task.previousColumn ? { previousColumn: task.previousColumn } : {}),
          ...(task.previousStatus ? { previousStatus: task.previousStatus } : {}),
        },
      },
      buildTaskDeleteNoticeIdempotencyKey(task.id),
    );
    return true;
  } catch (error) {
    // Swallowed on purpose: the delete already committed. Surfacing this would turn a successful
    // delete into a 500 and (worse) invite a retry against an already-deleted task.
    noticeLog.warn(
      `Operator delete notice failed for ${task.id} (delete already committed): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
