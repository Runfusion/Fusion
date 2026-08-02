import { and, asc, eq, lt, lte } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { recordRunAuditEvent, type AsyncDataLayer } from "../postgres/data-layer.js";

export const TASK_LIFECYCLE_RETENTION_DAYS = 30;
export const TASK_LIFECYCLE_RETENTION_MAX_DELETES = 5_000;

export interface TaskLifecycleRetentionResult {
  readonly prunedCount: number;
  readonly oldestRetainedSeq: bigint | null;
  readonly minAckedSeq: bigint | null;
  readonly liveConsumerCount: number;
  readonly staleConsumerCount: number;
  readonly budgetExhausted: boolean;
}

/**
 * FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
 * This is the sole outbox pruning seam. Live registrations, not cursor rows, protect restartable
 * consumers; with no live identity, age-only pruning preserves the 30-day replay contract.
 */
export async function pruneTaskLifecycleEvents(
  layer: AsyncDataLayer,
  projectId: string,
  options: { now?: Date; retentionDays?: number; livenessDays?: number; maxDeletes?: number } = {},
): Promise<TaskLifecycleRetentionResult> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? TASK_LIFECYCLE_RETENTION_DAYS;
  const livenessDays = options.livenessDays ?? retentionDays;
  const maxDeletes = options.maxDeletes ?? TASK_LIFECYCLE_RETENTION_MAX_DELETES;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const liveCutoff = new Date(now.getTime() - livenessDays * 86_400_000).toISOString();
  const registrations = await layer.db.select().from(schema.project.taskLifecycleConsumerRegistrations)
    .where(eq(schema.project.taskLifecycleConsumerRegistrations.projectId, projectId));
  const live = registrations.filter((row) => row.active === 1 && row.lastSeenAt >= liveCutoff);
  const staleConsumerCount = registrations.length - live.length;
  let minAckedSeq: bigint | null = null;

  if (live.length > 0) {
    const cursorRows = await Promise.all(live.map(async (registration) => {
      const [cursor] = await layer.db.select().from(schema.project.taskLifecycleConsumerCursors).where(and(
        eq(schema.project.taskLifecycleConsumerCursors.projectId, projectId),
        eq(schema.project.taskLifecycleConsumerCursors.consumerId, registration.consumerId),
      )).limit(1);
      return cursor;
    }));
    // A registered identity may have started but not acked yet: never prune its history.
    if (cursorRows.some((cursor) => !cursor)) {
      return { prunedCount: 0, oldestRetainedSeq: null, minAckedSeq: null, liveConsumerCount: live.length, staleConsumerCount, budgetExhausted: false };
    }
    minAckedSeq = cursorRows.reduce<bigint>((minimum, cursor) =>
      cursor!.lastAckedSeq < minimum ? cursor!.lastAckedSeq : minimum,
    cursorRows[0]!.lastAckedSeq);
  }

  const candidates = await layer.db.select({ seq: schema.project.taskLifecycleEvents.seq })
    .from(schema.project.taskLifecycleEvents)
    .where(live.length === 0
      ? and(eq(schema.project.taskLifecycleEvents.projectId, projectId), lt(schema.project.taskLifecycleEvents.occurredAt, cutoff))
      : and(
        eq(schema.project.taskLifecycleEvents.projectId, projectId),
        lt(schema.project.taskLifecycleEvents.occurredAt, cutoff),
        lte(schema.project.taskLifecycleEvents.seq, minAckedSeq!),
      ))
    .orderBy(asc(schema.project.taskLifecycleEvents.seq))
    .limit(maxDeletes);
  if (candidates.length > 0) {
    await layer.db.delete(schema.project.taskLifecycleEvents).where(and(
      eq(schema.project.taskLifecycleEvents.projectId, projectId),
      // Bounded candidate selection avoids an unbounded conditional DELETE under concurrent writers.
      lte(schema.project.taskLifecycleEvents.seq, candidates[candidates.length - 1]!.seq),
      lt(schema.project.taskLifecycleEvents.occurredAt, cutoff),
      ...(minAckedSeq === null ? [] : [lte(schema.project.taskLifecycleEvents.seq, minAckedSeq)]),
    ));
  }
  const [oldest] = await layer.db.select({ seq: schema.project.taskLifecycleEvents.seq })
    .from(schema.project.taskLifecycleEvents).where(eq(schema.project.taskLifecycleEvents.projectId, projectId))
    .orderBy(asc(schema.project.taskLifecycleEvents.seq)).limit(1);
  const result = {
    prunedCount: candidates.length,
    oldestRetainedSeq: oldest?.seq ?? null,
    minAckedSeq,
    liveConsumerCount: live.length,
    staleConsumerCount,
    budgetExhausted: candidates.length === maxDeletes,
  };
  await recordRunAuditEvent(layer, {
    agentId: "system",
    runId: "task-deleted-outbox:retention",
    domain: "task-lifecycle",
    mutationType: "task-deleted-outbox:retention-pruned",
    target: projectId,
    metadata: {
      projectId,
      prunedCount: result.prunedCount,
      oldestRetainedSeq: result.oldestRetainedSeq?.toString() ?? null,
      minAckedSeq: result.minAckedSeq?.toString() ?? null,
      liveConsumerCount: result.liveConsumerCount,
      staleConsumerCount: result.staleConsumerCount,
      budgetExhausted: result.budgetExhausted,
    },
  });
  return result;
}
