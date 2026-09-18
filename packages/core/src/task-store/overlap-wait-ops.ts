import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import type { Task, TaskLogEntry } from "../types.js";
import type {
  OverlapWaitClaim,
  OverlapWaitDeliverySnapshot,
  OverlapWaitExecutionIdentity,
  OverlapWaitPhase,
  OverlapWaitReceipt,
  TaskOverlapWait,
} from "../types/task/task-overlap-wait.js";
import type { TaskStore } from "../store.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { getTaskActivityLogEntryLimit, truncateTaskLogOutcome } from "./comments.js";

/*
FNXC:OverlapWaitSynchronization 2026-09-17-00:05:
Persistence for FN-332 "overlap wait synchronization": a file-scope wait must stay durable after
the transient `task.overlapBlockedBy` marker clears. Every observed predecessor edge is recorded
into `project.task_overlap_waits` in the SAME transaction that would otherwise replace/clear the
marker (see observeOverlapWaitTransitionInTransaction, called from audit-ops.ts
transitionQueuedEpisodeImpl and reset-lifecycle.ts). The executor later claims a pending episode,
proves delivery freshness, and publishes exactly one of resume/briefing/revalidate before the
continuation may resume — see packages/engine/src/workflows/overlap-plan-revalidation.ts.
*/

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapRow(row: typeof schema.project.taskOverlapWaits.$inferSelect): TaskOverlapWait {
  return {
    projectId: row.projectId,
    taskId: row.taskId,
    episodeId: row.episodeId,
    blockerTaskId: row.blockerTaskId,
    ...(row.taskLineageId ? { taskLineageId: row.taskLineageId } : {}),
    ...(row.blockerLineageId ? { blockerLineageId: row.blockerLineageId } : {}),
    observedAt: row.observedAt,
    ...(row.planFingerprint ? { planFingerprint: row.planFingerprint } : {}),
    phase: row.phase as OverlapWaitPhase,
    revision: row.revision,
    ...(row.owner ? { owner: row.owner } : {}),
    attempt: row.attempt,
    ...(row.checkoutEpoch ? { checkoutEpoch: row.checkoutEpoch } : {}),
    observation: (row.observation ?? {}) as Record<string, unknown>,
    ...(row.receipt && typeof row.receipt === "object" ? { receipt: row.receipt as OverlapWaitReceipt } : {}),
    updatedAt: row.updatedAt,
  };
}

/** Ensures one open (not delivered/cancelled) episode exists for (taskId, blockerTaskId); a repeat observation is a no-op. */
async function ensureObserved(
  tx: DbTransaction,
  input: { projectId: string; task: Pick<Task, "id" | "lineageId" | "prompt">; blockerTaskId: string; observedAt: string },
): Promise<void> {
  const existing = await tx
    .select({ episodeId: schema.project.taskOverlapWaits.episodeId })
    .from(schema.project.taskOverlapWaits)
    .where(
      and(
        eq(schema.project.taskOverlapWaits.projectId, input.projectId),
        eq(schema.project.taskOverlapWaits.taskId, input.task.id),
        eq(schema.project.taskOverlapWaits.blockerTaskId, input.blockerTaskId),
        sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`,
      ),
    )
    .limit(1);
  if (existing[0]) return;

  const blockerRows = await tx
    .select({ lineageId: schema.project.tasks.lineageId })
    .from(schema.project.tasks)
    .where(and(eq(schema.project.tasks.projectId, input.projectId), eq(schema.project.tasks.id, input.blockerTaskId)))
    .limit(1);

  await tx
    .insert(schema.project.taskOverlapWaits)
    .values({
      projectId: input.projectId,
      taskId: input.task.id,
      blockerTaskId: input.blockerTaskId,
      taskLineageId: input.task.lineageId ?? null,
      blockerLineageId: blockerRows[0]?.lineageId ?? null,
      observedAt: input.observedAt,
      planFingerprint: input.task.prompt ? sha256(input.task.prompt) : null,
      phase: "observed",
      revision: 1,
      attempt: 0,
      observation: {},
      updatedAt: input.observedAt,
    })
    .onConflictDoNothing();
}

/**
 * Records both sides of an overlap-marker transition inside the caller's own task transaction.
 * The old edge (if any) is ensured before it can be replaced/cleared, and the new edge (if any)
 * is independently ensured — so an A -> null -> C sequence keeps both A and C as separate
 * unconsumed observations rather than the marker's last write erasing the earlier one.
 */
export async function observeOverlapWaitTransitionInTransaction(
  tx: DbTransaction,
  input: {
    projectId: string;
    previous: Pick<Task, "id" | "lineageId" | "prompt" | "overlapBlockedBy">;
    nextOverlapBlockedBy: string | null | undefined;
    observedAt?: string;
  },
): Promise<void> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const previousBlocker = input.previous.overlapBlockedBy?.trim();
  const nextBlocker = input.nextOverlapBlockedBy?.trim();
  if (previousBlocker) {
    await ensureObserved(tx, { projectId: input.projectId, task: input.previous, blockerTaskId: previousBlocker, observedAt });
  }
  if (nextBlocker && nextBlocker !== previousBlocker) {
    await ensureObserved(tx, { projectId: input.projectId, task: input.previous, blockerTaskId: nextBlocker, observedAt });
  }
}

/** Attaches a merge/land delivery snapshot to every open episode waiting on this blocker task. */
export async function publishTaskOverlapDeliveriesImpl(
  store: TaskStore,
  blockerTaskId: string,
  deliveries: OverlapWaitDeliverySnapshot[],
): Promise<number> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap delivery publication requires a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  return layer.transactionImmediate(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.project.taskOverlapWaits)
      .where(
        and(
          eq(schema.project.taskOverlapWaits.projectId, projectId),
          eq(schema.project.taskOverlapWaits.blockerTaskId, blockerTaskId),
          sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`,
        ),
      );
    let updatedCount = 0;
    for (const row of rows) {
      const observation = (row.observation ?? {}) as { deliveries?: OverlapWaitDeliverySnapshot[] };
      const prior = Array.isArray(observation.deliveries) ? observation.deliveries : [];
      const replacementKeys = new Set(deliveries.map((delivery) => `${delivery.blockerTaskId}\0${delivery.repository}`));
      const nextDeliveries = [...prior.filter((delivery) => !replacementKeys.has(`${delivery.blockerTaskId}\0${delivery.repository}`)), ...deliveries];
      const updated = await tx
        .update(schema.project.taskOverlapWaits)
        .set({
          blockerLineageId: deliveries[0]?.blockerLineageId ?? row.blockerLineageId,
          observation: { ...observation, deliveries: nextDeliveries },
          revision: row.revision + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.project.taskOverlapWaits.projectId, projectId),
            eq(schema.project.taskOverlapWaits.taskId, row.taskId),
            eq(schema.project.taskOverlapWaits.episodeId, row.episodeId),
            eq(schema.project.taskOverlapWaits.revision, row.revision),
          ),
        )
        .returning({ episodeId: schema.project.taskOverlapWaits.episodeId });
      updatedCount += updated.length;
    }
    return updatedCount;
  });
}

export async function listTaskOverlapWaitsImpl(
  store: TaskStore,
  taskId: string,
  options: { pendingOnly?: boolean } = {},
): Promise<TaskOverlapWait[]> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap wait reads require a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const conditions = [eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, taskId)];
  if (options.pendingOnly) conditions.push(sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`);
  const rows = await layer.db.select().from(schema.project.taskOverlapWaits).where(and(...conditions)).orderBy(schema.project.taskOverlapWaits.observedAt);
  return rows.map(mapRow);
}

const EXECUTION_IDENTITY_KEYS = [
  "taskLineageId",
  "planFingerprint",
  "checkoutEpoch",
  "worktree",
  "branch",
  "headSha",
  "repository",
  "target",
  "nodeId",
  "nodeInstanceId",
] as const satisfies readonly (keyof OverlapWaitExecutionIdentity)[];

function sameExecutionIdentity(left: OverlapWaitExecutionIdentity | undefined, right: OverlapWaitExecutionIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return EXECUTION_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function executionIdentityMatches(task: Task, actualPlanFingerprint: string | undefined, expected: OverlapWaitExecutionIdentity | undefined): boolean {
  if (!expected) return true;
  return (
    (expected.taskLineageId === undefined || task.lineageId === expected.taskLineageId)
    && (expected.planFingerprint === undefined || actualPlanFingerprint === expected.planFingerprint)
    && (expected.worktree === undefined || task.worktree === expected.worktree)
    && (expected.branch === undefined || task.branch === expected.branch)
    && (expected.checkoutEpoch === undefined || String(task.checkoutLeaseEpoch ?? "") === expected.checkoutEpoch)
  );
}

/**
 * Claims a pending episode for analysis. Fences on (episodeId, expectedRevision) so only one
 * concurrent owner wins; a stale/reused claim (deleted task, paused task, wrong revision) returns
 * null rather than throwing so callers can treat it as "someone else has this" uniformly.
 */
export async function claimTaskOverlapWaitImpl(store: TaskStore, claim: OverlapWaitClaim): Promise<TaskOverlapWait | null> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap wait claims require a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  return layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, claim.taskId);
    const taskRows = await tx
      .select()
      .from(schema.project.tasks)
      .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, claim.taskId), isNull(schema.project.tasks.deletedAt)))
      .limit(1);
    const live = taskRows[0] as unknown as Task | undefined;
    if (!live || live.paused || live.userPaused) return null;
    if (claim.executionIdentity?.taskLineageId !== undefined && live.lineageId !== claim.executionIdentity.taskLineageId) return null;

    const currentRows = await tx
      .select({ observation: schema.project.taskOverlapWaits.observation })
      .from(schema.project.taskOverlapWaits)
      .where(
        and(
          eq(schema.project.taskOverlapWaits.projectId, projectId),
          eq(schema.project.taskOverlapWaits.taskId, claim.taskId),
          eq(schema.project.taskOverlapWaits.episodeId, claim.episodeId),
          eq(schema.project.taskOverlapWaits.revision, claim.expectedRevision),
        ),
      )
      .limit(1);
    if (!currentRows[0]) return null;

    const livePlanFingerprint = live.prompt ? sha256(live.prompt) : undefined;
    const executionIdentity: OverlapWaitExecutionIdentity = {
      ...claim.executionIdentity,
      ...(live.lineageId ? { taskLineageId: live.lineageId } : {}),
      ...(livePlanFingerprint ? { planFingerprint: livePlanFingerprint } : {}),
      ...(live.worktree ? { worktree: live.worktree } : {}),
      ...(live.branch ? { branch: live.branch } : {}),
      ...(claim.checkoutEpoch ? { checkoutEpoch: claim.checkoutEpoch } : {}),
    };
    const observation = { ...((currentRows[0].observation ?? {}) as Record<string, unknown>), executionIdentity };

    const updated = await tx
      .update(schema.project.taskOverlapWaits)
      .set({
        phase: "analyzing",
        owner: claim.owner,
        checkoutEpoch: claim.checkoutEpoch ?? null,
        planFingerprint: livePlanFingerprint ?? null,
        observation,
        attempt: sql`${schema.project.taskOverlapWaits.attempt} + 1`,
        revision: sql`${schema.project.taskOverlapWaits.revision} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(schema.project.taskOverlapWaits.projectId, projectId),
          eq(schema.project.taskOverlapWaits.taskId, claim.taskId),
          eq(schema.project.taskOverlapWaits.episodeId, claim.episodeId),
          eq(schema.project.taskOverlapWaits.revision, claim.expectedRevision),
          sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`,
        ),
      )
      .returning();
    return updated[0] ? mapRow(updated[0]) : null;
  });
}

/**
 * Publishes a resolved receipt for a claimed episode. Refuses (returns null, never throws) if the
 * task's live plan/checkout identity has moved since the claim, so a stale I/O race cannot record
 * a decision that no longer applies — see OverlapWaitExecutionIdentity.
 */
export async function completeTaskOverlapWaitImpl(
  store: TaskStore,
  input: {
    taskId: string;
    episodeId: string;
    expectedRevision: number;
    owner: string;
    phase?: "ready" | "delivered" | "freshness-pending" | "revalidation-pending" | "repair-required";
    receipt: OverlapWaitReceipt;
    executionIdentity?: OverlapWaitExecutionIdentity;
  },
): Promise<TaskOverlapWait | null> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap wait completion requires a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  return layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, input.taskId);
    const rows = await tx
      .select()
      .from(schema.project.taskOverlapWaits)
      .where(
        and(
          eq(schema.project.taskOverlapWaits.projectId, projectId),
          eq(schema.project.taskOverlapWaits.taskId, input.taskId),
          eq(schema.project.taskOverlapWaits.episodeId, input.episodeId),
          eq(schema.project.taskOverlapWaits.revision, input.expectedRevision),
          eq(schema.project.taskOverlapWaits.owner, input.owner),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;

    const taskRows = await tx
      .select()
      .from(schema.project.tasks)
      .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, input.taskId), isNull(schema.project.tasks.deletedAt)))
      .limit(1);
    const live = taskRows[0] as unknown as Task | undefined;
    if (!live || live.paused || live.userPaused) return null;

    const livePlanFingerprint = live.prompt ? sha256(live.prompt) : undefined;
    const storedIdentity = ((rows[0].observation ?? {}) as { executionIdentity?: OverlapWaitExecutionIdentity }).executionIdentity;
    const expectedIdentity = input.executionIdentity ?? storedIdentity;
    if (expectedIdentity?.checkoutEpoch !== undefined && rows[0].checkoutEpoch !== expectedIdentity.checkoutEpoch) return null;
    if (!executionIdentityMatches(live, livePlanFingerprint, expectedIdentity)) return null;
    // Recapture-time identity must exactly match the claim's snapshot — this fences HEAD,
    // repository/target, and node-incarnation races that happen during I/O between claim and complete.
    if (input.executionIdentity && !sameExecutionIdentity(input.executionIdentity, storedIdentity)) return null;

    const phase = input.phase ?? "ready";
    const now = new Date().toISOString();
    const updated = await tx
      .update(schema.project.taskOverlapWaits)
      .set({ receipt: input.receipt, phase, revision: rows[0].revision + 1, updatedAt: now })
      .where(
        and(
          eq(schema.project.taskOverlapWaits.projectId, projectId),
          eq(schema.project.taskOverlapWaits.taskId, input.taskId),
          eq(schema.project.taskOverlapWaits.episodeId, input.episodeId),
          eq(schema.project.taskOverlapWaits.revision, input.expectedRevision),
          eq(schema.project.taskOverlapWaits.owner, input.owner),
        ),
      )
      .returning();
    if (!updated[0]) return null;

    if (phase === "ready" || phase === "delivered") {
      const logRows = await tx
        .select({ log: schema.project.tasks.log })
        .from(schema.project.tasks)
        .where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, input.taskId), isNull(schema.project.tasks.deletedAt)))
        .limit(1);
      if (logRows[0]) {
        const log = Array.isArray(logRows[0].log) ? [...(logRows[0].log as TaskLogEntry[])] : [];
        const dedupeKey = `overlap-wait-release:${input.episodeId}:${input.receipt.decisionFingerprint}`;
        if (!log.some((entry) => entry.dedupeKey === dedupeKey)) {
          log.push({
            timestamp: now,
            dedupeKey,
            action: `Overlap wait released behind ${rows[0].blockerTaskId}`,
            outcome: truncateTaskLogOutcome(`${input.receipt.commonFiles.length} common files; decision=${input.receipt.decision}; freshness=${input.receipt.freshness}`),
          });
          const limit = getTaskActivityLogEntryLimit();
          if (log.length > limit) log.splice(0, log.length - limit);
          await tx.update(schema.project.tasks).set({ log }).where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, input.taskId)));
        }
      }
    }
    return mapRow(updated[0]);
  });
}

/** Cancels every open episode for a task, e.g. on Reset — an in-flight owner can no longer publish. */
export async function cancelTaskOverlapWaitsInTransaction(tx: DbTransaction, projectId: string, taskId: string): Promise<void> {
  await tx
    .update(schema.project.taskOverlapWaits)
    .set({ phase: "cancelled", owner: null, checkoutEpoch: null, revision: sql`${schema.project.taskOverlapWaits.revision} + 1`, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.project.taskOverlapWaits.projectId, projectId),
        eq(schema.project.taskOverlapWaits.taskId, taskId),
        sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`,
      ),
    );
}
