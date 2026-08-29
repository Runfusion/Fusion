import { EventEmitter } from "node:events";
import type { Database } from "../db/db.js";
import {
  ACTIVE_GOAL_LIMIT,
  ActiveGoalLimitExceededError,
  type Goal,
  type GoalCreateInput,
  type GoalListFilter,
  type GoalStatus,
  type GoalUpdateInput,
} from "./goal-types.js";

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GoalStoreEvents {
  "goal:created": [Goal];
  "goal:updated": [Goal];
}

export class GoalStore extends EventEmitter<GoalStoreEvents> {
  private idSequence = 0;

  public constructor(
    _fusionDir: string,
    private readonly db: Database,
  ) {
    super();
  }

  public createGoal(input: GoalCreateInput): Goal {
    const now = new Date().toISOString();
    const goal = this.db.transactionImmediate(() => {
      const activeCountRow = this.db
        .prepare("SELECT COUNT(*) as count FROM goals WHERE status = 'active'")
        .get() as { count: number } | undefined;
      const currentActive = activeCountRow?.count ?? 0;

      if (currentActive >= ACTIVE_GOAL_LIMIT) {
        throw new ActiveGoalLimitExceededError(ACTIVE_GOAL_LIMIT, currentActive);
      }

      const created: Goal = {
        id: this.generateGoalId(),
        title: input.title,
        description: input.description,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };

      this.db
        .prepare(
          "INSERT INTO goals (id, title, description, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(created.id, created.title, created.description ?? null, created.status, created.createdAt, created.updatedAt);

      return created;
    });

    this.db.bumpLastModified();
    this.emit("goal:created", goal);
    return goal;
  }

  public updateGoal(id: string, input: GoalUpdateInput): Goal {
    const existing = this.getGoal(id);
    if (!existing) {
      throw new Error(`Goal ${id} not found`);
    }

    const updated: Goal = {
      ...existing,
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare("UPDATE goals SET title = ?, description = ?, updatedAt = ? WHERE id = ?")
      .run(updated.title, updated.description ?? null, updated.updatedAt, id);

    this.db.bumpLastModified();
    this.emit("goal:updated", updated);
    return updated;
  }

  public archiveGoal(id: string): Goal {
    const existing = this.getGoal(id);
    if (!existing) {
      throw new Error(`Goal ${id} not found`);
    }

    if (existing.status === "archived") {
      this.emit("goal:updated", existing);
      return existing;
    }

    const updated: Goal = {
      ...existing,
      status: "archived",
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare("UPDATE goals SET status = 'archived', updatedAt = ? WHERE id = ?")
      .run(updated.updatedAt, id);

    this.db.bumpLastModified();
    this.emit("goal:updated", updated);
    return updated;
  }

  public unarchiveGoal(id: string): Goal {
    const { goal, changed } = this.db.transactionImmediate(() => {
      const existing = this.getGoal(id);
      if (!existing) {
        throw new Error(`Goal ${id} not found`);
      }

      if (existing.status === "active") {
        return { goal: existing, changed: false };
      }

      const activeCountRow = this.db
        .prepare("SELECT COUNT(*) as count FROM goals WHERE status = 'active'")
        .get() as { count: number } | undefined;
      const currentActive = activeCountRow?.count ?? 0;

      if (currentActive >= ACTIVE_GOAL_LIMIT) {
        throw new ActiveGoalLimitExceededError(ACTIVE_GOAL_LIMIT, currentActive);
      }

      const updated: Goal = {
        ...existing,
        status: "active",
        updatedAt: new Date().toISOString(),
      };

      this.db
        .prepare("UPDATE goals SET status = 'active', updatedAt = ? WHERE id = ?")
        .run(updated.updatedAt, id);

      return { goal: updated, changed: true };
    });

    if (!changed) {
      return goal;
    }

    this.db.bumpLastModified();
    this.emit("goal:updated", goal);
    return goal;
  }

  public listGoals(filter?: GoalListFilter): Goal[] {
    const rows = filter?.status
      ? this.db
        .prepare("SELECT id, title, description, status, createdAt, updatedAt FROM goals WHERE status = ? ORDER BY createdAt ASC")
        .all(filter.status) as GoalRow[]
      : this.db
        .prepare("SELECT id, title, description, status, createdAt, updatedAt FROM goals ORDER BY createdAt ASC")
        .all() as GoalRow[];

    return rows.map((row) => this.toGoal(row));
  }

  public getGoal(id: string): Goal | null {
    const row = this.db
      .prepare("SELECT id, title, description, status, createdAt, updatedAt FROM goals WHERE id = ?")
      .get(id) as GoalRow | undefined;

    if (!row) {
      return null;
    }

    return this.toGoal(row);
  }

  private toGoal(row: GoalRow): Goal {
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private generateGoalId(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    this.idSequence += 1;
    const sequence = this.idSequence.toString(36).toUpperCase().padStart(4, "0");
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `G-${timestamp}-${sequence}-${random}`;
  }
}
