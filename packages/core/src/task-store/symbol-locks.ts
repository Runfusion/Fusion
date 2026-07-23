import { and, eq, gt, inArray, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { projectOwnershipPartition, recordRunAuditEventWithinTransaction } from "../postgres/data-layer.js";
import type { DbTransaction } from "../postgres/data-layer.js";
import type { TaskStore } from "../store.js";
import type {
  AcquireSymbolLocksResult,
  ReconcileStaleSymbolLocksResult,
  ReleaseSymbolLocksResult,
  RenewSymbolLocksResult,
  SymbolLock,
  SymbolLockConflict,
  SymbolLockIdentity,
  SymbolLockOwner,
} from "../tasks/symbol-lock-types.js";

/**
 * FNXC:SymbolLock 2026-07-30-14:00:
 * Symbol references are an admission key, not a user-facing label. Normalize
 * whitespace, path separators, and casing deterministically so equivalent
 * `pkg/file.ts#Exported.member` references contend across agents.
 */
export function normalizeSymbolLockKey(rawSymbol: string): string {
  const normalized = rawSymbol
    .trim()
    .replaceAll("\\", "/")
    .replace(/\s+/g, "")
    .replace(/\/+/g, "/")
    .replace(/:+/g, ":")
    .replace(/#+/g, "#")
    .toLowerCase();
  if (!normalized) throw new Error("Symbol lock key must not be empty");
  return normalized;
}

/** Extracts the canonical project-scoped identity from a raw symbol reference. */
export function extractSymbolLockIdentity(projectId: string, rawSymbol: string): SymbolLockIdentity {
  const normalizedSymbol = normalizeSymbolLockKey(rawSymbol);
  return { projectId, normalizedSymbol, symbolKey: normalizedSymbol };
}

/** Equivalent canonical symbols contend; callers must normalize before storage. */
export function symbolLocksConflict(left: string, right: string): boolean {
  return normalizeSymbolLockKey(left) === normalizeSymbolLockKey(right);
}

function symbolKeys(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map(normalizeSymbolLockKey))].sort();
}

function toLock(row: typeof schema.project.symbolLocks.$inferSelect): SymbolLock {
  return {
    projectId: row.projectId,
    symbolKey: row.symbolKey,
    normalizedSymbol: row.symbolKey,
    ownerTaskId: row.ownerTaskId,
    missionId: row.missionId ?? undefined,
    featureId: row.featureId ?? undefined,
    lineageId: row.lineageId ?? undefined,
    nodeId: row.nodeId ?? undefined,
    agentId: row.agentId ?? undefined,
    status: row.status as SymbolLock["status"],
    acquiredAt: row.acquiredAt,
    renewedAt: row.renewedAt,
    expiresAt: row.expiresAt,
  };
}

function toConflict(row: typeof schema.project.symbolLocks.$inferSelect): SymbolLockConflict {
  return {
    symbolKey: row.symbolKey,
    ownerTaskId: row.ownerTaskId,
    missionId: row.missionId ?? undefined,
    featureId: row.featureId ?? undefined,
    lineageId: row.lineageId ?? undefined,
    nodeId: row.nodeId ?? undefined,
    agentId: row.agentId ?? undefined,
    expiresAt: row.expiresAt,
  };
}

/**
 * FNXC:SymbolLock 2026-07-30-14:10:
 * Advisory transaction locks serialize same-symbol admissions even when no row
 * exists yet. Acquiring all sorted keys before inspection preserves the
 * all-or-nothing contract without making later scheduler behavior responsible
 * for PostgreSQL race recovery.
 */
async function lockSymbolKeys(tx: DbTransaction, projectId: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${key}`}, 0))`);
  }
}

export async function acquireSymbolLocksAsync(
  store: TaskStore,
  symbols: readonly string[],
  owner: SymbolLockOwner,
  leaseMs: number,
): Promise<AcquireSymbolLocksResult> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("Durable symbol locks require an AsyncDataLayer");
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Symbol lock leaseMs must be positive");
  const projectId = projectOwnershipPartition(layer.projectId);
  const keys = symbolKeys(symbols);
  if (keys.length === 0) return { acquired: true, locks: [], conflicts: [] };

  return layer.transactionImmediate(async (tx) => {
    await lockSymbolKeys(tx, projectId, keys);
    const now = new Date();
    const nowIso = now.toISOString();
    const rows = await tx.select().from(schema.project.symbolLocks).where(and(
      eq(schema.project.symbolLocks.projectId, projectId),
      inArray(schema.project.symbolLocks.symbolKey, keys),
    ));
    const conflicts = rows.filter((row) => row.status === "held" && row.expiresAt > nowIso && row.ownerTaskId !== owner.ownerTaskId);
    if (conflicts.length > 0) {
      await recordRunAuditEventWithinTransaction(tx, {
        taskId: owner.ownerTaskId, agentId: owner.agentId ?? "symbol-lock", runId: `symbol-lock:${owner.ownerTaskId}`,
        domain: "symbol-lock", mutationType: "symbol-lock:acquire-conflict", target: owner.ownerTaskId,
        metadata: { count: conflicts.length, symbolKeys: conflicts.map((row) => row.symbolKey).sort(), outcome: "conflict" },
      });
      return { acquired: false, locks: [], conflicts: conflicts.map(toConflict) };
    }
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    for (const key of keys) {
      const existing = rows.find((row) => row.symbolKey === key);
      const values = {
        projectId, symbolKey: key, ownerTaskId: owner.ownerTaskId, missionId: owner.missionId ?? null,
        featureId: owner.featureId ?? null, lineageId: owner.lineageId ?? null, nodeId: owner.nodeId ?? null,
        agentId: owner.agentId ?? null, status: "held", acquiredAt: nowIso, renewedAt: nowIso,
        expiresAt, createdAt: nowIso, updatedAt: nowIso,
      };
      if (existing) {
        await tx.update(schema.project.symbolLocks).set(values).where(and(
          eq(schema.project.symbolLocks.projectId, projectId), eq(schema.project.symbolLocks.symbolKey, key),
        ));
      } else {
        await tx.insert(schema.project.symbolLocks).values(values);
      }
    }
    const held = await tx.select().from(schema.project.symbolLocks).where(and(
      eq(schema.project.symbolLocks.projectId, projectId), inArray(schema.project.symbolLocks.symbolKey, keys),
    ));
    await recordRunAuditEventWithinTransaction(tx, {
      taskId: owner.ownerTaskId, agentId: owner.agentId ?? "symbol-lock", runId: `symbol-lock:${owner.ownerTaskId}`,
      domain: "symbol-lock", mutationType: "symbol-lock:acquired", target: owner.ownerTaskId,
      metadata: { count: held.length, symbolKeys: keys, outcome: "acquired" },
    });
    return { acquired: true, locks: held.map(toLock), conflicts: [] };
  });
}

export async function renewSymbolLocksAsync(store: TaskStore, symbols: readonly string[], ownerTaskId: string, leaseMs: number): Promise<RenewSymbolLocksResult> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("Durable symbol locks require an AsyncDataLayer");
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Symbol lock leaseMs must be positive");
  const projectId = projectOwnershipPartition(layer.projectId);
  const keys = symbolKeys(symbols);
  const now = new Date(); const nowIso = now.toISOString(); const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  return layer.transactionImmediate(async (tx) => {
    await lockSymbolKeys(tx, projectId, keys);
    const rows = keys.length === 0 ? [] : await tx.select().from(schema.project.symbolLocks).where(and(eq(schema.project.symbolLocks.projectId, projectId), inArray(schema.project.symbolLocks.symbolKey, keys)));
    const renewable = rows.filter((row) => row.ownerTaskId === ownerTaskId && row.status === "held" && row.expiresAt > nowIso).map((row) => row.symbolKey);
    // FNXC:SymbolLock 2026-07-30-14:45: recheck expiry in the write predicate
    // so a delayed renewal cannot revive a lease that became expired after read.
    const renewed = renewable.length === 0 ? [] : (await tx.update(schema.project.symbolLocks)
      .set({ renewedAt: nowIso, expiresAt, updatedAt: nowIso })
      .where(and(
        eq(schema.project.symbolLocks.projectId, projectId),
        eq(schema.project.symbolLocks.ownerTaskId, ownerTaskId),
        inArray(schema.project.symbolLocks.symbolKey, renewable),
        eq(schema.project.symbolLocks.status, "held"),
        gt(schema.project.symbolLocks.expiresAt, nowIso),
      ))
      .returning({ symbolKey: schema.project.symbolLocks.symbolKey }))
      .map((row) => row.symbolKey);
    const lost = keys.filter((key) => !renewed.includes(key));
    await recordRunAuditEventWithinTransaction(tx, { taskId: ownerTaskId, agentId: "symbol-lock", runId: `symbol-lock:${ownerTaskId}`, domain: "symbol-lock", mutationType: "symbol-lock:renewed", target: ownerTaskId, metadata: { count: renewed.length, lostCount: lost.length, symbolKeys: renewed, outcome: "renewed" } });
    return { renewed, lost };
  });
}

export async function releaseSymbolLocksAsync(store: TaskStore, symbols: readonly string[], ownerTaskId: string): Promise<ReleaseSymbolLocksResult> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("Durable symbol locks require an AsyncDataLayer");
  const projectId = projectOwnershipPartition(layer.projectId); const keys = symbolKeys(symbols); const nowIso = new Date().toISOString();
  return layer.transactionImmediate(async (tx) => {
    await lockSymbolKeys(tx, projectId, keys);
    const released = keys.length === 0 ? [] : await tx.update(schema.project.symbolLocks).set({ status: "released", updatedAt: nowIso }).where(and(eq(schema.project.symbolLocks.projectId, projectId), eq(schema.project.symbolLocks.ownerTaskId, ownerTaskId), eq(schema.project.symbolLocks.status, "held"), inArray(schema.project.symbolLocks.symbolKey, keys))).returning({ symbolKey: schema.project.symbolLocks.symbolKey });
    await recordRunAuditEventWithinTransaction(tx, { taskId: ownerTaskId, agentId: "symbol-lock", runId: `symbol-lock:${ownerTaskId}`, domain: "symbol-lock", mutationType: "symbol-lock:released", target: ownerTaskId, metadata: { count: released.length, symbolKeys: released.map((row) => row.symbolKey).sort(), outcome: "released" } });
    return { released: released.map((row) => row.symbolKey) };
  });
}

export async function inspectSymbolLockConflictsAsync(store: TaskStore, symbols: readonly string[]): Promise<SymbolLockConflict[]> {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("Durable symbol locks require an AsyncDataLayer");
  const keys = symbolKeys(symbols); if (!keys.length) return [];
  const projectId = projectOwnershipPartition(layer.projectId); const nowIso = new Date().toISOString();
  const rows = await layer.db.select().from(schema.project.symbolLocks).where(and(eq(schema.project.symbolLocks.projectId, projectId), eq(schema.project.symbolLocks.status, "held"), inArray(schema.project.symbolLocks.symbolKey, keys)));
  return rows.filter((row) => row.expiresAt > nowIso).map(toConflict);
}

export async function reconcileStaleSymbolLocksAsync(store: TaskStore): Promise<ReconcileStaleSymbolLocksResult> {
  const layer = store.getAsyncLayer();
  if (!layer) return { reconciled: [], skipped: [] };
  const projectId = projectOwnershipPartition(layer.projectId); const nowIso = new Date().toISOString();
  const held = await layer.db.select().from(schema.project.symbolLocks).where(and(eq(schema.project.symbolLocks.projectId, projectId), eq(schema.project.symbolLocks.status, "held")));
  const stale: Array<{ symbolKey: string; ownerTaskId: string; expiresAt: string }> = [];
  const skipped: string[] = [];
  for (const lock of held) {
    const owner = await store.getTask(lock.ownerTaskId, { includeDeleted: true }).catch(() => undefined);
    const terminal = !owner || owner.deletedAt != null || owner.column === "done" || owner.column === "archived" || owner.status === "failed";
    if (lock.expiresAt <= nowIso || terminal) {
      stale.push({ symbolKey: lock.symbolKey, ownerTaskId: lock.ownerTaskId, expiresAt: lock.expiresAt });
    } else {
      skipped.push(lock.symbolKey);
    }
  }
  if (!stale.length) return { reconciled: [], skipped };
  const reconciled = await layer.transactionImmediate(async (tx) => {
    // FNXC:SymbolLock 2026-07-30-14:40: stale detection happens before this
    // transaction, so CAS on the observed owner and lease prevents a sweep from
    // expiring a lock that was reclaimed by another task in the interim.
    await lockSymbolKeys(tx, projectId, stale.map((lock) => lock.symbolKey).sort());
    const expired: string[] = [];
    for (const lock of stale) {
      const updated = await tx.update(schema.project.symbolLocks)
        .set({ status: "expired", updatedAt: nowIso })
        .where(and(
          eq(schema.project.symbolLocks.projectId, projectId),
          eq(schema.project.symbolLocks.symbolKey, lock.symbolKey),
          eq(schema.project.symbolLocks.ownerTaskId, lock.ownerTaskId),
          eq(schema.project.symbolLocks.expiresAt, lock.expiresAt),
          eq(schema.project.symbolLocks.status, "held"),
        ))
        .returning({ symbolKey: schema.project.symbolLocks.symbolKey });
      expired.push(...updated.map((row) => row.symbolKey));
    }
    return expired;
  });
  return { reconciled, skipped };
}
