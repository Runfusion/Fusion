import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import type { Task, TaskLogEntry } from "../types.js";
import type { OverlapWaitClaim, OverlapWaitDeliverySnapshot, OverlapWaitExecutionIdentity, OverlapWaitPhase, OverlapWaitReceipt, TaskOverlapWait } from "../types/task/task-overlap-wait.js";
import type { TaskStore } from "../store.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { getTaskActivityLogEntryLimit, truncateTaskLogOutcome } from "./comments.js";

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
    ...((row.receipt && typeof row.receipt === "object") ? { receipt: row.receipt as OverlapWaitReceipt } : {}),
    updatedAt: row.updatedAt,
  };
}

async function ensureObserved(
  tx: DbTransaction,
  input: { projectId: string; task: Pick<Task, "id" | "lineageId" | "prompt">; blockerTaskId: string; observedAt: string },
): Promise<void> {
  const blockerRows = await tx.select({
    lineageId: schema.project.tasks.lineageId,
    summary: schema.project.tasks.summary,
    mergeDetails: schema.project.tasks.mergeDetails,
  })
    .from(schema.project.tasks)
    .where(and(eq(schema.project.tasks.projectId, input.projectId), eq(schema.project.tasks.id, input.blockerTaskId)))
    .limit(1);
  const blocker = blockerRows[0];
  const details = blocker?.mergeDetails as Task["mergeDetails"] | null | undefined;
  const workspaceRepositories = [...new Set([
    ...Object.keys(details?.workspaceLandedShas ?? {}),
    ...Object.keys(details?.workspaceLandedFiles ?? {}),
  ])];
  const deliveries = workspaceRepositories.length > 0
    ? workspaceRepositories.map((repository) => {
      const landedSha = details?.workspaceLandedShas?.[repository];
      const landedFiles = details?.workspaceLandedFiles?.[repository];
      return {
        blockerTaskId: input.blockerTaskId,
        blockerLineageId: blocker?.lineageId ?? undefined,
        repository,
        ...(landedSha ? { landedSha } : {}),
        target: details?.mergeTargetBranch,
        summary: blocker?.summary ?? undefined,
        ...(landedFiles ? { paths: landedFiles.map((path) => ({ repository, path, status: "modified" })) } : {}),
        noOp: Array.isArray(landedFiles) && landedFiles.length === 0 && !landedSha,
        evidence: "workspace-landing",
      };
    })
    : details
      ? [{
        blockerTaskId: input.blockerTaskId,
        blockerLineageId: blocker?.lineageId ?? undefined,
        repository: ".",
        landedSha: details.commitSha,
        target: details.mergeTargetBranch,
        summary: blocker?.summary ?? undefined,
        paths: details.landedFiles?.map((path) => ({ repository: ".", path, status: "modified" })),
        noOp: details.noOpVerifiedShortCircuit === true || details.noOpMerge === true,
        evidence: details.landedFilesCaptureFallback === "attribution-failed" ? "unavailable" : "merge-details",
      }]
      : [];
  const observation = deliveries.length > 0 ? { deliveries } : {};
  const existing = await tx.select({ episodeId: schema.project.taskOverlapWaits.episodeId, revision: schema.project.taskOverlapWaits.revision })
    .from(schema.project.taskOverlapWaits)
    .where(and(
      eq(schema.project.taskOverlapWaits.projectId, input.projectId),
      eq(schema.project.taskOverlapWaits.taskId, input.task.id),
      eq(schema.project.taskOverlapWaits.blockerTaskId, input.blockerTaskId),
      sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`,
    )).limit(1);
  if (existing[0]) {
    if (deliveries.length > 0) {
      await tx.update(schema.project.taskOverlapWaits).set({
        blockerLineageId: blocker?.lineageId ?? null,
        observation,
        revision: existing[0].revision + 1,
        updatedAt: input.observedAt,
      }).where(and(
        eq(schema.project.taskOverlapWaits.projectId, input.projectId),
        eq(schema.project.taskOverlapWaits.taskId, input.task.id),
        eq(schema.project.taskOverlapWaits.episodeId, existing[0].episodeId),
        eq(schema.project.taskOverlapWaits.revision, existing[0].revision),
      ));
    }
    return;
  }
  await tx.insert(schema.project.taskOverlapWaits).values({
    projectId: input.projectId,
    taskId: input.task.id,
    blockerTaskId: input.blockerTaskId,
    taskLineageId: input.task.lineageId ?? null,
    blockerLineageId: blockerRows[0]?.lineageId ?? null,
    observedAt: input.observedAt,
    planFingerprint: input.task.prompt ? await sha256(input.task.prompt) : null,
    phase: "observed",
    revision: 1,
    attempt: 0,
    observation,
    updatedAt: input.observedAt,
  }).onConflictDoNothing();
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Records both sides of an overlap-marker transition inside its caller's task transaction.
 * The old edge is ensured before a replacement/clear, and the new edge is independently inserted.
 */
export async function observeOverlapWaitTransitionInTransaction(
  tx: DbTransaction,
  input: { projectId: string; previous: Pick<Task, "id" | "lineageId" | "prompt" | "overlapBlockedBy">; nextOverlapBlockedBy: string | null | undefined; observedAt?: string },
): Promise<void> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const previousBlocker = input.previous.overlapBlockedBy?.trim();
  const nextBlocker = input.nextOverlapBlockedBy?.trim();
  if (previousBlocker) await ensureObserved(tx, { projectId: input.projectId, task: input.previous, blockerTaskId: previousBlocker, observedAt });
  if (nextBlocker) await ensureObserved(tx, { projectId: input.projectId, task: input.previous, blockerTaskId: nextBlocker, observedAt });
}

export async function publishTaskOverlapDeliveriesImpl(
  store: TaskStore,
  blockerTaskId: string,
  deliveries: OverlapWaitDeliverySnapshot[],
): Promise<number> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap delivery publication requires a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  return layer.transactionImmediate(async (tx) => {
    const rows = await tx.select().from(schema.project.taskOverlapWaits).where(and(
      eq(schema.project.taskOverlapWaits.projectId, projectId),
      eq(schema.project.taskOverlapWaits.blockerTaskId, blockerTaskId),
      sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`,
    ));
    let updatedCount = 0;
    for (const row of rows) {
      const observation = (row.observation ?? {}) as { deliveries?: OverlapWaitDeliverySnapshot[] };
      const prior = Array.isArray(observation.deliveries) ? observation.deliveries : [];
      const replacementKeys = new Set(deliveries.map((delivery) => `${delivery.blockerTaskId}\0${delivery.repository}`));
      const nextDeliveries = [
        ...prior.filter((delivery) => !replacementKeys.has(`${delivery.blockerTaskId}\0${delivery.repository}`)),
        ...deliveries,
      ];
      const updated = await tx.update(schema.project.taskOverlapWaits).set({
        blockerLineageId: deliveries[0]?.blockerLineageId ?? row.blockerLineageId,
        observation: { ...observation, deliveries: nextDeliveries },
        revision: row.revision + 1,
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(schema.project.taskOverlapWaits.projectId, projectId),
        eq(schema.project.taskOverlapWaits.taskId, row.taskId),
        eq(schema.project.taskOverlapWaits.episodeId, row.episodeId),
        eq(schema.project.taskOverlapWaits.revision, row.revision),
      )).returning({ episodeId: schema.project.taskOverlapWaits.episodeId });
      updatedCount += updated.length;
    }
    return updatedCount;
  });
}

export async function listTaskOverlapWaitsImpl(store: TaskStore, taskId: string, options: { pendingOnly?: boolean } = {}): Promise<TaskOverlapWait[]> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap wait reads require a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const conditions = [eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, taskId)];
  if (options.pendingOnly) conditions.push(sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`);
  const rows = await layer.db.select().from(schema.project.taskOverlapWaits).where(and(...conditions)).orderBy(schema.project.taskOverlapWaits.observedAt);
  return rows.map(mapRow);
}

const EXECUTION_IDENTITY_KEYS = [
  "taskLineageId", "planFingerprint", "checkoutEpoch", "worktree", "branch", "headSha",
  "repository", "target", "nodeId", "nodeInstanceId",
] as const satisfies readonly (keyof OverlapWaitExecutionIdentity)[];

function sameExecutionIdentity(left: OverlapWaitExecutionIdentity | undefined, right: OverlapWaitExecutionIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return EXECUTION_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

/*
FNXC:OverlapWaitSynchronization 2026-09-12-17:20:
FN-332 fences a publication against a plan revision that lands mid-analysis, and `durablePlanFingerprint`
is the ONLY admissible source for that comparison: it is the episode row's own `plan_fingerprint` column,
written at observation and re-stamped at claim, so BOTH sides of the fence read the same durable value.

Do not reintroduce `sha256(task.prompt)` here. The spec text is not a column of `project.tasks` — it lives in
PROMPT.md — so a raw task row read inside this transaction always yields `prompt: undefined`. The original
implementation compared that permanently-absent value against a caller-supplied prompt hash, so the equality
could never hold for ANY task carrying a spec: every overlap wait with a plan was refused publication forever.
Measured 2026-09-12: FN-359 and FN-362 each burned 122 dispatches over ten hours (fresh worktree every cycle)
because the refusal is shaped like a lost race, so the executor retried it indefinitely.

Invariant: a fence field must be re-derivable from the same durable source at claim and at publication. A field
one side structurally cannot read is a defect, never a mismatch.
*/
function executionIdentityMatches(task: Task, durablePlanFingerprint: string | undefined, expected: OverlapWaitExecutionIdentity | undefined): boolean {
  if (!expected) return true;
  return (expected.taskLineageId === undefined || task.lineageId === expected.taskLineageId)
    && (expected.planFingerprint === undefined || durablePlanFingerprint === expected.planFingerprint)
    && (expected.worktree === undefined || task.worktree === expected.worktree)
    && (expected.branch === undefined || task.branch === expected.branch)
    && (expected.checkoutEpoch === undefined || String(task.checkoutLeaseEpoch) === expected.checkoutEpoch)
    && (expected.nodeId === undefined || task.checkoutNodeId === expected.nodeId || task.effectiveNodeId === expected.nodeId || task.nodeId === expected.nodeId);
}

export async function claimTaskOverlapWaitImpl(store: TaskStore, claim: OverlapWaitClaim): Promise<TaskOverlapWait | null> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap wait claims require a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  return layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, claim.taskId);
    const taskRows = await tx.select().from(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, claim.taskId), isNull(schema.project.tasks.deletedAt),
    )).limit(1);
    const live = taskRows[0] as unknown as Task | undefined;
    if (!live || live.paused || live.userPaused) return null;
    if (claim.executionIdentity?.taskLineageId !== undefined && live.lineageId !== claim.executionIdentity.taskLineageId) return null;
    const currentRows = await tx.select({
      observation: schema.project.taskOverlapWaits.observation,
      planFingerprint: schema.project.taskOverlapWaits.planFingerprint,
    }).from(schema.project.taskOverlapWaits).where(and(
      eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, claim.taskId),
      eq(schema.project.taskOverlapWaits.episodeId, claim.episodeId), eq(schema.project.taskOverlapWaits.revision, claim.expectedRevision),
    )).limit(1);
    if (!currentRows[0]) return null;
    /*
    FNXC:OverlapWaitSynchronization 2026-09-12-17:20:
    The claimant holds the hydrated task, so it owns the plan fingerprint; the store persists it and later
    verifies publication against this stored value. Falling back to the observation-time column keeps a claim
    that supplies no identity from ERASING the plan identity: the null-wipe that used to happen here also broke
    `revalidatePendingOverlapWaitsAtGraphNode`, whose repair path compares a repaired plan against this column
    and saw `null` after every claim.
    */
    const durablePlanFingerprint = claim.executionIdentity?.planFingerprint ?? currentRows[0].planFingerprint ?? undefined;
    const executionIdentity: OverlapWaitExecutionIdentity = {
      ...claim.executionIdentity,
      ...(live.lineageId ? { taskLineageId: live.lineageId } : {}),
      ...(durablePlanFingerprint ? { planFingerprint: durablePlanFingerprint } : {}),
      ...(live.worktree ? { worktree: live.worktree } : {}),
      ...(live.branch ? { branch: live.branch } : {}),
      ...(claim.checkoutEpoch ? { checkoutEpoch: claim.checkoutEpoch } : {}),
    };
    const observation = { ...((currentRows[0].observation ?? {}) as Record<string, unknown>), executionIdentity };
    const updated = await tx.update(schema.project.taskOverlapWaits).set({
      phase: "analyzing",
      owner: claim.owner,
      checkoutEpoch: claim.checkoutEpoch ?? null,
      planFingerprint: durablePlanFingerprint ?? null,
      observation,
      attempt: sql`${schema.project.taskOverlapWaits.attempt} + 1`,
      revision: sql`${schema.project.taskOverlapWaits.revision} + 1`,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(schema.project.taskOverlapWaits.projectId, projectId),
      eq(schema.project.taskOverlapWaits.taskId, claim.taskId),
      eq(schema.project.taskOverlapWaits.episodeId, claim.episodeId),
      eq(schema.project.taskOverlapWaits.revision, claim.expectedRevision),
      sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`,
      sql`EXISTS (SELECT 1 FROM project.tasks t WHERE t.project_id = ${projectId} AND t.id = ${claim.taskId} AND t.deleted_at IS NULL AND coalesce(t.paused, 0) = 0)`,
    )).returning();
    return updated[0] ? mapRow(updated[0]) : null;
  });
}

export async function completeTaskOverlapWaitImpl(
  store: TaskStore,
  input: { taskId: string; episodeId: string; expectedRevision: number; owner: string; phase?: "ready" | "delivered" | "freshness-pending" | "revalidation-pending" | "repair-required"; receipt: OverlapWaitReceipt; executionIdentity?: OverlapWaitExecutionIdentity },
): Promise<TaskOverlapWait | null> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Overlap wait completion requires a PostgreSQL store");
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  return layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, projectId, input.taskId);
    const rows = await tx.select().from(schema.project.taskOverlapWaits).where(and(
      eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, input.taskId),
      eq(schema.project.taskOverlapWaits.episodeId, input.episodeId), eq(schema.project.taskOverlapWaits.revision, input.expectedRevision),
      eq(schema.project.taskOverlapWaits.owner, input.owner),
    )).limit(1);
    if (!rows[0]) return null;
    const taskRows = await tx.select().from(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, input.taskId), isNull(schema.project.tasks.deletedAt),
    )).limit(1);
    const live = taskRows[0] as unknown as Task | undefined;
    if (!live || live.paused || live.userPaused) return null;
    /*
    FNXC:OverlapWaitSynchronization 2026-09-12-17:20:
    Read the plan identity the claim persisted, never a value recomputed from a column that does not exist.
    A plan revision landing mid-analysis is still fenced, by the `sameExecutionIdentity` comparison below:
    the caller recomputes its fingerprint from the hydrated task at publication time, so a rewritten spec no
    longer equals what it claimed with.
    */
    const durablePlanFingerprint = rows[0].planFingerprint ?? undefined;
    const storedIdentity = ((rows[0].observation ?? {}) as { executionIdentity?: OverlapWaitExecutionIdentity }).executionIdentity;
    const expectedIdentity = input.executionIdentity ?? storedIdentity;
    if (expectedIdentity?.checkoutEpoch !== undefined && rows[0].checkoutEpoch !== expectedIdentity.checkoutEpoch) return null;
    if (!executionIdentityMatches(live, durablePlanFingerprint, expectedIdentity)) return null;
    // The caller must recapture Git/session identity at publication time; equality with the claim
    // fences HEAD, repository/target, node incarnation and checkout generation changes during I/O.
    if (input.executionIdentity && !sameExecutionIdentity(input.executionIdentity, storedIdentity)) return null;
    const phase = input.phase ?? "ready";
    const now = new Date().toISOString();
    const updated = await tx.update(schema.project.taskOverlapWaits).set({ receipt: input.receipt, phase, revision: rows[0].revision + 1, updatedAt: now })
      .where(and(eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, input.taskId), eq(schema.project.taskOverlapWaits.episodeId, input.episodeId), eq(schema.project.taskOverlapWaits.revision, input.expectedRevision), eq(schema.project.taskOverlapWaits.owner, input.owner)))
      .returning();
    if (!updated[0]) return null;
    if (phase === "ready" || phase === "delivered") {
      const taskRows = await tx.select({ log: schema.project.tasks.log }).from(schema.project.tasks).where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, input.taskId), isNull(schema.project.tasks.deletedAt))).limit(1);
      if (!taskRows[0]) return null;
      const log = Array.isArray(taskRows[0].log) ? [...taskRows[0].log as TaskLogEntry[]] : [];
      const dedupeKey = `overlap-wait-release:${input.episodeId}:${input.receipt.decisionFingerprint}`;
      if (!log.some((entry) => entry.dedupeKey === dedupeKey)) {
        log.push({ timestamp: now, dedupeKey, action: `Overlap wait released behind ${rows[0].blockerTaskId}`, outcome: truncateTaskLogOutcome(`${input.receipt.commonFiles.length} common files; decision=${input.receipt.decision}; freshness=${input.receipt.freshness}`) });
        const limit = getTaskActivityLogEntryLimit();
        if (log.length > limit) log.splice(0, log.length - limit);
        await tx.update(schema.project.tasks).set({ log }).where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, input.taskId)));
      }
    }
    return mapRow(updated[0]);
  });
}

export async function cancelTaskOverlapWaitsInTransaction(tx: DbTransaction, projectId: string, taskId: string): Promise<void> {
  await tx.update(schema.project.taskOverlapWaits).set({ phase: "cancelled", owner: null, checkoutEpoch: null, revision: sql`${schema.project.taskOverlapWaits.revision} + 1`, updatedAt: new Date().toISOString() })
    .where(and(eq(schema.project.taskOverlapWaits.projectId, projectId), eq(schema.project.taskOverlapWaits.taskId, taskId), sql`${schema.project.taskOverlapWaits.phase} NOT IN ('delivered', 'cancelled')`));
}
