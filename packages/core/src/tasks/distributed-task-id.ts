import { randomUUID } from "node:crypto";
import type { Database } from "../db/db.js";
import type {
  DistributedTaskIdAbortInput,
  DistributedTaskIdAbortResult,
  DistributedTaskIdCommitInput,
  DistributedTaskIdCommitResult,
  DistributedTaskIdReserveInput,
  DistributedTaskIdReserveResult,
  DistributedTaskIdStateInput,
  DistributedTaskIdStateResult,
} from "../types.js";

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const TASK_ID_PATTERN = /^([A-Z][A-Z0-9]*)-(\d+)$/;

export interface DistributedTaskIdAllocator {
  formatDistributedTaskId(prefix: string, sequence: number): string;
  reserveDistributedTaskId(input: DistributedTaskIdReserveInput): Promise<DistributedTaskIdReserveResult>;
  commitDistributedTaskIdReservation(input: DistributedTaskIdCommitInput): Promise<DistributedTaskIdCommitResult>;
  abortDistributedTaskIdReservation(input: DistributedTaskIdAbortInput): Promise<DistributedTaskIdAbortResult>;
  getDistributedTaskIdState(input: DistributedTaskIdStateInput): Promise<DistributedTaskIdStateResult>;
}

export function resolveLocalNodeId(
  nodes: Array<{ id: string; type: string }> | undefined,
  fallback = "local",
): string {
  const localNode = nodes?.find((node) => node.type === "local");
  return localNode?.id ?? fallback;
}

export class DistributedTaskIdError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "reservation_not_found"
      | "reservation_not_owned"
      | "reservation_expired"
      | "reservation_finalized"
      | "invalid_prefix",
  ) {
    super(message);
  }
}

type ReservationRow = {
  reservationId: string;
  prefix: string;
  nodeId: string;
  sequence: number;
  taskId: string;
  status: "reserved" | "committed" | "aborted" | "expired";
  reason: "abort" | "expired" | "failed-create" | null;
  expiresAt: string;
  committedAt: string | null;
  abortedAt: string | null;
};

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

function getConfiguredPrefixAndLegacyNextId(db: Database): { prefix: string; nextId: number | null } {
  try {
    const row = db
      .prepare("SELECT nextId, settings FROM config WHERE id = 1")
      .get() as { nextId: number | null; settings: string | null } | undefined;
    if (!row) {
      return { prefix: "FN", nextId: null };
    }

    const settings = row.settings ? (JSON.parse(row.settings) as { taskPrefix?: string }) : null;
    return {
      prefix: (settings?.taskPrefix ?? "FN").trim().toUpperCase(),
      nextId: typeof row.nextId === "number" ? row.nextId : null,
    };
  } catch {
    return { prefix: "FN", nextId: null };
  }
}

function getKnownPrefixes(db: Database): Set<string> {
  const prefixes = new Set<string>();
  const configured = getConfiguredPrefixAndLegacyNextId(db).prefix;
  if (configured) {
    prefixes.add(configured);
  }

  const addFromQuery = (sql: string, mapper: (row: Record<string, unknown>) => string | undefined): void => {
    try {
      const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const prefix = mapper(row)?.trim().toUpperCase();
        if (prefix) {
          prefixes.add(prefix);
        }
      }
    } catch {
      // Best-effort for tests / partial schemas.
    }
  };

  addFromQuery("SELECT prefix FROM distributed_task_id_state", (row) => row.prefix as string | undefined);
  addFromQuery("SELECT prefix FROM distributed_task_id_reservations", (row) => row.prefix as string | undefined);
  // FN-5105: intentionally includes soft-deleted rows so reserved IDs/prefixes remain reserved.
  addFromQuery("SELECT id FROM tasks", (row) => parseTaskId(String(row.id ?? ""))?.prefix);
  addFromQuery("SELECT id FROM archivedTasks", (row) => parseTaskId(String(row.id ?? ""))?.prefix);

  return prefixes;
}

function getMaxTaskSequenceFromTable(db: Database, table: string, prefix: string): number {
  try {
    const rows = db.prepare(`SELECT id FROM ${table} WHERE id LIKE ?`).all(`${prefix}-%`) as Array<{ id: string }>;
    let maxSequence = 0;
    for (const row of rows) {
      const parsed = parseTaskId(row.id);
      if (parsed?.prefix === prefix && parsed.sequence > maxSequence) {
        maxSequence = parsed.sequence;
      }
    }
    return maxSequence;
  } catch {
    return 0;
  }
}

function getMaxReservationSequence(db: Database, prefix: string): number {
  try {
    const row = db
      .prepare("SELECT MAX(sequence) AS maxSeq FROM distributed_task_id_reservations WHERE prefix = ?")
      .get(prefix) as { maxSeq: number | null } | undefined;
    return typeof row?.maxSeq === "number" ? row.maxSeq : 0;
  } catch {
    return 0;
  }
}

function getNextSequenceFloor(db: Database, prefix: string): number {
  const configured = getConfiguredPrefixAndLegacyNextId(db);
  let nextSequence = 1;

  if (configured.prefix === prefix && configured.nextId && configured.nextId > nextSequence) {
    nextSequence = configured.nextId;
  }

  const taskHighWaterMark = getMaxTaskSequenceFromTable(db, "tasks", prefix) + 1;
  const archivedHighWaterMark = getMaxTaskSequenceFromTable(db, "archivedTasks", prefix) + 1;
  const reservationHighWaterMark = getMaxReservationSequence(db, prefix) + 1;

  nextSequence = Math.max(nextSequence, taskHighWaterMark, archivedHighWaterMark, reservationHighWaterMark);
  return nextSequence;
}

function ensureStateRow(db: Database, prefix: string, nowIso = new Date().toISOString()): void {
  const nextSequence = getNextSequenceFloor(db, prefix);
  db.prepare(
    `INSERT OR IGNORE INTO distributed_task_id_state (
      prefix, nextSequence, committedClusterTaskCount, lastCommittedTaskId, updatedAt
    ) VALUES (?, ?, 0, NULL, ?)`,
  ).run(prefix, nextSequence, nowIso);
  db.prepare(
    `UPDATE distributed_task_id_state
     SET nextSequence = MAX(nextSequence, ?),
         updatedAt = ?
     WHERE prefix = ?`,
  ).run(nextSequence, nowIso, prefix);
}

function expireDistributedTaskIdReservationsInExistingTransaction(db: Database, nowIso: string): number {
  const result = db.prepare(
    `UPDATE distributed_task_id_reservations
     SET status = 'expired', reason = 'expired', abortedAt = ?
     WHERE status = 'reserved' AND expiresAt <= ?`,
  ).run(nowIso, nowIso) as { changes?: number };
  return result.changes ?? 0;
}

/**
 * FNXC:TaskIdReservation 2026-06-26-00:00:
 * Distributed reservation commits must be composable into the caller's task-row insert transaction. This helper intentionally takes no allocator lock and opens no SQLite transaction so TaskStore can commit `distributed_task_id_reservations` and `tasks` atomically without better-sqlite3 nested-transaction failures.
 */
export function commitDistributedTaskIdReservationInExistingTransaction(
  db: Database,
  input: DistributedTaskIdCommitInput,
  nowIso = new Date().toISOString(),
): DistributedTaskIdCommitResult {
  expireDistributedTaskIdReservationsInExistingTransaction(db, nowIso);
  const row = db
    .prepare(
      `SELECT reservationId, prefix, nodeId, sequence, taskId, status, reason, expiresAt, committedAt, abortedAt
       FROM distributed_task_id_reservations
       WHERE reservationId = ?`,
    )
    .get(input.reservationId) as ReservationRow | undefined;

  if (!row) {
    throw new DistributedTaskIdError("reservation not found", "reservation_not_found");
  }
  if (row.nodeId !== input.nodeId) {
    throw new DistributedTaskIdError("reservation belongs to a different node", "reservation_not_owned");
  }
  if (row.status === "expired") {
    throw new DistributedTaskIdError("reservation has expired", "reservation_expired");
  }
  if (row.status !== "reserved") {
    throw new DistributedTaskIdError("reservation already finalized", "reservation_finalized");
  }

  db.prepare(
    `UPDATE distributed_task_id_reservations
     SET status = 'committed', committedAt = ?, updatedAt = ?
     WHERE reservationId = ?`,
  ).run(nowIso, nowIso, row.reservationId);

  ensureStateRow(db, row.prefix, nowIso);
  db.prepare(
    `UPDATE distributed_task_id_state
     SET committedClusterTaskCount = committedClusterTaskCount + 1,
         lastCommittedTaskId = ?,
         updatedAt = ?
     WHERE prefix = ?`,
  ).run(row.taskId, nowIso, row.prefix);

  const state = db
    .prepare(
      "SELECT committedClusterTaskCount FROM distributed_task_id_state WHERE prefix = ?",
    )
    .get(row.prefix) as { committedClusterTaskCount: number };
  db.bumpLastModified();

  return {
    reservationId: row.reservationId,
    taskId: row.taskId,
    sequence: row.sequence,
    committedClusterTaskCount: state.committedClusterTaskCount,
    committedAt: nowIso,
  };
}

/**
 * FNXC:TaskIdReservation 2026-06-26-00:00:
 * Post-insert create failures must burn the distributed ID without leaving a committed reservation. This transaction-participating rollback moves reserved or committed create reservations to `aborted`, recomputes committed counters, and preserves the reservation row so FN-5105 sequence permanence still prevents ID reuse.
 */
export function rollbackDistributedTaskIdReservationForFailedCreateInExistingTransaction(
  db: Database,
  input: DistributedTaskIdAbortInput,
  nowIso = new Date().toISOString(),
): DistributedTaskIdAbortResult {
  expireDistributedTaskIdReservationsInExistingTransaction(db, nowIso);
  const row = db
    .prepare(
      `SELECT reservationId, prefix, nodeId, sequence, taskId, status, reason, expiresAt, committedAt, abortedAt
       FROM distributed_task_id_reservations
       WHERE reservationId = ?`,
    )
    .get(input.reservationId) as ReservationRow | undefined;

  if (!row) {
    throw new DistributedTaskIdError("reservation not found", "reservation_not_found");
  }
  if (row.nodeId !== input.nodeId) {
    throw new DistributedTaskIdError("reservation belongs to a different node", "reservation_not_owned");
  }
  if (row.status === "expired") {
    throw new DistributedTaskIdError("reservation has expired", "reservation_expired");
  }
  if (row.status !== "reserved" && row.status !== "committed" && row.status !== "aborted") {
    throw new DistributedTaskIdError("reservation already finalized", "reservation_finalized");
  }

  if (row.status !== "aborted") {
    db.prepare(
      `UPDATE distributed_task_id_reservations
       SET status = 'aborted', reason = ?, committedAt = NULL, abortedAt = ?, updatedAt = ?
       WHERE reservationId = ?`,
    ).run(input.reason, nowIso, nowIso, row.reservationId);
  }

  ensureStateRow(db, row.prefix, nowIso);
  const count = db
    .prepare(
      "SELECT COUNT(*) AS count FROM distributed_task_id_reservations WHERE prefix = ? AND status = 'committed'",
    )
    .get(row.prefix) as { count: number };
  const lastCommitted = db
    .prepare(
      `SELECT taskId FROM distributed_task_id_reservations
       WHERE prefix = ? AND status = 'committed'
       ORDER BY sequence DESC
       LIMIT 1`,
    )
    .get(row.prefix) as { taskId: string } | undefined;
  db.prepare(
    `UPDATE distributed_task_id_state
     SET committedClusterTaskCount = ?,
         lastCommittedTaskId = ?,
         updatedAt = ?
     WHERE prefix = ?`,
  ).run(count.count, lastCommitted?.taskId ?? null, nowIso, row.prefix);
  db.bumpLastModified();

  return {
    reservationId: row.reservationId,
    taskId: row.taskId,
    sequence: row.sequence,
    committedClusterTaskCount: count.count,
    abortedAt: nowIso,
  };
}

export function reconcileTaskIdState(db: Database): string[] {
  const nowIso = new Date().toISOString();
  return db.transaction(() => {
    const reconciled: string[] = [];
    for (const prefix of getKnownPrefixes(db)) {
      const nextSequence = getNextSequenceFloor(db, prefix);
      db.prepare(
        `INSERT OR IGNORE INTO distributed_task_id_state (
          prefix, nextSequence, committedClusterTaskCount, lastCommittedTaskId, updatedAt
        ) VALUES (?, ?, 0, NULL, ?)`,
      ).run(prefix, nextSequence, nowIso);

      const before = db
        .prepare("SELECT nextSequence FROM distributed_task_id_state WHERE prefix = ?")
        .get(prefix) as { nextSequence: number } | undefined;
      db.prepare(
        `UPDATE distributed_task_id_state
         SET nextSequence = MAX(nextSequence, ?),
             updatedAt = ?
         WHERE prefix = ?`,
      ).run(nextSequence, nowIso, prefix);
      const after = db
        .prepare("SELECT nextSequence FROM distributed_task_id_state WHERE prefix = ?")
        .get(prefix) as { nextSequence: number } | undefined;

      if (!before || !after || after.nextSequence !== before.nextSequence) {
        reconciled.push(prefix);
      }
    }

    if (reconciled.length > 0) {
      db.bumpLastModified();
    }
    return reconciled;
  });
}

export function formatDistributedTaskId(prefix: string, sequence: number): string {
  const normalizedPrefix = prefix.trim().toUpperCase();
  if (!normalizedPrefix) {
    throw new DistributedTaskIdError("prefix is required", "invalid_prefix");
  }
  return `${normalizedPrefix}-${String(sequence).padStart(3, "0")}`;
}

export function createDistributedTaskIdAllocator(db: Database): DistributedTaskIdAllocator {
  let opLock: Promise<void> = Promise.resolve();
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = opLock;
    let resolve!: () => void;
    opLock = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  };

  const expireReservations = (nowIso: string): number => expireDistributedTaskIdReservationsInExistingTransaction(db, nowIso);

  const taskIdExists = (prefix: string, sequence: number): boolean => {
    const taskId = formatDistributedTaskId(prefix, sequence);
    const existsInTable = (table: string): boolean => {
      try {
        const row = db
          .prepare(`SELECT 1 as found FROM ${table} WHERE id = ? LIMIT 1`)
          .get(taskId) as { found?: number } | undefined;
        return row?.found === 1;
      } catch {
        return false;
      }
    };

    return existsInTable("tasks") || existsInTable("archivedTasks");
  };

  return {
    formatDistributedTaskId,
    reserveDistributedTaskId: async (input) =>
      withLock(async () => {
        const ttlMs = input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS;
        const now = new Date();
        const nowIso = now.toISOString();
        const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

        return db.transaction(() => {
          expireReservations(nowIso);
          const prefix = input.prefix.trim().toUpperCase();
          if (!prefix) {
            throw new DistributedTaskIdError("prefix is required", "invalid_prefix");
          }
          ensureStateRow(db, prefix);

          const state = db
            .prepare(
              "SELECT nextSequence, committedClusterTaskCount FROM distributed_task_id_state WHERE prefix = ?",
            )
            .get(prefix) as { nextSequence: number; committedClusterTaskCount: number };

          let sequence = state.nextSequence;
          while (taskIdExists(prefix, sequence)) {
            sequence += 1;
          }

          const taskId = formatDistributedTaskId(prefix, sequence);
          const reservationId = randomUUID();

          db.prepare(
            `INSERT INTO distributed_task_id_reservations (
              reservationId, prefix, nodeId, sequence, taskId, status, reason, expiresAt, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, 'reserved', NULL, ?, ?, ?)`,
          ).run(reservationId, prefix, input.nodeId, sequence, taskId, expiresAt, nowIso, nowIso);

          db.prepare(
            "UPDATE distributed_task_id_state SET nextSequence = ?, updatedAt = ? WHERE prefix = ?",
          ).run(sequence + 1, nowIso, prefix);
          db.bumpLastModified();

          return {
            reservationId,
            taskId,
            sequence,
            expiresAt,
            committedClusterTaskCount: state.committedClusterTaskCount,
          };
        });
      }),
    commitDistributedTaskIdReservation: async (input) =>
      withLock(async () => {
        const nowIso = new Date().toISOString();
        return db.transaction(() => commitDistributedTaskIdReservationInExistingTransaction(db, input, nowIso));
      }),
    abortDistributedTaskIdReservation: async (input) =>
      withLock(async () => {
        const nowIso = new Date().toISOString();
        return db.transaction(() => {
          expireReservations(nowIso);
          const row = db
            .prepare(
              `SELECT reservationId, prefix, nodeId, sequence, taskId, status, reason, expiresAt, committedAt, abortedAt
               FROM distributed_task_id_reservations
               WHERE reservationId = ?`,
            )
            .get(input.reservationId) as ReservationRow | undefined;

          if (!row) {
            throw new DistributedTaskIdError("reservation not found", "reservation_not_found");
          }
          if (row.nodeId !== input.nodeId) {
            throw new DistributedTaskIdError("reservation belongs to a different node", "reservation_not_owned");
          }
          if (row.status === "committed") {
            throw new DistributedTaskIdError("reservation already finalized", "reservation_finalized");
          }

          if (row.status === "reserved") {
            db.prepare(
              `UPDATE distributed_task_id_reservations
               SET status = 'aborted', reason = ?, abortedAt = ?, updatedAt = ?
               WHERE reservationId = ?`,
            ).run(input.reason, nowIso, nowIso, row.reservationId);
          }

          ensureStateRow(db, row.prefix);
          const state = db
            .prepare(
              "SELECT committedClusterTaskCount FROM distributed_task_id_state WHERE prefix = ?",
            )
            .get(row.prefix) as { committedClusterTaskCount: number };
          db.bumpLastModified();

          return {
            reservationId: row.reservationId,
            taskId: row.taskId,
            sequence: row.sequence,
            committedClusterTaskCount: state.committedClusterTaskCount,
            abortedAt: nowIso,
          };
        });
      }),
    getDistributedTaskIdState: async (input) =>
      withLock(async () => {
        const nowIso = new Date().toISOString();
        return db.transaction(() => {
          expireReservations(nowIso);
          const prefix = input.prefix.trim().toUpperCase();
          if (!prefix) {
            throw new DistributedTaskIdError("prefix is required", "invalid_prefix");
          }
          ensureStateRow(db, prefix);
          const row = db
            .prepare(
              `SELECT nextSequence, committedClusterTaskCount, lastCommittedTaskId
               FROM distributed_task_id_state
               WHERE prefix = ?`,
            )
            .get(prefix) as {
            nextSequence: number;
            committedClusterTaskCount: number;
            lastCommittedTaskId: string | null;
          };

          const active = db
            .prepare(
              `SELECT COUNT(*) AS count FROM distributed_task_id_reservations
               WHERE prefix = ? AND status = 'reserved'`,
            )
            .get(prefix) as { count: number };
          const burned = db
            .prepare(
              `SELECT COUNT(*) AS count FROM distributed_task_id_reservations
               WHERE prefix = ? AND status IN ('aborted', 'expired')`,
            )
            .get(prefix) as { count: number };

          return {
            nextSequence: row.nextSequence,
            committedClusterTaskCount: row.committedClusterTaskCount,
            activeReservationCount: active.count,
            burnedReservationCount: burned.count,
            lastCommittedTaskId: row.lastCommittedTaskId ?? undefined,
          };
        });
      }),
  };
}
