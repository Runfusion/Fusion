import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as schema from "../postgres/schema/index.js";
import type { TaskStore } from "../store.js";

export interface PhantomReservationReconcileResult {
  reconciled: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * FNXC:PostgresReservationRecovery 2026-07-14-17:22:
 * A committed distributed reservation permanently burns its task ID even when
 * the later task materialization vanished. PostgreSQL maintenance must prune
 * only child activity/agent state after proving that live, deleted, archived,
 * and task.json representations are all absent; the reservation and prior
 * audit history remain durable.
 */
export async function reconcilePhantomCommittedReservationsAsync(
  store: TaskStore,
): Promise<PhantomReservationReconcileResult> {
  const layer = store.getAsyncLayer();
  if (!layer) return { reconciled: [], skipped: [] };
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
  const projectArchive = alias(schema.project.archivedTasks, "phantom_project_archive");
  const coldArchive = alias(schema.archive.archivedTasks, "phantom_cold_archive");
  const result: PhantomReservationReconcileResult = { reconciled: [], skipped: [] };
  /*
  FNXC:PostgresReservationRecoveryPerformance 2026-07-14-17:50:
  Classify every committed reservation with one project-scoped join instead of issuing three existence queries per ID. Filesystem proof remains per candidate because task.json is intentionally outside PostgreSQL.
  */
  const reservations = await layer.db
    .select({
      taskId: schema.project.distributedTaskIdReservations.taskId,
      liveId: schema.project.tasks.id,
      projectArchiveId: projectArchive.id,
      coldArchiveId: coldArchive.id,
    })
    .from(schema.project.distributedTaskIdReservations)
    .leftJoin(schema.project.tasks, and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, schema.project.distributedTaskIdReservations.taskId),
    ))
    .leftJoin(projectArchive, and(
      eq(projectArchive.projectId, projectId),
      eq(projectArchive.id, schema.project.distributedTaskIdReservations.taskId),
    ))
    .leftJoin(coldArchive, and(
      eq(coldArchive.projectId, projectId),
      eq(coldArchive.id, schema.project.distributedTaskIdReservations.taskId),
    ))
    .where(and(
      eq(schema.project.distributedTaskIdReservations.projectId, projectId),
      eq(schema.project.distributedTaskIdReservations.status, "committed"),
    ))
    .orderBy(
      asc(schema.project.distributedTaskIdReservations.prefix),
      asc(schema.project.distributedTaskIdReservations.sequence),
    );

  const filesystemApproved: string[] = [];
  for (const { taskId, liveId, projectArchiveId, coldArchiveId } of reservations) {
    if (liveId !== null) {
      result.skipped.push({ id: taskId, reason: "task-row-present" });
      continue;
    }
    if (projectArchiveId !== null || coldArchiveId !== null) {
      result.skipped.push({ id: taskId, reason: "archived-task-present" });
      continue;
    }
    if (existsSync(join(store.taskDir(taskId), "task.json"))) {
      result.skipped.push({ id: taskId, reason: "task-json-present" });
      continue;
    }
    filesystemApproved.push(taskId);
  }

  if (filesystemApproved.length === 0) return result;

  let prunedByTask: Map<string, { prunedActivityLog: number; prunedAgents: number }>;
  try {
    prunedByTask = await layer.transactionImmediate(async (tx) => {
      // Re-prove database absence inside the delete transaction so a task that
      // materialized after the classification query cannot lose child rows.
      const safeRows = await tx
        .select({ taskId: schema.project.distributedTaskIdReservations.taskId })
        .from(schema.project.distributedTaskIdReservations)
        .leftJoin(schema.project.tasks, and(
          eq(schema.project.tasks.projectId, projectId),
          eq(schema.project.tasks.id, schema.project.distributedTaskIdReservations.taskId),
        ))
        .leftJoin(projectArchive, and(
          eq(projectArchive.projectId, projectId),
          eq(projectArchive.id, schema.project.distributedTaskIdReservations.taskId),
        ))
        .leftJoin(coldArchive, and(
          eq(coldArchive.projectId, projectId),
          eq(coldArchive.id, schema.project.distributedTaskIdReservations.taskId),
        ))
        .where(and(
          eq(schema.project.distributedTaskIdReservations.projectId, projectId),
          eq(schema.project.distributedTaskIdReservations.status, "committed"),
          inArray(schema.project.distributedTaskIdReservations.taskId, filesystemApproved),
          isNull(schema.project.tasks.id),
          isNull(projectArchive.id),
          isNull(coldArchive.id),
        ));
      const safeIds = safeRows.map((row) => row.taskId);
      if (safeIds.length === 0) return new Map<string, { prunedActivityLog: number; prunedAgents: number }>();

      const activity = await tx.delete(schema.project.activityLog).where(and(
        eq(schema.project.activityLog.projectId, projectId),
        inArray(schema.project.activityLog.taskId, safeIds),
      )).returning({ taskId: schema.project.activityLog.taskId });
      const agents = await tx.delete(schema.project.agents).where(and(
        eq(schema.project.agents.projectId, projectId),
        inArray(schema.project.agents.taskId, safeIds),
      )).returning({ taskId: schema.project.agents.taskId });
      const counts = new Map(safeIds.map((id) => [id, { prunedActivityLog: 0, prunedAgents: 0 }]));
      for (const row of activity) {
        if (row.taskId) counts.get(row.taskId)!.prunedActivityLog += 1;
      }
      for (const row of agents) {
        if (row.taskId) counts.get(row.taskId)!.prunedAgents += 1;
      }
      return counts;
    });
  } catch (error) {
    for (const taskId of filesystemApproved) {
      result.skipped.push({
        id: taskId,
        reason: `reconcile-failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return result;
  }

  for (const taskId of filesystemApproved) {
    const pruned = prunedByTask.get(taskId);
    if (!pruned) {
      result.skipped.push({ id: taskId, reason: "representation-present-after-proof" });
      continue;
    }
    if (pruned.prunedActivityLog > 0 || pruned.prunedAgents > 0) {
      try {
        await store.recordRunAuditEvent({
          agentId: "self-healing",
          runId: `phantom-reservation:${taskId}`,
          taskId,
          domain: "database",
          mutationType: "task:reconcile-phantom-committed-reservation",
          target: taskId,
          metadata: { reservationStatus: "committed", ...pruned },
        });
      } catch (error) {
        /*
        FNXC:PostgresReservationRecovery 2026-07-14-21:55:
        Audit emission is isolated per reconciled reservation. One failed audit must not relabel earlier successful reconciliations as skipped or prevent later IDs from completing their own bookkeeping.
        */
        result.skipped.push({
          id: taskId,
          reason: `audit-failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }
    result.reconciled.push(taskId);
  }
  return result;
}
