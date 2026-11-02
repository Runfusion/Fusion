/*
FNXC:UnrunGateParkWithheldNotice 2026-11-02-03:45 (RUFU-318):
RUFU-276 shipped `routeUnrunGateParkBackToReview` to repair an `in-review` card terminalized over a
pre-merge gate that never ran, and paired it with `task:merge-unrun-gate-park-repaired`. That pair only
records the arm when it acts: both refusal outcomes (`seed-refused`, `signature-drift`) wrote no task-log
entry at all, and the audit row is deduped on an in-process key, so a refusal that persists across passes
is recorded at most once per engine lifetime. Measured on the motivating card RUFU-225: an 8-day park whose
`.fusion/tasks/RUFU-225/agent-log.jsonl` holds nothing after the terminalization, and whose only notice ever
was the `terminal-failed` wedge for the terminalization itself — never for the withheld repair. The board
could not answer "did the repair run and refuse, or never run" without direct database access.

This module lights the refusal path in the shape the repo already uses twice for exactly this problem
(RUFU-180 wedge + RUFU-371/RUFU-283 idempotent mailbox notice). The wedge seam was considered and rejected:
`claimTaskWedgeNotificationEpisode` keeps ONE active episode per task, and a card in this state already
carries an active wedge for its own terminalization (RUFU-225's `terminal-failed`), so a second reason either
loses the claim and is suppressed forever or overwrites an episode the operator is still reading. The repair
arm also has no stall code of its own to hang a descriptor on — inventing one would put a second authority
over the same card next to `NotificationService`, which stays the sole validation and dispatch authority for
everything it can represent.

So: one idempotent mailbox notice per (task, outcome, refusing guard, cooldown window), authored by the sweep,
bounded by `deliverMailboxMessageOnce` so an absent, throwing, or stalled mailbox cannot alter the repair
outcome. It changes no lifecycle, no verdict, and no column.
*/
import {
  DASHBOARD_USER_ID,
  WEDGE_RENOTIFY_COOLDOWN_MS,
  type MessageStore,
  type Task,
} from "@fusion/core";
import { deliverMailboxMessageOnce } from "./mailbox-delivery.js";
import { resolveStallParkAgeMs } from "./review-escalation-notice.js";
import type { UnrunPreMergeGateRefusalReason } from "../merge/pre-merge-gate-reseed.js";

/**
 * The paired `-no-action` counterpart of `task:merge-unrun-gate-park-repaired`, emitted when the arm admits a
 * card and withholds the repair. Declared here so the event name has one owner shared by the emitter, its
 * tests, and the documentation.
 */
export const UNRUN_GATE_PARK_NO_ACTION_EVENT = "task:merge-unrun-gate-park-no-action";

/** Which half of the arm withheld the repair. Mirrors the existing `-repaired` outcome vocabulary. */
export type UnrunGateParkWithheldOutcome = "seed-refused" | "signature-drift";

/**
 * The named refusing guard: the seed lane's own refusal half (already discriminated at its producer) plus the
 * fenced-clear drift the arm reports itself. Success is not expressible here because success is `-repaired`'s
 * record.
 */
export type UnrunGateParkRefusalReason = UnrunPreMergeGateRefusalReason | "park-signature-drift";

/** Census of the fixed vocabulary, asserted by a test so a new guard cannot enter the row unlisted. */
export const UNRUN_GATE_PARK_REFUSAL_REASONS = [
  "rerun-budget-exhausted",
  "active-continuation",
  "no-unrun-gate",
  "no-review-route",
  "not-singular",
  "operator-held",
  "workflow-selection-changed",
  "park-signature-drift",
] as const satisfies readonly UnrunGateParkRefusalReason[];

/**
 * Time-bucketed dedupe key for the arm's in-process audit set.
 *
 * The bucket is the whole point: a key over (task, outcome, guard) alone is swallowed by the `Set` for the
 * rest of the process, which is how an 8-day refusal produced one row and then silence. Dividing wall clock
 * by the wedge re-notify window makes a persistent refusal re-announce once per window while repeats inside a
 * window still collapse to a single row.
 */
export function unrunGateParkEpisodeKey(
  taskId: string,
  outcome: UnrunGateParkWithheldOutcome,
  refusalReason: UnrunGateParkRefusalReason,
  workflowStepId: string | null,
  now: number,
): string {
  const bucket = Math.floor(now / WEDGE_RENOTIFY_COOLDOWN_MS);
  return `${taskId}:unrun-gate-park:${outcome}:${refusalReason}:${workflowStepId ?? "unknown"}:${bucket}`;
}

/**
 * Stable History-line key for the durable withheld marker. Carries no time bucket on purpose: `logEntryOnce`
 * bounds repeats by `windowMs`, and a bucketed key would make that window inert while letting a new bucket
 * append a byte-identical line.
 */
export function unrunGateParkLogDedupeKey(
  taskId: string,
  outcome: UnrunGateParkWithheldOutcome,
  refusalReason: UnrunGateParkRefusalReason,
  workflowStepId: string | null,
): string {
  return `unrun-gate-park-withheld:${taskId}:${outcome}:${refusalReason}:${workflowStepId ?? "unknown"}`;
}

/** Idempotency key for the mailbox notice: one message per (task, outcome, guard, cooldown window). */
export function unrunGateParkNoticeKey(
  taskId: string,
  outcome: UnrunGateParkWithheldOutcome,
  refusalReason: UnrunGateParkRefusalReason,
  workflowStepId: string | null,
  now: number,
): string {
  const bucket = Math.floor(now / WEDGE_RENOTIFY_COOLDOWN_MS);
  return `system:unrun-gate-park-withheld:${taskId}:${outcome}:${refusalReason}:${workflowStepId ?? "unknown"}:${bucket}`;
}

/** The withheld sentence is fixed text over ids and a gate name; the blocker prose never reaches it. */
export function unrunGateParkNoticeContent(input: {
  taskId: string;
  outcome: UnrunGateParkWithheldOutcome;
  refusalReason: UnrunGateParkRefusalReason;
  workflowStepId: string | null;
  withheldAgeMs?: number;
}): string {
  const gate = input.workflowStepId ?? "unknown";
  const ageHours = typeof input.withheldAgeMs === "number"
    ? Math.floor(input.withheldAgeMs / (60 * 60 * 1000))
    : undefined;
  const why = input.outcome === "signature-drift"
    ? `the card's row changed under the repair, so its ${input.refusalReason === "park-signature-drift" ? "park signature" : input.refusalReason} clear was withheld`
    : `re-seeding it was refused (${input.refusalReason})`;
  return `Self-healing is holding ${input.taskId} in review with a pre-merge gate that never ran ('${gate}') `
    + `and the repair was withheld: ${why}${ageHours !== undefined ? ` (park waiting ${ageHours} h)` : ""}. `
    + `The card keeps its failed park — retry it, or run the gate by hand.`;
}

/**
 * Deliver one operator notice for a withheld never-ran-gate repair.
 *
 * Returns only `delivered` / `unavailable`; a missing, throwing, or stalled mailbox store cannot change the
 * arm's outcome, and the caller records the returned value in the same audit row as the refusal.
 */
export async function notifyUnrunGateParkWithheld(input: {
  messageStore?: Pick<MessageStore, "sendMessageOnce"> | null;
  task: Task;
  outcome: UnrunGateParkWithheldOutcome;
  refusalReason: UnrunGateParkRefusalReason;
  workflowStepId: string | null;
  /** Age of the failed park. Caller derives it from durable timestamps, never from this pass. */
  withheldAgeMs?: number;
  now?: number;
  timeoutMs?: number;
}): Promise<"delivered" | "unavailable"> {
  const now = input.now ?? Date.now();
  return deliverMailboxMessageOnce(
    input.messageStore ?? undefined,
    {
      fromId: "system",
      fromType: "system",
      toId: DASHBOARD_USER_ID,
      toType: "user",
      type: "system",
      content: unrunGateParkNoticeContent({
        taskId: input.task.id,
        outcome: input.outcome,
        refusalReason: input.refusalReason,
        workflowStepId: input.workflowStepId,
        ...(typeof input.withheldAgeMs === "number" ? { withheldAgeMs: input.withheldAgeMs } : {}),
      }),
      metadata: {
        kind: "unrun-gate-park-withheld",
        taskId: input.task.id,
        outcome: input.outcome,
        refusalReason: input.refusalReason,
        ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      },
    },
    unrunGateParkNoticeKey(input.task.id, input.outcome, input.refusalReason, input.workflowStepId, now),
    input.timeoutMs,
  );
}

/**
 * Age of the withheld park in ms, from the most durable timestamp the row carries.
 *
 * `updatedAt` moves when the arm itself writes, so the lane-entry timestamp wins when present — the same
 * lesson RUFU-371 recorded for RUFU-281, where a three-day park ranked as brand new.
 */
export function resolveUnrunGateParkAgeMs(task: Pick<Task, "columnMovedAt" | "updatedAt">, now: number): number | undefined {
  return resolveStallParkAgeMs({ columnMovedAt: task.columnMovedAt, updatedAt: task.updatedAt, now });
}
