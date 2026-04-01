/**
 * CentralCore — Main API for kb's multi-project central infrastructure.
 *
 * Provides project registry, health tracking, unified activity feed,
 * and global concurrency management across all registered projects.
 *
 * The central database is located at `~/.pi/kb/kb-central.db`.
 *
 * @example
 * ```typescript
 * const central = new CentralCore();
 * await central.init();
 *
 * // Register a project
 * const project = await central.registerProject({
 *   name: "My Project",
 *   path: "/path/to/project"
 * });
 *
 * // Log activity
 * await central.logActivity({
 *   type: "task:created",
 *   projectId: project.id,
 *   projectName: project.name,
 *   details: "Task KB-001 created"
 * });
 * ```
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, basename, resolve } from "node:path";
import type {
  RegisteredProject,
  ProjectHealth,
  CentralActivityLogEntry,
  GlobalConcurrencyState,
  IsolationMode,
  ProjectStatus,
  ActivityEventType,
  ProjectSettings,
} from "./types.js";
import { CentralDatabase, toJson, toJsonNullable, fromJson } from "./central-db.js";
import { defaultGlobalDir } from "./global-settings.js";

// ── Event Types ───────────────────────────────────────────────────────────

export interface CentralCoreEvents {
  /** Emitted when a new project is registered */
  "project:registered": [project: RegisteredProject];
  /** Emitted when a project is unregistered */
  "project:unregistered": [projectId: string];
  /** Emitted when project metadata is updated */
  "project:updated": [project: RegisteredProject];
  /** Emitted when project health metrics change */
  "project:health:changed": [health: ProjectHealth];
  /** Emitted when a new activity is logged */
  "activity:logged": [entry: CentralActivityLogEntry];
  /** Emitted when global concurrency state changes */
  "concurrency:changed": [state: GlobalConcurrencyState];
}

// ── CentralCore Class ─────────────────────────────────────────────────────

export class CentralCore extends EventEmitter<CentralCoreEvents> {
  private db: CentralDatabase | null = null;
  private readonly globalDir: string;
  private initialized = false;

  /**
   * Create a CentralCore instance.
   * @param globalDir — Directory for central database. Defaults to `~/.pi/kb/`.
   *                  Accepts a custom path for testing.
   */
  constructor(globalDir?: string) {
    super();
    this.setMaxListeners(100);
    this.globalDir = globalDir ?? defaultGlobalDir();
  }

  /**
   * Initialize the central infrastructure.
   * Ensures the directory and database exist with proper schema.
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Ensure directory exists
    await mkdir(this.globalDir, { recursive: true });

    // Initialize database
    if (!this.db) {
      this.db = new CentralDatabase(this.globalDir);
      this.db.init();
    }

    this.initialized = true;
  }

  /**
   * Close the central infrastructure.
   * Closes database connections and releases resources.
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
    this.removeAllListeners();
  }

  /**
   * Check if the central infrastructure is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ── Project Registry API ────────────────────────────────────────────────

  /**
   * Register a new project in the central database.
   *
   * @param input — Project registration input
   * @returns The registered project
   * @throws Error if path doesn't exist, isn't absolute, or is already registered
   */
  async registerProject(input: {
    name: string;
    path: string;
    isolationMode?: IsolationMode;
    settings?: ProjectSettings;
  }): Promise<RegisteredProject> {
    this.ensureInitialized();

    // Validate path
    if (!isAbsolute(input.path)) {
      throw new Error(`Project path must be absolute: ${input.path}`);
    }
    if (!existsSync(input.path)) {
      throw new Error(`Project path does not exist: ${input.path}`);
    }
    if (!statSync(input.path).isDirectory()) {
      throw new Error(`Project path must be a directory: ${input.path}`);
    }

    // Check for duplicate path
    const existingByPath = await this.getProjectByPath(input.path);
    if (existingByPath) {
      throw new Error(`Project already registered at path: ${input.path}`);
    }

    const now = new Date().toISOString();
    const project: RegisteredProject = {
      id: `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name: input.name,
      path: input.path,
      status: "initializing",
      isolationMode: input.isolationMode ?? "in-process",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      settings: input.settings,
    };

    this.db!.transaction(() => {
      // Insert project
      this.db!.prepare(
        `INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt, lastActivityAt, settings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        project.id,
        project.name,
        project.path,
        project.status,
        project.isolationMode,
        project.createdAt,
        project.updatedAt,
        project.lastActivityAt ?? null,
        toJsonNullable(project.settings)
      );

      // Initialize health record
      this.db!.prepare(
        `INSERT INTO projectHealth (projectId, status, updatedAt, totalTasksCompleted, totalTasksFailed)
         VALUES (?, ?, ?, 0, 0)`
      ).run(project.id, project.status, now);
    });

    this.db!.bumpLastModified();
    this.emit("project:registered", project);
    return project;
  }

  /**
   * Unregister a project from the central database.
   * Cascades to delete health records and activity log entries.
   *
   * @param id — Project ID to unregister
   */
  async unregisterProject(id: string): Promise<void> {
    this.ensureInitialized();

    // Check if project exists
    const project = await this.getProject(id);
    if (!project) {
      return; // Idempotent
    }

    // Delete will cascade to health and activity log
    this.db!.prepare("DELETE FROM projects WHERE id = ?").run(id);
    this.db!.bumpLastModified();

    this.emit("project:unregistered", id);
  }

  /**
   * Get a registered project by ID.
   *
   * @param id — Project ID
   * @returns The project or undefined if not found
   */
  async getProject(id: string): Promise<RegisteredProject | undefined> {
    this.ensureInitialized();

    const row = this.db!.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | {
          id: string;
          name: string;
          path: string;
          status: string;
          isolationMode: string;
          createdAt: string;
          updatedAt: string;
          lastActivityAt: string | null;
          settings: string | null;
        }
      | undefined;

    if (!row) return undefined;

    return this.rowToProject(row);
  }

  /**
   * Get a registered project by path.
   *
   * @param path — Absolute project path
   * @returns The project or undefined if not found
   */
  async getProjectByPath(path: string): Promise<RegisteredProject | undefined> {
    this.ensureInitialized();

    const row = this.db!.prepare("SELECT * FROM projects WHERE path = ?").get(path) as
      | {
          id: string;
          name: string;
          path: string;
          status: string;
          isolationMode: string;
          createdAt: string;
          updatedAt: string;
          lastActivityAt: string | null;
          settings: string | null;
        }
      | undefined;

    if (!row) return undefined;

    return this.rowToProject(row);
  }

  /**
   * List all registered projects.
   *
   * @returns Array of all registered projects
   */
  async listProjects(): Promise<RegisteredProject[]> {
    this.ensureInitialized();

    const rows = this.db!.prepare("SELECT * FROM projects ORDER BY name").all() as Array<{
      id: string;
      name: string;
      path: string;
      status: string;
      isolationMode: string;
      createdAt: string;
      updatedAt: string;
      lastActivityAt: string | null;
      settings: string | null;
    }>;

    return rows.map((row) => this.rowToProject(row));
  }

  /**
   * Update a registered project's metadata.
   *
   * @param id — Project ID to update
   * @param updates — Partial project updates (id, createdAt cannot be changed)
   * @returns Updated project
   * @throws Error if project not found
   */
  async updateProject(
    id: string,
    updates: Partial<Omit<RegisteredProject, "id" | "createdAt">>
  ): Promise<RegisteredProject> {
    this.ensureInitialized();

    const project = await this.getProject(id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }

    const now = new Date().toISOString();
    const updated: RegisteredProject = {
      ...project,
      ...updates,
      id, // Ensure ID doesn't change
      createdAt: project.createdAt, // Ensure createdAt doesn't change
      updatedAt: now,
    };

    this.db!.prepare(
      `UPDATE projects SET
        name = ?,
        path = ?,
        status = ?,
        isolationMode = ?,
        updatedAt = ?,
        lastActivityAt = ?,
        settings = ?
       WHERE id = ?`
    ).run(
      updated.name,
      updated.path,
      updated.status,
      updated.isolationMode,
      updated.updatedAt,
      updated.lastActivityAt ?? null,
      toJsonNullable(updated.settings),
      id
    );

    this.db!.bumpLastModified();
    this.emit("project:updated", updated);
    return updated;
  }

  // ── Project Health API ──────────────────────────────────────────────────

  /**
   * Update project health metrics.
   *
   * @param projectId — Project ID
   * @param updates — Partial health updates
   * @returns Updated health metrics
   */
  async updateProjectHealth(
    projectId: string,
    updates: Partial<ProjectHealth>
  ): Promise<ProjectHealth> {
    this.ensureInitialized();

    const current = await this.getProjectHealth(projectId);
    if (!current) {
      throw new Error(`Project health not found for: ${projectId}`);
    }

    const now = new Date().toISOString();
    const updated: ProjectHealth = {
      ...current,
      ...updates,
      projectId, // Ensure projectId doesn't change
      updatedAt: now,
    };

    this.db!.prepare(
      `UPDATE projectHealth SET
        status = ?,
        activeTaskCount = ?,
        inFlightAgentCount = ?,
        lastActivityAt = ?,
        lastErrorAt = ?,
        lastErrorMessage = ?,
        totalTasksCompleted = ?,
        totalTasksFailed = ?,
        averageTaskDurationMs = ?,
        updatedAt = ?
       WHERE projectId = ?`
    ).run(
      updated.status,
      updated.activeTaskCount,
      updated.inFlightAgentCount,
      updated.lastActivityAt ?? null,
      updated.lastErrorAt ?? null,
      updated.lastErrorMessage ?? null,
      updated.totalTasksCompleted,
      updated.totalTasksFailed,
      updated.averageTaskDurationMs ?? null,
      updated.updatedAt,
      projectId
    );

    this.emit("project:health:changed", updated);
    return updated;
  }

  /**
   * Get project health metrics.
   *
   * @param projectId — Project ID
   * @returns Health metrics or undefined if not found
   */
  async getProjectHealth(projectId: string): Promise<ProjectHealth | undefined> {
    this.ensureInitialized();

    const row = this.db!.prepare("SELECT * FROM projectHealth WHERE projectId = ?").get(projectId) as
      | {
          projectId: string;
          status: string;
          activeTaskCount: number;
          inFlightAgentCount: number;
          lastActivityAt: string | null;
          lastErrorAt: string | null;
          lastErrorMessage: string | null;
          totalTasksCompleted: number;
          totalTasksFailed: number;
          averageTaskDurationMs: number | null;
          updatedAt: string;
        }
      | undefined;

    if (!row) return undefined;

    return this.rowToHealth(row);
  }

  /**
   * List health metrics for all projects.
   *
   * @returns Array of all project health metrics
   */
  async listAllHealth(): Promise<ProjectHealth[]> {
    this.ensureInitialized();

    const rows = this.db!.prepare("SELECT * FROM projectHealth").all() as Array<{
      projectId: string;
      status: string;
      activeTaskCount: number;
      inFlightAgentCount: number;
      lastActivityAt: string | null;
      lastErrorAt: string | null;
      lastErrorMessage: string | null;
      totalTasksCompleted: number;
      totalTasksFailed: number;
      averageTaskDurationMs: number | null;
      updatedAt: string;
    }>;

    return rows.map((row) => this.rowToHealth(row));
  }

  /**
   * Record a task completion/failure for health tracking.
   * Atomically updates counters and rolling average duration.
   *
   * @param projectId — Project ID
   * @param durationMs — Task duration in milliseconds
   * @param success — Whether the task completed successfully
   */
  async recordTaskCompletion(projectId: string, durationMs: number, success: boolean): Promise<void> {
    this.ensureInitialized();

    const health = await this.getProjectHealth(projectId);
    if (!health) {
      throw new Error(`Project health not found for: ${projectId}`);
    }

    const now = new Date().toISOString();
    const totalCompleted = health.totalTasksCompleted + (success ? 1 : 0);
    const totalFailed = health.totalTasksFailed + (success ? 0 : 1);

    // Calculate rolling average duration
    let averageDuration: number | undefined;
    if (success) {
      const currentAvg = health.averageTaskDurationMs ?? 0;
      const newCount = totalCompleted;
      // Rolling average: newAvg = (oldAvg * (n-1) + newValue) / n
      averageDuration = Math.round((currentAvg * (newCount - 1) + durationMs) / newCount);
    } else {
      averageDuration = health.averageTaskDurationMs;
    }

    this.db!.prepare(
      `UPDATE projectHealth SET
        totalTasksCompleted = ?,
        totalTasksFailed = ?,
        averageTaskDurationMs = ?,
        lastActivityAt = ?,
        updatedAt = ?
       WHERE projectId = ?`
    ).run(totalCompleted, totalFailed, averageDuration ?? null, now, now, projectId);

    const updated = await this.getProjectHealth(projectId);
    if (updated) {
      this.emit("project:health:changed", updated);
    }
  }

  // ── Unified Activity Feed API ───────────────────────────────────────────

  /**
   * Log an activity to the unified central feed.
   * Also updates the project's lastActivityAt timestamp.
   *
   * @param entry — Activity entry (without id - will be generated)
   * @returns The logged entry with generated id
   */
  async logActivity(
    entry: Omit<CentralActivityLogEntry, "id">
  ): Promise<CentralActivityLogEntry> {
    this.ensureInitialized();

    const fullEntry: CentralActivityLogEntry = {
      ...entry,
      id: randomUUID(),
    };

    this.db!.transaction(() => {
      // Insert activity log entry
      this.db!.prepare(
        `INSERT INTO centralActivityLog (id, timestamp, type, projectId, projectName, taskId, taskTitle, details, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        fullEntry.id,
        fullEntry.timestamp,
        fullEntry.type,
        fullEntry.projectId,
        fullEntry.projectName,
        fullEntry.taskId ?? null,
        fullEntry.taskTitle ?? null,
        fullEntry.details,
        toJsonNullable(fullEntry.metadata)
      );

      // Update project's lastActivityAt
      this.db!.prepare("UPDATE projects SET lastActivityAt = ? WHERE id = ?").run(
        fullEntry.timestamp,
        fullEntry.projectId
      );
    });

    this.db!.bumpLastModified();
    this.emit("activity:logged", fullEntry);
    return fullEntry;
  }

  /**
   * Get recent activity from the unified feed.
   *
   * @param options — Query options (limit, projectId filter, type filter)
   * @returns Array of activity entries, newest first
   */
  async getRecentActivity(options?: {
    limit?: number;
    projectId?: string;
    types?: ActivityEventType[];
  }): Promise<CentralActivityLogEntry[]> {
    this.ensureInitialized();

    const limit = options?.limit ?? 100;
    const conditions: string[] = [];
    const params: (string | number | string[])[] = [limit];

    if (options?.projectId) {
      conditions.push("projectId = ?");
      params.unshift(options.projectId);
    }

    if (options?.types && options.types.length > 0) {
      conditions.push(`type IN (${options.types.map(() => "?").join(",")})`);
      params.unshift(...options.types);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Reorder params: types first, then projectId, then limit
    const queryParams: (string | number)[] = [];
    if (options?.types) queryParams.push(...options.types);
    if (options?.projectId) queryParams.push(options.projectId);
    queryParams.push(limit);

    const sql = `SELECT * FROM centralActivityLog ${whereClause} ORDER BY timestamp DESC LIMIT ?`;
    const rows = this.db!.prepare(sql).all(...queryParams) as Array<{
      id: string;
      timestamp: string;
      type: string;
      projectId: string;
      projectName: string;
      taskId: string | null;
      taskTitle: string | null;
      details: string;
      metadata: string | null;
    }>;

    return rows.map((row) => this.rowToActivityEntry(row));
  }

  /**
   * Get the total count of activity log entries.
   *
   * @param projectId — Optional project filter
   * @returns Count of entries
   */
  async getActivityCount(projectId?: string): Promise<number> {
    this.ensureInitialized();

    let sql = "SELECT COUNT(*) as count FROM centralActivityLog";
    const params: string[] = [];

    if (projectId) {
      sql += " WHERE projectId = ?";
      params.push(projectId);
    }

    const row = this.db!.prepare(sql).get(...params) as { count: number };
    return row.count;
  }

  /**
   * Clean up old activity log entries.
   *
   * @param olderThanDays — Delete entries older than this many days
   * @returns Number of entries deleted
   */
  async cleanupOldActivity(olderThanDays: number): Promise<number> {
    this.ensureInitialized();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const cutoff = cutoffDate.toISOString();

    const result = this.db!.prepare("DELETE FROM centralActivityLog WHERE timestamp < ?").run(cutoff);
    const deletedCount = typeof result.changes === "bigint" ? Number(result.changes) : (result.changes ?? 0);

    if (deletedCount > 0) {
      this.db!.bumpLastModified();
    }

    return deletedCount;
  }

  // ── Global Concurrency API ─────────────────────────────────────────────

  /**
   * Get the current global concurrency state.
   *
   * @returns Current concurrency state including per-project active counts
   */
  async getGlobalConcurrencyState(): Promise<GlobalConcurrencyState> {
    this.ensureInitialized();

    const row = this.db!.prepare("SELECT * FROM globalConcurrency WHERE id = 1").get() as {
      globalMaxConcurrent: number;
      currentlyActive: number;
      queuedCount: number;
    };

    // Calculate per-project active counts
    const healthRows = this.db!.prepare(
      "SELECT projectId, inFlightAgentCount FROM projectHealth WHERE inFlightAgentCount > 0"
    ).all() as Array<{ projectId: string; inFlightAgentCount: number }>;

    const projectsActive: Record<string, number> = {};
    for (const { projectId, inFlightAgentCount } of healthRows) {
      projectsActive[projectId] = inFlightAgentCount;
    }

    return {
      globalMaxConcurrent: row.globalMaxConcurrent,
      currentlyActive: row.currentlyActive,
      queuedCount: row.queuedCount,
      projectsActive,
    };
  }

  /**
   * Update global concurrency settings.
   * Only allows updating globalMaxConcurrent, currentlyActive, and queuedCount.
   *
   * @param updates — Partial concurrency state updates
   * @returns Updated concurrency state
   */
  async updateGlobalConcurrency(
    updates: Partial<Pick<GlobalConcurrencyState, "globalMaxConcurrent" | "currentlyActive" | "queuedCount">>
  ): Promise<GlobalConcurrencyState> {
    this.ensureInitialized();

    const current = await this.getGlobalConcurrencyState();
    const updated = {
      ...current,
      ...updates,
    };

    this.db!.prepare(
      `UPDATE globalConcurrency SET
        globalMaxConcurrent = ?,
        currentlyActive = ?,
        queuedCount = ?,
        updatedAt = ?
       WHERE id = 1`
    ).run(
      updated.globalMaxConcurrent,
      updated.currentlyActive,
      updated.queuedCount,
      new Date().toISOString()
    );

    this.emit("concurrency:changed", updated);
    return updated;
  }

  /**
   * Acquire a global concurrency slot.
   * Atomically checks if a slot is available and acquires it if so.
   *
   * @param projectId — Project requesting the slot
   * @returns true if slot acquired, false if at limit (queued)
   */
  async acquireGlobalSlot(projectId: string): Promise<boolean> {
    this.ensureInitialized();

    // Check if project exists
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    let acquired = false;

    this.db!.transaction(() => {
      const row = this.db!.prepare("SELECT * FROM globalConcurrency WHERE id = 1").get() as {
        globalMaxConcurrent: number;
        currentlyActive: number;
        queuedCount: number;
      };

      if (row.currentlyActive < row.globalMaxConcurrent) {
        // Acquire slot
        this.db!.prepare(
          "UPDATE globalConcurrency SET currentlyActive = currentlyActive + 1, updatedAt = ? WHERE id = 1"
        ).run(new Date().toISOString());

        // Increment project's active count
        this.db!.prepare(
          "UPDATE projectHealth SET inFlightAgentCount = inFlightAgentCount + 1, updatedAt = ? WHERE projectId = ?"
        ).run(new Date().toISOString(), projectId);

        acquired = true;
      } else {
        // Queue the request
        this.db!.prepare(
          "UPDATE globalConcurrency SET queuedCount = queuedCount + 1, updatedAt = ? WHERE id = 1"
        ).run(new Date().toISOString());

        acquired = false;
      }
    });

    const state = await this.getGlobalConcurrencyState();
    this.emit("concurrency:changed", state);
    return acquired;
  }

  /**
   * Release a global concurrency slot.
   * Decrements the global active count and project's active count.
   *
   * @param projectId — Project releasing the slot
   */
  async releaseGlobalSlot(projectId: string): Promise<void> {
    this.ensureInitialized();

    // Check if project exists
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    this.db!.transaction(() => {
      // Decrement global active count (don't go below 0)
      this.db!.prepare(
        `UPDATE globalConcurrency SET
          currentlyActive = MAX(0, currentlyActive - 1),
          updatedAt = ?
         WHERE id = 1`
      ).run(new Date().toISOString());

      // Decrement project's active count (don't go below 0)
      this.db!.prepare(
        `UPDATE projectHealth SET
          inFlightAgentCount = MAX(0, inFlightAgentCount - 1),
          updatedAt = ?
         WHERE projectId = ?`
      ).run(new Date().toISOString(), projectId);
    });

    const state = await this.getGlobalConcurrencyState();
    this.emit("concurrency:changed", state);
  }

  // ── Utility Methods ─────────────────────────────────────────────────────

  /**
   * Get the path to the central database file.
   *
   * @returns Absolute path to kb-central.db
   */
  getDatabasePath(): string {
    return this.db?.getPath() ?? join(this.globalDir, "kb-central.db");
  }

  /**
   * Get the global directory path.
   *
   * @returns Absolute path to global kb directory
   */
  getGlobalDir(): string {
    return this.globalDir;
  }

  /**
   * Get statistics about the central infrastructure.
   *
   * @returns Statistics including project count, task totals, and database size
   */
  async getStats(): Promise<{ projectCount: number; totalTasksCompleted: number; dbSizeBytes: number }> {
    this.ensureInitialized();

    const projectCount = (
      this.db!.prepare("SELECT COUNT(*) as count FROM projects").get() as { count: number }
    ).count;

    const totalTasksCompleted = (
      this.db!.prepare("SELECT SUM(totalTasksCompleted) as total FROM projectHealth").get() as {
        total: number | null;
      }
    ).total ?? 0;

    const dbPath = this.db!.getPath();
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(dbPath).size;
    } catch {
      // File might not exist yet
    }

    return { projectCount, totalTasksCompleted, dbSizeBytes };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error("CentralCore not initialized. Call init() first.");
    }
  }

  private rowToProject(row: {
    id: string;
    name: string;
    path: string;
    status: string;
    isolationMode: string;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string | null;
    settings: string | null;
  }): RegisteredProject {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      status: row.status as ProjectStatus,
      isolationMode: row.isolationMode as IsolationMode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastActivityAt: row.lastActivityAt ?? undefined,
      settings: fromJson<ProjectSettings>(row.settings),
    };
  }

  private rowToHealth(row: {
    projectId: string;
    status: string;
    activeTaskCount: number;
    inFlightAgentCount: number;
    lastActivityAt: string | null;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
    totalTasksCompleted: number;
    totalTasksFailed: number;
    averageTaskDurationMs: number | null;
    updatedAt: string;
  }): ProjectHealth {
    return {
      projectId: row.projectId,
      status: row.status as ProjectStatus,
      activeTaskCount: row.activeTaskCount,
      inFlightAgentCount: row.inFlightAgentCount,
      lastActivityAt: row.lastActivityAt ?? undefined,
      lastErrorAt: row.lastErrorAt ?? undefined,
      lastErrorMessage: row.lastErrorMessage ?? undefined,
      totalTasksCompleted: row.totalTasksCompleted,
      totalTasksFailed: row.totalTasksFailed,
      averageTaskDurationMs: row.averageTaskDurationMs ?? undefined,
      updatedAt: row.updatedAt,
    };
  }

  private rowToActivityEntry(row: {
    id: string;
    timestamp: string;
    type: string;
    projectId: string;
    projectName: string;
    taskId: string | null;
    taskTitle: string | null;
    details: string;
    metadata: string | null;
  }): CentralActivityLogEntry {
    return {
      id: row.id,
      timestamp: row.timestamp,
      type: row.type as ActivityEventType,
      projectId: row.projectId,
      projectName: row.projectName,
      taskId: row.taskId ?? undefined,
      taskTitle: row.taskTitle ?? undefined,
      details: row.details,
      metadata: fromJson<Record<string, unknown>>(row.metadata),
    };
  }

  // ── Migration Helpers ────────────────────────────────────────────────

  /**
   * Auto-register a project at the given path.
   *
   * This is used during migration from single-project to multi-project mode.
   * Generates the project name from git remote or directory name.
   *
   * @param projectPath — Absolute path to project directory
   * @returns Registered project
   * @throws Error if path doesn't exist, isn't absolute, or registration fails
   */
  async autoRegisterProject(projectPath: string): Promise<RegisteredProject> {
    this.ensureInitialized();

    const normalizedProjectPath = resolve(projectPath);
    const existingProjects = await this.listProjects();
    const overlappingProject = existingProjects.find((project) => {
      const existingPath = resolve(project.path);
      return (
        existingPath === normalizedProjectPath ||
        existingPath.startsWith(`${normalizedProjectPath}/`) ||
        normalizedProjectPath.startsWith(`${existingPath}/`)
      );
    });

    if (overlappingProject) {
      if (resolve(overlappingProject.path) === normalizedProjectPath) {
        return overlappingProject;
      }
      throw new Error(`Project path overlaps an existing registered project: ${overlappingProject.path}`);
    }

    // Check if already registered
    const existing = await this.getProjectByPath(projectPath);
    if (existing) {
      return existing;
    }

    // Generate name from git remote or directory
    const name = await this.generateProjectName(projectPath);

    // Ensure unique name
    const uniqueName = await this.ensureUniqueName(name);

    // Register with in-process isolation, then mark active for migration/init flows.
    const project = await this.registerProject({
      name: uniqueName,
      path: projectPath,
      isolationMode: "in-process",
    });

    return this.updateProject(project.id, { status: "active" });
  }

  /**
   * Get the current first-run state for this central instance.
   *
   * @returns First-run state
   */
  async getFirstRunState(): Promise<import("./migration.js").FirstRunState> {
    const { FirstRunDetector } = await import("./migration.js");
    const detector = new FirstRunDetector(this.globalDir);
    return detector.detectFirstRunState(this);
  }

  /**
   * Check if a project path is already registered.
   *
   * @param projectPath — Absolute project path
   * @returns true if already registered
   */
  async isProjectRegistered(projectPath: string): Promise<boolean> {
    const existing = await this.getProjectByPath(projectPath);
    return !!existing;
  }

  /**
   * Generate a project name from git remote or directory name.
   */
  private async generateProjectName(projectPath: string): Promise<string> {
    // Try git remote first
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const { stdout } = await execFileAsync(
        "git",
        ["remote", "get-url", "origin"],
        { cwd: projectPath, timeout: 5000 }
      );

      const remoteUrl = stdout.trim();
      if (remoteUrl) {
        const name = this.extractRepoName(remoteUrl);
        if (name) return name;
      }
    } catch {
      // Git not available or no remote - fall through to directory name
    }

    // Fallback to directory name
    return basename(projectPath);
  }

  /**
   * Extract repository name from git remote URL.
   */
  private extractRepoName(remoteUrl: string): string | null {
    // Remove .git suffix
    const withoutGit = remoteUrl.replace(/\.git$/, "");

    // Handle SSH format: git@host:owner/repo
    const sshMatch = withoutGit.match(/:([^/:]+\/([^/]+))$/);
    if (sshMatch) {
      return sshMatch[2];
    }

    // Handle HTTPS format: https://host/owner/repo
    const httpsMatch = withoutGit.match(/\/([^/]+)$/);
    if (httpsMatch) {
      return httpsMatch[1];
    }

    return null;
  }

  /**
   * Ensure a project name is unique by appending -N suffix if needed.
   */
  private async ensureUniqueName(baseName: string): Promise<string> {
    const existing = await this.listProjects();
    const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));

    if (!existingNames.has(baseName.toLowerCase())) {
      return baseName;
    }

    // Find unique suffix
    let counter = 1;
    let candidate = `${baseName}-${counter}`;
    while (existingNames.has(candidate.toLowerCase())) {
      counter++;
      candidate = `${baseName}-${counter}`;
    }

    return candidate;
  }
}
