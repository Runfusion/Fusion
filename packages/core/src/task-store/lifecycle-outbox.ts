import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../postgres/data-layer.js";
import type { TaskStore } from "../store.js";

export type TaskDeletedLifecyclePayload = {
  taskId: string;
  previousColumn: string;
  previousStatus: string | null;
  deletedAt: string;
  allowResurrection: boolean;
  githubIssueAction: string | null;
  deletedBy: string | null;
};

/*
FNXC:ReviewLaneDispatch 2026-09-09 (STAS-205):
Every other column transition was invisible to the outbox because the CHECK allowed one
event type, so "when did this card enter review?" had no committed answer. Entering review
is the fact the dispatch invariant is keyed on, so it is the one addition here; the payload
stays a discriminated union so a new event type cannot borrow another type's payload.
*/
export type TaskEnteredReviewLifecyclePayload = {
  taskId: string;
  previousColumn: string;
  toColumn: string;
  enteredAt: string;
  actor: string;
};

export type TaskLifecycleEventInput =
  | { projectId: string; eventType: "task:deleted"; taskId: string; occurredAt: string; payload: TaskDeletedLifecyclePayload }
  | { projectId: string; eventType: "task:entered-review"; taskId: string; occurredAt: string; payload: TaskEnteredReviewLifecyclePayload };

export function makeTaskLifecycleEventId(projectId: string, eventType: string, taskId: string, occurredAt: string): string {
  return `evt_${createHash("sha256").update(`${projectId}\0${eventType}\0${taskId}\0${occurredAt}`).digest("hex").slice(0, 32)}`;
}

/**
 * FNXC:LifecycleOutbox 2026-08-01-10:33:
 * Allocation occurs in the delete transaction. Each project counter row remains locked to
 * commit, so allocation order is commit order; rollback reverts the counter and consumes no
 * sequence. This avoids both cross-project contention and MAX(seq)+1 collision aborts.
 */
export async function appendTaskLifecycleEventInTransaction(
  tx: DbTransaction,
  input: TaskLifecycleEventInput,
): Promise<{ seq: string; eventId: string }> {
  const sequenceRows = await tx.execute(sql`
    INSERT INTO project.task_lifecycle_event_seq (project_id, last_seq)
    VALUES (${input.projectId}, 1)
    ON CONFLICT (project_id)
    DO UPDATE SET last_seq = project.task_lifecycle_event_seq.last_seq + 1
    RETURNING last_seq
  `) as unknown as Array<{ last_seq: number | string }>;
  // FNXC:LifecycleOutbox 2026-08-01-10:33: PostgreSQL bigint values exceed
  // Number's exact range; preserve the returned decimal sequence for the INSERT.
  const seq = String(sequenceRows[0]!.last_seq);
  const eventId = makeTaskLifecycleEventId(input.projectId, input.eventType, input.taskId, input.occurredAt);
  await tx.execute(sql`
    INSERT INTO project.task_lifecycle_events
      (project_id, seq, event_id, event_type, task_id, occurred_at, created_at, payload)
    VALUES (${input.projectId}, ${seq}, ${eventId}, ${input.eventType}, ${input.taskId}, ${input.occurredAt}, ${input.occurredAt}, ${JSON.stringify(input.payload)}::jsonb)
  `);
  return { seq, eventId };
}

/*
FNXC:ReviewLaneDispatch 2026-09-16-16:20 (#3619 review E):
The dispatch sweep must not key grace/ordering on `task.updatedAt` — an unrelated edit (a comment,
a description bump) advances that timestamp, so a card awaiting dispatch could be held in the grace
window indefinitely or shuffled backwards in the queue. The committed `task:entered-review` event is
the durable entry timestamp both checks key on. Returns null for cards that entered the review lane
before migration 0084 introduced the event; callers fall back to `updatedAt` for those.
*/
export async function latestTaskEnteredReviewAt(store: TaskStore, taskId: string): Promise<string | null> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error(`latestTaskEnteredReviewAt requires the async data layer (task ${taskId})`);
  const projectId = layer.projectId;
  if (!projectId) throw new Error(`latestTaskEnteredReviewAt requires a project-bound data layer (task ${taskId})`);
  const rows = await layer.transactionImmediate(async (tx: DbTransaction) => {
    return await tx.execute(sql`
      SELECT occurred_at
        FROM project.task_lifecycle_events
       WHERE project_id = ${projectId}
         AND task_id = ${taskId}
         AND event_type = 'task:entered-review'
       ORDER BY seq DESC
       LIMIT 1
    `) as unknown as Array<{ occurred_at: string }>;
  });
  return rows[0]?.occurred_at ?? null;
}
