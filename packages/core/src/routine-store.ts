/**
 * RoutineStore: SQLite-backed store for Routine CRUD, run tracking, and due queries.
 *
 * Follows the AutomationStore pattern with:
 * - Lazy DB initialization
 * - Per-routine mutation locking via promise chains
 * - Typed EventEmitter lifecycle events
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { Database, toJson, fromJson } from "./db.js";
import {
  isCronTrigger,
  type Routine,
  type RoutineTrigger,
  type RoutineCreateInput,
  type RoutineUpdateInput,
  type RoutineExecutionResult,
  type RoutineTriggerType,
  type RoutineCronTrigger,
  type RoutineWebhookTrigger,
  type RoutineApiTrigger,
  type RoutineManualTrigger,
  MAX_ROUTINE_RUN_HISTORY,
} from "./routine.js";

export interface RoutineStoreEvents {
  "routine:created": [routine: Routine];
  "routine:updated": [routine: Routine];
  "routine:deleted": [routine: Routine];
  "routine:run": [data: { routine: Routine; result: RoutineExecutionResult }];
}

export class RoutineStore extends EventEmitter<RoutineStoreEvents> {
  /** SQLite database instance (lazy init). */
  private _db: Database | null = null;

  /** Per-routine promise chain for serializing writes. */
  private routineLocks: Map<string, Promise<void>> = new Map();

  constructor(private rootDir: string) {
    super();
  }

  // ── Database Access ────────────────────────────────────────────────

  /**
   * Get the SQLite database, initializing it on first access.
   */
  private get db(): Database {
    if (!this._db) {
      const kbDir = `${this.rootDir}/.fusion`;
      this._db = new Database(kbDir);
      this._db.init();
    }
    return this._db;
  }

  /** Initialize the store (no-op, DB is lazily initialized). */
  async init(): Promise<void> {
    // Trigger lazy init
    const _ = this.db;
  }

  // ── Row Conversion ─────────────────────────────────────────────────

  private rowToRoutine(row: any): Routine {
    const triggerConfig = fromJson<{
      cronExpression?: string;
      timezone?: string;
      webhookPath?: string;
      secret?: string;
      endpoint?: string;
    }>(row.triggerConfig);

    let trigger: RoutineTrigger;
    switch (row.triggerType as RoutineTriggerType) {
      case "cron":
        trigger = {
          type: "cron",
          cronExpression: triggerConfig?.cronExpression ?? "0 * * * *",
          timezone: triggerConfig?.timezone,
        } as RoutineCronTrigger;
        break;
      case "webhook":
        trigger = {
          type: "webhook",
          webhookPath: triggerConfig?.webhookPath ?? "",
          secret: triggerConfig?.secret,
        } as RoutineWebhookTrigger;
        break;
      case "api":
        trigger = {
          type: "api",
          endpoint: triggerConfig?.endpoint ?? "",
        } as RoutineApiTrigger;
        break;
      case "manual":
      default:
        trigger = { type: "manual" } as RoutineManualTrigger;
        break;
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      trigger,
      catchUpPolicy: (row.catchUpPolicy as Routine["catchUpPolicy"]) || "run_one",
      executionPolicy: (row.executionPolicy as Routine["executionPolicy"]) || "queue",
      enabled: row.enabled === 1,
      lastRunAt: row.lastRunAt || undefined,
      lastRunResult: fromJson<RoutineExecutionResult>(row.lastRunResult),
      nextRunAt: row.nextRunAt || undefined,
      runCount: row.runCount || 0,
      runHistory: fromJson<RoutineExecutionResult[]>(row.runHistory) || [],
      cronExpression: isCronTrigger(trigger) ? trigger.cronExpression : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private upsertRoutine(routine: Routine): void {
    const trigger = routine.trigger;
    let triggerConfig: Record<string, unknown> = {};

    if (isCronTrigger(trigger)) {
      triggerConfig = {
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
      };
    } else if (trigger.type === "webhook") {
      triggerConfig = {
        webhookPath: trigger.webhookPath,
        secret: trigger.secret,
      };
    } else if (trigger.type === "api") {
      triggerConfig = {
        endpoint: trigger.endpoint,
      };
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO routines (
        id, name, description, triggerType, triggerConfig,
        catchUpPolicy, executionPolicy, enabled,
        lastRunAt, lastRunResult, nextRunAt,
        runCount, runHistory, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      routine.id,
      routine.name,
      routine.description ?? null,
      trigger.type,
      JSON.stringify(triggerConfig),
      routine.catchUpPolicy,
      routine.executionPolicy,
      routine.enabled ? 1 : 0,
      routine.lastRunAt ?? null,
      routine.lastRunResult ? JSON.stringify(routine.lastRunResult) : null,
      routine.nextRunAt ?? null,
      routine.runCount || 0,
      JSON.stringify(routine.runHistory || []),
      routine.createdAt,
      routine.updatedAt,
    );
    this.db.bumpLastModified();
  }

  // ── Locking ───────────────────────────────────────────────────────

  /**
   * Serialize all mutations to a given routine by chaining promises.
   * Concurrent callers for the same ID will queue behind each other.
   */
  private withRoutineLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.routineLocks.get(id) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.routineLocks.set(id, next);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        if (this.routineLocks.get(id) === next) {
          this.routineLocks.delete(id);
        }
        resolve!();
      }
    });
  }

  // ── Cron Utilities ────────────────────────────────────────────────

  /**
   * Compute the next run time from a cron expression.
   * @param cronExpression - A valid cron expression (5 fields).
   * @param fromDate - The date to compute from. Defaults to now.
   * @returns ISO-8601 timestamp of the next run.
   */
  computeNextRun(cronExpression: string, fromDate?: Date): string {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: fromDate ?? new Date(),
    });
    const next = interval.next();
    return new Date(next.getTime()).toISOString();
  }

  /**
   * Validate a cron expression. Returns true if valid.
   */
  static isValidCron(cronExpression: string): boolean {
    try {
      CronExpressionParser.parse(cronExpression);
      return true;
    } catch {
      return false;
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  /**
   * Create a new routine.
   */
  async createRoutine(input: RoutineCreateInput): Promise<Routine> {
    if (!input.name?.trim()) {
      throw new Error("Name is required and cannot be empty");
    }

    // Validate cron expression if cron trigger
    if (isCronTrigger(input.trigger)) {
      if (!RoutineStore.isValidCron(input.trigger.cronExpression)) {
        throw new Error(`Invalid cron expression: "${input.trigger.cronExpression}"`);
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const enabled = input.enabled !== undefined ? input.enabled : true;

    const routine: Routine = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      trigger: input.trigger,
      catchUpPolicy: input.catchUpPolicy ?? "run_one",
      executionPolicy: input.executionPolicy ?? "queue",
      enabled,
      runCount: 0,
      runHistory: [],
      createdAt: now,
      updatedAt: now,
    };

    // Compute nextRunAt for enabled cron routines
    if (enabled && isCronTrigger(routine.trigger)) {
      routine.nextRunAt = this.computeNextRun(routine.trigger.cronExpression);
    }

    this.upsertRoutine(routine);
    this.emit("routine:created", routine);
    return routine;
  }

  /**
   * Get a routine by ID.
   */
  async getRoutine(id: string): Promise<Routine> {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as any;
    if (!row) {
      throw Object.assign(new Error(`Routine '${id}' not found`), { code: "ENOENT" });
    }
    return this.rowToRoutine(row);
  }

  /**
   * List all routines.
   */
  async listRoutines(): Promise<Routine[]> {
    const rows = this.db.prepare("SELECT * FROM routines ORDER BY createdAt ASC").all() as any[];
    return rows.map((row) => this.rowToRoutine(row));
  }

  /**
   * Update an existing routine.
   */
  async updateRoutine(id: string, updates: RoutineUpdateInput): Promise<Routine> {
    return this.withRoutineLock(id, async () => {
      const routine = await this.getRoutine(id);

      if (updates.name !== undefined) {
        if (!updates.name.trim()) throw new Error("Name cannot be empty");
        routine.name = updates.name.trim();
      }
      if (updates.description !== undefined) {
        routine.description = updates.description?.trim() || undefined;
      }
      if (updates.trigger !== undefined) {
        // Validate cron if switching to cron
        if (isCronTrigger(updates.trigger)) {
          if (!RoutineStore.isValidCron(updates.trigger.cronExpression)) {
            throw new Error(`Invalid cron expression: "${updates.trigger.cronExpression}"`);
          }
        }
        routine.trigger = updates.trigger;
      }
      if (updates.catchUpPolicy !== undefined) {
        routine.catchUpPolicy = updates.catchUpPolicy;
      }
      if (updates.executionPolicy !== undefined) {
        routine.executionPolicy = updates.executionPolicy;
      }
      if (updates.enabled !== undefined) {
        routine.enabled = updates.enabled;
      }

      // Recompute nextRunAt if enabled and cron trigger
      if (routine.enabled && isCronTrigger(routine.trigger)) {
        routine.nextRunAt = this.computeNextRun(routine.trigger.cronExpression);
      } else if (!routine.enabled || !isCronTrigger(routine.trigger)) {
        routine.nextRunAt = undefined;
      }

      routine.updatedAt = new Date().toISOString();
      this.upsertRoutine(routine);
      this.emit("routine:updated", routine);
      return routine;
    });
  }

  /**
   * Delete a routine.
   */
  async deleteRoutine(id: string): Promise<Routine> {
    return this.withRoutineLock(id, async () => {
      const routine = await this.getRoutine(id);
      this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
      this.db.bumpLastModified();
      this.emit("routine:deleted", routine);
      return routine;
    });
  }

  // ── Run Tracking ─────────────────────────────────────────────────

  /**
   * Record a run result for a routine. Updates lastRunAt, lastRunResult,
   * nextRunAt, runCount, and appends to runHistory.
   */
  async recordRun(id: string, result: RoutineExecutionResult): Promise<Routine> {
    return this.withRoutineLock(id, async () => {
      const routine = await this.getRoutine(id);

      routine.lastRunAt = result.startedAt;
      routine.lastRunResult = result;
      routine.runCount += 1;

      // Prepend to history (most recent first), cap at MAX_ROUTINE_RUN_HISTORY
      routine.runHistory.unshift(result);
      if (routine.runHistory.length > MAX_ROUTINE_RUN_HISTORY) {
        routine.runHistory = routine.runHistory.slice(0, MAX_ROUTINE_RUN_HISTORY);
      }

      // Recompute next run if enabled and cron trigger
      if (routine.enabled && isCronTrigger(routine.trigger)) {
        routine.nextRunAt = this.computeNextRun(routine.trigger.cronExpression);
      }

      routine.updatedAt = new Date().toISOString();
      this.upsertRoutine(routine);
      this.emit("routine:run", { routine, result });
      return routine;
    });
  }

  /**
   * Get all routines that are due to run (nextRunAt <= now and enabled).
   */
  async getDueRoutines(): Promise<Routine[]> {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      "SELECT * FROM routines WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ?"
    ).all(now) as any[];
    return rows.map((row) => this.rowToRoutine(row));
  }
}
