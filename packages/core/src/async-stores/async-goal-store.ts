/**
 * Async Drizzle GoalStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:GoalStore 2026-06-24-06:35:
 * Async equivalents of the sync SQLite GoalStore call sites in goal-store.ts.
 * These helpers target the PostgreSQL `project.goals` table via Drizzle and
 * preserve the active-goal-limit enforcement and archive/unarchive semantics.
 *
 * The active-goal limit (ACTIVE_GOAL_LIMIT) is enforced inside a transaction
 * so the count-then-insert is atomic (matching the sync transactionImmediate
 * behavior). Archive/unarchive use a transaction for the same reason.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { projectOwnershipPartition, type AsyncDataLayer, type DbTransaction } from "../postgres/data-layer.js";
import {
  ACTIVE_GOAL_LIMIT,
  ActiveGoalLimitExceededError,
  type Goal,
  type GoalCreateInput,
  type GoalListFilter,
  type GoalStatus,
  type GoalUpdateInput,
} from "../goals/goal-types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

const goalColumns = {
  id: schema.project.goals.id,
  title: schema.project.goals.title,
  description: schema.project.goals.description,
  status: schema.project.goals.status,
  createdAt: schema.project.goals.createdAt,
  updatedAt: schema.project.goals.updatedAt,
};

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * FNXC:MissionGoalLinking 2026-09-23-08:55:
 * Operational goal reads use the AsyncDataLayer ownership partition, not a
 * natural id alone or the connection's optional RLS session binding. This keeps
 * goal-show and mission-link validation identical on administrative connections
 * and confines an unbound compatibility store to the legacy quarantine.
 */
export async function getGoal(handle: QueryHandle, id: string, projectId?: string): Promise<Goal | null> {
  const rows = await handle
    .select(goalColumns)
    .from(schema.project.goals)
    .where(and(
      eq(schema.project.goals.projectId, projectOwnershipPartition(projectId)),
      eq(schema.project.goals.id, id),
    ));
  return rows[0] ? toGoal(rows[0] as GoalRow) : null;
}

/**
 * FNXC:GoalStore 2026-06-24-06:40:
 * Create a goal inside a transaction that enforces the ACTIVE_GOAL_LIMIT.
 * The count-then-insert is atomic so two concurrent creates cannot both
 * exceed the limit.
 */
export async function createGoal(
  layer: AsyncDataLayer,
  input: GoalCreateInput & { id: string },
): Promise<Goal> {
  const now = new Date().toISOString();
  const created = await layer.transactionImmediate(async (tx) => {
    const projectId = projectOwnershipPartition(layer.projectId);
    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.project.goals)
      .where(and(
        eq(schema.project.goals.projectId, projectId),
        eq(schema.project.goals.status, "active"),
      ));
    const currentActive = countRows[0]?.count ?? 0;
    if (currentActive >= ACTIVE_GOAL_LIMIT) {
      throw new ActiveGoalLimitExceededError(ACTIVE_GOAL_LIMIT, currentActive);
    }
    await tx.insert(schema.project.goals).values({
      projectId,
      id: input.id,
      title: input.title,
      description: input.description ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return {
      id: input.id,
      title: input.title,
      description: input.description,
      status: "active" as GoalStatus,
      createdAt: now,
      updatedAt: now,
    };
  });
  return created;
}

/**
 * Update a goal's title/description. Throws if the goal does not exist.
 */
export async function updateGoal(
  handle: QueryHandle,
  id: string,
  input: GoalUpdateInput,
  projectId?: string,
): Promise<Goal> {
  const ownershipPartition = projectOwnershipPartition(projectId);
  const existing = await getGoal(handle, id, ownershipPartition);
  if (!existing) throw new Error(`Goal ${id} not found`);
  const now = new Date().toISOString();
  await handle
    .update(schema.project.goals)
    .set({
      title: input.title ?? existing.title,
      description: input.description ?? existing.description ?? null,
      updatedAt: now,
    })
    .where(and(
      eq(schema.project.goals.projectId, ownershipPartition),
      eq(schema.project.goals.id, id),
    ));
  return (await getGoal(handle, id, ownershipPartition))!;
}

/**
 * FNXC:GoalStore 2026-06-24-06:45:
 * Archive a goal. If already archived, returns the existing goal unchanged.
 */
export async function archiveGoal(handle: QueryHandle, id: string, projectId?: string): Promise<Goal> {
  const ownershipPartition = projectOwnershipPartition(projectId);
  const existing = await getGoal(handle, id, ownershipPartition);
  if (!existing) throw new Error(`Goal ${id} not found`);
  if (existing.status === "archived") return existing;
  const now = new Date().toISOString();
  await handle
    .update(schema.project.goals)
    .set({ status: "archived", updatedAt: now })
    .where(and(
      eq(schema.project.goals.projectId, ownershipPartition),
      eq(schema.project.goals.id, id),
    ));
  return (await getGoal(handle, id, ownershipPartition))!;
}

/**
 * FNXC:GoalStore 2026-06-24-06:50:
 * Unarchive a goal inside a transaction that enforces the ACTIVE_GOAL_LIMIT.
 * If the goal is already active, returns it unchanged.
 */
export async function unarchiveGoal(
  layer: AsyncDataLayer,
  id: string,
): Promise<Goal> {
  const result = await layer.transactionImmediate(async (tx) => {
    const projectId = projectOwnershipPartition(layer.projectId);
    const existing = await getGoal(tx, id, projectId);
    if (!existing) throw new Error(`Goal ${id} not found`);
    if (existing.status === "active") return { goal: existing, changed: false };

    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.project.goals)
      .where(and(
        eq(schema.project.goals.projectId, projectId),
        eq(schema.project.goals.status, "active"),
      ));
    const currentActive = countRows[0]?.count ?? 0;
    if (currentActive >= ACTIVE_GOAL_LIMIT) {
      throw new ActiveGoalLimitExceededError(ACTIVE_GOAL_LIMIT, currentActive);
    }
    const now = new Date().toISOString();
    await tx
      .update(schema.project.goals)
      .set({ status: "active", updatedAt: now })
      .where(and(
        eq(schema.project.goals.projectId, projectId),
        eq(schema.project.goals.id, id),
      ));
    return { goal: (await getGoal(tx, id, projectId))!, changed: true };
  });
  return result.goal;
}

/**
 * List goals, optionally filtered by status. Ordered by createdAt ASC.
 */
export async function listGoals(
  handle: QueryHandle,
  filter?: GoalListFilter,
  projectId?: string,
): Promise<Goal[]> {
  const ownershipScope = eq(schema.project.goals.projectId, projectOwnershipPartition(projectId));
  const query = handle
    .select(goalColumns)
    .from(schema.project.goals)
    .orderBy(asc(schema.project.goals.createdAt));
  const rows = filter?.status
    ? await query.where(and(ownershipScope, eq(schema.project.goals.status, filter.status)))
    : await query.where(ownershipScope);
  return rows.map((row) => toGoal(row as GoalRow));
}

/**
 * FNXC:GoalStore 2026-06-27-18:00:
 * PostgreSQL-backed GoalStore — the AsyncDataLayer counterpart of the sync
 * SQLite `GoalStore` (goal-store.ts). It exposes the SAME public method names so
 * the dashboard goals routes (/api/goals), the mission goal-resolution helpers,
 * and the CLI/agent goal tools can call either implementation behind `await`;
 * `getGoalStoreImpl` returns this in backend mode instead of constructing the
 * sync store (which dereferences the sync SQLite handle). Id generation mirrors
 * the sync store's `G-<ts>-<seq>-<rand>` format so the route id regex still
 * matches.
 *
 * ACTIVE_GOAL_LIMIT enforcement is NOT re-implemented here: the create/unarchive
 * helpers above enforce it atomically inside transactionImmediate (count-then-
 * insert/update), throwing ActiveGoalLimitExceededError — identical semantics to
 * the sync store's transactionImmediate path. getGoal returns null (not
 * undefined) when absent, matching the sync convention the routes branch on.
 *
 * Known gap vs the sync store: the sync GoalStore is an EventEmitter that emits
 * goal:created/goal:updated for SSE live-refresh. This wrapper performs the CRUD
 * only; UI updates land on the next read/refresh, not via live events.
 */
export class AsyncGoalStore {
  private idSequence = 0;

  /*
  FNXC:MissionGoalLinking 2026-09-23-08:55:
  The layer projectId is the permanent ownership seam for every operation in this facade; never infer operational goal scope from whichever pooled session executes a query.
  */
  constructor(private readonly layer: AsyncDataLayer) {}

  private generateGoalId(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    this.idSequence += 1;
    const sequence = this.idSequence.toString(36).toUpperCase().padStart(4, "0");
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `G-${timestamp}-${sequence}-${random}`;
  }

  async listGoals(filter?: GoalListFilter): Promise<Goal[]> {
    return listGoals(this.layer.db, filter, this.layer.projectId);
  }

  async getGoal(id: string): Promise<Goal | null> {
    return getGoal(this.layer.db, id, this.layer.projectId);
  }

  async createGoal(input: GoalCreateInput): Promise<Goal> {
    return createGoal(this.layer, { ...input, id: this.generateGoalId() });
  }

  async updateGoal(id: string, input: GoalUpdateInput): Promise<Goal> {
    return updateGoal(this.layer.db, id, input, this.layer.projectId);
  }

  async archiveGoal(id: string): Promise<Goal> {
    return archiveGoal(this.layer.db, id, this.layer.projectId);
  }

  async unarchiveGoal(id: string): Promise<Goal> {
    return unarchiveGoal(this.layer, id);
  }
}
