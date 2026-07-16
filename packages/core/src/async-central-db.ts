/**
 * Async Drizzle CentralDatabase helpers (U6 satellite-central-archive-db).
 *
 * FNXC:CentralDatabase 2026-06-24-18:00:
 * Async equivalents of the sync SQLite CentralDatabase call sites in
 * central-db.ts. The CentralDatabase lives at `~/.fusion/fusion-central.db`
 * and is the coordination hub for all projects: the project registry, unified
 * activity feed, global concurrency limits, node mesh state, plugin install
 * registry, durable mesh shared-state snapshots, offline write queue, global
 * secrets, and the authoritative cross-node task claims table.
 *
 * This helper covers the load-bearing contract surface that consumers depend
 * on: the `CentralClaimStore` interface (tryClaimTask / renewTaskClaim /
 * releaseTaskClaim / getTaskClaim). These cross-node task claims are how the
 * engine coordinates lease ownership when multiple nodes could race to run the
 * same task. The remaining central tables (projects, nodes, projectHealth,
 * centralActivityLog, globalConcurrency, centralSettings, peerNodes,
 * settingsSyncState, managedDockerNodes, pluginInstalls, projectPluginStates,
 * meshSharedSnapshots, meshWriteQueue, secretsGlobal) are covered by their
 * dedicated async helpers (async-plugin-store.ts for the plugin tables; the
 * secrets round-trip test + async-secrets-store.ts for secrets_global) or are
 * addressable via the same schema.central.* table refs when their consumers
 * are converted at the coordinated getDatabase() flip.
 *
 * SQLite → PostgreSQL notes (see library/satellite-store-migration-pattern.md):
 *   - `db.prepare(sql).get/run/all()` → awaited Drizzle queries against
 *     `schema.central.*` table refs.
 *   - `db.transaction(fn)` (BEGIN IMMEDIATE + SAVEPOINT nesting) →
 *     `layer.transactionImmediate(async (tx) => ...)` (READ WRITE access mode;
 *     PostgreSQL uses MVCC, no BEGIN IMMEDIATE). All writes inside the callback
 *     commit atomically; a thrown error rolls back every write (VAL-DATA-002,
 *     VAL-DATA-003).
 *   - The composite PRIMARY KEY (projectId, taskId) on task_claims maps
 *     directly to the Drizzle primaryKey declaration in schema/central.ts.
 *   - DELETE results: postgres.js does not expose rowCount; use
 *     `.returning({...})` and check `.length`.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database`/`CentralDatabase` until
 *   the coordinated `getDatabase()` flip. The sync CentralDatabase keeps its
 *   sync path (the gate depends on it). These helpers are the async target the
 *   PostgreSQL integration tests consume, and the surface the engine will
 *   program against once the connection model flips. They target the stable
 *   `AsyncDataLayer` interface (U4), not the underlying driver.
 */
import { and, eq } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import type { CentralClaimStore, TaskClaimRow } from "./types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

/** Row shape for central.task_claims (camelCase column aliases via Drizzle). */
interface TaskClaimDbRow {
  projectId: string;
  taskId: string;
  ownerNodeId: string;
  ownerAgentId: string;
  ownerRunId: string | null;
  leaseEpoch: number;
  leaseRenewedAt: string;
  createdAt: string;
  updatedAt: string;
}

const taskClaimColumns = {
  projectId: schema.central.taskClaims.projectId,
  taskId: schema.central.taskClaims.taskId,
  ownerNodeId: schema.central.taskClaims.ownerNodeId,
  ownerAgentId: schema.central.taskClaims.ownerAgentId,
  ownerRunId: schema.central.taskClaims.ownerRunId,
  leaseEpoch: schema.central.taskClaims.leaseEpoch,
  leaseRenewedAt: schema.central.taskClaims.leaseRenewedAt,
  createdAt: schema.central.taskClaims.createdAt,
  updatedAt: schema.central.taskClaims.updatedAt,
};

function mapTaskClaimRow(row: TaskClaimDbRow | undefined): TaskClaimRow | null {
  if (!row) return null;
  return {
    projectId: String(row.projectId),
    taskId: String(row.taskId),
    ownerNodeId: String(row.ownerNodeId),
    ownerAgentId: String(row.ownerAgentId),
    ownerRunId: row.ownerRunId == null ? null : String(row.ownerRunId),
    leaseEpoch: Number(row.leaseEpoch),
    leaseRenewedAt: String(row.leaseRenewedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

/**
 * FNXC:CentralDatabase 2026-06-24-18:05:
 * Read a single task claim row by its composite key. Returns null when absent.
 * Direct equivalent of sync `CentralDatabase.getTaskClaim()`.
 *
 * @param handle The runtime db or a transaction handle.
 * @param projectId The project the claim is scoped to.
 * @param taskId The task the claim covers.
 */
export async function getTaskClaim(
  handle: QueryHandle,
  projectId: string,
  taskId: string,
): Promise<TaskClaimRow | null> {
  const rows = await handle
    .select(taskClaimColumns)
    .from(schema.central.taskClaims)
    .where(
      and(
        eq(schema.central.taskClaims.projectId, projectId),
        eq(schema.central.taskClaims.taskId, taskId),
      ),
    )
    .limit(1);
  return mapTaskClaimRow(rows[0] as TaskClaimDbRow | undefined);
}

/** Result shape for tryClaimTask, mirroring sync CentralClaimStore. */
export type TryClaimResult =
  | { ok: true; claim: TaskClaimRow }
  | { ok: false; reason: "conflict"; current: TaskClaimRow };

/** Result shape for renewTaskClaim, mirroring sync CentralClaimStore. */
export type RenewClaimResult =
  | { ok: true; claim: TaskClaimRow }
  | { ok: false; reason: "conflict" | "not_found"; current: TaskClaimRow | null };

/** Result shape for releaseTaskClaim, mirroring sync CentralClaimStore. */
export type ReleaseClaimResult =
  | { ok: true }
  | { ok: false; reason: "not_owner" | "not_found"; current: TaskClaimRow | null };

export interface TryClaimInput {
  projectId: string;
  taskId: string;
  nodeId: string;
  agentId: string;
  runId: string | null;
  renewedAt: string;
  expectedEpoch?: number | null;
}

/**
 * FNXC:CentralDatabase 2026-06-24-18:10:
 * Attempt to acquire or renew a cross-node task claim inside a single
 * transaction. Mirrors the sync `CentralDatabase.tryClaimTask()` semantics:
 *
 *   - No existing claim → INSERT a fresh claim (leaseEpoch = 1).
 *   - Same owner (nodeId + agentId) → renew: bump runId/leaseRenewedAt, but
 *     only if `expectedEpoch` matches the current epoch (else conflict).
 *   - Different owner → take over (bump epoch) only when `expectedEpoch`
 *     matches the current epoch (optimistic handoff); otherwise conflict.
 *
 * The entire read-then-write sequence runs inside one
 * `transactionImmediate()` so concurrent claimants cannot interleave
 * (VAL-DATA-004: concurrent transactions do not observe each other's
 * uncommitted writes). This removes the single-writer contention the SQLite
 * BEGIN IMMEDIATE path imposed (the central-DB concurrency learning).
 *
 * @param layer The async data layer providing the transaction primitive.
 * @param input The claim request.
 */
export async function tryClaimTask(
  layer: AsyncDataLayer,
  input: TryClaimInput,
): Promise<TryClaimResult> {
  return layer.transactionImmediate(async (tx): Promise<TryClaimResult> => {
    const existing = await getTaskClaim(tx, input.projectId, input.taskId);
    const now = input.renewedAt;

    if (!existing) {
      /*
      FNXC:AsyncCentralClaims 2026-07-16-10:55:
      FN-8047 requires concurrent first claims from separate nodes to produce one winner and a normal conflict for the loser. PostgreSQL transactions can both observe an absent row, so make the unique-key collision non-throwing and classify the persisted winner below instead of leaking a database constraint error through AgentStore checkout.
      */
      await tx.insert(schema.central.taskClaims).values({
        projectId: input.projectId,
        taskId: input.taskId,
        ownerNodeId: input.nodeId,
        ownerAgentId: input.agentId,
        ownerRunId: input.runId,
        leaseEpoch: 1,
        leaseRenewedAt: now,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      const claim = await getTaskClaim(tx, input.projectId, input.taskId);
      if (!claim) {
        throw new Error("Task claim insert succeeded but row could not be read back");
      }
      if (claim.ownerNodeId !== input.nodeId || claim.ownerAgentId !== input.agentId) {
        return { ok: false, reason: "conflict", current: claim };
      }
      return { ok: true, claim };
    }

    const sameOwner =
      existing.ownerNodeId === input.nodeId && existing.ownerAgentId === input.agentId;
    const expectedEpochMatches = input.expectedEpoch === existing.leaseEpoch;

    if (sameOwner) {
      if (!expectedEpochMatches) {
        return { ok: false, reason: "conflict", current: existing };
      }
      await tx
        .update(schema.central.taskClaims)
        .set({ ownerRunId: input.runId, leaseRenewedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.central.taskClaims.projectId, input.projectId),
            eq(schema.central.taskClaims.taskId, input.taskId),
          ),
        );
      const claim = await getTaskClaim(tx, input.projectId, input.taskId);
      if (!claim) {
        throw new Error("Task claim renewal succeeded but row could not be read back");
      }
      return { ok: true, claim };
    }

    // Different owner: optimistic takeover only when the expected epoch matches.
    if (input.expectedEpoch == null || !expectedEpochMatches) {
      return { ok: false, reason: "conflict", current: existing };
    }

    await tx
      .update(schema.central.taskClaims)
      .set({
        ownerNodeId: input.nodeId,
        ownerAgentId: input.agentId,
        ownerRunId: input.runId,
        leaseEpoch: existing.leaseEpoch + 1,
        leaseRenewedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.central.taskClaims.projectId, input.projectId),
          eq(schema.central.taskClaims.taskId, input.taskId),
        ),
      );
    const claim = await getTaskClaim(tx, input.projectId, input.taskId);
    if (!claim) {
      throw new Error("Task claim owner change succeeded but row could not be read back");
    }
    return { ok: true, claim };
  });
}

export interface RenewClaimInput {
  projectId: string;
  taskId: string;
  nodeId: string;
  agentId: string;
  runId: string | null;
  renewedAt: string;
  expectedEpoch: number;
}

/**
 * FNXC:CentralDatabase 2026-06-24-18:15:
 * Renew an existing claim owned by the same (nodeId, agentId) with a matching
 * epoch. Mirrors sync `CentralDatabase.renewTaskClaim()`. Returns not_found
 * when no claim exists, conflict when the owner/epoch does not match.
 */
export async function renewTaskClaim(
  layer: AsyncDataLayer,
  input: RenewClaimInput,
): Promise<RenewClaimResult> {
  return layer.transactionImmediate(async (tx): Promise<RenewClaimResult> => {
    const existing = await getTaskClaim(tx, input.projectId, input.taskId);
    if (!existing) {
      return { ok: false, reason: "not_found", current: null };
    }
    if (
      existing.ownerNodeId !== input.nodeId ||
      existing.ownerAgentId !== input.agentId ||
      existing.leaseEpoch !== input.expectedEpoch
    ) {
      return { ok: false, reason: "conflict", current: existing };
    }
    await tx
      .update(schema.central.taskClaims)
      .set({
        ownerRunId: input.runId,
        leaseRenewedAt: input.renewedAt,
        updatedAt: input.renewedAt,
      })
      .where(
        and(
          eq(schema.central.taskClaims.projectId, input.projectId),
          eq(schema.central.taskClaims.taskId, input.taskId),
        ),
      );
    const claim = await getTaskClaim(tx, input.projectId, input.taskId);
    if (!claim) {
      throw new Error("Task claim renew succeeded but row could not be read back");
    }
    return { ok: true, claim };
  });
}

export interface ReleaseClaimInput {
  projectId: string;
  taskId: string;
  nodeId: string;
  agentId: string;
}

/**
 * FNXC:CentralDatabase 2026-06-24-18:20:
 * Release a claim owned by (nodeId, agentId). Mirrors sync
 * `CentralDatabase.releaseTaskClaim()`. Returns not_found when no claim
 * exists, not_owner when the caller is not the current owner.
 */
export async function releaseTaskClaim(
  layer: AsyncDataLayer,
  input: ReleaseClaimInput,
): Promise<ReleaseClaimResult> {
  return layer.transactionImmediate(async (tx): Promise<ReleaseClaimResult> => {
    const existing = await getTaskClaim(tx, input.projectId, input.taskId);
    if (!existing) {
      return { ok: false, reason: "not_found", current: null };
    }
    if (existing.ownerNodeId !== input.nodeId || existing.ownerAgentId !== input.agentId) {
      return { ok: false, reason: "not_owner", current: existing };
    }
    await tx
      .delete(schema.central.taskClaims)
      .where(
        and(
          eq(schema.central.taskClaims.projectId, input.projectId),
          eq(schema.central.taskClaims.taskId, input.taskId),
        ),
      );
    return { ok: true };
  });
}

/**
 * FNXC:CentralDatabase 2026-06-24-18:25:
 * Drop all claims owned by a given node (used on node shutdown / lease sweep).
 * Direct Drizzle equivalent of `DELETE FROM task_claims WHERE owner_node_id = ?`.
 * Returns the number of rows deleted (via returning()).
 *
 * @param handle The runtime db or a transaction handle.
 * @param ownerNodeId The node whose claims should be released.
 */
export async function releaseClaimsForNode(
  handle: QueryHandle,
  ownerNodeId: string,
): Promise<number> {
  const deleted = await handle
    .delete(schema.central.taskClaims)
    .where(eq(schema.central.taskClaims.ownerNodeId, ownerNodeId))
    .returning({ projectId: schema.central.taskClaims.projectId });
  return deleted.length;
}

/** Awaitable CentralClaimStore adapter used by the PostgreSQL engine runtime. */
export class AsyncCentralClaimStore implements CentralClaimStore {
  constructor(private readonly layer: AsyncDataLayer) {}

  tryClaimTask(input: TryClaimInput): Promise<TryClaimResult> {
    return tryClaimTask(this.layer, input);
  }

  renewTaskClaim(input: RenewClaimInput): Promise<RenewClaimResult> {
    return renewTaskClaim(this.layer, input);
  }

  releaseTaskClaim(input: ReleaseClaimInput): Promise<ReleaseClaimResult> {
    return releaseTaskClaim(this.layer, input);
  }

  getTaskClaim(projectId: string, taskId: string): Promise<TaskClaimRow | null> {
    return getTaskClaim(this.layer.db, projectId, taskId);
  }
}
