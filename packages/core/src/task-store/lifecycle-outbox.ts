import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../postgres/data-layer.js";
import type { TaskDeleteClosureContext } from "../types.js";

export type TaskDeletedLifecyclePayload = {
  taskId: string;
  previousColumn: string;
  previousStatus: string | null;
  deletedAt: string;
  allowResurrection: boolean;
  githubIssueAction: string | null;
  closureContext: TaskDeleteClosureContext | null;
  deletedBy: string | null;
};

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
  input: { projectId: string; eventType: "task:deleted"; taskId: string; occurredAt: string; payload: TaskDeletedLifecyclePayload },
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
