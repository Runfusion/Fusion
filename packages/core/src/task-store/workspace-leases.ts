import { and, eq, isNull, sql } from "drizzle-orm";
import { projectOwnershipPartition } from "../postgres/data-layer.js";
import type { DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import type { TaskStore } from "../store.js";
import type {
  AcquireWorkspaceLeaseResult,
  WorkspaceLandIntent,
  WorkspaceLandIntentResolution,
  WorkspaceLease,
  WorkspaceLeaseConflict,
  WorkspaceLeaseHandle,
  WorkspaceLeaseKind,
  WorkspaceLeaseOwner,
  WorkspaceLeaseReclaimOutcome,
} from "../tasks/workspace-lease-types.js";
import { isTerminalWorkspaceLeaseOwner } from "../tasks/workspace-lease-types.js";

type LeaseRow = typeof schema.project.workspaceCoordinationLeases.$inferSelect;

type LeaseStore = Pick<TaskStore, "getAsyncLayer">;

function project(store: LeaseStore) {
  const layer = store.getAsyncLayer();
  if (!layer) throw new Error("Workspace leases require an AsyncDataLayer");
  return { layer, projectId: projectOwnershipPartition(layer.projectId) };
}

function assertLeaseInput(leaseKey: string, leaseMs?: number): void {
  if (!leaseKey.trim()) throw new Error("Workspace lease key must not be empty");
  if (leaseMs !== undefined && (!Number.isFinite(leaseMs) || leaseMs <= 0)) {
    throw new Error("Workspace leaseMs must be positive");
  }
}

/** Serialize absent-row claims as well as updates to an existing lease row. */
async function lock(tx: DbTransaction, projectId: string, leaseKey: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${leaseKey}`}, 0))`);
}

function ownerMatches(row: Pick<LeaseRow, "ownerTaskId" | "ownerNodeId" | "ownerIncarnationId" | "ownerRunId">, owner: WorkspaceLeaseOwner): boolean {
  return row.ownerTaskId === owner.taskId
    && row.ownerNodeId === owner.nodeId
    && row.ownerIncarnationId === owner.incarnationId
    && (row.ownerRunId ?? undefined) === owner.runId;
}

function handle(row: LeaseRow): WorkspaceLeaseHandle {
  return {
    leaseKey: row.leaseKey,
    owner: { taskId: row.ownerTaskId, nodeId: row.ownerNodeId, incarnationId: row.ownerIncarnationId, ...(row.ownerRunId ? { runId: row.ownerRunId } : {}) },
    fenceToken: row.fenceToken,
    expiresAt: row.expiresAt,
    ...(row.fenceRefName ? { fenceRefName: row.fenceRefName } : {}),
    ...(row.fenceRefSha ? { fenceRefSha: row.fenceRefSha } : {}),
  };
}

function lease(row: LeaseRow): WorkspaceLease {
  return { ...handle(row), kind: row.kind as WorkspaceLeaseKind, status: row.status as WorkspaceLease["status"], acquiredAt: row.acquiredAt, renewedAt: row.renewedAt };
}

function conflict(row: LeaseRow): WorkspaceLeaseConflict {
  return { leaseKey: row.leaseKey, taskId: row.ownerTaskId, nodeId: row.ownerNodeId, incarnationId: row.ownerIncarnationId, fenceToken: row.fenceToken, expiresAt: row.expiresAt };
}

function intent(row: typeof schema.project.workspaceLandIntents.$inferSelect): WorkspaceLandIntent {
  return {
    taskId: row.taskId, repoRelPath: row.repoRelPath, remoteUrl: row.remoteUrl, integrationRef: row.integrationRef,
    intendedSha: row.intendedSha, expectedTip: row.expectedTip, fenceRefName: row.fenceRefName, fenceRefSha: row.fenceRefSha,
    owner: { taskId: row.ownerTaskId, nodeId: row.ownerNodeId, incarnationId: row.ownerIncarnationId }, fenceToken: row.fenceToken,
    status: row.status as WorkspaceLandIntent["status"], ...(row.resolvedSha ? { resolvedSha: row.resolvedSha } : {}),
    ...(row.resolution ? { resolution: row.resolution as WorkspaceLandIntentResolution } : {}),
    createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
  };
}

/**
 * FNXC:WorkspaceLease 2026-08-15-08:45:
 * Workspace acquire, land, and merge-dispatch writers contend on one durable
 * project/repository key. The increasing token is the fencing authority; a TTL
 * only permits a successor to claim it and never authorizes an old holder.
 */
export async function acquireWorkspaceLeaseAsync(
  store: TaskStore,
  input: { leaseKey: string; kind: WorkspaceLeaseKind; owner: WorkspaceLeaseOwner; leaseMs: number },
): Promise<AcquireWorkspaceLeaseResult> {
  assertLeaseInput(input.leaseKey, input.leaseMs);
  const { layer, projectId } = project(store);
  return layer.transactionImmediate(async (tx) => {
    await lock(tx, projectId, input.leaseKey);
    const [existing] = await tx.select().from(schema.project.workspaceCoordinationLeases).where(and(
      eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, input.leaseKey),
    )).limit(1);
    const now = new Date(); const nowIso = now.toISOString(); const expiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
    if (existing?.status === "held" && existing.expiresAt > nowIso && !ownerMatches(existing, input.owner)) {
      return { outcome: "conflict", conflict: conflict(existing) };
    }
    if (existing?.status === "held" && existing.expiresAt > nowIso) {
      if (existing.kind !== input.kind) return { outcome: "conflict", conflict: conflict(existing) };
      const [renewed] = await tx.update(schema.project.workspaceCoordinationLeases).set({ renewedAt: nowIso, expiresAt, updatedAt: nowIso }).where(and(
        eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, input.leaseKey),
        eq(schema.project.workspaceCoordinationLeases.fenceToken, existing.fenceToken), eq(schema.project.workspaceCoordinationLeases.status, "held"),
      )).returning();
      if (!renewed) throw new Error("Workspace lease reentrant renewal lost its fence");
      return { outcome: "reentrant", handle: handle(renewed) };
    }
    const fenceToken = (existing?.fenceToken ?? 0n) + 1n;
    const values = {
      projectId, leaseKey: input.leaseKey, kind: input.kind, ownerTaskId: input.owner.taskId, ownerNodeId: input.owner.nodeId,
      ownerIncarnationId: input.owner.incarnationId, ownerRunId: input.owner.runId ?? null, fenceToken, fenceRefName: null, fenceRefSha: null,
      status: "held", acquiredAt: nowIso, renewedAt: nowIso, expiresAt, createdAt: existing?.createdAt ?? nowIso, updatedAt: nowIso,
    };
    const [claimed] = existing
      ? await tx.update(schema.project.workspaceCoordinationLeases).set(values).where(and(eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, input.leaseKey))).returning()
      : await tx.insert(schema.project.workspaceCoordinationLeases).values(values).returning();
    if (!claimed) throw new Error("Workspace lease claim did not return a row");
    /*
    FNXC:WorkspaceLease 2026-08-15-12:00:
    Only an absent row starts a new tenancy. Reusing released or expired rows
    clears their pin and must be labelled reclaimed so fence publication occurs.
    */
    return { outcome: existing ? "reclaimed-expired" : "acquired", handle: handle(claimed) };
  });
}

export async function renewWorkspaceLeaseAsync(store: TaskStore, current: WorkspaceLeaseHandle, leaseMs: number): Promise<WorkspaceLeaseHandle | undefined> {
  assertLeaseInput(current.leaseKey, leaseMs);
  const { layer, projectId } = project(store);
  return layer.transactionImmediate(async (tx) => {
    await lock(tx, projectId, current.leaseKey);
    const now = new Date(); const nowIso = now.toISOString(); const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const [renewed] = await tx.update(schema.project.workspaceCoordinationLeases).set({ renewedAt: nowIso, expiresAt, updatedAt: nowIso }).where(and(
      eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, current.leaseKey),
      eq(schema.project.workspaceCoordinationLeases.ownerTaskId, current.owner.taskId), eq(schema.project.workspaceCoordinationLeases.ownerNodeId, current.owner.nodeId),
      eq(schema.project.workspaceCoordinationLeases.ownerIncarnationId, current.owner.incarnationId), (current.owner.runId ? eq(schema.project.workspaceCoordinationLeases.ownerRunId, current.owner.runId) : isNull(schema.project.workspaceCoordinationLeases.ownerRunId)),
      eq(schema.project.workspaceCoordinationLeases.fenceToken, current.fenceToken), eq(schema.project.workspaceCoordinationLeases.status, "held"),
    )).returning();
    return renewed ? handle(renewed) : undefined;
  });
}

export async function releaseWorkspaceLeaseAsync(store: TaskStore, current: WorkspaceLeaseHandle): Promise<boolean> {
  const { layer, projectId } = project(store);
  return layer.transactionImmediate(async (tx) => {
    await lock(tx, projectId, current.leaseKey);
    const released = await tx.update(schema.project.workspaceCoordinationLeases).set({ status: "released", updatedAt: new Date().toISOString() }).where(and(
      eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, current.leaseKey),
      eq(schema.project.workspaceCoordinationLeases.ownerTaskId, current.owner.taskId), eq(schema.project.workspaceCoordinationLeases.ownerNodeId, current.owner.nodeId),
      eq(schema.project.workspaceCoordinationLeases.ownerIncarnationId, current.owner.incarnationId), (current.owner.runId ? eq(schema.project.workspaceCoordinationLeases.ownerRunId, current.owner.runId) : isNull(schema.project.workspaceCoordinationLeases.ownerRunId)), eq(schema.project.workspaceCoordinationLeases.fenceToken, current.fenceToken), eq(schema.project.workspaceCoordinationLeases.status, "held"),
    )).returning({ leaseKey: schema.project.workspaceCoordinationLeases.leaseKey });
    return released.length === 1;
  });
}

export async function withValidWorkspaceLeaseAsync<T>(store: TaskStore, current: WorkspaceLeaseHandle, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const { layer, projectId } = project(store);
  return layer.transactionImmediate(async (tx) => {
    await lock(tx, projectId, current.leaseKey);
    const [row] = await tx.select().from(schema.project.workspaceCoordinationLeases).where(and(eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, current.leaseKey))).limit(1);
    if (!row || row.status !== "held" || row.expiresAt <= new Date().toISOString() || !ownerMatches(row, current.owner) || row.fenceToken !== current.fenceToken) {
      throw new Error("Workspace lease is no longer valid");
    }
    return fn(tx);
  });
}

export async function validateWorkspaceLeaseFenceAsync(store: TaskStore, input: { leaseKey: string; owner: WorkspaceLeaseOwner; fenceToken: bigint }) {
  const { layer, projectId } = project(store);
  const [row] = await layer.db.select().from(schema.project.workspaceCoordinationLeases).where(and(eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, input.leaseKey))).limit(1);
  if (!row) return "missing" as const;
  if (row.fenceToken < input.fenceToken) return "unknown" as const;
  if (row.fenceToken !== input.fenceToken || !ownerMatches(row, input.owner) || row.status !== "held" || row.expiresAt <= new Date().toISOString()) return "superseded" as const;
  return "valid" as const;
}

export async function recordWorkspaceLeaseFenceRefAsync(store: TaskStore, input: { handle: WorkspaceLeaseHandle; fenceRefName: string; fenceRefSha: string }): Promise<WorkspaceLeaseHandle> {
  if (!input.fenceRefName || !input.fenceRefSha) throw new Error("Workspace fence ref name and SHA are required");
  return withValidWorkspaceLeaseAsync(store, input.handle, async (tx) => {
    const { projectId } = project(store);
    const [updated] = await tx.update(schema.project.workspaceCoordinationLeases).set({ fenceRefName: input.fenceRefName, fenceRefSha: input.fenceRefSha, updatedAt: new Date().toISOString() }).where(and(
      eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, input.handle.leaseKey), eq(schema.project.workspaceCoordinationLeases.fenceToken, input.handle.fenceToken),
    )).returning();
    if (!updated) throw new Error("Workspace fence ref write lost its lease");
    return handle(updated);
  });
}

export async function inspectWorkspaceLeasesAsync(store: TaskStore, filter: { taskId?: string; leaseKeys?: string[] } = {}): Promise<WorkspaceLease[]> {
  const { layer, projectId } = project(store);
  const conditions = [eq(schema.project.workspaceCoordinationLeases.projectId, projectId)];
  if (filter.taskId) conditions.push(eq(schema.project.workspaceCoordinationLeases.ownerTaskId, filter.taskId));
  const rows = await layer.db.select().from(schema.project.workspaceCoordinationLeases).where(and(...conditions));
  return rows.filter((row) => !filter.leaseKeys || filter.leaseKeys.includes(row.leaseKey)).map(lease);
}

export async function recordWorkspaceLandIntentAsync(store: TaskStore, input: { handle: WorkspaceLeaseHandle; taskId: string; repoRelPath: string; remoteUrl: string; integrationRef: string; intendedSha: string; expectedTip: string }) {
  if (!input.handle.fenceRefName || !input.handle.fenceRefSha) throw new Error("Land intent requires a published fence ref");
  const fenceRefName = input.handle.fenceRefName;
  const fenceRefSha = input.handle.fenceRefSha;
  return withValidWorkspaceLeaseAsync(store, input.handle, async (tx) => {
    const { projectId } = project(store); const now = new Date().toISOString();
    const values: typeof schema.project.workspaceLandIntents.$inferInsert = { projectId, taskId: input.taskId, repoRelPath: input.repoRelPath, remoteUrl: input.remoteUrl, integrationRef: input.integrationRef, intendedSha: input.intendedSha, expectedTip: input.expectedTip, fenceRefName, fenceRefSha, ownerTaskId: input.handle.owner.taskId, ownerNodeId: input.handle.owner.nodeId, ownerIncarnationId: input.handle.owner.incarnationId, fenceToken: input.handle.fenceToken, status: "pending", createdAt: now, updatedAt: now };
    await tx.insert(schema.project.workspaceLandIntents).values(values).onConflictDoUpdate({ target: [schema.project.workspaceLandIntents.projectId, schema.project.workspaceLandIntents.taskId, schema.project.workspaceLandIntents.repoRelPath], set: { remoteUrl: input.remoteUrl, integrationRef: input.integrationRef, intendedSha: input.intendedSha, expectedTip: input.expectedTip, fenceRefName, fenceRefSha, ownerTaskId: input.handle.owner.taskId, ownerNodeId: input.handle.owner.nodeId, ownerIncarnationId: input.handle.owner.incarnationId, fenceToken: input.handle.fenceToken, status: "pending", resolvedSha: null, resolution: null, resolvedAt: null, updatedAt: now } });
  });
}

export async function listPendingWorkspaceLandIntentsAsync(store: TaskStore, filter: { taskId?: string; repoRelPath?: string; limit?: number } = {}): Promise<WorkspaceLandIntent[]> {
  const { layer, projectId } = project(store); const conditions = [eq(schema.project.workspaceLandIntents.projectId, projectId), eq(schema.project.workspaceLandIntents.status, "pending")];
  if (filter.taskId) conditions.push(eq(schema.project.workspaceLandIntents.taskId, filter.taskId));
  if (filter.repoRelPath) conditions.push(eq(schema.project.workspaceLandIntents.repoRelPath, filter.repoRelPath));
  const rows = await layer.db.select().from(schema.project.workspaceLandIntents).where(and(...conditions));
  return rows.slice(0, filter.limit).map(intent);
}

async function resolveIntent(tx: DbTransaction, projectId: string, input: { taskId: string; repoRelPath: string; expectedIntentFenceToken: bigint; resolution: WorkspaceLandIntentResolution; resolvedSha?: string; persistLandedSha?: () => Promise<void> }, maxFence?: bigint) {
  const [row] = await tx.select().from(schema.project.workspaceLandIntents).where(and(eq(schema.project.workspaceLandIntents.projectId, projectId), eq(schema.project.workspaceLandIntents.taskId, input.taskId), eq(schema.project.workspaceLandIntents.repoRelPath, input.repoRelPath))).limit(1);
  if (!row) return { outcome: "missing" as const };
  if (row.status !== "pending") return { outcome: "resolved" as const };
  if (row.fenceToken !== input.expectedIntentFenceToken || (maxFence !== undefined && row.fenceToken > maxFence)) return { outcome: "stale-intent" as const };
  if (input.resolution === "landed") await input.persistLandedSha?.();
  const now = new Date().toISOString();
  await tx.update(schema.project.workspaceLandIntents).set({ status: input.resolution === "landed" ? "recorded" : "abandoned", resolution: input.resolution, resolvedSha: input.resolvedSha ?? null, resolvedAt: now, updatedAt: now }).where(and(eq(schema.project.workspaceLandIntents.projectId, projectId), eq(schema.project.workspaceLandIntents.taskId, input.taskId), eq(schema.project.workspaceLandIntents.repoRelPath, input.repoRelPath), eq(schema.project.workspaceLandIntents.status, "pending")));
  return { outcome: "resolved" as const };
}

export async function resolveWorkspaceLandIntentAsync(store: TaskStore, input: { handle: WorkspaceLeaseHandle; taskId: string; repoRelPath: string; expectedIntentFenceToken: bigint; resolution: WorkspaceLandIntentResolution; resolvedSha?: string; persistLandedSha?: () => Promise<void> }) {
  return withValidWorkspaceLeaseAsync(store, input.handle, (tx) => resolveIntent(tx, project(store).projectId, input, input.handle.fenceToken));
}

export async function resolveOrphanedWorkspaceLandIntentAsync(store: TaskStore, input: { leaseKey: string; taskId: string; repoRelPath: string; expectedIntentFenceToken: bigint; resolution: WorkspaceLandIntentResolution; resolvedSha?: string; persistLandedSha?: () => Promise<void> }) {
  const { layer, projectId } = project(store);
  return layer.transactionImmediate(async (tx) => { await lock(tx, projectId, input.leaseKey); const [row] = await tx.select().from(schema.project.workspaceCoordinationLeases).where(and(eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, input.leaseKey))).limit(1); if (row?.status === "held" && row.expiresAt > new Date().toISOString()) return { outcome: "lease-live" as const }; return resolveIntent(tx, projectId, input); });
}

export async function reclaimWorkspaceLeaseAsync(store: TaskStore, input: { leaseKey: string; expectedOwner: WorkspaceLeaseOwner; expectedFenceToken: bigint; requireTerminalOwner?: boolean; reason?: string }): Promise<{ outcome: WorkspaceLeaseReclaimOutcome }> {
  const { layer, projectId } = project(store);
  return layer.transactionImmediate(async (tx) => {
    await lock(tx, projectId, input.leaseKey); const [row] = await tx.select().from(schema.project.workspaceCoordinationLeases).where(and(eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, input.leaseKey))).limit(1);
    if (!row) return { outcome: "missing" }; if (!ownerMatches(row, input.expectedOwner) || row.fenceToken !== input.expectedFenceToken) return { outcome: "stale-precondition" };
    if (row.expiresAt > new Date().toISOString()) {
      if (!input.requireTerminalOwner) return { outcome: "still-live" };
      const [owner] = await tx.select({ column: schema.project.tasks.column, status: schema.project.tasks.status }).from(schema.project.tasks).where(and(eq(schema.project.tasks.projectId, projectId), eq(schema.project.tasks.id, row.ownerTaskId))).limit(1);
      if (!owner) return { outcome: "owner-unresolvable" }; if (!isTerminalWorkspaceLeaseOwner({ ...owner, status: owner.status ?? undefined })) return { outcome: "still-live" };
    }
    await tx.update(schema.project.workspaceCoordinationLeases).set({ status: "expired", updatedAt: new Date().toISOString() }).where(and(eq(schema.project.workspaceCoordinationLeases.projectId, projectId), eq(schema.project.workspaceCoordinationLeases.leaseKey, input.leaseKey), eq(schema.project.workspaceCoordinationLeases.fenceToken, input.expectedFenceToken), eq(schema.project.workspaceCoordinationLeases.status, "held")));
    return { outcome: "reclaimed" };
  });
}

export async function reconcileExpiredWorkspaceLeasesAsync(store: TaskStore): Promise<string[]> {
  const leases = await inspectWorkspaceLeasesAsync(store); const reclaimed: string[] = [];
  for (const item of leases) if (item.status === "held" && item.expiresAt <= new Date().toISOString()) { const result = await reclaimWorkspaceLeaseAsync(store, { leaseKey: item.leaseKey, expectedOwner: item.owner, expectedFenceToken: item.fenceToken }); if (result.outcome === "reclaimed") reclaimed.push(item.leaseKey); }
  return reclaimed;
}

export async function releaseStaleWorkspaceLeasesForNodeAsync(store: TaskStore, nodeId: string, { currentIncarnationId }: { currentIncarnationId: string }): Promise<string[]> {
  const leases = await inspectWorkspaceLeasesAsync(store); const reclaimed: string[] = [];
  for (const item of leases) if (item.owner.nodeId === nodeId && item.owner.incarnationId !== currentIncarnationId && item.expiresAt <= new Date().toISOString()) { const result = await reclaimWorkspaceLeaseAsync(store, { leaseKey: item.leaseKey, expectedOwner: item.owner, expectedFenceToken: item.fenceToken }); if (result.outcome === "reclaimed") reclaimed.push(item.leaseKey); }
  return reclaimed;
}
