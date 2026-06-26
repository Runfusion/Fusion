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
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  ACTIVE_GOAL_LIMIT,
  ActiveGoalLimitExceededError,
  type Goal,
  type GoalCreateInput,
  type GoalListFilter,
  type GoalStatus,
  type GoalUpdateInput,
} from "./goal-types.js";

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
 * Get a single goal by id. Returns null if not found.
 */
export async function getGoal(handle: QueryHandle, id: string): Promise<Goal | null> {
  const rows = await handle
    .select(goalColumns)
    .from(schema.project.goals)
    .where(eq(schema.project.goals.id, id));
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
    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.project.goals)
      .where(eq(schema.project.goals.status, "active"));
    const currentActive = countRows[0]?.count ?? 0;
    if (currentActive >= ACTIVE_GOAL_LIMIT) {
      throw new ActiveGoalLimitExceededError(ACTIVE_GOAL_LIMIT, currentActive);
    }
    await tx.insert(schema.project.goals).values({
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
): Promise<Goal> {
  const existing = await getGoal(handle, id);
  if (!existing) throw new Error(`Goal ${id} not found`);
  const now = new Date().toISOString();
  await handle
    .update(schema.project.goals)
    .set({
      title: input.title ?? existing.title,
      description: input.description ?? existing.description ?? null,
      updatedAt: now,
    })
    .where(eq(schema.project.goals.id, id));
  return (await getGoal(handle, id))!;
}

/**
 * FNXC:GoalStore 2026-06-24-06:45:
 * Archive a goal. If already archived, returns the existing goal unchanged.
 */
export async function archiveGoal(handle: QueryHandle, id: string): Promise<Goal> {
  const existing = await getGoal(handle, id);
  if (!existing) throw new Error(`Goal ${id} not found`);
  if (existing.status === "archived") return existing;
  const now = new Date().toISOString();
  await handle
    .update(schema.project.goals)
    .set({ status: "archived", updatedAt: now })
    .where(eq(schema.project.goals.id, id));
  return (await getGoal(handle, id))!;
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
    const existing = await getGoal(tx, id);
    if (!existing) throw new Error(`Goal ${id} not found`);
    if (existing.status === "active") return { goal: existing, changed: false };

    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.project.goals)
      .where(eq(schema.project.goals.status, "active"));
    const currentActive = countRows[0]?.count ?? 0;
    if (currentActive >= ACTIVE_GOAL_LIMIT) {
      throw new ActiveGoalLimitExceededError(ACTIVE_GOAL_LIMIT, currentActive);
    }
    const now = new Date().toISOString();
    await tx
      .update(schema.project.goals)
      .set({ status: "active", updatedAt: now })
      .where(eq(schema.project.goals.id, id));
    return { goal: (await getGoal(tx, id))!, changed: true };
  });
  return result.goal;
}

/**
 * List goals, optionally filtered by status. Ordered by createdAt ASC.
 */
export async function listGoals(
  handle: QueryHandle,
  filter?: GoalListFilter,
): Promise<Goal[]> {
  const query = handle
    .select(goalColumns)
    .from(schema.project.goals)
    .orderBy(asc(schema.project.goals.createdAt));
  const rows = filter?.status
    ? await query.where(eq(schema.project.goals.status, filter.status))
    : await query;
  return rows.map((row) => toGoal(row as GoalRow));
}
