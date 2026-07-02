/**
 * Async Drizzle branch-groups / PR-entities helpers (U14).
 *
 * FNXC:TaskStoreBranchGroups 2026-06-24-07:50:
 * Async equivalents of the sync SQLite branch-group and PR-entity call sites
 * in store.ts (`createBranchGroup`, `updateBranchGroup`, `getBranchGroup`,
 * `listBranchGroups`, `ensurePrEntityForSource`, `updatePrEntity`,
 * `recordPrThreadOutcome`). These helpers target the PostgreSQL
 * `project.branch_groups`, `project.pull_requests`, and
 * `project.pull_request_thread_state` tables via Drizzle.
 *
 * The branch-groups and PR-entities are not soft-delete-scoped (they have their
 * own `status` / `state` lifecycle columns), so the soft-delete filter does not
 * apply here. The branch-name shell-safety guard (`validateBranchGroupBranchName`)
 * is applied at the boundary so injection-shaped names never reach a downstream
 * git/shell sink.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync branch-group/PR path (the gate depends on
 *   it). These helpers are the async target the migrating store and the
 *   PostgreSQL integration tests consume.
 */
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import {
  validateBranchGroupBranchName,
} from "../branch-assignment.js";
import type {
  BranchGroup,
  BranchGroupCreateInput,
  BranchGroupUpdate,
  PrEntity,
  PrEntityCreateInput,
  PrEntityUpdate,
  PrThreadState,
  PrThreadOutcome,
} from "../types.js";
import type {
  BranchGroupRow,
  PrEntityRow,
  PrThreadStateRow,
} from "./row-types.js";

/**
 * Generate a branch-group id. Mirrors the sync `generateBranchGroupId()`.
 */
function generateBranchGroupId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `BG-${timestamp}-${random}`;
}

/**
 * Generate a PR-entity id. Mirrors the sync `generatePrEntityId()`.
 */
function generatePrEntityId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PR-${timestamp}-${random}`;
}

/**
 * Convert a raw `branch_groups` row into the public `BranchGroup` shape.
 * Mirrors the sync `rowToBranchGroup`.
 */
export function rowToBranchGroup(row: BranchGroupRow): BranchGroup {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    branchName: row.branchName,
    worktreePath: row.worktreePath ?? undefined,
    autoMerge: Boolean(row.autoMerge),
    prState: row.prState,
    prUrl: row.prUrl ?? undefined,
    prNumber: row.prNumber ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt ?? undefined,
  };
}

/**
 * FNXC:TaskStoreBranchGroups 2026-06-24-07:55:
 * Create a branch group. The branch-name shell-safety guard is applied at this
 * boundary so an injection-shaped name is rejected before it can reach a
 * downstream git/shell sink (Fix #11). This is the async equivalent of the
 * sync `createBranchGroup`.
 *
 * @param db The Drizzle instance.
 * @param input The branch-group create input.
 * @returns The created branch group.
 */
export async function createBranchGroup(
  db: AsyncDataLayer["db"] | DbTransaction,
  input: BranchGroupCreateInput,
): Promise<BranchGroup> {
  // Fix #11: reject injection-shaped branch names at the persistence boundary.
  validateBranchGroupBranchName(input.branchName);
  const now = Date.now();
  const id = generateBranchGroupId();
  await db.insert(schema.project.branchGroups).values({
    id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    branchName: input.branchName,
    worktreePath: input.worktreePath ?? null,
    autoMerge: input.autoMerge ? 1 : 0,
    prState: input.prState ?? "none",
    prUrl: input.prUrl ?? null,
    prNumber: input.prNumber ?? null,
    status: input.status ?? "open",
    createdAt: now,
    updatedAt: now,
    closedAt: input.closedAt ?? null,
  });
  const created = await getBranchGroup(db, id);
  if (!created) throw new Error(`Failed to read branch group ${id} after create`);
  return created;
}

/**
 * Read a branch group by id. Returns `null` if not found.
 */
export async function getBranchGroup(
  db: AsyncDataLayer["db"] | DbTransaction,
  id: string,
): Promise<BranchGroup | null> {
  const rows = await db
    .select()
    .from(schema.project.branchGroups)
    .where(eq(schema.project.branchGroups.id, id))
    .limit(1);
  const row = rows[0] as BranchGroupRow | undefined;
  return row ? rowToBranchGroup(row) : null;
}

/**
 * Read a branch group by source (sourceType + sourceId). Returns `null` if not
 * found. This is the async equivalent of `getBranchGroupBySource`.
 */
export async function getBranchGroupBySource(
  db: AsyncDataLayer["db"] | DbTransaction,
  sourceType: BranchGroup["sourceType"],
  sourceId: string,
): Promise<BranchGroup | null> {
  const rows = await db
    .select()
    .from(schema.project.branchGroups)
    .where(
      and(
        eq(schema.project.branchGroups.sourceType, sourceType),
        eq(schema.project.branchGroups.sourceId, sourceId),
      ),
    )
    .limit(1);
  const row = rows[0] as BranchGroupRow | undefined;
  return row ? rowToBranchGroup(row) : null;
}

/**
 * Read the open branch group by branch name (status = 'open', newest first).
 * This is the async equivalent of `getBranchGroupByBranchName`.
 */
export async function getBranchGroupByBranchName(
  db: AsyncDataLayer["db"] | DbTransaction,
  branchName: string,
): Promise<BranchGroup | null> {
  const rows = await db
    .select()
    .from(schema.project.branchGroups)
    .where(eq(schema.project.branchGroups.branchName, branchName))
    .orderBy(sql`${schema.project.branchGroups.createdAt} DESC`)
    .limit(1);
  const row = rows[0] as BranchGroupRow | undefined;
  return row ? rowToBranchGroup(row) : null;
}

/**
 * FNXC:TaskStoreBranchGroups 2026-06-24-08:00:
 * Ensure a branch group exists for a source, creating it if absent. Reuses an
 * existing open group for the same branch name rather than violating the UNIQUE
 * constraint (two missions whose shared base resolves to the same branch must
 * not collide). This is the async equivalent of `ensureBranchGroupForSource`.
 */
export async function ensureBranchGroupForSource(
  db: AsyncDataLayer["db"] | DbTransaction,
  sourceType: BranchGroup["sourceType"],
  sourceId: string,
  init: Omit<BranchGroupCreateInput, "sourceType" | "sourceId">,
): Promise<BranchGroup> {
  const existing = await getBranchGroupBySource(db, sourceType, sourceId);
  if (existing) return existing;

  // branch_groups.branchName is globally UNIQUE — reuse an existing open group
  // for this branch rather than colliding on insert.
  const existingByBranch = await getBranchGroupByBranchName(db, init.branchName);
  if (existingByBranch) return existingByBranch;

  return createBranchGroup(db, { sourceType, sourceId, ...init });
}

/**
 * List branch groups, optionally filtered by status, ordered by createdAt ASC.
 */
export async function listBranchGroups(
  db: AsyncDataLayer["db"] | DbTransaction,
  options?: { status?: BranchGroup["status"] },
): Promise<BranchGroup[]> {
  const query = db
    .select()
    .from(schema.project.branchGroups)
    .orderBy(asc(schema.project.branchGroups.createdAt));
  const rows = options?.status
    ? await query.where(eq(schema.project.branchGroups.status, options.status))
    : await query;
  return (rows as BranchGroupRow[]).map((row) => rowToBranchGroup(row));
}

/**
 * FNXC:TaskStoreBranchGroups 2026-06-24-08:05:
 * Update a branch group. A rename re-applies the shell-safety guard at the
 * same boundary as create (Fix #11). When status transitions away from 'open',
 * `closedAt` is stamped automatically (mirrors the sync logic). This is the
 * async equivalent of `updateBranchGroup`.
 */
export async function updateBranchGroup(
  db: AsyncDataLayer["db"] | DbTransaction,
  id: string,
  patch: BranchGroupUpdate,
): Promise<BranchGroup> {
  const current = await getBranchGroup(db, id);
  if (!current) throw new Error(`Branch group ${id} not found`);

  // Fix #11: a rename must reject injection-shaped names.
  if (patch.branchName !== undefined) {
    validateBranchGroupBranchName(patch.branchName);
  }

  const nextStatus = patch.status ?? current.status;
  const now = Date.now();
  const nextClosedAt =
    patch.closedAt === null
      ? null
      : patch.closedAt ?? (nextStatus !== "open" && current.status === "open" ? now : current.closedAt ?? null);

  await db
    .update(schema.project.branchGroups)
    .set({
      sourceId: patch.sourceId ?? current.sourceId,
      branchName: patch.branchName ?? current.branchName,
      worktreePath: patch.worktreePath === null ? null : (patch.worktreePath ?? current.worktreePath ?? null),
      autoMerge: patch.autoMerge === undefined ? (current.autoMerge ? 1 : 0) : (patch.autoMerge ? 1 : 0),
      prState: patch.prState ?? current.prState,
      prUrl: patch.prUrl === null ? null : (patch.prUrl ?? current.prUrl ?? null),
      prNumber: patch.prNumber === null ? null : (patch.prNumber ?? current.prNumber ?? null),
      status: nextStatus,
      updatedAt: now,
      closedAt: nextClosedAt,
    })
    .where(eq(schema.project.branchGroups.id, id));

  const updated = await getBranchGroup(db, id);
  if (!updated) throw new Error(`Branch group ${id} disappeared after update`);
  return updated;
}

// ── PR entities (pull_requests) ──────────────────────────────────────

/**
 * Convert a raw `pull_requests` row into the public `PrEntity` shape.
 * The jsonb columns (`checksRollup`, `mergeable`) come back already-parsed.
 */
export function rowToPrEntity(row: PrEntityRow): PrEntity {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    repo: row.repo,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch ?? undefined,
    state: row.state,
    prNumber: row.prNumber ?? undefined,
    prUrl: row.prUrl ?? undefined,
    headOid: row.headOid ?? undefined,
    mergeable: (row.mergeable as PrEntity["mergeable"] | null) ?? undefined,
    checksRollup: (row.checksRollup as PrEntity["checksRollup"] | null) ?? undefined,
    reviewDecision: (row.reviewDecision as PrEntity["reviewDecision"]) ?? undefined,
    autoMerge: Boolean(row.autoMerge),
    unverified: Boolean(row.unverified),
    failureReason: row.failureReason ?? undefined,
    responseRounds: row.responseRounds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt ?? undefined,
  };
}

/**
 * Read a PR entity by id. Returns `null` if not found.
 */
export async function getPrEntity(
  db: AsyncDataLayer["db"] | DbTransaction,
  id: string,
): Promise<PrEntity | null> {
  const rows = await db
    .select()
    .from(schema.project.pullRequests)
    .where(eq(schema.project.pullRequests.id, id))
    .limit(1);
  const row = rows[0] as PrEntityRow | undefined;
  return row ? rowToPrEntity(row) : null;
}

/**
 * FNXC:TaskStoreBranchGroups 2026-06-24-08:10:
 * Create-or-reuse the non-terminal PR entity for a source (AE6 idempotency).
 * Reuse is keyed on the source identity (the open-source partial unique index),
 * so re-entry from the pr-create node never mints a second live entity.
 * This is the async equivalent of `ensurePrEntityForSource`.
 */
export async function ensurePrEntityForSource(
  db: AsyncDataLayer["db"] | DbTransaction,
  input: PrEntityCreateInput,
): Promise<PrEntity> {
  const existing = await getActivePrEntityBySource(db, input.sourceType, input.sourceId);
  if (existing) return existing;

  const id = generatePrEntityId();
  const now = Date.now();
  await db.insert(schema.project.pullRequests).values({
    id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    repo: input.repo,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch ?? null,
    state: input.state ?? "creating",
    prNumber: input.prNumber ?? null,
    prUrl: input.prUrl ?? null,
    autoMerge: input.autoMerge ? 1 : 0,
    unverified: input.unverified ? 1 : 0,
    responseRounds: 0,
    createdAt: now,
    updatedAt: now,
  });

  const created = await getPrEntity(db, id);
  if (!created) throw new Error(`Failed to read PR entity ${id} after create`);
  return created;
}

/**
 * Read the active (non-terminal) PR entity for a source, newest first.
 */
export async function getActivePrEntityBySource(
  db: AsyncDataLayer["db"] | DbTransaction,
  sourceType: PrEntity["sourceType"],
  sourceId: string,
): Promise<PrEntity | null> {
  const rows = await db
    .select()
    .from(schema.project.pullRequests)
    .where(
      and(
        eq(schema.project.pullRequests.sourceType, sourceType),
        eq(schema.project.pullRequests.sourceId, sourceId),
        notInArray(schema.project.pullRequests.state, ["merged", "closed", "failed"]),
      ),
    )
    .orderBy(sql`${schema.project.pullRequests.createdAt} DESC`)
    .limit(1);
  const row = rows[0] as PrEntityRow | undefined;
  return row ? rowToPrEntity(row) : null;
}

/**
 * FNXC:TaskStoreBranchGroups 2026-06-24-08:15:
 * Update a PR entity. When the state transitions to a terminal state
 * ('merged'/'closed'), `closedAt` is stamped automatically. This is the async
 * equivalent of `updatePrEntity`.
 */
export async function updatePrEntity(
  db: AsyncDataLayer["db"] | DbTransaction,
  id: string,
  patch: PrEntityUpdate,
): Promise<PrEntity> {
  const current = await getPrEntity(db, id);
  if (!current) throw new Error(`PR entity ${id} not found`);

  const nextState = patch.state ?? current.state;
  const now = Date.now();
  const isTerminal = nextState === "merged" || nextState === "closed";
  const nextClosedAt =
    patch.closedAt === null
      ? null
      : patch.closedAt ?? (isTerminal && current.closedAt === undefined ? now : current.closedAt ?? null);

  const orCurrent = <T>(v: T | null | undefined, cur: T | undefined): T | null =>
    v === null ? null : v ?? cur ?? null;

  await db
    .update(schema.project.pullRequests)
    .set({
      state: nextState,
      prNumber: orCurrent(patch.prNumber, current.prNumber),
      prUrl: orCurrent(patch.prUrl, current.prUrl),
      headOid: orCurrent(patch.headOid, current.headOid),
      mergeable: orCurrent(patch.mergeable, current.mergeable),
      checksRollup: orCurrent(patch.checksRollup, current.checksRollup),
      reviewDecision:
        patch.reviewDecision === undefined ? current.reviewDecision ?? null : patch.reviewDecision,
      autoMerge: patch.autoMerge === undefined ? (current.autoMerge ? 1 : 0) : patch.autoMerge ? 1 : 0,
      unverified: patch.unverified === undefined ? (current.unverified ? 1 : 0) : patch.unverified ? 1 : 0,
      failureReason: orCurrent(patch.failureReason, current.failureReason),
      responseRounds: patch.responseRounds ?? current.responseRounds,
      updatedAt: now,
      closedAt: nextClosedAt,
    })
    .where(eq(schema.project.pullRequests.id, id));

  const updated = await getPrEntity(db, id);
  if (!updated) throw new Error(`PR entity ${id} disappeared after update`);
  return updated;
}

/**
 * List non-terminal PR entities (the reconcile poll set), oldest first.
 */
export async function listActivePrEntities(
  db: AsyncDataLayer["db"] | DbTransaction,
): Promise<PrEntity[]> {
  const rows = await db
    .select()
    .from(schema.project.pullRequests)
    .where(notInArray(schema.project.pullRequests.state, ["merged", "closed", "failed"]))
    .orderBy(asc(schema.project.pullRequests.createdAt));
  return (rows as PrEntityRow[]).map((r) => rowToPrEntity(r));
}

// ── PR thread state (per-thread response outcomes) ───────────────────

/**
 * Read a per-thread response state row. Returns `null` if not found.
 */
export async function getPrThreadState(
  db: AsyncDataLayer["db"] | DbTransaction,
  prEntityId: string,
  threadId: string,
  headOid: string,
): Promise<PrThreadState | null> {
  const rows = await db
    .select()
    .from(schema.project.pullRequestThreadState)
    .where(
      and(
        eq(schema.project.pullRequestThreadState.prEntityId, prEntityId),
        eq(schema.project.pullRequestThreadState.threadId, threadId),
        eq(schema.project.pullRequestThreadState.headOid, headOid),
      ),
    )
    .limit(1);
  const row = rows[0] as PrThreadStateRow | undefined;
  return row
    ? {
        prEntityId: row.prEntityId,
        threadId: row.threadId,
        headOid: row.headOid,
        outcome: row.outcome,
        fixCommitSha: row.fixCommitSha ?? undefined,
        updatedAt: row.updatedAt,
      }
    : null;
}

/**
 * List all per-thread response states for a PR entity.
 */
export async function listPrThreadStates(
  db: AsyncDataLayer["db"] | DbTransaction,
  prEntityId: string,
): Promise<PrThreadState[]> {
  const rows = await db
    .select()
    .from(schema.project.pullRequestThreadState)
    .where(eq(schema.project.pullRequestThreadState.prEntityId, prEntityId));
  return (rows as PrThreadStateRow[]).map((row) => ({
    prEntityId: row.prEntityId,
    threadId: row.threadId,
    headOid: row.headOid,
    outcome: row.outcome,
    fixCommitSha: row.fixCommitSha ?? undefined,
    updatedAt: row.updatedAt,
  }));
}

/**
 * FNXC:TaskStoreBranchGroups 2026-06-24-08:20:
 * Upsert a per-thread response outcome. This is the async equivalent of
 * `recordPrThreadOutcome`. The composite primary key (prEntityId, threadId,
 * headOid) makes the upsert idempotent for a given (thread, head) pair.
 */
export async function recordPrThreadOutcome(
  db: AsyncDataLayer["db"] | DbTransaction,
  prEntityId: string,
  threadId: string,
  headOid: string,
  outcome: PrThreadOutcome,
  fixCommitSha?: string,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(schema.project.pullRequestThreadState)
    .values({
      prEntityId,
      threadId,
      headOid,
      outcome,
      fixCommitSha: fixCommitSha ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.project.pullRequestThreadState.prEntityId,
        schema.project.pullRequestThreadState.threadId,
        schema.project.pullRequestThreadState.headOid,
      ],
      set: {
        outcome,
        fixCommitSha: fixCommitSha ?? null,
        updatedAt: now,
      },
    });
}
