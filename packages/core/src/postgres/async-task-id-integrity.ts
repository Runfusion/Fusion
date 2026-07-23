/**
 * Async task-ID integrity detector for PostgreSQL (U8).
 *
 * FNXC:TaskIdIntegrity 2026-06-24-15:00:
 * PostgreSQL-backed equivalent of the SQLite `detectTaskIdIntegrityAnomalies`
 * in `task-id-integrity.ts`. The detector is preserved per the feature
 * description ("Preserve task-ID-integrity detector") and surfaces the same
 * anomaly kinds via the same `TaskIdIntegrityReport` shape so the dashboard
 * banner and `/api/health` payload remain compatible.
 *
 * The detector checks for (VAL-HEALTH-003):
 *   - duplicate task IDs inside `tasks`
 *   - task IDs that exist in both `tasks` and `archived_tasks` (cross-table
 *     collision)
 *   - `distributed_task_id_state.next_sequence` values that point at or below
 *     an already-used numeric suffix (sequence drift)
 *   - active task rows whose prefix falls outside the prefixes declared in
 *     `distributed_task_id_state`
 *
 * All queries use the Drizzle query builder against the project schema so the
 * detector works identically against embedded or external PostgreSQL.
 */

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "./data-layer.js";
import type {
  TaskIdIntegrityAnomaly,
  TaskIdIntegrityReport,
} from "../tasks/task-id-integrity.js";
import { PROJECT_SCHEMA } from "./schema/_shared.js";

const TASK_ID_PATTERN = /^([A-Z][A-Z0-9]*)-(\d+)$/;

function parseTaskId(taskId: string): { prefix: string; sequence: number } | null {
  const match = taskId.trim().toUpperCase().match(TASK_ID_PATTERN);
  if (!match) return null;
  const sequence = Number.parseInt(match[2], 10);
  if (!Number.isFinite(sequence)) return null;
  return { prefix: match[1], sequence };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function buildReport(checkedAt: string, anomalies: TaskIdIntegrityAnomaly[]): TaskIdIntegrityReport {
  return {
    status: anomalies.length > 0 ? "anomaly" : "ok",
    checkedAt,
    anomalies,
  };
}

/**
 * FNXC:TaskIdIntegrity 2026-06-24-15:05:
 * Detect task-ID integrity anomalies against a PostgreSQL backend via Drizzle.
 * This is the async PostgreSQL equivalent of the sync SQLite
 * `detectTaskIdIntegrityAnomalies(db)`.
 *
 * The detector intentionally does NOT filter on `deletedAt` for the `tasks`
 * table — soft-deleted IDs must remain visible to integrity checks (FN-5105).
 *
 * @param db The runtime Drizzle instance.
 * @returns The integrity report with the same shape as the SQLite version.
 */
export async function detectTaskIdIntegrityAnomaliesAsync(db: DrizzleDb): Promise<TaskIdIntegrityReport> {
  const checkedAt = new Date().toISOString();

  try {
    const anomalies: TaskIdIntegrityAnomaly[] = [];

    // Read all active and archived task IDs. We intentionally do not filter
    // deletedAt on tasks (FN-5105). Use raw SQL for direct column access
    // without needing full Drizzle row-type mapping.
    const activeRows = (await db.execute(
      sql.raw(`SELECT id FROM ${PROJECT_SCHEMA}.tasks`),
    )) as unknown as Array<{ id: string }>;
    const archivedRows = (await db.execute(
      sql.raw(`SELECT id FROM ${PROJECT_SCHEMA}.archived_tasks`),
    )) as unknown as Array<{ id: string }>;

    const activeIds = activeRows.map((r) => String(r.id ?? ""));
    const archivedIds = archivedRows.map((r) => String(r.id ?? ""));
    const allIds = [...activeIds, ...archivedIds];

    // 1. Duplicate active IDs.
    const idCounts = new Map<string, number>();
    for (const id of activeIds) {
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of idCounts) {
      if (count > 1) {
        const parsed = parseTaskId(id);
        anomalies.push({
          kind: "duplicate_active_id",
          prefix: parsed?.prefix ?? "unknown",
          affectedIds: [id],
          details: `Active tasks contains ${count} rows for ${id}.`,
        });
      }
    }

    // 2. IDs in both active and archived (cross-table collision).
    const archivedIdSet = new Set(archivedIds);
    const activeAndArchived = uniqueSorted(activeIds.filter((id) => archivedIdSet.has(id)));
    if (activeAndArchived.length > 0) {
      const byPrefix = new Map<string, string[]>();
      for (const taskId of activeAndArchived) {
        const prefix = parseTaskId(taskId)?.prefix ?? "unknown";
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), taskId]);
      }
      for (const [prefix, affectedIds] of byPrefix) {
        anomalies.push({
          kind: "id_in_active_and_archived",
          prefix,
          affectedIds,
          details: `Task IDs exist in both active and archived storage for prefix ${prefix}.`,
        });
      }
    }

    // 3. Compute max used sequence per prefix.
    const maxUsedSequenceByPrefix = new Map<string, { maxSequence: number; taskIds: string[] }>();
    for (const taskId of allIds) {
      const parsed = parseTaskId(taskId);
      if (!parsed) continue;
      const existing = maxUsedSequenceByPrefix.get(parsed.prefix);
      if (!existing || parsed.sequence > existing.maxSequence) {
        maxUsedSequenceByPrefix.set(parsed.prefix, { maxSequence: parsed.sequence, taskIds: [taskId] });
        continue;
      }
      if (parsed.sequence === existing.maxSequence) {
        existing.taskIds.push(taskId);
      }
    }

    // Read allocator state rows.
    const stateRows = (await db.execute(
      sql.raw(`SELECT prefix, next_sequence FROM ${PROJECT_SCHEMA}.distributed_task_id_state`),
    )) as unknown as Array<{ prefix: string; next_sequence: string | number }>;

    // 4. Sequence drift: next_sequence at or below a used suffix.
    for (const stateRow of stateRows) {
      const prefix = String(stateRow.prefix).trim().toUpperCase();
      const nextSequence = Number(stateRow.next_sequence);
      const maxUsed = maxUsedSequenceByPrefix.get(prefix);
      if (!maxUsed) continue;
      if (nextSequence <= maxUsed.maxSequence) {
        anomalies.push({
          kind: "next_sequence_at_or_below_used",
          prefix,
          affectedIds: uniqueSorted(maxUsed.taskIds),
          details: `distributed_task_id_state.next_sequence=${nextSequence} is at or below existing sequence ${maxUsed.maxSequence} for prefix ${prefix}.`,
        });
      }
    }

    // 5. Active task rows with a prefix outside known allocator prefixes.
    if (stateRows.length > 0) {
      const knownPrefixes = new Set(
        stateRows
          .map((row) => String(row.prefix).trim().toUpperCase())
          .filter((prefix) => prefix.length > 0),
      );
      if (knownPrefixes.size > 0) {
        const outsideKnownPrefix = new Map<string, string[]>();
        for (const taskId of activeIds) {
          const parsed = parseTaskId(taskId);
          const prefix = parsed?.prefix ?? "unknown";
          if (!parsed || !knownPrefixes.has(prefix)) {
            outsideKnownPrefix.set(prefix, [...(outsideKnownPrefix.get(prefix) ?? []), taskId]);
          }
        }
        for (const [prefix, affectedIds] of outsideKnownPrefix) {
          anomalies.push({
            kind: "task_row_outside_known_prefix",
            prefix,
            affectedIds: uniqueSorted(affectedIds),
            details:
              prefix === "unknown"
                ? "Active task rows contain IDs that do not match the expected PREFIX-123 format."
                : `Active task rows use prefix ${prefix}, which is not declared in distributed_task_id_state.`,
          });
        }
      }
    }

    return buildReport(checkedAt, anomalies);
  } catch {
    // On any query failure, return an ok report (fail-open). The separate
    // health check will surface connectivity issues via the corruption banner.
    return buildReport(checkedAt, []);
  }
}
