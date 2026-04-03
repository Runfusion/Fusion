import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { existsSync, watch, type FSWatcher, readFileSync } from "node:fs";
import type { Task, TaskDetail, TaskCreateInput, TaskAttachment, AgentLogEntry, BoardConfig, Column, MergeResult, Settings, GlobalSettings, ProjectSettings, ActivityLogEntry, ActivityEventType } from "./types.js";
import { VALID_TRANSITIONS, DEFAULT_SETTINGS, DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS, GLOBAL_SETTINGS_KEYS } from "./types.js";
import { GlobalSettingsStore } from "./global-settings.js";
import { Database, toJson, toJsonNullable, fromJson } from "./db.js";
import { detectLegacyData, migrateFromLegacy } from "./db-migrate.js";
import { MissionStore } from "./mission-store.js";
import { BackwardCompat, ProjectRequiredError } from "./migration.js";
import { CentralCore } from "./central-core.js";

export interface TaskStoreEvents {
  "task:created": [task: Task];
  "task:moved": [data: { task: Task; from: Column; to: Column }];
  "task:updated": [task: Task];
  "task:deleted": [task: Task];
  "task:merged": [result: MergeResult];
  "settings:updated": [data: { settings: Settings; previous: Settings }];
  "agent:log": [entry: AgentLogEntry];
}

export class TaskStore extends EventEmitter<TaskStoreEvents> {
  static async getOrCreateForProject(projectId?: string, centralCore?: CentralCore): Promise<TaskStore> {
    const central = centralCore ?? new CentralCore();
    let initializedHere = false;

    if (!centralCore) {
      await central.init();
      initializedHere = true;
    }

    try {
      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext(process.cwd(), projectId);
      const store = new TaskStore(context.workingDirectory);
      await store.init();
      return store;
    } catch (error) {
      if (error instanceof ProjectRequiredError) {
        if (projectId) {
          throw new Error(`Project "${projectId}" not found`);
        }
        throw new Error(error.message);
      }
      throw error;
    } finally {
      if (initializedHere) {
        await central.close();
      }
    }
  }

  /**
   * Hybrid storage note: task metadata lives in SQLite, while blob files remain on disk.
   * Any write to `.fusion/tasks/{id}` must recreate the directory on demand, and any read from
   * optional blob files must tolerate missing files/directories because cleanup, migration,
   * or manual filesystem changes can remove them independently of the database row.
   */
  private kbDir: string;
  private tasksDir: string;
  private configPath: string;
  private archiveLogPath: string;
  private activityLogPath: string;
  /** SQLite database for structured data storage */
  private _db: Database | null = null;

  /** File-system watcher instance */
  private watcher: FSWatcher | null = null;
  /** In-memory cache of tasks for diffing watcher events */
  private taskCache: Map<string, Task> = new Map();
  /** Paths recently written by in-process mutations (suppresses duplicate events) */
  private recentlyWritten: Set<string> = new Set();
  /** Pending debounce timers keyed by task ID */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Debounce interval in ms */
  private debounceMs = 150;
  /** Per-task promise chain for serializing writes */
  private taskLocks: Map<string, Promise<void>> = new Map();
  /** Promise chain for serializing config.json read-modify-write cycles */
  private configLock: Promise<void> = Promise.resolve();
  /** Global settings store (`~/.pi/fusion/settings.json`) */
  private globalSettingsStore: GlobalSettingsStore;
  /** Polling interval for change detection */
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** Last known modification timestamp for change detection */
  private lastKnownModified: number = 0;

  /** Whether the store is actively watching for changes (watcher or polling). */
  private get isWatching(): boolean {
    return this.watcher !== null || this.pollInterval !== null;
  }
  /** Cached MissionStore instance */
  private missionStore: MissionStore | null = null;

  constructor(private rootDir: string, globalSettingsDir?: string) {
    super();
    this.setMaxListeners(100);
    this.kbDir = join(rootDir, ".fusion");
    this.tasksDir = join(this.kbDir, "tasks");
    this.configPath = join(this.kbDir, "config.json");
    this.archiveLogPath = join(this.kbDir, "archive.jsonl");
    this.activityLogPath = join(this.kbDir, "activity-log.jsonl");
    this.globalSettingsStore = new GlobalSettingsStore(globalSettingsDir);
  }

  /**
   * Get the SQLite database, initializing it on first access.
   * Also performs auto-migration from legacy file-based storage if needed.
   */
  private get db(): Database {
    if (!this._db) {
      this._db = new Database(this.kbDir);
      this._db.init();
      // Auto-migrate legacy data if needed
      if (detectLegacyData(this.kbDir)) {
        // Note: migrateFromLegacy is async but we need sync access.
        // The init() method handles async migration. This getter
        // just ensures the DB is available for synchronous operations.
      }
    }
    return this._db;
  }

  async init(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    
    // Initialize SQLite database
    if (!this._db) {
      this._db = new Database(this.kbDir);
      this._db.init();
    }
    
    // Auto-migrate from legacy file-based storage
    if (detectLegacyData(this.kbDir)) {
      await migrateFromLegacy(this.kbDir, this._db);
    }
    
    // Write config.json for backward compatibility if it doesn't exist
    if (!existsSync(this.configPath)) {
      const config = await this.readConfig();
      try {
        await writeFile(this.configPath, JSON.stringify(config, null, 2));
      } catch {
        // Non-fatal
      }
    }
    
    this.setupActivityLogListeners();
  }

  // ── Row <-> Task Conversion ────────────────────────────────────────

  /**
   * Convert a database row to a Task object, parsing JSON columns.
   */
  private rowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title || undefined,
      description: row.description,
      column: row.column as Column,
      status: row.status || undefined,
      size: row.size || undefined,
      reviewLevel: row.reviewLevel ?? undefined,
      currentStep: row.currentStep || 0,
      worktree: row.worktree || undefined,
      blockedBy: row.blockedBy || undefined,
      paused: row.paused ? true : undefined,
      baseBranch: row.baseBranch || undefined,
      branch: row.branch || undefined,
      baseCommitSha: row.baseCommitSha || undefined,
      modelPresetId: row.modelPresetId || undefined,
      modelProvider: row.modelProvider || undefined,
      modelId: row.modelId || undefined,
      validatorModelProvider: row.validatorModelProvider || undefined,
      validatorModelId: row.validatorModelId || undefined,
      mergeRetries: row.mergeRetries ?? undefined,
      error: row.error || undefined,
      summary: row.summary || undefined,
      thinkingLevel: row.thinkingLevel || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      columnMovedAt: row.columnMovedAt || undefined,
      dependencies: fromJson<string[]>(row.dependencies) || [],
      steps: fromJson<import("./types.js").TaskStep[]>(row.steps) || [],
      log: fromJson<import("./types.js").TaskLogEntry[]>(row.log) || [],
      attachments: (() => { const a = fromJson<TaskAttachment[]>(row.attachments); return a && a.length > 0 ? a : undefined; })(),
      steeringComments: (() => {
        const sc = fromJson<import("./types.js").SteeringComment[]>(row.steeringComments);
        return sc && sc.length > 0 ? sc : undefined;
      })(),
      comments: (() => {
        // Comments column already contains steering comments (addSteeringComment calls addComment).
        // Do NOT merge steeringComments here — that caused duplication on every read-write cycle.
        const c = fromJson<import("./types.js").TaskComment[]>(row.comments) || [];
        // Deduplicate by id to recover from prior corruption
        const seen = new Set<string>();
        const deduped = c.filter(entry => {
          if (seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        });
        return deduped.length > 0 ? deduped : undefined;
      })(),
      workflowStepResults: (() => { const w = fromJson<import("./types.js").WorkflowStepResult[]>(row.workflowStepResults); return w && w.length > 0 ? w : undefined; })(),
      prInfo: fromJson<import("./types.js").PrInfo>(row.prInfo),
      issueInfo: fromJson<import("./types.js").IssueInfo>(row.issueInfo),
      mergeDetails: fromJson<import("./types.js").MergeDetails>(row.mergeDetails),
      breakIntoSubtasks: row.breakIntoSubtasks ? true : undefined,
      enabledWorkflowSteps: (() => { const e = fromJson<string[]>(row.enabledWorkflowSteps); return e && e.length > 0 ? e : undefined; })(),
      modifiedFiles: (() => { const m = fromJson<string[]>(row.modifiedFiles); return m && m.length > 0 ? m : undefined; })(),
      missionId: row.missionId || undefined,
      sliceId: row.sliceId || undefined,
    };
  }

  /**
   * Upsert a task to the database. Used by create and update operations.
   */
  private upsertTask(task: Task): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, title, description, "column", status, size, reviewLevel, currentStep,
        worktree, blockedBy, paused, baseBranch, branch, baseCommitSha, modelPresetId, modelProvider,
        modelId, validatorModelProvider, validatorModelId, mergeRetries, error,
        summary, thinkingLevel, createdAt, updatedAt, columnMovedAt,
        dependencies, steps, log, attachments, steeringComments,
        comments, workflowStepResults, prInfo, issueInfo, mergeDetails,
        breakIntoSubtasks, enabledWorkflowSteps, modifiedFiles, missionId, sliceId
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      task.id,
      task.title ?? null,
      task.description,
      task.column,
      task.status ?? null,
      task.size ?? null,
      task.reviewLevel ?? null,
      task.currentStep || 0,
      task.worktree ?? null,
      task.blockedBy ?? null,
      task.paused ? 1 : 0,
      task.baseBranch ?? null,
      task.branch ?? null,
      task.baseCommitSha ?? null,
      task.modelPresetId ?? null,
      task.modelProvider ?? null,
      task.modelId ?? null,
      task.validatorModelProvider ?? null,
      task.validatorModelId ?? null,
      task.mergeRetries ?? null,
      task.error ?? null,
      task.summary ?? null,
      task.thinkingLevel ?? null,
      task.createdAt,
      task.updatedAt,
      task.columnMovedAt ?? null,
      toJson(task.dependencies || []),
      toJson(task.steps || []),
      toJson(task.log || []),
      toJson(task.attachments || []),
      toJson(task.steeringComments || []),
      toJson(task.comments || []),
      toJson(task.workflowStepResults || []),
      toJsonNullable(task.prInfo),
      toJsonNullable(task.issueInfo),
      toJsonNullable(task.mergeDetails),
      task.breakIntoSubtasks ? 1 : 0,
      toJson(task.enabledWorkflowSteps || []),
      toJson(task.modifiedFiles || []),
      task.missionId ?? null,
      task.sliceId ?? null,
    );
    this.db.bumpLastModified();
  }

  /**
   * Read a task from SQLite by ID.
   */
  private readTaskFromDb(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return undefined;
    return this.rowToTask(row);
  }

  /**
   * Set up event listeners for activity logging.
   * Call after init() to record task lifecycle events.
   */
  private setupActivityLogListeners(): void {
    // Task created
    this.on("task:created", (task) => {
      this.recordActivity({
        type: "task:created",
        taskId: task.id,
        taskTitle: task.title,
        details: `Task ${task.id} created${task.title ? `: ${task.title}` : ""}`,
      }).catch(() => {
        // Best-effort: ignore recording errors
      });
    });

    // Task moved
    this.on("task:moved", (data) => {
      this.recordActivity({
        type: "task:moved",
        taskId: data.task.id,
        taskTitle: data.task.title,
        details: `Task ${data.task.id} moved: ${data.from} → ${data.to}`,
        metadata: { from: data.from, to: data.to },
      }).catch(() => {
        // Best-effort: ignore recording errors
      });
    });

    // Task merged
    this.on("task:merged", (result) => {
      const status = result.merged ? "successfully merged" : "merge attempted";
      this.recordActivity({
        type: "task:merged",
        taskId: result.task.id,
        taskTitle: result.task.title,
        details: `Task ${result.task.id} ${status} to main`,
        metadata: { merged: result.merged, branch: result.branch },
      }).catch(() => {
        // Best-effort: ignore recording errors
      });
    });

    // Task updated (check for failures)
    this.on("task:updated", (task) => {
      if (task.status === "failed") {
        this.recordActivity({
          type: "task:failed",
          taskId: task.id,
          taskTitle: task.title,
          details: `Task ${task.id} failed${task.error ? `: ${task.error}` : ""}`,
          metadata: task.error ? { error: task.error } : undefined,
        }).catch(() => {
          // Best-effort: ignore recording errors
        });
      }
    });

    // Settings updated (log important changes)
    this.on("settings:updated", (data) => {
      const importantChanges: string[] = [];
      if (data.settings.ntfyEnabled !== data.previous.ntfyEnabled) {
        importantChanges.push(`ntfy ${data.settings.ntfyEnabled ? "enabled" : "disabled"}`);
      }
      if (data.settings.ntfyTopic !== data.previous.ntfyTopic) {
        importantChanges.push(`ntfy topic changed to ${data.settings.ntfyTopic}`);
      }
      if (data.settings.globalPause !== data.previous.globalPause) {
        importantChanges.push(`global pause ${data.settings.globalPause ? "enabled" : "disabled"}`);
      }
      if (data.settings.enginePaused !== data.previous.enginePaused) {
        importantChanges.push(`engine pause ${data.settings.enginePaused ? "enabled" : "disabled"}`);
      }

      if (importantChanges.length > 0) {
        this.recordActivity({
          type: "settings:updated",
          details: `Settings updated: ${importantChanges.join(", ")}`,
          metadata: { changes: importantChanges },
        }).catch(() => {
          // Best-effort: ignore recording errors
        });
      }
    });

    // Task deleted
    this.on("task:deleted", (task) => {
      this.recordActivity({
        type: "task:deleted",
        taskId: task.id,
        taskTitle: task.title,
        details: `Task ${task.id} deleted${task.title ? `: ${task.title}` : ""}`,
      }).catch(() => {
        // Best-effort: ignore recording errors
      });
    });
  }

  /**
   * Serialize all mutations to config.json by chaining promises.
   * Concurrent callers will queue behind each other, preventing
   * lost-update races on the nextId counter.
   */
  private withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = this.configLock;
    this.configLock = next;

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve!();
      }
    });
  }

  /**
   * Serialize all mutations to a given task's task.json by chaining promises
   * per task ID. Concurrent callers for the same ID will queue behind each other.
   */
  private withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.taskLocks.get(id) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.taskLocks.set(id, next);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        if (this.taskLocks.get(id) === next) {
          this.taskLocks.delete(id);
        }
        resolve!();
      }
    });
  }

  /**
   * Read a task from SQLite by ID (extracted from dir path for backward compat).
   * Falls back to file-based reading if not in DB.
   */
  private async readTaskJson(dir: string): Promise<Task> {
    // Extract task ID from directory path (handles both / and \ separators)
    const parts = dir.replace(/\\/g, "/").split("/");
    const id = parts[parts.length - 1];
    
    // Try SQLite first
    const task = this.readTaskFromDb(id);
    if (task) return task;
    
    // Fallback to file-based reading (for legacy compatibility)
    const filePath = join(dir, "task.json");
    const raw = await readFile(filePath, "utf-8");
    try {
      const fileTask = JSON.parse(raw) as Task;
      if (!Array.isArray(fileTask.log)) fileTask.log = [];
      if (!Array.isArray(fileTask.dependencies)) fileTask.dependencies = [];
      if (!Array.isArray(fileTask.steps)) fileTask.steps = [];
      return fileTask;
    } catch (err) {
      throw new Error(
        `Failed to parse task.json at ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Write a task to SQLite (primary store) and also write task.json to disk
   * for backward compatibility and debugging.
   */
  private async atomicWriteTaskJson(dir: string, task: Task): Promise<void> {
    this.upsertTask(task);
    // Also write to disk for backward compatibility
    const taskJsonPath = join(dir, "task.json");
    const tmpPath = join(dir, "task.json.tmp");
    this.suppressWatcher(taskJsonPath);
    await mkdir(dir, { recursive: true }); // Ensure directory exists
    await writeFile(tmpPath, JSON.stringify(task, null, 2));
    await rename(tmpPath, taskJsonPath);
  }

  /**
   * Get merged settings: global defaults ← global user prefs ← project overrides.
   *
   * Returns the combined view that most consumers should use. Project-level
   * values in `.fusion/config.json` override global values from `~/.pi/fusion/settings.json`.
   */
  async getSettings(): Promise<Settings> {
    const [globalSettings, config] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.readConfig(),
    ]);
    return {
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...config.settings,
    };
  }

  /**
   * Get settings separated by scope. Returns both the global and
   * project-level settings independently (useful for the UI to show
   * which scope a value comes from).
   */
  async getSettingsByScope(): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    const [globalSettings, config] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.readConfig(),
    ]);

    // Extract only project-level keys from config.settings
    const projectSettings: Partial<ProjectSettings> = {};
    if (config.settings) {
      const globalKeySet = new Set<string>(GLOBAL_SETTINGS_KEYS);
      for (const key of Object.keys(config.settings)) {
        if (!globalKeySet.has(key)) {
          (projectSettings as any)[key] = (config.settings as any)[key];
        }
      }
    }

    return { global: globalSettings, project: projectSettings };
  }

  /**
   * Update project-level settings in `.fusion/config.json`.
   *
   * Accepts `Partial<Settings>` for backward compatibility. Any global-only
   * fields in the patch are silently filtered out — they will not be persisted
   * to the project config. Use `updateGlobalSettings()` for global fields.
   */
  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    // Filter out global-only fields — they should go through updateGlobalSettings()
    const projectPatch: Partial<Settings> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!(GLOBAL_SETTINGS_KEYS as readonly string[]).includes(key)) {
        (projectPatch as Record<string, unknown>)[key] = value;
      }
    }

    return this.withConfigLock(async () => {
      const config = await this.readConfig();
      const globalSettings = await this.globalSettingsStore.getSettings();
      const previousMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...config.settings } as Settings;
      const updatedProjectSettings = { ...config.settings, ...projectPatch };
      config.settings = updatedProjectSettings as Settings;
      await this.writeConfig(config);
      const updatedMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...updatedProjectSettings } as Settings;
      this.emit("settings:updated", { settings: updatedMerged, previous: previousMerged });
      return updatedMerged;
    });
  }

  /**
   * Update global (user-level) settings in `~/.pi/fusion/settings.json`.
   *
   * These settings persist across all kb projects for the current user.
   * Only fields defined in `GlobalSettings` are accepted.
   */
  async updateGlobalSettings(patch: Partial<GlobalSettings>): Promise<Settings> {
    // Read previous state BEFORE writing so the diff is correct
    const [previousGlobal, config] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.readConfig(),
    ]);
    const previous: Settings = { ...DEFAULT_SETTINGS, ...previousGlobal, ...config.settings } as Settings;

    const updatedGlobal = await this.globalSettingsStore.updateSettings(patch);
    const merged: Settings = { ...DEFAULT_SETTINGS, ...updatedGlobal, ...config.settings } as Settings;

    // Emit settings:updated so SSE listeners pick up the change
    this.emit("settings:updated", { settings: merged, previous });
    return merged;
  }

  /**
   * Get the GlobalSettingsStore instance (used by API routes).
   */
  getGlobalSettingsStore(): GlobalSettingsStore {
    return this.globalSettingsStore;
  }

  private async readConfig(): Promise<BoardConfig> {
    const row = this.db.prepare("SELECT * FROM config WHERE id = 1").get() as any;
    if (!row) {
      return { nextId: 1 };
    }
    return {
      nextId: row.nextId || 1,
      settings: fromJson<Settings>(row.settings),
      workflowSteps: fromJson<import("./types.js").WorkflowStep[]>(row.workflowSteps),
      nextWorkflowStepId: row.nextWorkflowStepId || 1,
    };
  }

  private async writeConfig(config: BoardConfig): Promise<void> {
    const now = new Date().toISOString();
    // Use INSERT OR REPLACE to ensure the config row exists (handles edge case where row is missing)
    this.db.prepare(
      `INSERT OR REPLACE INTO config (id, nextId, nextWorkflowStepId, settings, workflowSteps, updatedAt) 
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      config.nextId || 1,
      config.nextWorkflowStepId || 1,
      JSON.stringify(config.settings || {}),
      JSON.stringify(config.workflowSteps || []),
      now,
    );
    this.db.bumpLastModified();
    // Also write config.json to disk for backward compatibility
    try {
      const tmpPath = this.configPath + ".tmp";
      await writeFile(tmpPath, JSON.stringify(config, null, 2));
      await rename(tmpPath, this.configPath);
    } catch {
      // Best-effort: SQLite is the primary store
    }
  }

  private async allocateId(): Promise<string> {
    // Use withConfigLock to ensure the entire ID allocation + config sync is serialized
    return this.withConfigLock(async () => {
      const id = this.db.transaction(() => {
        const row = this.db.prepare("SELECT nextId, settings FROM config WHERE id = 1").get() as any;
        const settings = fromJson<Settings>(row.settings);
        const prefix = settings?.taskPrefix || "KB";
        const nextId = row.nextId || 1;
        const taskId = `${prefix}-${String(nextId).padStart(3, "0")}`;
        this.db.prepare("UPDATE config SET nextId = ? WHERE id = 1").run(nextId + 1);
        this.db.bumpLastModified();
        return taskId;
      }); // Database.transaction() directly executes and returns the result
      
      // Sync config.json to disk for backward compatibility
      try {
        const config = await this.readConfig();
        const tmpPath = this.configPath + ".tmp";
        await writeFile(tmpPath, JSON.stringify(config, null, 2));
        await rename(tmpPath, this.configPath);
      } catch {
        // Non-fatal: SQLite is the primary store
      }
      
      return id;
    });
  }

  private taskDir(id: string): string {
    return join(this.tasksDir, id);
  }

  async createTask(
    input: TaskCreateInput,
    options?: {
      onSummarize?: (description: string) => Promise<string | null>;
      settings?: { autoSummarizeTitles?: boolean };
    }
  ): Promise<Task> {
    if (!input.description?.trim()) {
      throw new Error("Description is required and cannot be empty");
    }

    const id = await this.allocateId();
    // Validate that task doesn't depend on itself
    if (input.dependencies?.includes(id)) {
      throw new Error(`Task ${id} cannot depend on itself`);
    }

    // Determine if we should try to summarize the title
    let title = input.title?.trim() || undefined;
    const shouldSummarize =
      !title && // Only if no title provided
      input.description.length > 140 && // Only if description is long enough
      (input.summarize === true || // Explicit request
        options?.settings?.autoSummarizeTitles === true); // Auto-enabled

    if (shouldSummarize && options?.onSummarize) {
      try {
        const generatedTitle = await options.onSummarize(input.description);
        if (generatedTitle) {
          title = generatedTitle;
        }
      } catch (err) {
        // Log warning but don't block task creation
        console.warn(`[TaskStore] Title summarization failed for task ${id}:`, err instanceof Error ? err.message : err);
      }
    }

    const now = new Date().toISOString();
    const task: Task = {
      id,
      title,
      description: input.description,
      column: input.column || "triage",
      dependencies: input.dependencies || [],
      breakIntoSubtasks: input.breakIntoSubtasks === true ? true : undefined,
      enabledWorkflowSteps: input.enabledWorkflowSteps?.length ? input.enabledWorkflowSteps : undefined,
      modelPresetId: input.modelPresetId,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      validatorModelProvider: input.validatorModelProvider,
      validatorModelId: input.validatorModelId,
      steps: [],
      currentStep: 0,
      log: [{ timestamp: now, action: "Task created" }],
      columnMovedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const dir = this.taskDir(id);
    await mkdir(dir, { recursive: true });
    await this.atomicWriteTaskJson(dir, task);

    // Update cache if watcher is active
    if (this.isWatching) this.taskCache.set(id, { ...task });

    const heading = task.title ? `${id}: ${task.title}` : id;
    const prompt = task.column === "triage"
      ? `# ${heading}\n\n${task.description}\n`
      : this.generateSpecifiedPrompt(task);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), prompt);

    this.emit("task:created", task);
    return task;
  }

  /**
   * Duplicate an existing task, creating a fresh copy in triage.
   * Copies title and description with source reference, but resets all
   * execution state. The new task will be re-specified by the AI.
   */
  async duplicateTask(id: string): Promise<Task> {
    // Read the source task with its prompt
    const sourceTask = await this.getTask(id);

    // Allocate a new ID
    const newId = await this.allocateId();
    const now = new Date().toISOString();

    // Create new task with copied title/description, but fresh state
    const newTask: Task = {
      id: newId,
      title: sourceTask.title,
      description: `${sourceTask.description}\n\n(Duplicated from ${id})`,
      column: "triage",
      modelPresetId: sourceTask.modelPresetId,
      dependencies: [], // Fresh task should have no dependencies
      steps: [], // Reset execution state
      currentStep: 0,
      log: [{ timestamp: now, action: `Duplicated from ${id}` }],
      columnMovedAt: now,
      createdAt: now,
      updatedAt: now,
      // Explicitly NOT copied: worktree, status, blockedBy, paused, baseBranch,
      // attachments, comments, prInfo, agent logs, size, reviewLevel
    };

    const newDir = this.taskDir(newId);
    await mkdir(newDir, { recursive: true });
    await this.atomicWriteTaskJson(newDir, newTask);

    // Copy source PROMPT.md content (the AI will re-specify it in triage)
    const sourcePrompt = sourceTask.prompt;
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "PROMPT.md"), sourcePrompt);

    // Update cache if watcher is active
    if (this.isWatching) this.taskCache.set(newId, { ...newTask });

    this.emit("task:created", newTask);
    return newTask;
  }

  /**
   * Create a refinement task from a completed or in-review task.
   * The new task is created in triage with a dependency on the original task.
   * Validates the original is in 'done' or 'in-review' column.
   */
  async refineTask(id: string, feedback: string): Promise<Task> {
    // Read the source task with its prompt
    const sourceTask = await this.getTask(id);

    // Validate task is in done or in-review column
    if (sourceTask.column !== "done" && sourceTask.column !== "in-review") {
      throw new Error(
        `Cannot refine ${id}: task is in '${sourceTask.column}', must be in 'done' or 'in-review'`,
      );
    }

    // Validate feedback is not empty
    if (!feedback?.trim()) {
      throw new Error("Feedback is required and cannot be empty");
    }

    // Allocate a new ID
    const newId = await this.allocateId();
    const now = new Date().toISOString();

    // Create new refinement task
    const newTask: Task = {
      id: newId,
      title: `Refinement: ${sourceTask.title || sourceTask.id}`,
      description: `${feedback.trim()}\n\nRefines: ${id}`,
      column: "triage",
      dependencies: [id], // Refinement depends on the original being complete
      steps: [], // Reset execution state
      currentStep: 0,
      log: [{ timestamp: now, action: `Created as refinement of ${id}` }],
      columnMovedAt: now,
      createdAt: now,
      updatedAt: now,
      // Copy attachments from original for context (defensive copy)
      attachments: sourceTask.attachments ? [...sourceTask.attachments] : undefined,
    };

    const newDir = this.taskDir(newId);
    await mkdir(newDir, { recursive: true });
    await this.atomicWriteTaskJson(newDir, newTask);

    // Create a PROMPT.md for the refinement
    const heading = newTask.title;
    const prompt = `# ${heading}\n\n${newTask.description}\n`;
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "PROMPT.md"), prompt);

    // Copy attachments from source if any
    if (sourceTask.attachments && sourceTask.attachments.length > 0) {
      const sourceAttachDir = join(this.taskDir(id), "attachments");
      const targetAttachDir = join(newDir, "attachments");
      await mkdir(targetAttachDir, { recursive: true });

      for (const attachment of sourceTask.attachments) {
        const sourcePath = join(sourceAttachDir, attachment.filename);
        const targetPath = join(targetAttachDir, attachment.filename);
        if (existsSync(sourcePath)) {
          const content = await readFile(sourcePath);
          await writeFile(targetPath, content);
        }
      }
    }

    // Update cache if watcher is active
    if (this.isWatching) this.taskCache.set(newId, { ...newTask });

    this.emit("task:created", newTask);
    return newTask;
  }

  /**
   * Read a task and its prompt content.
   */
  async getTask(id: string): Promise<TaskDetail> {
    const task = this.readTaskFromDb(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }

    // Sync steps from PROMPT.md if task.steps is empty
    if (task.steps.length === 0) {
      task.steps = await this.parseStepsFromPrompt(id);
    }

    let prompt = "";
    const promptPath = join(this.taskDir(id), "PROMPT.md");
    if (existsSync(promptPath)) {
      prompt = await readFile(promptPath, "utf-8");
    }

    return { ...task, prompt };
  }

  async listTasks(options?: { limit?: number; offset?: number }): Promise<Task[]> {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY createdAt ASC').all();
    const tasks = (rows as any[]).map((row) => this.rowToTask(row));

    // Sort by createdAt, then by numeric ID suffix for tie-breaking
    const sorted = tasks.sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return aNum - bNum;
    });

    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;

    if (limit === undefined) {
      return sorted.slice(offset);
    }

    return sorted.slice(offset, offset + Math.max(0, limit));
  }

  async moveTask(id: string, toColumn: Column): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      const validTargets = VALID_TRANSITIONS[task.column];
      if (!validTargets.includes(toColumn)) {
        throw new Error(
          `Invalid transition: '${task.column}' → '${toColumn}'. ` +
            `Valid targets: ${validTargets.join(", ") || "none"}`,
        );
      }

      const fromColumn = task.column;
      task.column = toColumn;
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;

      // Clear transient fields when moving to done (matches moveToDone behavior)
      if (toColumn === "done") {
        task.status = undefined;
        task.error = undefined;
        task.worktree = undefined;
        task.blockedBy = undefined;
      }

      // Clear transient fields when moving from in-progress to reset columns (todo/triage)
      // This ensures failed tasks don't show failed status after being moved for retry
      if (fromColumn === "in-progress" && (toColumn === "todo" || toColumn === "triage")) {
        task.status = undefined;
        task.error = undefined;
        task.worktree = undefined;
        task.blockedBy = undefined;
      }

      // Clear workflow step results when moving from in-review back to todo or in-progress
      // This ensures fresh workflow step runs on retry
      if (fromColumn === "in-review" && (toColumn === "todo" || toColumn === "in-progress")) {
        task.workflowStepResults = undefined;
      }

      await this.atomicWriteTaskJson(dir, task);

      // Update cache if watcher is active
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:moved", { task, from: fromColumn, to: toColumn });
      return task;
    });
  }

  async updateTask(
    id: string,
    updates: { title?: string; description?: string; prompt?: string; worktree?: string; status?: string | null; dependencies?: string[]; blockedBy?: string | null; paused?: boolean; baseBranch?: string; branch?: string; baseCommitSha?: string; size?: "S" | "M" | "L"; reviewLevel?: number; mergeRetries?: number; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; error?: string | null; summary?: string | null; workflowStepResults?: import("./types.js").WorkflowStepResult[] | null; modifiedFiles?: string[] | null; missionId?: string | null; sliceId?: string | null },
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      // Validate that task doesn't depend on itself
      if (updates.dependencies?.includes(id)) {
        throw new Error(`Task ${id} cannot depend on itself`);
      }

      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (updates.title !== undefined) task.title = updates.title;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.worktree !== undefined) task.worktree = updates.worktree;
      // Detect new dependencies being added to a todo task → auto-move to triage
      let movedToTriage = false;
      if (updates.dependencies !== undefined) {
        const oldDeps = new Set(task.dependencies);
        const hasNewDeps = updates.dependencies.some((d) => !oldDeps.has(d));
        task.dependencies = updates.dependencies;

        if (hasNewDeps && task.column === "todo") {
          const fromColumn = task.column;
          task.column = "triage";
          task.status = undefined;
          task.columnMovedAt = new Date().toISOString();
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Moved to triage for re-specification — new dependency added",
          });
          movedToTriage = true;
        }
      }
      if (updates.status === null) {
        task.status = undefined;
      } else if (updates.status !== undefined) {
        task.status = updates.status;
      }
      if (updates.blockedBy === null) {
        task.blockedBy = undefined;
      } else if (updates.blockedBy !== undefined) {
        task.blockedBy = updates.blockedBy;
      }
      if (updates.paused !== undefined) task.paused = updates.paused || undefined;
      if (updates.baseBranch !== undefined) task.baseBranch = updates.baseBranch;
      if (updates.branch !== undefined) task.branch = updates.branch;
      if (updates.baseCommitSha !== undefined) task.baseCommitSha = updates.baseCommitSha;
      if (updates.size !== undefined) task.size = updates.size;
      if (updates.reviewLevel !== undefined) task.reviewLevel = updates.reviewLevel;
      if (updates.mergeRetries !== undefined) task.mergeRetries = updates.mergeRetries;
      if (updates.modelProvider === null) {
        task.modelProvider = undefined;
      } else if (updates.modelProvider !== undefined) {
        task.modelProvider = updates.modelProvider;
      }
      if (updates.modelId === null) {
        task.modelId = undefined;
      } else if (updates.modelId !== undefined) {
        task.modelId = updates.modelId;
      }
      if (updates.validatorModelProvider === null) {
        task.validatorModelProvider = undefined;
      } else if (updates.validatorModelProvider !== undefined) {
        task.validatorModelProvider = updates.validatorModelProvider;
      }
      if (updates.validatorModelId === null) {
        task.validatorModelId = undefined;
      } else if (updates.validatorModelId !== undefined) {
        task.validatorModelId = updates.validatorModelId;
      }
      if (updates.error === null) {
        task.error = undefined;
      } else if (updates.error !== undefined) {
        task.error = updates.error;
      }
      if (updates.summary === null) {
        task.summary = undefined;
      } else if (updates.summary !== undefined) {
        task.summary = updates.summary;
      }
      if (updates.workflowStepResults === null) {
        task.workflowStepResults = undefined;
      } else if (updates.workflowStepResults !== undefined) {
        task.workflowStepResults = updates.workflowStepResults;
      }
      if (updates.modifiedFiles === null) {
        task.modifiedFiles = undefined;
      } else if (updates.modifiedFiles !== undefined) {
        task.modifiedFiles = updates.modifiedFiles;
      }
      if (updates.missionId === null) {
        task.missionId = undefined;
      } else if (updates.missionId !== undefined) {
        task.missionId = updates.missionId;
      }
      if (updates.sliceId === null) {
        task.sliceId = undefined;
      } else if (updates.sliceId !== undefined) {
        task.sliceId = updates.sliceId;
      }
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);

      // Update cache if watcher is active
      if (this.isWatching) this.taskCache.set(id, { ...task });

      if (updates.prompt !== undefined) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "PROMPT.md"), updates.prompt);
      }

      // Regenerate PROMPT.md when title or description changes (but not when explicit prompt update)
      if (updates.prompt === undefined && (updates.title !== undefined || updates.description !== undefined)) {
        const promptPath = join(dir, "PROMPT.md");
        if (existsSync(promptPath)) {
          const existingPrompt = await readFile(promptPath, "utf-8");
          let newPrompt: string;
          
          if (task.column === "triage") {
            // Simple format for triage tasks: # heading\n\ndescription
            const heading = task.title ? `${task.id}: ${task.title}` : task.id;
            newPrompt = `# ${heading}\n\n${task.description}\n`;
          } else {
            // Structured format for other columns - preserve sections
            newPrompt = this.regeneratePrompt(task, existingPrompt);
          }
          
          await writeFile(promptPath, newPrompt);
        }
      }

      if (movedToTriage) {
        this.emit("task:moved", { task, from: "todo" as Column, to: "triage" as Column });
      }
      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Pause or unpause a task. Paused tasks are excluded from all automated
   * agent and scheduler interaction. Logs the action and emits `task:updated`.
   */
  async pauseTask(id: string, paused: boolean): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      task.paused = paused || undefined;
      // When pausing an in-progress task, set status so the UI can show the state.
      // When unpausing, clear the "paused" status.
      if (task.column === "in-progress") {
        task.status = paused ? "paused" : undefined;
      }
      const now = new Date().toISOString();
      task.updatedAt = now;
      task.log.push({
        timestamp: now,
        action: paused ? "Task paused" : "Task unpaused",
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Update a step's status. Automatically advances currentStep.
   */
  async updateStep(
    id: string,
    stepIndex: number,
    status: import("./types.js").StepStatus,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Auto-initialize steps from PROMPT.md if empty
      if (task.steps.length === 0) {
        task.steps = await this.parseStepsFromPrompt(id);
      }

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (stepIndex < 0 || stepIndex >= task.steps.length) {
        throw new Error(
          `Step ${stepIndex} out of range (task has ${task.steps.length} steps)`,
        );
      }

      task.steps[stepIndex].status = status;
      task.updatedAt = new Date().toISOString();

      // Advance currentStep to first non-done step
      if (status === "done") {
        while (
          task.currentStep < task.steps.length &&
          task.steps[task.currentStep].status === "done"
        ) {
          task.currentStep++;
        }
      } else if (status === "in-progress") {
        task.currentStep = stepIndex;
      }

      // Log it
      task.log.push({
        timestamp: task.updatedAt,
        action: `Step ${stepIndex} (${task.steps[stepIndex].name}) → ${status}`,
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Add a log entry to a task.
   */
  async logEntry(id: string, action: string, outcome?: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      task.log.push({
        timestamp: new Date().toISOString(),
        action,
        outcome,
      });
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Sync steps from PROMPT.md into task.json (called when steps are empty).
   */
  async parseStepsFromPrompt(id: string): Promise<import("./types.js").TaskStep[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");
    const steps: import("./types.js").TaskStep[] = [];
    const stepRegex = /^###\s+Step\s+\d+[^:]*:\s*(.+)$/gm;
    let match;
    while ((match = stepRegex.exec(content)) !== null) {
      steps.push({ name: match[1].trim(), status: "pending" });
    }
    return steps;
  }

  /**
   * Parse the `## Dependencies` section from a task's PROMPT.md and extract
   * task IDs from lines matching `- **Task:** {ID}` (where ID is `[A-Z]+-\d+`).
   *
   * Returns an empty array if the section says `- **None**`, has no task
   * references, or if the section/file doesn't exist.
   *
   * @param id - The task ID whose PROMPT.md to parse
   * @returns Array of dependency task IDs (e.g. `["KB-001", "KB-002"]`)
   */
  async parseDependenciesFromPrompt(id: string): Promise<string[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    // Find the ## Dependencies section.
    // We locate the heading then slice to the next heading (or end of file)
    // to avoid multiline `$` anchor issues with lazy quantifiers.
    const headingMatch = content.match(/^##\s+Dependencies\s*$/m);
    if (!headingMatch) return [];

    const startIdx = headingMatch.index! + headingMatch[0].length;
    const rest = content.slice(startIdx);
    const nextHeading = rest.search(/\n##?\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    const ids: string[] = [];
    const taskIdRegex = /^-\s+\*\*Task:\*\*\s+([A-Z]+-\d+)/gm;
    let match;
    while ((match = taskIdRegex.exec(section)) !== null) {
      ids.push(match[1]);
    }

    return ids;
  }

  /**
   * Parse the `## File Scope` section from a task's PROMPT.md and extract
   * backtick-quoted file paths. Glob patterns ending in `/*` are stored
   * as directory prefixes for overlap comparison.
   */
  async parseFileScopeFromPrompt(id: string): Promise<string[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    // Find the ## File Scope section.
    // We locate the heading then slice to the next heading (or end of file)
    // to avoid multiline `$` anchor issues with lazy quantifiers.
    const headingMatch = content.match(/^##\s+File\s+Scope\s*$/m);
    if (!headingMatch) return [];

    const startIdx = headingMatch.index! + headingMatch[0].length;
    const rest = content.slice(startIdx);
    const nextHeading = rest.search(/\n##?\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    const paths: string[] = [];
    const backtickRegex = /`([^`]+)`/g;
    let match;
    while ((match = backtickRegex.exec(section)) !== null) {
      paths.push(match[1]);
    }

    return paths;
  }

  async deleteTask(id: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const task = this.readTaskFromDb(id);
      if (!task) {
        throw new Error(`Task ${id} not found`);
      }

      // Delete from SQLite
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      this.db.bumpLastModified();

      // Remove from cache if watcher is active
      if (this.isWatching) this.taskCache.delete(id);

      // Delete directory from disk
      const dir = this.taskDir(id);
      if (existsSync(dir)) {
        const { rm } = await import("node:fs/promises");
        await rm(dir, { recursive: true });
      }

      this.emit("task:deleted", task);
      return task;
    });
  }

  private collectMergeDetails(id: string, branch: string, task: Task, commitMessage: string): import("./types.js").MergeDetails {
    const mergedAt = new Date().toISOString();
    let commitSha: string | undefined;
    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;

    try {
      commitSha = execSync("git rev-parse HEAD", {
        cwd: this.rootDir,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim() || undefined;
    } catch {
      commitSha = undefined;
    }

    try {
      const statsOutput = execSync("git show --shortstat --format= HEAD", {
        cwd: this.rootDir,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      const normalized = statsOutput.replace(/\n/g, " ");
      const filesMatch = normalized.match(/(\d+) files? changed/);
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      filesChanged = filesMatch ? Number.parseInt(filesMatch[1], 10) : 0;
      insertions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;
    } catch {
      filesChanged = undefined;
      insertions = undefined;
      deletions = undefined;
    }

    return {
      commitSha,
      filesChanged,
      insertions,
      deletions,
      mergeCommitMessage: commitMessage,
      mergedAt,
      mergeConfirmed: true,
      prNumber: task.prInfo?.number,
      resolutionStrategy: task.mergeDetails?.resolutionStrategy,
      resolutionMethod: task.mergeDetails?.resolutionMethod,
      attemptsMade: task.mergeDetails?.attemptsMade,
      autoResolvedCount: task.mergeDetails?.autoResolvedCount,
    };
  }

  /**
   * Merge an in-review task's branch into the current branch,
   * clean up the worktree, and move the task to done.
   */
  async mergeTask(id: string): Promise<MergeResult> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      if (task.column !== "in-review") {
        throw new Error(
          `Cannot merge ${id}: task is in '${task.column}', must be in 'in-review'`,
        );
      }

      const branch = `kb/${id.toLowerCase()}`;
      const worktreePath = task.worktree;
      const result: MergeResult = {
        task,
        branch,
        merged: false,
        worktreeRemoved: false,
        branchDeleted: false,
      };

      // 1. Check the branch exists
      try {
        execSync(`git rev-parse --verify "${branch}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
      } catch {
        // No branch — might have been manually merged. Just move to done.
        result.error = `Branch '${branch}' not found — moving to done without merge`;
        task.mergeDetails = {
          mergedAt: new Date().toISOString(),
          mergeConfirmed: false,
          prNumber: task.prInfo?.number,
        };
        await this.moveToDone(task, dir);
        result.task = { ...task, column: "done" };
        this.emit("task:merged", result);
        return result;
      }

      // 2. Merge the branch
      const mergeCommitMessage = `feat(${id}): merge ${branch}`;
      try {
        execSync(`git merge --squash "${branch}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        execSync(`git commit --no-edit -m "${mergeCommitMessage}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        result.merged = true;
        const mergeDetails = this.collectMergeDetails(id, branch, task, mergeCommitMessage);
        task.mergeDetails = mergeDetails;
        Object.assign(result, mergeDetails);
      } catch (err: any) {
        // Squash conflict — reset and report
        try {
          execSync("git reset --merge", { cwd: this.rootDir, stdio: "pipe" });
        } catch {
          // already clean
        }
        throw new Error(
          `Merge conflict merging '${branch}'. Resolve manually:\n` +
            `  cd ${this.rootDir}\n` +
            `  git merge --squash ${branch}\n` +
            `  # resolve conflicts, then: kb task move ${id} done`,
        );
      }

      // 3. Remove worktree
      if (worktreePath && existsSync(worktreePath)) {
        try {
          execSync(`git worktree remove "${worktreePath}" --force`, {
            cwd: this.rootDir,
            stdio: "pipe",
          });
          result.worktreeRemoved = true;
        } catch {
          // Non-fatal — worktree may already be gone
        }
      }

      // 4. Delete the branch
      try {
        execSync(`git branch -d "${branch}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        result.branchDeleted = true;
      } catch {
        // Branch might not be fully merged in some edge cases; try force
        try {
          execSync(`git branch -D "${branch}"`, {
            cwd: this.rootDir,
            stdio: "pipe",
          });
          result.branchDeleted = true;
        } catch {
          // Non-fatal
        }
      }

      // 5. Move task to done
      await this.moveToDone(task, dir);
      result.task = { ...task, column: "done" };

      this.emit("task:merged", result);
      return result;
    });
  }

  /**
   * Archive all tasks currently in the "done" column.
   * Returns an array of archived tasks.
   */
  async archiveAllDone(): Promise<Task[]> {
    const tasks = await this.listTasks();
    const doneTasks = tasks.filter((t) => t.column === "done");
    
    if (doneTasks.length === 0) {
      return [];
    }

    // Archive all done tasks concurrently
    const archivedTasks = await Promise.all(
      doneTasks.map((task) => this.archiveTask(task.id))
    );

    return archivedTasks;
  }

  /**
   * Archive a done task (move from done → archived).
   * Logs the action and emits `task:moved` event.
   * @param cleanup - If true, immediately cleans up the task directory after archiving
   *                  by writing a compact entry to archive.jsonl and removing files.
   *                  Default: false for backward compatibility.
   */
  async archiveTask(id: string, cleanup: boolean = false): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (task.column !== "done") {
        throw new Error(
          `Cannot archive ${id}: task is in '${task.column}', must be in 'done'`,
        );
      }

      task.column = "archived";
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;
      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task archived",
      });

      // If cleanup requested, write archive entry BEFORE removing directory
      if (cleanup) {
        const entry: import("./types.js").ArchivedTaskEntry = {
          id: task.id,
          title: task.title,
          description: task.description,
          column: "archived",
          dependencies: task.dependencies,
          steps: task.steps,
          currentStep: task.currentStep,
          size: task.size,
          reviewLevel: task.reviewLevel,
          prInfo: task.prInfo,
          issueInfo: task.issueInfo,
          attachments: task.attachments,
          log: task.log,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          columnMovedAt: task.columnMovedAt,
          archivedAt: task.columnMovedAt,
          modelPresetId: task.modelPresetId,
          modelProvider: task.modelProvider,
          modelId: task.modelId,
          validatorModelProvider: task.validatorModelProvider,
          validatorModelId: task.validatorModelId,
          breakIntoSubtasks: task.breakIntoSubtasks,
          paused: task.paused,
          baseBranch: task.baseBranch,
          branch: task.branch,
          baseCommitSha: task.baseCommitSha,
          mergeRetries: task.mergeRetries,
          error: task.error,
          modifiedFiles: task.modifiedFiles,
        };

        // Write to archivedTasks table in SQLite
        this.db.prepare(
          `INSERT OR REPLACE INTO archivedTasks (id, data, archivedAt) VALUES (?, ?, ?)`,
        ).run(entry.id, JSON.stringify(entry), entry.archivedAt!);

        // Remove from tasks table
        this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        this.db.bumpLastModified();

        // Remove task directory recursively
        const { rm } = await import("node:fs/promises");
        await rm(dir, { recursive: true, force: true });

        // Remove from cache if watcher is active
        if (this.isWatching) {
          this.taskCache.delete(id);
        }
      } else {
        // Normal archive - update task in SQLite
        await this.atomicWriteTaskJson(dir, task);

        // Update cache if watcher is active
        if (this.isWatching) this.taskCache.set(id, { ...task });
      }

      this.emit("task:moved", { task, from: "done" as Column, to: "archived" as Column });
      return task;
    });
  }

  /**
   * Archive a task and immediately clean up its directory.
   * Convenience method equivalent to `archiveTask(id, true)`.
   */
  async archiveTaskAndCleanup(id: string): Promise<Task> {
    return this.archiveTask(id, true);
  }

  /**
   * Unarchive an archived task (move from archived → done).
   * If the task directory was cleaned up, restores from archive.jsonl first.
   * Logs the action and emits `task:moved` event.
   */
  async unarchiveTask(id: string): Promise<Task> {
    const dir = this.taskDir(id);

    // Check if directory exists BEFORE acquiring lock
    if (!existsSync(dir)) {
      // Task was cleaned up - restore from archive
      const entry = await this.findInArchive(id);
      if (!entry) {
        throw new Error(
          `Cannot unarchive ${id}: task directory missing and not found in archive`,
        );
      }

      // Restore the task directory first
      await this.restoreFromArchive(entry);
    }

    return this.withTaskLock(id, async () => {
      // Re-read task.json (either existing or freshly restored)
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (task.column !== "archived") {
        throw new Error(
          `Cannot unarchive ${id}: task is in '${task.column}', must be in 'archived'`,
        );
      }

      task.column = "done";
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;
      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task unarchived",
      });

      await this.atomicWriteTaskJson(dir, task);

      // Update cache if watcher is active
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:moved", { task, from: "archived" as Column, to: "done" as Column });
      return task;
    });
  }

  private async moveToDone(task: Task, dir: string): Promise<void> {
    task.column = "done";
    task.worktree = undefined;
    task.status = undefined;
    task.blockedBy = undefined;
    task.columnMovedAt = new Date().toISOString();
    task.updatedAt = task.columnMovedAt;

    await this.atomicWriteTaskJson(dir, task);

    // Update cache if watcher is active
    if (this.isWatching) this.taskCache.set(task.id, { ...task });

    this.emit("task:moved", { task, from: "in-review" as Column, to: "done" as Column });
  }

  // ── File-system watcher ───────────────────────────────────────────

  /**
   * Start watching for changes via SQLite polling.
   * Populates the in-memory cache and begins emitting events for
   * any task mutations.
   */
  async watch(): Promise<void> {
    if (this.watcher || this.pollInterval) return; // already watching

    // Populate cache with current state
    const tasks = await this.listTasks();
    this.taskCache.clear();
    for (const task of tasks) {
      this.taskCache.set(task.id, { ...task });
    }

    // Store current lastModified
    this.lastKnownModified = this.db.getLastModified();

    // Use a sentinel watcher object so existing code that checks `this.watcher` still works
    try {
      this.watcher = watch(this.tasksDir, { recursive: true }, (_event, filename) => {
        // No-op - we use polling now, but keep watcher for API compat
      });
      this.watcher.on("error", () => {
        // Ignore errors
      });
    } catch {
      // fs.watch may not be available - that's fine
    }

    // Poll for changes every second
    this.pollInterval = setInterval(() => {
      this.checkForChanges();
    }, 1000);
  }

  /**
   * Check for changes by comparing lastModified timestamps.
   */
  private checkForChanges(): void {
    try {
      const currentModified = this.db.getLastModified();
      if (currentModified <= this.lastKnownModified) return;
      this.lastKnownModified = currentModified;

      // Reload all tasks and diff against cache
      const rows = this.db.prepare('SELECT * FROM tasks').all() as any[];
      const currentTasks = new Map<string, Task>();
      for (const row of rows) {
        const task = this.rowToTask(row);
        currentTasks.set(task.id, task);
      }

      // Check for deleted tasks
      for (const [id, cached] of this.taskCache) {
        if (!currentTasks.has(id)) {
          this.taskCache.delete(id);
          this.emit("task:deleted", cached);
        }
      }

      // Check for new and updated tasks
      for (const [id, task] of currentTasks) {
        const cached = this.taskCache.get(id);
        if (!cached) {
          this.taskCache.set(id, { ...task });
          this.emit("task:created", task);
        } else if (cached.column !== task.column) {
          const from = cached.column;
          this.taskCache.set(id, { ...task });
          this.emit("task:moved", { task, from, to: task.column });
        } else if (JSON.stringify(cached) !== JSON.stringify(task)) {
          this.taskCache.set(id, { ...task });
          this.emit("task:updated", task);
        }
      }
    } catch {
      // Ignore polling errors
    }
  }

  /**
   * Stop watching and clean up.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.taskCache.clear();
    this.recentlyWritten.clear();
  }

  /**
   * Mark a file path as recently written by an in-process mutation
   * so the watcher will skip it.
   */
  private suppressWatcher(filePath: string): void {
    this.recentlyWritten.add(filePath);
    setTimeout(() => {
      this.recentlyWritten.delete(filePath);
    }, this.debounceMs + 100);
  }

  /**
   * Handle a raw fs.watch callback. `filename` is relative to tasksDir.
   */
  private handleFsChange(filename: string): void {
    // We only care about task.json files
    const parts = filename.split(sep);
    // Normalize for platforms that may use forward slashes
    const normalizedParts = parts.length === 1 ? filename.split("/") : parts;

    if (normalizedParts.length < 2) return;
    const taskId = normalizedParts[0];
    const file = normalizedParts[normalizedParts.length - 1];
    if (file !== "task.json") return;
    if (!/^[A-Z]+-\d+$/.test(taskId)) return;

    const fullPath = join(this.tasksDir, taskId, "task.json");

    // Check suppression
    if (this.recentlyWritten.has(fullPath)) return;

    // Debounce per task ID
    const existing = this.debounceTimers.get(taskId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      taskId,
      setTimeout(() => {
        this.debounceTimers.delete(taskId);
        this.processTaskChange(taskId, fullPath).catch(() => {
          // Ignore errors (file may have been deleted mid-read)
        });
      }, this.debounceMs),
    );
  }

  /**
   * Read a task.json from disk and diff against the cache to emit the right event.
   */
  private async processTaskChange(taskId: string, filePath: string): Promise<void> {
    const cached = this.taskCache.get(taskId);

    if (!existsSync(filePath)) {
      // Task was deleted
      if (cached) {
        this.taskCache.delete(taskId);
        this.emit("task:deleted", cached);
      }
      return;
    }

    let task: Task;
    try {
      const taskDir = join(this.tasksDir, taskId);
      task = await this.readTaskJson(taskDir);
    } catch {
      return; // File not readable or invalid JSON
    }

    if (!cached) {
      // New task
      this.taskCache.set(taskId, { ...task });
      this.emit("task:created", task);
      return;
    }

    // Check for column change → task:moved
    if (cached.column !== task.column) {
      const from = cached.column;
      this.taskCache.set(taskId, { ...task });
      this.emit("task:moved", { task, from, to: task.column });
      return;
    }

    // Check for any other field change → task:updated
    if (JSON.stringify(cached) !== JSON.stringify(task)) {
      this.taskCache.set(taskId, { ...task });
      this.emit("task:updated", task);
    }
  }

  private static ALLOWED_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/plain",
    "application/json",
    "text/yaml",
    "text/x-toml",
    "text/csv",
    "application/xml",
  ]);

  private static MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB

  async addAttachment(
    id: string,
    filename: string,
    content: Buffer,
    mimeType: string,
  ): Promise<TaskAttachment> {
    if (!TaskStore.ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(
        `Invalid mime type '${mimeType}'. Allowed: ${[...TaskStore.ALLOWED_MIME_TYPES].join(", ")}`,
      );
    }
    if (content.length > TaskStore.MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `File too large (${content.length} bytes). Maximum: ${TaskStore.MAX_ATTACHMENT_SIZE} bytes (5MB)`,
      );
    }

    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const attachDir = join(dir, "attachments");
      await mkdir(attachDir, { recursive: true });

      // Sanitize filename: keep alphanumeric, dots, hyphens, underscores
      const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storedName = `${Date.now()}-${sanitized}`;
      await writeFile(join(attachDir, storedName), content);

      const attachment: TaskAttachment = {
        filename: storedName,
        originalName: filename,
        mimeType,
        size: content.length,
        createdAt: new Date().toISOString(),
      };

      const task = await this.readTaskJson(dir);
      if (!task.attachments) task.attachments = [];
      task.attachments.push(attachment);
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);

      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);

      return attachment;
    });
  }

  async getAttachment(
    id: string,
    filename: string,
  ): Promise<{ path: string; mimeType: string }> {
    const dir = this.taskDir(id);
    const task = await this.readTaskJson(dir);
    const attachment = task.attachments?.find((a) => a.filename === filename);
    if (!attachment) {
      const err: NodeJS.ErrnoException = new Error(
        `Attachment '${filename}' not found on task ${id}`,
      );
      err.code = "ENOENT";
      throw err;
    }
    return {
      path: join(dir, "attachments", filename),
      mimeType: attachment.mimeType,
    };
  }

  async deleteAttachment(id: string, filename: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const idx = task.attachments?.findIndex((a) => a.filename === filename) ?? -1;
      if (idx === -1) {
        const err: NodeJS.ErrnoException = new Error(
          `Attachment '${filename}' not found on task ${id}`,
        );
        err.code = "ENOENT";
        throw err;
      }

      // Remove file from disk
      const filePath = join(dir, "attachments", filename);
      try {
        await unlink(filePath);
      } catch {
        // File may already be gone
      }

      task.attachments!.splice(idx, 1);
      if (task.attachments!.length === 0) {
        task.attachments = undefined;
      }
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);

      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);

      return task;
    });
  }

  /**
   * Append an agent log entry to the task's agent log file (JSONL format).
   * Each entry is a single JSON line appended to `.fusion/tasks/{ID}/agent.log`.
   * Also emits an `agent:log` event for live streaming.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @param text - The text content (delta for "text"/"thinking", tool name for "tool"/"tool_result"/"tool_error")
   * @param type - The entry type discriminator
   * @param detail - Optional human-readable summary (tool args, result summary, or error message)
   * @param agent - Optional agent role that produced this entry
   */
  async appendAgentLog(
    taskId: string,
    text: string,
    type: AgentLogEntry["type"],
    detail?: string,
    agent?: AgentLogEntry["agent"],
  ): Promise<void> {
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      taskId,
      text,
      type,
      ...(detail !== undefined && { detail }),
      ...(agent !== undefined && { agent }),
    };
    const dir = this.taskDir(taskId);
    const logPath = join(dir, "agent.log");
    await mkdir(dir, { recursive: true });
    await appendFile(logPath, JSON.stringify(entry) + "\n");
    this.emit("agent:log", entry);
  }

  async addTaskComment(id: string, text: string, author: string): Promise<Task> {
    // Delegate to unified addComment method
    return this.addComment(id, text, author);
  }

  /**
   * Add a steering comment to a task.
   * Steering comments are injected into the AI execution context.
   * They are stored in BOTH `comments` (for unified UI display) and
   * `steeringComments` (for executor real-time injection).
   * Unlike regular comments, steering comments never trigger auto-refinement.
   */
  async addSteeringComment(id: string, text: string, author: "user" | "agent" = "user"): Promise<Task> {
    // Write to unified comments (skip refinement — steering is for agent injection, not follow-up tasks)
    const task = await this.addComment(id, text, author, { skipRefinement: true });

    // Also write to steeringComments so the executor's real-time injection listener can detect new entries
    const updated = await this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const currentTask = await this.readTaskJson(dir);

      const steeringComment: import("./types.js").SteeringComment = {
        id: task.comments![task.comments!.length - 1].id,
        text,
        createdAt: new Date().toISOString(),
        author,
      };

      if (!currentTask.steeringComments) {
        currentTask.steeringComments = [];
      }
      currentTask.steeringComments.push(steeringComment);
      currentTask.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, currentTask);
      if (this.isWatching) this.taskCache.set(id, { ...currentTask });

      this.emit("task:updated", currentTask);
      return currentTask;
    });

    return updated;
  }

  async updateTaskComment(id: string, commentId: string, text: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const comments = task.comments || [];
      const comment = comments.find((entry) => entry.id === commentId);

      if (!comment) {
        throw new Error(`Comment ${commentId} not found on task ${id}`);
      }

      comment.text = text;
      comment.updatedAt = new Date().toISOString();
      task.comments = comments;
      task.updatedAt = comment.updatedAt;
      task.log.push({
        timestamp: task.updatedAt,
        action: "Comment updated",
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  async deleteTaskComment(id: string, commentId: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const currentComments = task.comments || [];
      const nextComments = currentComments.filter((entry) => entry.id !== commentId);

      if (nextComments.length === currentComments.length) {
        throw new Error(`Comment ${commentId} not found on task ${id}`);
      }

      task.comments = nextComments.length > 0 ? nextComments : undefined;
      task.updatedAt = new Date().toISOString();
      task.log.push({
        timestamp: task.updatedAt,
        action: "Comment deleted",
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Add a comment to a task.
   * Comments are injected into the AI execution context.
   * When a comment is added to a task in the "done" column by a user,
   * automatically creates a refinement task with the comment text as feedback.
   * 
   * Note: Now uses the unified comments system (TaskComment).
   */
  async addComment(
    id: string,
    text: string,
    author: string = "user",
    options?: { skipRefinement?: boolean },
  ): Promise<Task> {
    // Phase 1: Add comment under lock
    const task = await this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      // Generate unique ID: timestamp + random suffix for collision resistance
      const commentId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const comment: import("./types.js").TaskComment = {
        id: commentId,
        text,
        author,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (!task.comments) {
        task.comments = [];
      }
      task.comments.push(comment);
      task.updatedAt = new Date().toISOString();
      task.log.push({
        timestamp: task.updatedAt,
        action: `Comment added by ${author}`,
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });

    // Phase 2: Auto-refinement OUTSIDE the lock (to avoid lock contention)
    // Only create refinement for user comments on done tasks
    // Steering comments skip refinement — they are injected into the agent stream instead
    if (task.column === "done" && author === "user" && !options?.skipRefinement) {
      try {
        await this.refineTask(id, text);
      } catch {
        // Silently ignore - refinement is best-effort and shouldn't fail
        // the comment addition. refineTask already validates
        // feedback text, so empty/whitespace comments won't create refinements.
      }
    }

    return task;
  }

  /**
   * Update or clear PR information for a task.
   * Updates task.json atomically and emits `task:updated` event.
   *
   * @param id - The task ID
   * @param prInfo - The PR info to set, or null to clear
   * @returns The updated task
   */
  async updatePrInfo(
    id: string,
    prInfo: import("./types.js").PrInfo | null,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      const previous = task.prInfo;
      const badgeChanged =
        previous?.url !== prInfo?.url ||
        previous?.number !== prInfo?.number ||
        previous?.status !== prInfo?.status ||
        previous?.title !== prInfo?.title ||
        previous?.headBranch !== prInfo?.headBranch ||
        previous?.baseBranch !== prInfo?.baseBranch ||
        previous?.commentCount !== prInfo?.commentCount ||
        previous?.lastCommentAt !== prInfo?.lastCommentAt;
      const linkChanged = previous?.number !== prInfo?.number || previous?.url !== prInfo?.url;

      if (prInfo) {
        task.prInfo = prInfo;
        if (!previous || linkChanged) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "PR linked",
            outcome: `PR #${prInfo.number}: ${prInfo.url}`,
          });
        } else if (badgeChanged) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "PR updated",
            outcome: `PR #${prInfo.number} badge metadata refreshed`,
          });
        }
      } else {
        task.prInfo = undefined;
        if (previous?.number) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "PR unlinked",
            outcome: `PR #${previous.number} removed`,
          });
        }
      }

      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      if (badgeChanged) {
        this.emit("task:updated", task);
      }

      return task;
    });
  }

  /**
   * Update or clear Issue information for a task.
   * Updates task.json atomically and emits `task:updated` event.
   *
   * @param id - The task ID
   * @param issueInfo - The Issue info to set, or null to clear
   * @returns The updated task
   */
  async updateIssueInfo(
    id: string,
    issueInfo: import("./types.js").IssueInfo | null,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      const previous = task.issueInfo;
      const badgeChanged =
        previous?.url !== issueInfo?.url ||
        previous?.number !== issueInfo?.number ||
        previous?.state !== issueInfo?.state ||
        previous?.title !== issueInfo?.title ||
        previous?.stateReason !== issueInfo?.stateReason;
      const linkChanged = previous?.number !== issueInfo?.number || previous?.url !== issueInfo?.url;

      if (issueInfo) {
        task.issueInfo = issueInfo;
        if (!previous || linkChanged) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue linked",
            outcome: `Issue #${issueInfo.number}: ${issueInfo.url}`,
          });
        } else if (badgeChanged) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue updated",
            outcome: `Issue #${issueInfo.number} badge metadata refreshed`,
          });
        }
      } else {
        task.issueInfo = undefined;
        if (previous?.number) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue unlinked",
            outcome: `Issue #${previous.number} removed`,
          });
        }
      }

      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      if (badgeChanged) {
        this.emit("task:updated", task);
      }

      return task;
    });
  }

  /**
   * Read all historical agent log entries for a task from its agent log file.
   * Returns entries in chronological order (oldest first).
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @returns Array of agent log entries, empty if no log file exists
   */
  async getAgentLogs(taskId: string): Promise<AgentLogEntry[]> {
    const dir = this.taskDir(taskId);
    const logPath = join(dir, "agent.log");
    if (!existsSync(logPath)) return [];
    const content = await readFile(logPath, "utf-8");
    const entries: AgentLogEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AgentLogEntry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  // ── Archive Cleanup Methods ─────────────────────────────────────────

  /**
   * Read all archived task entries from SQLite.
   */
  async readArchiveLog(): Promise<import("./types.js").ArchivedTaskEntry[]> {
    const rows = this.db.prepare("SELECT * FROM archivedTasks ORDER BY archivedAt DESC").all() as any[];
    return rows.map((row) => JSON.parse(row.data) as import("./types.js").ArchivedTaskEntry);
  }

  /**
   * Find a specific task in the archive by ID.
   */
  async findInArchive(id: string): Promise<import("./types.js").ArchivedTaskEntry | undefined> {
    const row = this.db.prepare("SELECT * FROM archivedTasks WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return JSON.parse(row.data) as import("./types.js").ArchivedTaskEntry;
  }

  /**
   * Cleanup archived tasks by writing compact entries to archivedTasks table
   * and removing task directories. Also removes from tasks table.
   */
  async cleanupArchivedTasks(): Promise<string[]> {
    const archivedTasks = await this.listTasks().then((tasks) =>
      tasks.filter((t) => t.column === "archived"),
    );

    const cleanedUpIds: string[] = [];

    for (const task of archivedTasks) {
      const dir = this.taskDir(task.id);

      // Skip if directory already cleaned up
      if (!existsSync(dir)) {
        continue;
      }

      // Create compact archive entry (exclude agent logs)
      const entry: import("./types.js").ArchivedTaskEntry = {
        id: task.id,
        title: task.title,
        description: task.description,
        column: "archived",
        dependencies: task.dependencies,
        steps: task.steps,
        currentStep: task.currentStep,
        size: task.size,
        reviewLevel: task.reviewLevel,
        prInfo: task.prInfo,
        issueInfo: task.issueInfo,
        attachments: task.attachments,
        log: task.log,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        columnMovedAt: task.columnMovedAt,
        archivedAt: new Date().toISOString(),
        modelProvider: task.modelProvider,
        modelId: task.modelId,
        validatorModelProvider: task.validatorModelProvider,
        validatorModelId: task.validatorModelId,
        breakIntoSubtasks: task.breakIntoSubtasks,
        paused: task.paused,
        baseBranch: task.baseBranch,
        branch: task.branch,
        baseCommitSha: task.baseCommitSha,
        mergeRetries: task.mergeRetries,
        error: task.error,
        modifiedFiles: task.modifiedFiles,
      };

      // Write to archivedTasks table
      this.db.prepare(
        `INSERT OR REPLACE INTO archivedTasks (id, data, archivedAt) VALUES (?, ?, ?)`,
      ).run(entry.id, JSON.stringify(entry), entry.archivedAt);

      // Remove task from tasks table
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
      this.db.bumpLastModified();

      // Remove task directory recursively
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });

      // Remove from cache if watcher is active
      if (this.isWatching) {
        this.taskCache.delete(task.id);
      }

      cleanedUpIds.push(task.id);
    }

    return cleanedUpIds;
  }

  /**
   * Restore a task from an archive entry.
   * Recreates task directory with task.json and PROMPT.md.
   * Clears transient execution state (worktree, status, blockedBy, etc.).
   * Does NOT recreate agent.log (intentionally lost during archive).
   */
  private async restoreFromArchive(entry: import("./types.js").ArchivedTaskEntry): Promise<Task> {
    const dir = this.taskDir(entry.id);

    // Create task directory
    await mkdir(dir, { recursive: true });

    // Build restored task (clear transient fields)
    const restoredTask: Task = {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      column: "archived", // Will be changed to "done" by unarchiveTask
      dependencies: entry.dependencies,
      steps: entry.steps,
      currentStep: entry.currentStep,
      size: entry.size,
      reviewLevel: entry.reviewLevel,
      prInfo: entry.prInfo,
      issueInfo: entry.issueInfo,
      attachments: entry.attachments,
      log: [...entry.log, { timestamp: new Date().toISOString(), action: "Task restored from archive" }],
      createdAt: entry.createdAt,
      updatedAt: new Date().toISOString(),
      columnMovedAt: entry.columnMovedAt,
      modelPresetId: entry.modelPresetId,
      modelProvider: entry.modelProvider,
      modelId: entry.modelId,
      validatorModelProvider: entry.validatorModelProvider,
      validatorModelId: entry.validatorModelId,
      breakIntoSubtasks: entry.breakIntoSubtasks,
      modifiedFiles: entry.modifiedFiles,
      // Intentionally NOT restoring: worktree, status, blockedBy, paused, baseBranch, baseCommitSha, error, comments
    };

    // Write task.json
    await this.atomicWriteTaskJson(dir, restoredTask);

    // Generate PROMPT.md with preserved steps
    const prompt = this.generatePromptFromArchiveEntry(entry);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), prompt);

    // Create empty attachments directory if attachments existed
    if (entry.attachments && entry.attachments.length > 0) {
      await mkdir(join(dir, "attachments"), { recursive: true });
    }

    return restoredTask;
  }

  /**
   * Generate a PROMPT.md from an archive entry, preserving the original step structure.
   */
  private generatePromptFromArchiveEntry(entry: import("./types.js").ArchivedTaskEntry): string {
    const deps =
      entry.dependencies.length > 0
        ? entry.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    const heading = entry.title ? `${entry.id}: ${entry.title}` : entry.id;

    // Build steps section from preserved steps
    let stepsSection = "## Steps\n\n";
    if (entry.steps && entry.steps.length > 0) {
      for (let i = 0; i < entry.steps.length; i++) {
        const step = entry.steps[i];
        const status = step.status === "done" ? "[x]" : "[ ]";
        stepsSection += `### Step ${i}: ${step.name}\n\n- ${status} ${step.name}\n\n`;
      }
    } else {
      stepsSection += "### Step 0: Preflight\n\n- [ ] Review and verify\n\n";
    }

    return `# ${heading}

**Created:** ${entry.createdAt.split("T")[0]}
${entry.size ? `**Size:** ${entry.size}` : "**Size:** M"}

## Mission

${entry.description}

## Dependencies

${deps}

${stepsSection}`;
  }

  // ── Workflow Step CRUD Methods ─────────────────────────────────────

  /**
   * Create a new workflow step definition.
   * Generates a unique ID (WS-001, WS-002, etc.) and stores in config.json.
   */
  async createWorkflowStep(input: import("./types.js").WorkflowStepInput): Promise<import("./types.js").WorkflowStep> {
    return this.withConfigLock(async () => {
      const config = await this.readConfig();
      const nextWsId = config.nextWorkflowStepId || 1;
      const id = `WS-${String(nextWsId).padStart(3, "0")}`;

      const now = new Date().toISOString();
      const step: import("./types.js").WorkflowStep = {
        id,
        name: input.name,
        description: input.description,
        prompt: input.prompt || "",
        enabled: input.enabled !== undefined ? input.enabled : true,
        createdAt: now,
        updatedAt: now,
      };

      if (!config.workflowSteps) {
        config.workflowSteps = [];
      }
      config.workflowSteps.push(step);
      config.nextWorkflowStepId = nextWsId + 1;
      await this.writeConfig(config);

      return step;
    });
  }

  /**
   * List all workflow step definitions from config.json.
   */
  async listWorkflowSteps(): Promise<import("./types.js").WorkflowStep[]> {
    const config = await this.readConfig();
    return config.workflowSteps || [];
  }

  /**
   * Get a single workflow step by ID.
   */
  async getWorkflowStep(id: string): Promise<import("./types.js").WorkflowStep | undefined> {
    const config = await this.readConfig();
    return (config.workflowSteps || []).find((ws) => ws.id === id);
  }

  /**
   * Update a workflow step definition.
   * @throws Error if the workflow step is not found
   */
  async updateWorkflowStep(id: string, updates: Partial<import("./types.js").WorkflowStepInput>): Promise<import("./types.js").WorkflowStep> {
    return this.withConfigLock(async () => {
      const config = await this.readConfig();
      const steps = config.workflowSteps || [];
      const index = steps.findIndex((ws) => ws.id === id);

      if (index === -1) {
        throw new Error(`Workflow step '${id}' not found`);
      }

      const step = steps[index];
      if (updates.name !== undefined) step.name = updates.name;
      if (updates.description !== undefined) step.description = updates.description;
      if (updates.prompt !== undefined) step.prompt = updates.prompt;
      if (updates.enabled !== undefined) step.enabled = updates.enabled;
      step.updatedAt = new Date().toISOString();

      config.workflowSteps = steps;
      await this.writeConfig(config);

      return step;
    });
  }

  /**
   * Delete a workflow step definition.
   * Also removes the ID from any tasks that reference it in enabledWorkflowSteps.
   * @throws Error if the workflow step is not found
   */
  async deleteWorkflowStep(id: string): Promise<void> {
    await this.withConfigLock(async () => {
      const config = await this.readConfig();
      const steps = config.workflowSteps || [];
      const index = steps.findIndex((ws) => ws.id === id);

      if (index === -1) {
        throw new Error(`Workflow step '${id}' not found`);
      }

      steps.splice(index, 1);
      config.workflowSteps = steps;
      await this.writeConfig(config);
    });

    // Clean up references from existing tasks (best-effort, outside config lock)
    try {
      const tasks = await this.listTasks();
      for (const task of tasks) {
        if (task.enabledWorkflowSteps?.includes(id)) {
          const updated = task.enabledWorkflowSteps.filter((wsId) => wsId !== id);
          // Direct task.json mutation for enabledWorkflowSteps cleanup
          await this.withTaskLock(task.id, async () => {
            const dir = this.taskDir(task.id);
            const t = await this.readTaskJson(dir);
            t.enabledWorkflowSteps = updated.length > 0 ? updated : undefined;
            t.updatedAt = new Date().toISOString();
            await this.atomicWriteTaskJson(dir, t);
          });
        }
      }
    } catch {
      // Best-effort: task cleanup is non-critical
    }
  }

  /**
   * Close the database connection and clean up resources.
   * Call this when the store is no longer needed (e.g., short-lived per-request stores).
   */
  close(): void {
    this.stopWatching();
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getTasksDir(): string {
    return this.tasksDir;
  }

  private generateSpecifiedPrompt(task: Task): string {
    const deps =
      task.dependencies.length > 0
        ? task.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    // Get current settings to check for ntfy configuration
    const settings = this.getSettingsSync();
    const notificationsSection =
      settings.ntfyEnabled && settings.ntfyTopic
        ? `\n## Notifications\n\nntfy topic: \`${settings.ntfyTopic}\`\n`
        : "";

    const heading = task.title ? `${task.id}: ${task.title}` : task.id;
    return `# ${heading}

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

${task.description}

## Dependencies

${deps}

## Steps

### Step 1: Implementation

- [ ] Implement the required changes
- [ ] Verify changes work correctly

### Step 2: Testing & Verification

- [ ] All tests pass
- [ ] No regressions introduced

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] .DONE created

## Acceptance Criteria

- [ ] All steps complete
- [ ] All tests passing
${notificationsSection}`;
  }

  /**
   * Regenerate PROMPT.md when task title or description changes.
   * Preserves existing sections (Dependencies, Steps, File Scope, etc.) from the original prompt,
   * while updating the heading and Mission section with new values.
   */
  private regeneratePrompt(task: Task, existingPrompt: string): string {
    // Generate the new heading
    const heading = task.title ? `${task.id}: ${task.title}` : task.id;

    // Helper to extract a section by heading name
    const extractSection = (sectionName: string): string | null => {
      const regex = new RegExp(`^##\\s+${sectionName}\\s*$`, "m");
      const match = existingPrompt.match(regex);
      if (!match) return null;

      const startIdx = match.index! + match[0].length;
      const rest = existingPrompt.slice(startIdx);
      // Find next ## heading (any level) or end of string
      const nextHeading = rest.search(/\n##\\s/);
      const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
      return section.trim();
    };

    // Extract preserved sections
    const depsSection = extractSection("Dependencies");
    const stepsSection = extractSection("Steps");
    const fileScopeSection = extractSection("File Scope");
    const acceptanceSection = extractSection("Acceptance Criteria");
    const notificationsSection = extractSection("Notifications");

    // Reconstruct PROMPT.md with preserved sections
    let result = `# ${heading}\n\n**Created:** ${task.createdAt.split("T")[0]}\n**Size:** ${task.size || "M"}\n\n## Mission\n\n${task.description}\n`;

    if (depsSection !== null) {
      result += `\n## Dependencies\n\n${depsSection}\n`;
    }

    if (stepsSection !== null) {
      result += `\n## Steps\n\n${stepsSection}\n`;
    }

    if (fileScopeSection !== null) {
      result += `\n## File Scope\n\n${fileScopeSection}\n`;
    }

    if (acceptanceSection !== null) {
      result += `\n## Acceptance Criteria\n\n${acceptanceSection}\n`;
    }

    if (notificationsSection !== null) {
      result += `\n## Notifications\n\n${notificationsSection}\n`;
    }

    return result;
  }

  /**
   * Synchronous version of getSettings for internal use.
   * Returns project-level settings merged with defaults.
   * Note: This does NOT merge global settings because it's synchronous
   * and global settings require async I/O.
   */
  private getSettingsSync(): Settings {
    try {
      const row = this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as any;
      if (!row) return DEFAULT_SETTINGS;
      const settings = fromJson<Settings>(row.settings);
      return { ...DEFAULT_SETTINGS, ...settings };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  // ── Activity Log Methods ─────────────────────────────────────────

  /**
   * Record an activity log entry to the SQLite database.
   * Auto-generates ID and timestamp.
   */
  async recordActivity(entry: Omit<ActivityLogEntry, "id" | "timestamp">): Promise<ActivityLogEntry> {
    const fullEntry: ActivityLogEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };

    try {
      this.db.prepare(
        `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fullEntry.id,
        fullEntry.timestamp,
        fullEntry.type,
        fullEntry.taskId ?? null,
        fullEntry.taskTitle ?? null,
        fullEntry.details,
        fullEntry.metadata ? JSON.stringify(fullEntry.metadata) : null,
      );
      this.db.bumpLastModified();
    } catch (err) {
      // Best-effort: log errors but don't break operations
      console.error("Failed to record activity:", err);
    }

    return fullEntry;
  }

  /**
   * Get activity log entries from SQLite.
   * Returns entries sorted newest first.
   * Supports filtering by limit, since timestamp, and event type.
   */
  async getActivityLog(options?: { limit?: number; since?: string; type?: ActivityEventType }): Promise<ActivityLogEntry[]> {
    let sql = "SELECT * FROM activityLog WHERE 1=1";
    const params: any[] = [];

    if (options?.since) {
      sql += " AND timestamp > ?";
      params.push(options.since);
    }

    if (options?.type) {
      sql += " AND type = ?";
      params.push(options.type);
    }

    sql += " ORDER BY timestamp DESC";

    if (options?.limit && options.limit > 0) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      type: row.type as ActivityEventType,
      taskId: row.taskId || undefined,
      taskTitle: row.taskTitle || undefined,
      details: row.details,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  /**
   * Clear all activity log entries.
   * Use with caution - this permanently deletes activity history.
   */
  async clearActivityLog(): Promise<void> {
    this.db.prepare("DELETE FROM activityLog").run();
    this.db.bumpLastModified();
  }

  /**
   * Get the MissionStore instance for mission hierarchy operations.
   * Lazily initializes the MissionStore on first access.
   */
  getMissionStore(): MissionStore {
    if (!this.missionStore) {
      this.missionStore = new MissionStore(this.kbDir, this.db);
    }
    return this.missionStore;
  }

  // ── Backward Compatibility (Multi-Project Support) ────────────────────────

}
