import type { Database } from "../db/db.js";

const TASK_ID_PATTERN = /^([A-Z][A-Z0-9]*)-(\d+)$/;

export type TaskIdIntegrityAnomalyKind =
  | "duplicate_active_id"
  | "id_in_active_and_archived"
  | "next_sequence_at_or_below_used"
  | "task_row_outside_known_prefix";

export interface TaskIdIntegrityAnomaly {
  kind: TaskIdIntegrityAnomalyKind;
  prefix: string;
  affectedIds: string[];
  details: string;
}

export interface TaskIdIntegrityReport {
  status: "ok" | "anomaly";
  checkedAt: string;
  anomalies: TaskIdIntegrityAnomaly[];
}

type TaskRow = { id: string; source: "tasks" | "archivedTasks" };
type StateRow = { prefix: string; nextSequence: number };
type DuplicateRow = { id: string; duplicateCount: number };

function parseTaskId(taskId: string): { prefix: string; sequence: number } | null {
  const match = taskId.trim().toUpperCase().match(TASK_ID_PATTERN);
  if (!match) {
    return null;
  }

  const sequence = Number.parseInt(match[2], 10);
  if (!Number.isFinite(sequence)) {
    return null;
  }

  return { prefix: match[1], sequence };
}

function hasTable(db: Database, table: string): boolean {
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .all(table) as Array<{ name: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

function readTaskRows(db: Database, table: "tasks" | "archivedTasks"): TaskRow[] {
  if (!hasTable(db, table)) {
    return [];
  }

  try {
    // FN-5105: intentionally do not filter deletedAt for `tasks`; soft-deleted IDs must remain visible to integrity checks.
    return db
      .prepare(`SELECT id FROM ${table}`)
      .all()
      .map((row) => ({ id: String((row as { id?: unknown }).id ?? ""), source: table }));
  } catch {
    return [];
  }
}

function readStateRows(db: Database): StateRow[] {
  if (!hasTable(db, "distributed_task_id_state")) {
    return [];
  }

  try {
    return db.prepare("SELECT prefix, nextSequence FROM distributed_task_id_state").all() as StateRow[];
  } catch {
    return [];
  }
}

function readDuplicateActiveIds(db: Database): DuplicateRow[] {
  if (!hasTable(db, "tasks")) {
    return [];
  }

  try {
    return db.prepare("SELECT id, COUNT(*) AS duplicateCount FROM tasks GROUP BY id HAVING COUNT(*) > 1").all() as DuplicateRow[];
  } catch {
    return [];
  }
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

export function detectTaskIdIntegrityAnomalies(db: Database): TaskIdIntegrityReport {
  const checkedAt = new Date().toISOString();

  try {
    const anomalies: TaskIdIntegrityAnomaly[] = [];
    const activeRows = readTaskRows(db, "tasks");
    const archivedRows = readTaskRows(db, "archivedTasks");
    const allRows = [...activeRows, ...archivedRows];

    for (const row of readDuplicateActiveIds(db)) {
      const parsed = parseTaskId(row.id);
      anomalies.push({
        kind: "duplicate_active_id",
        prefix: parsed?.prefix ?? "unknown",
        affectedIds: [row.id],
        details: `Active tasks contains ${row.duplicateCount} rows for ${row.id}.`,
      });
    }

    const archivedIds = new Set(archivedRows.map((row) => row.id));
    const activeAndArchived = uniqueSorted(activeRows.map((row) => row.id).filter((id) => archivedIds.has(id)));
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

    const maxUsedSequenceByPrefix = new Map<string, { maxSequence: number; taskIds: string[] }>();
    for (const row of allRows) {
      const parsed = parseTaskId(row.id);
      if (!parsed) {
        continue;
      }
      const existing = maxUsedSequenceByPrefix.get(parsed.prefix);
      if (!existing || parsed.sequence > existing.maxSequence) {
        maxUsedSequenceByPrefix.set(parsed.prefix, { maxSequence: parsed.sequence, taskIds: [row.id] });
        continue;
      }
      if (parsed.sequence === existing.maxSequence) {
        existing.taskIds.push(row.id);
      }
    }

    for (const stateRow of readStateRows(db)) {
      const prefix = stateRow.prefix.trim().toUpperCase();
      const maxUsed = maxUsedSequenceByPrefix.get(prefix);
      if (!maxUsed) {
        continue;
      }
      if (stateRow.nextSequence <= maxUsed.maxSequence) {
        anomalies.push({
          kind: "next_sequence_at_or_below_used",
          prefix,
          affectedIds: uniqueSorted(maxUsed.taskIds),
          details: `distributed_task_id_state.nextSequence=${stateRow.nextSequence} is at or below existing sequence ${maxUsed.maxSequence} for prefix ${prefix}.`,
        });
      }
    }

    if (hasTable(db, "distributed_task_id_state")) {
      const knownPrefixes = new Set(
        readStateRows(db)
          .map((row) => row.prefix.trim().toUpperCase())
          .filter((prefix) => prefix.length > 0),
      );
      if (knownPrefixes.size > 0) {
        const outsideKnownPrefix = new Map<string, string[]>();
        for (const row of activeRows) {
          const parsed = parseTaskId(row.id);
          const prefix = parsed?.prefix ?? "unknown";
          if (!parsed || !knownPrefixes.has(prefix)) {
            outsideKnownPrefix.set(prefix, [...(outsideKnownPrefix.get(prefix) ?? []), row.id]);
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
    return buildReport(checkedAt, []);
  }
}
