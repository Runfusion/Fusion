import { EventEmitter } from "node:events";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskUpdateInput,
  AutomationRunResult,
} from "./automation.js";
import { AUTOMATION_PRESETS, MAX_RUN_HISTORY } from "./automation.js";
import type { ScheduleType } from "./automation.js";
import { Database, fromJson } from "./db.js";
import { assertProjectRootDir } from "./project-root-guard.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
/*
 * FNXC:PhysicalDeleteSqliteClass 2026-06-26-14:00:
 * Async Drizzle helpers for backend-mode (PostgreSQL) AutomationStore operations.
 * These helpers target the project.automations table via Drizzle and are the
 * async equivalent of the sync this.db.prepare() call sites below. They are the
 * AutomationStore dual of the routine-store / plugin-store async helpers.
 */
import {
  upsertSchedule as upsertScheduleAsync,
  getSchedule as getScheduleAsync,
  listSchedules as listSchedulesAsync,
  deleteSchedule as deleteScheduleAsync,
  getDueSchedules as getDueSchedulesAsync,
  claimDueSchedule as claimDueScheduleAsync,
} from "./async-automation-store.js";

const CRON_TIMEZONE = "UTC";

export interface AutomationStoreEvents {
  "schedule:created": [schedule: ScheduledTask];
  "schedule:updated": [schedule: ScheduledTask];
  "schedule:deleted": [schedule: ScheduledTask];
  "schedule:run": [data: { schedule: ScheduledTask; result: AutomationRunResult }];
}

/**
 * FNXC:PhysicalDeleteSqliteClass 2026-06-26-14:00:
 * Construction options for AutomationStore. When `asyncLayer` is provided the
 * store operates in backend mode (PostgreSQL via Drizzle) and never constructs
 * a SQLite Database. This is the AutomationStore dual of RoutineStoreOptions /
 * PluginStoreOptions / AgentStoreOptions.
 */
export interface AutomationStoreOptions {
  asyncLayer?: AsyncDataLayer;
}

/** Database row shape for the automations table. */
interface ScheduleRow {
  id: string;
  name: string;
  description: string | null;
  scheduleType: string;
  cronExpression: string;
  command: string;
  enabled: number;
  timeoutMs: number | null;
  steps: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunResult: string | null;
  runCount: number;
  runHistory: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export class AutomationStore extends EventEmitter<AutomationStoreEvents> {
  /** Per-schedule promise chain for serializing writes. */
  private scheduleLocks: Map<string, Promise<void>> = new Map();
  /** SQLite database instance */
  private _db: Database | null = null;

  /**
   * FNXC:PhysicalDeleteSqliteClass 2026-06-26-14:00:
   * When an AsyncDataLayer is injected, AutomationStore operates in "backend
   * mode": all data access delegates to PostgreSQL via Drizzle and no SQLite
   * Database is constructed. When absent, the legacy SQLite path is
   * byte-identical to pre-migration. This mirrors the TaskStore/RoutineStore/
   * PluginStore/AgentStore dual-path pattern.
   */
  public readonly asyncLayer: AsyncDataLayer | null = null;

  /** True when AsyncDataLayer was injected. Gates all SQLite construction. */
  public get backendMode(): boolean {
    return this.asyncLayer !== null;
  }

  /**
   * FNXC:PhysicalDeleteSqliteClass 2026-06-26-14:00:
   * AutomationStore may receive an injected AsyncDataLayer so that production
   * construction sites (engine ProjectEngine, CLI dashboard) propagate the
   * backend mode from the owning TaskStore. The optional second arg preserves
   * the historical `new AutomationStore(rootDir)` call shape used by tests.
   */
  constructor(private rootDir: string, options?: AutomationStoreOptions) {
    super();
    assertProjectRootDir(rootDir, "AutomationStore");
    this.asyncLayer = options?.asyncLayer ?? null;
  }

  /**
   * Get the SQLite database, initializing it on first access.
   *
   * FNXC:PhysicalDeleteSqliteClass 2026-06-26-14:00:
   * Throws in backend mode (asyncLayer injected) — callers must branch on
   * backendMode and use the async helpers instead. This is the same guard the
   * other satellite stores (RoutineStore/PluginStore/AgentStore) use so that a
   * missed call site fails loudly instead of silently constructing a SQLite
   * file under backend mode.
   */
  private get db(): Database {
    if (this.backendMode) {
      throw new Error("SQLite Database is not available in backend mode (asyncLayer injected)");
    }
    if (!this._db) {
      const fusionDir = join(this.rootDir, ".fusion");
      this._db = new Database(fusionDir);
      this._db.init();
    }
    return this._db;
  }

  /**
   * Initialize the store.
   *
   * FNXC:PhysicalDeleteSqliteClass 2026-06-26-14:00:
   * In backend mode this is a no-op: the PostgreSQL schema baseline (applied
   * by the startup factory) already creates the automations table, so there is
   * no SQLite file to open or one-shot migration to run.
   */
  async init(): Promise<void> {
    if (this.backendMode) return;
    // Ensure DB is initialized
    const _ = this.db;
  }

  // ── Row Conversion ─────────────────────────────────────────────────

  private rowToSchedule(row: ScheduleRow): ScheduledTask {
    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      scheduleType: row.scheduleType as ScheduleType,
      cronExpression: row.cronExpression,
      command: row.command,
      enabled: row.enabled === 1,
      timeoutMs: row.timeoutMs ?? undefined,
      steps: fromJson<ScheduledTask["steps"]>(row.steps),
      nextRunAt: row.nextRunAt || undefined,
      lastRunAt: row.lastRunAt || undefined,
      lastRunResult: fromJson<AutomationRunResult>(row.lastRunResult),
      runCount: row.runCount || 0,
      runHistory: fromJson<AutomationRunResult[]>(row.runHistory) || [],
      scope: (row.scope as "global" | "project") || "project",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private upsertSchedule(schedule: ScheduledTask): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO automations (
        id, name, description, scheduleType, cronExpression, command,
        enabled, timeoutMs, steps, nextRunAt, lastRunAt, lastRunResult,
        runCount, runHistory, scope, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      schedule.id,
      schedule.name,
      schedule.description ?? null,
      schedule.scheduleType,
      schedule.cronExpression,
      schedule.command,
      schedule.enabled ? 1 : 0,
      schedule.timeoutMs ?? null,
      schedule.steps ? JSON.stringify(schedule.steps) : null,
      schedule.nextRunAt ?? null,
      schedule.lastRunAt ?? null,
      schedule.lastRunResult ? JSON.stringify(schedule.lastRunResult) : null,
      schedule.runCount || 0,
      JSON.stringify(schedule.runHistory || []),
      schedule.scope ?? "project",
      schedule.createdAt,
      schedule.updatedAt,
    );
  }

  // ── Locking ────────────────────────────────────────────────────────

  /**
   * Serialize all mutations to a given schedule by chaining promises.
   * Concurrent callers for the same ID will queue behind each other.
   */
  private withScheduleLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.scheduleLocks.get(id) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.scheduleLocks.set(id, next);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        if (this.scheduleLocks.get(id) === next) {
          this.scheduleLocks.delete(id);
        }
        resolve!();
      }
    });
  }

  // ── Persistence ────────────────────────────────────────────────────

  private async readScheduleJson(id: string): Promise<ScheduledTask> {
    if (this.backendMode) {
      return getScheduleAsync(this.asyncLayer!, id);
    }
    const row = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as unknown as ScheduleRow | undefined;
    if (!row) {
      throw Object.assign(new Error(`Schedule '${id}' not found`), { code: "ENOENT" });
    }
    return this.rowToSchedule(row);
  }

  private async persistSchedule(schedule: ScheduledTask): Promise<void> {
    if (this.backendMode) {
      await upsertScheduleAsync(this.asyncLayer!, schedule);
      return;
    }
    this.upsertSchedule(schedule);
    this.db.bumpLastModified();
  }

  // ── Cron Computation ───────────────────────────────────────────────

  /**
   * Compute the next run time from a cron expression.
   * @param cronExpression - A valid cron expression (5 fields).
   * @param fromDate - The date to compute from. Defaults to now.
   * @returns ISO-8601 timestamp of the next run.
   */
  computeNextRun(cronExpression: string, fromDate?: Date): string {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: fromDate ?? new Date(),
      tz: CRON_TIMEZONE,
    });
    const next = interval.next();
    return next.toISOString() ?? new Date(next.getTime()).toISOString();
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

  // ── CRUD ───────────────────────────────────────────────────────────

  async createSchedule(input: ScheduledTaskCreateInput): Promise<ScheduledTask> {
    if (!input.name?.trim()) {
      throw new Error("Name is required and cannot be empty");
    }
    const hasSteps = input.steps && input.steps.length > 0;
    if (!hasSteps && !input.command?.trim()) {
      throw new Error("Command is required and cannot be empty");
    }

    // Resolve cron expression
    let cronExpression: string;
    if (input.scheduleType === "custom") {
      if (!input.cronExpression?.trim()) {
        throw new Error("Cron expression is required for custom schedule type");
      }
      if (!AutomationStore.isValidCron(input.cronExpression)) {
        throw new Error(`Invalid cron expression: "${input.cronExpression}"`);
      }
      cronExpression = input.cronExpression.trim();
    } else {
      cronExpression = AUTOMATION_PRESETS[input.scheduleType];
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const enabled = input.enabled !== undefined ? input.enabled : true;

    const schedule: ScheduledTask = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      scheduleType: input.scheduleType,
      cronExpression,
      command: (input.command ?? "").trim(),
      enabled,
      runCount: 0,
      runHistory: [],
      timeoutMs: input.timeoutMs,
      steps: hasSteps ? input.steps : undefined,
      nextRunAt: enabled ? this.computeNextRun(cronExpression) : undefined,
      scope: input.scope ?? "project",
      createdAt: now,
      updatedAt: now,
    };

    await this.persistSchedule(schedule);
    this.emit("schedule:created", schedule);
    return schedule;
  }

  async getSchedule(id: string): Promise<ScheduledTask> {
    if (this.backendMode) {
      return getScheduleAsync(this.asyncLayer!, id);
    }
    return this.readScheduleJson(id);
  }

  async listSchedules(): Promise<ScheduledTask[]> {
    if (this.backendMode) {
      return listSchedulesAsync(this.asyncLayer!);
    }
    const rows = this.db.prepare('SELECT * FROM automations ORDER BY createdAt ASC').all() as unknown as ScheduleRow[];
    return rows.map((row) => this.rowToSchedule(row));
  }

  async updateSchedule(id: string, updates: ScheduledTaskUpdateInput): Promise<ScheduledTask> {
    return this.withScheduleLock(id, async () => {
      const schedule = await this.getSchedule(id);
      const previousEnabled = schedule.enabled;
      const previousScheduleType = schedule.scheduleType;
      const previousCronExpression = schedule.cronExpression;

      if (updates.name !== undefined) {
        if (!updates.name.trim()) throw new Error("Name cannot be empty");
        schedule.name = updates.name.trim();
      }
      if (updates.description !== undefined) {
        schedule.description = updates.description?.trim() || undefined;
      }
      if (updates.command !== undefined) {
        schedule.command = updates.command.trim();
      }
      if (updates.steps !== undefined) {
        schedule.steps = updates.steps.length > 0 ? updates.steps : undefined;
      }
      const willHaveSteps = schedule.steps && schedule.steps.length > 0;
      if (!willHaveSteps && !schedule.command) {
        throw new Error("Command is required and cannot be empty");
      }
      if (updates.timeoutMs !== undefined) {
        schedule.timeoutMs = updates.timeoutMs;
      }

      // Handle schedule type / cron changes
      if (updates.scheduleType !== undefined || updates.cronExpression !== undefined) {
        const newType = updates.scheduleType ?? schedule.scheduleType;
        let newCron: string;

        if (newType === "custom") {
          const customCron = updates.cronExpression ?? schedule.cronExpression;
          if (!customCron?.trim()) {
            throw new Error("Cron expression is required for custom schedule type");
          }
          if (!AutomationStore.isValidCron(customCron)) {
            throw new Error(`Invalid cron expression: "${customCron}"`);
          }
          newCron = customCron.trim();
        } else {
          newCron = AUTOMATION_PRESETS[newType as Exclude<ScheduleType, "custom">];
        }

        schedule.scheduleType = newType;
        schedule.cronExpression = newCron;
      }

      if (updates.enabled !== undefined) {
        schedule.enabled = updates.enabled;
      }

      const cadenceChanged =
        schedule.scheduleType !== previousScheduleType ||
        schedule.cronExpression !== previousCronExpression;
      const enabledFromDisabled = !previousEnabled && schedule.enabled;
      const missingNextRunAt = !schedule.nextRunAt;

      if (!schedule.enabled) {
        schedule.nextRunAt = undefined;
      } else if (cadenceChanged || enabledFromDisabled || missingNextRunAt) {
        schedule.nextRunAt = this.computeNextRun(schedule.cronExpression);
      }

      schedule.updatedAt = new Date().toISOString();
      await this.persistSchedule(schedule);
      this.emit("schedule:updated", schedule);
      return schedule;
    });
  }

  /**
   * Reorder the steps of a schedule by providing the step IDs in the desired order.
   * The `stepIds` array must contain exactly the same IDs as the current steps.
   */
  async reorderSteps(scheduleId: string, stepIds: string[]): Promise<ScheduledTask> {
    return this.withScheduleLock(scheduleId, async () => {
      const schedule = await this.getSchedule(scheduleId);
      if (!schedule.steps || schedule.steps.length === 0) {
        throw new Error("Schedule has no steps to reorder");
      }
      if (stepIds.length !== schedule.steps.length) {
        throw new Error(
          `Step ID count mismatch: expected ${schedule.steps.length}, got ${stepIds.length}`,
        );
      }

      const stepMap = new Map(schedule.steps.map((s) => [s.id, s]));
      const reordered = [];
      for (const id of stepIds) {
        const step = stepMap.get(id);
        if (!step) {
          throw new Error(`Unknown step ID: "${id}"`);
        }
        reordered.push(step);
      }

      schedule.steps = reordered;
      schedule.updatedAt = new Date().toISOString();
      await this.persistSchedule(schedule);
      this.emit("schedule:updated", schedule);
      return schedule;
    });
  }

  async deleteSchedule(id: string): Promise<ScheduledTask> {
    return this.withScheduleLock(id, async () => {
      const schedule = await this.getSchedule(id);
      if (this.backendMode) {
        await deleteScheduleAsync(this.asyncLayer!, id);
      } else {
        // Delete from SQLite
        this.db.prepare('DELETE FROM automations WHERE id = ?').run(id);
        this.db.bumpLastModified();
      }
      this.emit("schedule:deleted", schedule);
      return schedule;
    });
  }

  /**
   * Atomically claim one due schedule occurrence before execution.
   *
   * FNXC:Automations 2026-06-27-00:00:
   * Claiming advances nextRunAt before executing the schedule so concurrent CronRunner pollers, overlapping scopes, and separate engine processes sharing one database cannot double-fire the same due window. The conditional UPDATE is the cross-process claim boundary; losers observe zero changed rows and skip execution.
   *
   * FNXC:AutomationIsolation 2026-07-13-22:37:
   * In PostgreSQL mode both the preliminary read and conditional claim use the bound AsyncDataLayer so a duplicate automation ID in another project cannot be observed or advanced.
   */
  async claimDueSchedule(id: string, expectedNextRunAt: string): Promise<boolean> {
    return this.withScheduleLock(id, async () => {
      if (this.backendMode) {
        const schedule = await getScheduleAsync(this.asyncLayer!, id).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (!schedule?.enabled || !schedule.nextRunAt) return false;
        return claimDueScheduleAsync(
          this.asyncLayer!,
          id,
          expectedNextRunAt,
          this.computeNextRun(schedule.cronExpression),
          new Date().toISOString(),
        );
      }

      const row = this.db.prepare(
        'SELECT id, cronExpression, enabled, nextRunAt FROM automations WHERE id = ?',
      ).get(id) as unknown as Pick<ScheduleRow, "id" | "cronExpression" | "enabled" | "nextRunAt"> | undefined;

      if (!row || row.enabled !== 1 || !row.nextRunAt) {
        return false;
      }

      const nextRunAt = this.computeNextRun(row.cronExpression);
      const updatedAt = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE automations
        SET nextRunAt = ?, updatedAt = ?
        WHERE id = ? AND enabled = 1 AND nextRunAt = ?
      `).run(nextRunAt, updatedAt, id, expectedNextRunAt);

      const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
      if (changes === 1) {
        this.db.bumpLastModified();
        return true;
      }
      return false;
    });
  }

  /**
   * Record a run result for a schedule. Updates lastRunAt, lastRunResult,
   * nextRunAt, runCount, and appends to runHistory.
   */
  async recordRun(id: string, result: AutomationRunResult): Promise<ScheduledTask> {
    return this.withScheduleLock(id, async () => {
      const schedule = await this.getSchedule(id);

      schedule.lastRunAt = result.startedAt;
      schedule.lastRunResult = result;
      schedule.runCount += 1;

      // Prepend to history (most recent first), cap at MAX_RUN_HISTORY
      schedule.runHistory.unshift(result);
      if (schedule.runHistory.length > MAX_RUN_HISTORY) {
        schedule.runHistory = schedule.runHistory.slice(0, MAX_RUN_HISTORY);
      }

      // Recompute next run
      if (schedule.enabled) {
        schedule.nextRunAt = this.computeNextRun(schedule.cronExpression);
      }

      schedule.updatedAt = new Date().toISOString();
      await this.persistSchedule(schedule);
      this.emit("schedule:run", { schedule, result });
      return schedule;
    });
  }

  /**
   * Get all schedules that are due to run (nextRunAt <= now and enabled).
   * Filters by scope: "global" or "project".
   */
  async getDueSchedules(scope: "global" | "project"): Promise<ScheduledTask[]> {
    const now = new Date().toISOString();
    if (this.backendMode) {
      return getDueSchedulesAsync(this.asyncLayer!, now, scope);
    }
    const rows = this.db.prepare(
      'SELECT * FROM automations WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ? AND scope = ?'
    ).all(now, scope) as unknown as ScheduleRow[];
    return rows.map((row) => this.rowToSchedule(row));
  }

  /**
   * Get all schedules that are due to run (nextRunAt <= now and enabled) for both scopes.
   * Returns schedules from both "global" and "project" scopes.
   */
  async getDueSchedulesAllScopes(): Promise<ScheduledTask[]> {
    const now = new Date().toISOString();
    if (this.backendMode) {
      return getDueSchedulesAsync(this.asyncLayer!, now);
    }
    const rows = this.db.prepare(
      'SELECT * FROM automations WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ?'
    ).all(now) as unknown as ScheduleRow[];
    return rows.map((row) => this.rowToSchedule(row));
  }
}
