import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import type { Task, TaskDetail, TaskCreateInput, TaskAttachment, AgentLogEntry, BoardConfig, Column, MergeResult, Settings, GlobalSettings, ProjectSettings, ActivityLogEntry, ActivityEventType, TaskDocument, TaskDocumentRevision, TaskDocumentCreateInput, TaskDocumentWithTask, InboxTask, TaskLogEntry, RunMutationContext, RunAuditEvent, RunAuditEventInput, RunAuditEventFilter, ArchivedTaskEntry, ArchiveAgentLogMode, TaskPriority } from "./types.js";
import { VALID_TRANSITIONS, DEFAULT_SETTINGS, isGlobalSettingsKey, WORKFLOW_STEP_TEMPLATES, validateDocumentKey } from "./types.js";
import { normalizeTaskPriority } from "./task-priority.js";
import { GlobalSettingsStore } from "./global-settings.js";
import { Database, toJson, toJsonNullable, fromJson } from "./db.js";
import { ArchiveDatabase } from "./archive-db.js";
import { detectLegacyData, migrateFromLegacy } from "./db-migrate.js";
import { MissionStore } from "./mission-store.js";
import { PluginStore } from "./plugin-store.js";
import { RoadmapStore } from "./roadmap-store.js";
import { InsightStore } from "./insight-store.js";
import { TodoStore } from "./todo-store.js";
import { BackwardCompat, ProjectRequiredError } from "./migration.js";
import { CentralCore } from "./central-core.js";
import { getTaskMergeBlocker } from "./task-merge.js";
import { ensureMemoryFileWithBackend } from "./project-memory.js";
import { runCommandAsync } from "./run-command.js";
import { createLogger } from "./logger.js";
import { validateNodeOverrideChange } from "./node-override-guard.js";

/** Database row shape for the tasks table (all columns). */
interface TaskRow {
  id: string;
  title: string | null;
  description: string;
  priority: string | null;
  column: string;
  status: string | null;
  size: string | null;
  reviewLevel: number | null;
  currentStep: number;
  worktree: string | null;
  blockedBy: string | null;
  paused: number | null;
  baseBranch: string | null;
  branch: string | null;
  baseCommitSha: string | null;
  modelPresetId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  validatorModelProvider: string | null;
  validatorModelId: string | null;
  planningModelProvider: string | null;
  planningModelId: string | null;
  mergeRetries: number | null;
  workflowStepRetries: number | null;
  stuckKillCount: number | null;
  postReviewFixCount: number | null;
  recoveryRetryCount: number | null;
  taskDoneRetryCount: number | null;
  verificationFailureCount: number | null;
  nextRecoveryAt: string | null;
  error: string | null;
  summary: string | null;
  thinkingLevel: string | null;
  executionMode: string | null;
  tokenUsageInputTokens: number | null;
  tokenUsageOutputTokens: number | null;
  tokenUsageCachedTokens: number | null;
  tokenUsageTotalTokens: number | null;
  tokenUsageFirstUsedAt: string | null;
  tokenUsageLastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  columnMovedAt: string | null;
  dependencies: string | null;
  steps: string | null;
  log: string | null;
  attachments: string | null;
  steeringComments: string | null;
  comments: string | null;
  workflowStepResults: string | null;
  prInfo: string | null;
  issueInfo: string | null;
  sourceIssueProvider: string | null;
  sourceIssueRepository: string | null;
  sourceIssueExternalIssueId: string | null;
  sourceIssueNumber: number | null;
  sourceIssueUrl: string | null;
  mergeDetails: string | null;
  breakIntoSubtasks: number | null;
  enabledWorkflowSteps: string | null;
  modifiedFiles: string | null;
  missionId: string | null;
  sliceId: string | null;
  assignedAgentId: string | null;
  assigneeUserId: string | null;
  nodeId: string | null;
  checkedOutBy: string | null;
  checkedOutAt: string | null;
}

/** Database row shape for the task_documents table. */
interface TaskDocumentRow {
  id: string;
  taskId: string;
  key: string;
  content: string;
  revision: number;
  author: string;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the task_document_revisions table. */
interface TaskDocumentRevisionRow {
  id: number;
  taskId: string;
  key: string;
  content: string;
  revision: number;
  author: string;
  metadata: string | null;
  createdAt: string;
}

/** Database row shape for the runAuditEvents table. */
interface RunAuditEventRow {
  id: string;
  timestamp: string;
  taskId: string | null;
  agentId: string;
  runId: string;
  domain: string;
  mutationType: string;
  target: string;
  metadata: string | null;
}

/** Database row shape for the config table. */
interface ConfigRow {
  nextId: number;
  settings: string | null;
  nextWorkflowStepId: number | null;
}

/** Database row shape for the activityLog table. */
interface ActivityLogRow {
  id: string;
  timestamp: string;
  type: string;
  taskId: string | null;
  taskTitle: string | null;
  details: string;
  metadata: string | null;
}

const TASK_ACTIVITY_LOG_ENTRY_LIMIT = 1_000;
const TASK_ACTIVITY_LOG_OUTCOME_LIMIT = 4_000;
const ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT = 25;
const ARCHIVE_AGENT_LOG_SNIPPET_LIMIT = 160;
const storeLog = createLogger("task-store");

/**
 * Reject branch names that would be unsafe to interpolate into a shell command.
 * The allowed set is a conservative subset of git's refname rules: alphanumerics,
 * `_`, `.`, `/`, `+`, and `-`, with the same leading/trailing/segment restrictions
 * git enforces. Any branch that fails this check is rejected before reaching the
 * shell, so no branch-name value can inject shell metacharacters.
 */
function assertSafeGitBranchName(name: string): void {
  if (
    !name ||
    name.length > 255 ||
    name.startsWith("-") ||
    name.startsWith(".") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("@{") ||
    !/^[A-Za-z0-9._/+-]+$/.test(name)
  ) {
    throw new Error(`Unsafe git branch name: ${JSON.stringify(name)}`);
  }
}

/**
 * Reject filesystem paths that would be unsafe to interpolate into a shell
 * command. Worktree paths are generated by fusion itself and are expected to
 * be absolute, but `task.worktree` is writable via the authenticated API, so
 * validate at the shell boundary as defense-in-depth.
 */
function assertSafeAbsolutePath(path: string): void {
  const isAbsolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  if (
    !path ||
    path.length > 4096 ||
    !isAbsolute ||
    path.startsWith("-") ||
    // Reject shell metacharacters, quotes, control chars, and NULs.
    /["'`$\n\r\t;&|<>()*?[\]{}\\\0]/.test(
      path.replace(/^[A-Za-z]:/, ""), // ignore the drive-letter colon on Windows
    )
  ) {
    throw new Error(`Unsafe path: ${JSON.stringify(path)}`);
  }
}

function truncateTaskLogOutcome(outcome: string | undefined): string | undefined {
  if (!outcome || outcome.length <= TASK_ACTIVITY_LOG_OUTCOME_LIMIT) {
    return outcome;
  }
  return `${outcome.slice(0, TASK_ACTIVITY_LOG_OUTCOME_LIMIT)}\n... outcome truncated to ${TASK_ACTIVITY_LOG_OUTCOME_LIMIT} characters ...`;
}

function compactTaskActivityLog(entries: TaskLogEntry[]): TaskLogEntry[] {
  const recentEntries = entries.slice(-TASK_ACTIVITY_LOG_ENTRY_LIMIT);
  return recentEntries.map((entry) => ({
    ...entry,
    outcome: truncateTaskLogOutcome(entry.outcome),
  }));
}

/**
 * Canonicalizes a settings object by stripping legacy fields that are no longer valid
 * and rewriting legacy path values left over from the kb → fn rename.
 */
function canonicalizeSettings(settings: Settings): Settings {
  // Strip legacy globalMaxConcurrent from project settings - this field was
  // deprecated in favor of the global-level maxConcurrent in concurrency settings.
  const { globalMaxConcurrent, ...rest } = settings as Settings & { globalMaxConcurrent?: number };
  const base = globalMaxConcurrent !== undefined ? (rest as Settings) : settings;

  // Rewrite legacy .kb/backups → .fusion/backups for projects upgraded from the
  // old brand so persisted settings keep working. Custom .kb/* paths are left alone.
  if (base.autoBackupDir === ".kb/backups") {
    return { ...base, autoBackupDir: ".fusion/backups" };
  }
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeWithNullDelete(
  existingValue: unknown,
  patchValue: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = isPlainObject(existingValue) ? { ...existingValue } : {};

  for (const [key, value] of Object.entries(patchValue)) {
    if (value === null) {
      delete merged[key];
      continue;
    }

    if (isPlainObject(value)) {
      const nested = deepMergeWithNullDelete(merged[key], value);
      if (nested === undefined) {
        delete merged[key];
      } else {
        merged[key] = nested;
      }
      continue;
    }

    merged[key] = value;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export interface TaskStoreEvents {
  "task:created": [task: Task];
  "task:moved": [data: { task: Task; from: Column; to: Column }];
  "task:updated": [task: Task];
  "task:deleted": [task: Task];
  "task:merged": [result: MergeResult];
  "settings:updated": [data: { settings: Settings; previous: Settings }];
  "agent:log": [entry: AgentLogEntry];
}

/**
 * Thrown by {@link TaskStore.deleteTask} when the target task is still
 * referenced by at least one other live task's `dependencies` array.
 *
 * Callers that intend to split a task into children (e.g. triage, the
 * dashboard subtask-breakdown endpoint) must rewrite or drop those
 * references *before* deleting the parent — otherwise the dependents
 * would be permanently blocked by a nonexistent id.
 */
export class TaskHasDependentsError extends Error {
  readonly taskId: string;
  readonly dependentIds: string[];

  constructor(taskId: string, dependentIds: string[]) {
    super(
      `Cannot delete task ${taskId}: still referenced as a dependency by ${dependentIds.join(", ")}. ` +
        `Rewrite or remove these dependencies before deleting.`,
    );
    this.name = "TaskHasDependentsError";
    this.taskId = taskId;
    this.dependentIds = dependentIds;
  }
}

export class TaskStore extends EventEmitter<TaskStoreEvents> {
  static async getOrCreateForProject(
    projectId?: string,
    centralCore?: CentralCore,
    globalSettingsDir?: string,
  ): Promise<TaskStore> {
    const central = centralCore ?? new CentralCore();
    let initializedHere = false;

    if (!centralCore) {
      await central.init();
      initializedHere = true;
    }

    try {
      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext(process.cwd(), projectId);
      const resolvedGlobalSettingsDir = globalSettingsDir
        ?? (process.env.VITEST === "true"
          ? join(context.workingDirectory, ".fusion-global-settings")
          : undefined);
      const store = new TaskStore(context.workingDirectory, resolvedGlobalSettingsDir);
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
  private fusionDir: string;
  private tasksDir: string;
  private configPath: string;
  /** SQLite database for structured data storage */
  private _db: Database | null = null;
  private activityListenersWired = false;
  /** Separate SQLite database for compact archived task snapshots. */
  private _archiveDb: ArchiveDatabase | null = null;

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
  /** Cached workflow steps — invalidated on create/update/delete */
  private workflowStepsCache: import("./types.js").WorkflowStep[] | null = null;
  /** Global settings store (`~/.fusion/settings.json`) */
  private globalSettingsStore: GlobalSettingsStore;
  /** Polling interval for change detection */
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** Guard flag to prevent overlapping poll cycles */
  private pollingInProgress = false;
  /** Last known modification timestamp for change detection */
  private lastKnownModified: number = 0;
  /** ISO timestamp of last poll — used to filter changed tasks */
  private lastPollTime: string | null = null;

  /** Whether the store is actively watching for changes (watcher or polling). */
  private get isWatching(): boolean {
    return this.watcher !== null || this.pollInterval !== null;
  }
  /** Cached MissionStore instance */
  private missionStore: MissionStore | null = null;
  /** Cached PluginStore instance */
  private pluginStore: PluginStore | null = null;
  /** Cached RoadmapStore instance */
  private roadmapStore: RoadmapStore | null = null;
  /** Cached InsightStore instance */
  private insightStore: InsightStore | null = null;
  /** Cached TodoStore instance */
  private todoStore: TodoStore | null = null;

  // Test-only: when true, both fusion.db and archive.db open as `:memory:`
  // SQLite connections instead of disk-backed files. Production code never
  // sets this; it's gated through an opt-in TaskStoreOptions field below.
  // Tests that need cross-instance persistence (open store A, close,
  // open store B on the same dir, expect data) must leave this false.
  private readonly inMemoryDb: boolean;

  constructor(
    private rootDir: string,
    globalSettingsDir?: string,
    options?: { inMemoryDb?: boolean },
  ) {
    super();
    this.setMaxListeners(100);
    this.fusionDir = join(rootDir, ".fusion");
    this.tasksDir = join(this.fusionDir, "tasks");
    this.configPath = join(this.fusionDir, "config.json");
    this.inMemoryDb = options?.inMemoryDb === true;
    const resolvedGlobalSettingsDir = globalSettingsDir
      ?? (process.env.VITEST === "true" ? join(rootDir, ".fusion-global-settings") : undefined);
    this.globalSettingsStore = new GlobalSettingsStore(resolvedGlobalSettingsDir);
  }

  /**
   * Get the SQLite database, initializing it on first access.
   * Also performs auto-migration from legacy file-based storage if needed.
   */
  private get db(): Database {
    if (!this._db) {
      this._db = new Database(this.fusionDir, { inMemory: this.inMemoryDb });
      this._db.init();
      // Auto-migrate legacy data if needed
      if (detectLegacyData(this.fusionDir)) {
        // Note: migrateFromLegacy is async but we need sync access.
        // The init() method handles async migration. This getter
        // just ensures the DB is available for synchronous operations.
      }
    }
    return this._db;
  }

  private get archiveDb(): ArchiveDatabase {
    if (!this._archiveDb) {
      this._archiveDb = new ArchiveDatabase(this.fusionDir, { inMemory: this.inMemoryDb });
      this._archiveDb.init();
      this.migrateLegacyArchiveEntriesToArchiveDb();
    }
    return this._archiveDb;
  }

  async init(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    
    // Initialize SQLite database
    if (!this._db) {
      this._db = new Database(this.fusionDir, { inMemory: this.inMemoryDb });
      this._db.init();
    }
    
    // Auto-migrate from legacy file-based storage
    if (detectLegacyData(this.fusionDir)) {
      await migrateFromLegacy(this.fusionDir, this._db);
    }
    await this.migrateActiveArchivedTasksToArchiveDb();
    await this.importLegacyAgentLogsOnce();

    // Write config.json for backward compatibility if it doesn't exist
    if (!existsSync(this.configPath)) {
      const config = await this.readConfig();
      try {
        await writeFile(this.configPath, JSON.stringify(config, null, 2));
      } catch (err) {
        storeLog.warn("Backward-compat config.json sync failed during init", {
          phase: "init:config-sync",
          configPath: this.configPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    
    this.setupActivityLogListeners();

    // Bootstrap project memory file if memory is enabled
    try {
      const config = await this.readConfig();
      const mergedSettings: Settings = { ...DEFAULT_SETTINGS, ...config.settings };
      if (mergedSettings.memoryEnabled !== false) {
        // Use backend-aware bootstrap to honor memoryBackendType setting
        await ensureMemoryFileWithBackend(this.rootDir, mergedSettings);
      }
    } catch (err) {
      // Non-fatal — memory bootstrap failure should not block startup
      storeLog.warn("Project-memory bootstrap failed during init", {
        phase: "init:memory-bootstrap",
        rootDir: this.rootDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Row <-> Task Conversion ────────────────────────────────────────

  /**
   * Convert a database row to a Task object, parsing JSON columns.
   */
  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title || undefined,
      description: row.description,
      priority: normalizeTaskPriority(row.priority),
      column: row.column as Column,
      status: row.status || undefined,
      size: (row.size || undefined) as Task["size"],
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
      planningModelProvider: row.planningModelProvider || undefined,
      planningModelId: row.planningModelId || undefined,
      mergeRetries: row.mergeRetries ?? undefined,
      workflowStepRetries: row.workflowStepRetries ?? undefined,
      stuckKillCount: row.stuckKillCount ?? undefined,
      postReviewFixCount: row.postReviewFixCount ?? undefined,
      recoveryRetryCount: row.recoveryRetryCount ?? undefined,
      taskDoneRetryCount: row.taskDoneRetryCount ?? undefined,
      verificationFailureCount: row.verificationFailureCount ?? undefined,
      nextRecoveryAt: row.nextRecoveryAt || undefined,
      error: row.error || undefined,
      summary: row.summary || undefined,
      thinkingLevel: (row.thinkingLevel || undefined) as Task["thinkingLevel"],
      executionMode: (row.executionMode || undefined) as Task["executionMode"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      columnMovedAt: row.columnMovedAt || undefined,
      dependencies: fromJson<string[]>(row.dependencies) || [],
      steps: fromJson<import("./types.js").TaskStep[]>(row.steps) || [],
      log: fromJson<import("./types.js").TaskLogEntry[]>(row.log) || [],
      tokenUsage: (() => {
        if (
          row.tokenUsageInputTokens === null
          || row.tokenUsageOutputTokens === null
          || row.tokenUsageCachedTokens === null
          || row.tokenUsageTotalTokens === null
          || row.tokenUsageFirstUsedAt === null
          || row.tokenUsageLastUsedAt === null
        ) {
          return undefined;
        }

        return {
          inputTokens: row.tokenUsageInputTokens,
          outputTokens: row.tokenUsageOutputTokens,
          cachedTokens: row.tokenUsageCachedTokens,
          totalTokens: row.tokenUsageTotalTokens,
          firstUsedAt: row.tokenUsageFirstUsedAt,
          lastUsedAt: row.tokenUsageLastUsedAt,
        };
      })(),
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
      sourceIssue: (() => {
        if (
          row.sourceIssueProvider === null
          || row.sourceIssueRepository === null
          || row.sourceIssueExternalIssueId === null
          || row.sourceIssueNumber === null
        ) {
          return undefined;
        }

        return {
          provider: row.sourceIssueProvider,
          repository: row.sourceIssueRepository,
          externalIssueId: row.sourceIssueExternalIssueId,
          issueNumber: row.sourceIssueNumber,
          url: row.sourceIssueUrl ?? undefined,
        };
      })(),
      mergeDetails: fromJson<import("./types.js").MergeDetails>(row.mergeDetails),
      breakIntoSubtasks: row.breakIntoSubtasks ? true : undefined,
      enabledWorkflowSteps: (() => { const e = fromJson<string[]>(row.enabledWorkflowSteps); return e && e.length > 0 ? e : undefined; })(),
      modifiedFiles: (() => { const m = fromJson<string[]>(row.modifiedFiles); return m && m.length > 0 ? m : undefined; })(),
      missionId: row.missionId || undefined,
      sliceId: row.sliceId || undefined,
      assignedAgentId: row.assignedAgentId || undefined,
      assigneeUserId: row.assigneeUserId || undefined,
      nodeId: row.nodeId || undefined,
      checkedOutBy: row.checkedOutBy || undefined,
      checkedOutAt: row.checkedOutAt || undefined,
    };
  }

  private archiveEntryToTask(entry: ArchivedTaskEntry, slim = false): Task {
    return {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      priority: normalizeTaskPriority(entry.priority),
      column: "archived",
      dependencies: entry.dependencies ?? [],
      steps: entry.steps ?? [],
      currentStep: entry.currentStep ?? 0,
      size: entry.size,
      reviewLevel: entry.reviewLevel,
      prInfo: slim ? undefined : entry.prInfo,
      issueInfo: slim ? undefined : entry.issueInfo,
      sourceIssue: slim ? undefined : entry.sourceIssue,
      attachments: slim ? undefined : entry.attachments,
      comments: entry.comments,
      log: slim ? [] : entry.log ?? [],
      timedExecutionMs: slim ? this.computeTimedExecutionMs(entry.log) : undefined,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      columnMovedAt: entry.columnMovedAt,
      modelPresetId: entry.modelPresetId,
      modelProvider: entry.modelProvider,
      modelId: entry.modelId,
      validatorModelProvider: entry.validatorModelProvider,
      validatorModelId: entry.validatorModelId,
      planningModelProvider: entry.planningModelProvider,
      planningModelId: entry.planningModelId,
      breakIntoSubtasks: entry.breakIntoSubtasks,
      modifiedFiles: slim ? undefined : entry.modifiedFiles,
      missionId: entry.missionId,
      sliceId: entry.sliceId,
      assigneeUserId: entry.assigneeUserId,
    };
  }

  private summarizeAgentLog(entries: AgentLogEntry[], totalCount: number): string | undefined {
    if (totalCount === 0) {
      return undefined;
    }

    const countsByType = new Map<string, number>();
    const countsByAgent = new Map<string, number>();
    for (const entry of entries) {
      countsByType.set(entry.type, (countsByType.get(entry.type) ?? 0) + 1);
      if (entry.agent) {
        countsByAgent.set(entry.agent, (countsByAgent.get(entry.agent) ?? 0) + 1);
      }
    }

    const typeSummary = Array.from(countsByType.entries())
      .map(([type, count]) => `${type}:${count}`)
      .join(", ");
    const agentSummary = Array.from(countsByAgent.entries())
      .map(([agent, count]) => `${agent}:${count}`)
      .join(", ");
    const recentText = entries
      .slice(-5)
      .map((entry) => {
        const source = entry.agent ? `${entry.agent}/${entry.type}` : entry.type;
        const text = (entry.detail || entry.text || "").replace(/\s+/g, " ").trim();
        const snippet = text.length > ARCHIVE_AGENT_LOG_SNIPPET_LIMIT
          ? `${text.slice(0, ARCHIVE_AGENT_LOG_SNIPPET_LIMIT)}...`
          : text;
        return snippet ? `${source}: ${snippet}` : source;
      })
      .filter(Boolean)
      .join("\n");

    return [
      `Agent log entries: ${totalCount}`,
      typeSummary ? `Types: ${typeSummary}` : undefined,
      agentSummary ? `Agents: ${agentSummary}` : undefined,
      recentText ? `Recent entries:\n${recentText}` : undefined,
    ].filter(Boolean).join("\n");
  }

  private async readPromptForArchive(taskId: string): Promise<string | undefined> {
    const promptPath = join(this.taskDir(taskId), "PROMPT.md");
    if (!existsSync(promptPath)) {
      return undefined;
    }
    return readFile(promptPath, "utf-8");
  }

  private async buildArchivedAgentLogFields(
    taskId: string,
    mode: ArchiveAgentLogMode,
  ): Promise<Pick<ArchivedTaskEntry, "agentLogMode" | "agentLogSummary" | "agentLogSnapshot" | "agentLogFull">> {
    if (mode === "none") {
      return { agentLogMode: mode };
    }

    if (mode === "full") {
      const entries = await this.getAgentLogs(taskId);
      return {
        agentLogMode: mode,
        agentLogSummary: this.summarizeAgentLog(entries, entries.length),
        agentLogFull: entries,
      };
    }

    const [totalCount, snapshot] = await Promise.all([
      this.getAgentLogCount(taskId),
      this.getAgentLogs(taskId, { limit: ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT }),
    ]);
    return {
      agentLogMode: mode,
      agentLogSummary: this.summarizeAgentLog(snapshot, totalCount),
      agentLogSnapshot: snapshot,
    };
  }

  private async taskToArchiveEntry(task: Task, archivedAt: string): Promise<ArchivedTaskEntry> {
    const settings = await this.getSettingsFast();
    const agentLogMode = settings.archiveAgentLogMode ?? "compact";
    const [prompt, agentLogFields] = await Promise.all([
      this.readPromptForArchive(task.id),
      this.buildArchivedAgentLogFields(task.id, agentLogMode),
    ]);

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      priority: normalizeTaskPriority(task.priority),
      column: "archived",
      dependencies: task.dependencies,
      steps: task.steps,
      currentStep: task.currentStep,
      size: task.size,
      reviewLevel: task.reviewLevel,
      prInfo: task.prInfo,
      issueInfo: task.issueInfo,
      sourceIssue: task.sourceIssue,
      attachments: task.attachments,
      comments: task.comments,
      prompt,
      ...agentLogFields,
      log: [{ timestamp: archivedAt, action: "Task archived" }],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      columnMovedAt: task.columnMovedAt,
      archivedAt,
      modelPresetId: task.modelPresetId,
      modelProvider: task.modelProvider,
      modelId: task.modelId,
      validatorModelProvider: task.validatorModelProvider,
      validatorModelId: task.validatorModelId,
      planningModelProvider: task.planningModelProvider,
      planningModelId: task.planningModelId,
      breakIntoSubtasks: task.breakIntoSubtasks,
      baseBranch: task.baseBranch,
      branch: task.branch,
      baseCommitSha: task.baseCommitSha,
      mergeRetries: task.mergeRetries,
      error: task.error,
      modifiedFiles: task.modifiedFiles,
      missionId: task.missionId,
      sliceId: task.sliceId,
      assigneeUserId: task.assigneeUserId,
    };
  }

  /**
   * Convert a task_documents row to a TaskDocument object.
   */
  private rowToTaskDocument(row: TaskDocumentRow): TaskDocument {
    return {
      id: row.id,
      taskId: row.taskId,
      key: row.key,
      content: row.content,
      revision: row.revision,
      author: row.author,
      metadata: fromJson<Record<string, unknown>>(row.metadata),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a task_document_revisions row to a TaskDocumentRevision object.
   */
  private rowToTaskDocumentRevision(row: TaskDocumentRevisionRow): TaskDocumentRevision {
    return {
      id: row.id,
      taskId: row.taskId,
      key: row.key,
      content: row.content,
      revision: row.revision,
      author: row.author,
      metadata: fromJson<Record<string, unknown>>(row.metadata),
      createdAt: row.createdAt,
    };
  }

  private getTaskSelectClause(slim: boolean, tableAlias?: string): string {
    if (!slim) {
      return tableAlias ? `${tableAlias}.*` : "*";
    }

    const prefix = tableAlias ? `${tableAlias}.` : "";
    return [
      "id", "title", "description", "priority", "\"column\"", "status", "size", "reviewLevel", "currentStep",
      "worktree", "blockedBy", "paused", "baseBranch", "branch", "baseCommitSha",
      "modelPresetId", "modelProvider", "modelId",
      "validatorModelProvider", "validatorModelId",
      "planningModelProvider", "planningModelId",
      "mergeRetries", "workflowStepRetries", "stuckKillCount", "postReviewFixCount", "recoveryRetryCount", "taskDoneRetryCount", "verificationFailureCount", "nextRecoveryAt",
      "error", "summary", "thinkingLevel", "executionMode",
      "tokenUsageInputTokens", "tokenUsageOutputTokens", "tokenUsageCachedTokens", "tokenUsageTotalTokens", "tokenUsageFirstUsedAt", "tokenUsageLastUsedAt",
      "createdAt", "updatedAt", "columnMovedAt",
      "dependencies", "steps", "comments", "workflowStepResults", "steeringComments",
      "attachments", "prInfo", "issueInfo", "sourceIssueProvider", "sourceIssueRepository", "sourceIssueExternalIssueId", "sourceIssueNumber", "sourceIssueUrl", "mergeDetails",
      "breakIntoSubtasks", "enabledWorkflowSteps", "modifiedFiles",
      "missionId", "sliceId", "assignedAgentId", "assigneeUserId", "nodeId",
      "checkedOutBy", "checkedOutAt",
      // `log` is fetched in slim mode so the server can aggregate
      // `timedExecutionMs` from `[timing] … in <N>ms` entries before
      // returning. The log itself is stripped from the response —
      // see `listTasks()` slim post-processing.
      "log",
    ].map((column) => `${prefix}${column}`).join(", ");
  }

  /**
   * Sum the durations of all `[timing] … in <N>ms` (or `… after <N>ms`) log
   * entries. Returns 0 when no timing entries are present.
   *
   * Mirrors the client-side `getTimedDurationMs` so slim board listings can
   * report the same total-execution figure that the task detail Stats panel
   * computes from the full log.
   */
  private computeTimedExecutionMs(log: import("./types.js").TaskLogEntry[] | undefined): number {
    if (!log || log.length === 0) return 0;
    let total = 0;
    for (const entry of log) {
      const action = typeof entry.action === "string" ? entry.action : "";
      const outcome = typeof entry.outcome === "string" ? entry.outcome : "";
      if (!action.includes("[timing]") && !outcome.includes("[timing]")) continue;
      const haystack = `${action}\n${outcome}`;
      const match = haystack.match(/(\d+(?:\.\d+)?)ms\b/i);
      if (!match) continue;
      const ms = Number(match[1]);
      if (Number.isFinite(ms)) total += ms;
    }
    return total;
  }

  private getTaskSelectClauseWithActivityLogLimit(limit: number): string {
    const columns = [
      "id", "title", "description", "priority", "\"column\"", "status", "size", "reviewLevel", "currentStep",
      "worktree", "blockedBy", "paused", "baseBranch", "branch", "baseCommitSha",
      "modelPresetId", "modelProvider", "modelId",
      "validatorModelProvider", "validatorModelId",
      "planningModelProvider", "planningModelId",
      "mergeRetries", "workflowStepRetries", "stuckKillCount", "postReviewFixCount", "recoveryRetryCount", "taskDoneRetryCount", "verificationFailureCount", "nextRecoveryAt",
      "error", "summary", "thinkingLevel", "executionMode",
      "tokenUsageInputTokens", "tokenUsageOutputTokens", "tokenUsageCachedTokens", "tokenUsageTotalTokens", "tokenUsageFirstUsedAt", "tokenUsageLastUsedAt",
      "createdAt", "updatedAt", "columnMovedAt",
      "dependencies", "steps", "attachments", "steeringComments",
      "comments", "workflowStepResults", "prInfo", "issueInfo", "sourceIssueProvider", "sourceIssueRepository", "sourceIssueExternalIssueId", "sourceIssueNumber", "sourceIssueUrl", "mergeDetails",
      "breakIntoSubtasks", "enabledWorkflowSteps", "modifiedFiles",
      "missionId", "sliceId", "assignedAgentId", "assigneeUserId", "nodeId",
      "checkedOutBy", "checkedOutAt",
    ];

    const limitedLog = `
      CASE
        WHEN json_valid(log) AND json_array_length(log) > ${limit} THEN (
          SELECT json_group_array(json(value))
          FROM (
            SELECT value
            FROM (
              SELECT key, value
              FROM json_each(tasks.log)
              ORDER BY key DESC
              LIMIT ${limit}
            )
            ORDER BY key ASC
          )
        )
        ELSE log
      END AS log
    `;

    return [...columns, limitedLog].join(", ");
  }

  /**
   * Upsert a task to the database. Used by create and update operations.
   */
  private upsertTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, priority, "column", status, size, reviewLevel, currentStep,
        worktree, blockedBy, paused, baseBranch, branch, baseCommitSha, modelPresetId, modelProvider,
        modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId, mergeRetries,
        workflowStepRetries, stuckKillCount, postReviewFixCount, recoveryRetryCount, taskDoneRetryCount, verificationFailureCount, nextRecoveryAt, error,
        summary, thinkingLevel, executionMode, tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens,
        tokenUsageTotalTokens, tokenUsageFirstUsedAt, tokenUsageLastUsedAt, createdAt, updatedAt, columnMovedAt,
        dependencies, steps, log, attachments, steeringComments,
        comments, workflowStepResults, prInfo, issueInfo,
        sourceIssueProvider, sourceIssueRepository, sourceIssueExternalIssueId, sourceIssueNumber, sourceIssueUrl,
        mergeDetails, breakIntoSubtasks, enabledWorkflowSteps, modifiedFiles, missionId, sliceId, assignedAgentId, assigneeUserId, nodeId, checkedOutBy, checkedOutAt
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        priority = excluded.priority,
        "column" = excluded."column",
        status = excluded.status,
        size = excluded.size,
        reviewLevel = excluded.reviewLevel,
        currentStep = excluded.currentStep,
        worktree = excluded.worktree,
        blockedBy = excluded.blockedBy,
        paused = excluded.paused,
        baseBranch = excluded.baseBranch,
        branch = excluded.branch,
        baseCommitSha = excluded.baseCommitSha,
        modelPresetId = excluded.modelPresetId,
        modelProvider = excluded.modelProvider,
        modelId = excluded.modelId,
        validatorModelProvider = excluded.validatorModelProvider,
        validatorModelId = excluded.validatorModelId,
        planningModelProvider = excluded.planningModelProvider,
        planningModelId = excluded.planningModelId,
        mergeRetries = excluded.mergeRetries,
        workflowStepRetries = excluded.workflowStepRetries,
        stuckKillCount = excluded.stuckKillCount,
        postReviewFixCount = excluded.postReviewFixCount,
        recoveryRetryCount = excluded.recoveryRetryCount,
        taskDoneRetryCount = excluded.taskDoneRetryCount,
        verificationFailureCount = excluded.verificationFailureCount,
        nextRecoveryAt = excluded.nextRecoveryAt,
        error = excluded.error,
        summary = excluded.summary,
        thinkingLevel = excluded.thinkingLevel,
        executionMode = excluded.executionMode,
        tokenUsageInputTokens = excluded.tokenUsageInputTokens,
        tokenUsageOutputTokens = excluded.tokenUsageOutputTokens,
        tokenUsageCachedTokens = excluded.tokenUsageCachedTokens,
        tokenUsageTotalTokens = excluded.tokenUsageTotalTokens,
        tokenUsageFirstUsedAt = excluded.tokenUsageFirstUsedAt,
        tokenUsageLastUsedAt = excluded.tokenUsageLastUsedAt,
        createdAt = excluded.createdAt,
        updatedAt = excluded.updatedAt,
        columnMovedAt = excluded.columnMovedAt,
        dependencies = excluded.dependencies,
        steps = excluded.steps,
        log = excluded.log,
        attachments = excluded.attachments,
        steeringComments = excluded.steeringComments,
        comments = excluded.comments,
        workflowStepResults = excluded.workflowStepResults,
        prInfo = excluded.prInfo,
        issueInfo = excluded.issueInfo,
        sourceIssueProvider = excluded.sourceIssueProvider,
        sourceIssueRepository = excluded.sourceIssueRepository,
        sourceIssueExternalIssueId = excluded.sourceIssueExternalIssueId,
        sourceIssueNumber = excluded.sourceIssueNumber,
        sourceIssueUrl = excluded.sourceIssueUrl,
        mergeDetails = excluded.mergeDetails,
        breakIntoSubtasks = excluded.breakIntoSubtasks,
        enabledWorkflowSteps = excluded.enabledWorkflowSteps,
        modifiedFiles = excluded.modifiedFiles,
        missionId = excluded.missionId,
        sliceId = excluded.sliceId,
        assignedAgentId = excluded.assignedAgentId,
        assigneeUserId = excluded.assigneeUserId,
        nodeId = excluded.nodeId,
        checkedOutBy = excluded.checkedOutBy,
        checkedOutAt = excluded.checkedOutAt
    `).run(
      task.id,
      task.title ?? null,
      task.description,
      normalizeTaskPriority(task.priority),
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
      task.planningModelProvider ?? null,
      task.planningModelId ?? null,
      task.mergeRetries ?? null,
      task.workflowStepRetries ?? null,
      task.stuckKillCount ?? 0,
      task.postReviewFixCount ?? 0,
      task.recoveryRetryCount ?? null,
      task.taskDoneRetryCount ?? 0,
      task.verificationFailureCount ?? 0,
      task.nextRecoveryAt ?? null,
      task.error ?? null,
      task.summary ?? null,
      task.thinkingLevel ?? null,
      task.executionMode ?? null,
      task.tokenUsage?.inputTokens ?? null,
      task.tokenUsage?.outputTokens ?? null,
      task.tokenUsage?.cachedTokens ?? null,
      task.tokenUsage?.totalTokens ?? null,
      task.tokenUsage?.firstUsedAt ?? null,
      task.tokenUsage?.lastUsedAt ?? null,
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
      task.sourceIssue?.provider ?? null,
      task.sourceIssue?.repository ?? null,
      task.sourceIssue?.externalIssueId ?? null,
      task.sourceIssue?.issueNumber ?? null,
      task.sourceIssue?.url ?? null,
      toJsonNullable(task.mergeDetails),
      task.breakIntoSubtasks ? 1 : 0,
      toJson(task.enabledWorkflowSteps || []),
      toJson(task.modifiedFiles || []),
      task.missionId ?? null,
      task.sliceId ?? null,
      task.assignedAgentId ?? null,
      task.assigneeUserId ?? null,
      task.nodeId ?? null,
      task.checkedOutBy ?? null,
      task.checkedOutAt ?? null,
    );
    this.db.bumpLastModified();
  }

  /**
   * Read a task from SQLite by ID.
   */
  private readTaskFromDb(id: string, options?: { activityLogLimit?: number }): Task | undefined {
    const selectClause = options?.activityLogLimit
      ? this.getTaskSelectClauseWithActivityLogLimit(options.activityLogLimit)
      : "*";
    const row = this.db.prepare(`SELECT ${selectClause} FROM tasks WHERE id = ?`).get(id) as unknown as TaskRow | undefined;
    if (!row) return undefined;
    return this.rowToTask(row);
  }

  /**
   * Return the ids of live tasks whose `dependencies` array contains `id`.
   *
   * Uses a SQL LIKE probe as a cheap pre-filter then parses the JSON column
   * to rule out false positives (substring matches on similar ids, matches
   * inside escaped strings, etc.).
   */
  private findLiveDependents(id: string): string[] {
    const rows = this.db
      .prepare(`SELECT id, dependencies FROM tasks WHERE dependencies LIKE ? AND id != ?`)
      .all(`%${id}%`, id) as Array<{ id: string; dependencies: string | null }>;

    const dependents: string[] = [];
    for (const row of rows) {
      if (!row.dependencies) continue;
      try {
        const deps = JSON.parse(row.dependencies) as unknown;
        if (Array.isArray(deps) && deps.includes(id)) {
          dependents.push(row.id);
        }
      } catch {
        // Malformed JSON — skip; nothing we can verify.
      }
    }
    return dependents;
  }

  /**
   * Set up event listeners for activity logging.
   * Call after init() to record task lifecycle events.
   *
   * Idempotent — repeated calls are no-ops. Without this guard, each duplicate
   * call double-registers handlers, causing the activity log to record every
   * `task:created` / `task:moved` event N times where N = number of init() calls.
   */
  private setupActivityLogListeners(): void {
    if (this.activityListenersWired) return;
    this.activityListenersWired = true;

    // Task created
    this.on("task:created", (task) => {
      this.recordActivityFromListener(
        {
          type: "task:created",
          taskId: task.id,
          taskTitle: task.title,
          details: `Task ${task.id} created${task.title ? `: ${task.title}` : ""}`,
        },
        "task:created",
      );
    });

    // Task moved
    this.on("task:moved", (data) => {
      this.recordActivityFromListener(
        {
          type: "task:moved",
          taskId: data.task.id,
          taskTitle: data.task.title,
          details: `Task ${data.task.id} moved: ${data.from} → ${data.to}`,
          metadata: { from: data.from, to: data.to },
        },
        "task:moved",
      );
    });

    // Task merged
    this.on("task:merged", (result) => {
      const status = result.merged ? "successfully merged" : "merge attempted";
      this.recordActivityFromListener(
        {
          type: "task:merged",
          taskId: result.task.id,
          taskTitle: result.task.title,
          details: `Task ${result.task.id} ${status} to main`,
          metadata: { merged: result.merged, branch: result.branch },
        },
        "task:merged",
      );
    });

    // Task updated (check for failures)
    this.on("task:updated", (task) => {
      if (task.status === "failed") {
        this.recordActivityFromListener(
          {
            type: "task:failed",
            taskId: task.id,
            taskTitle: task.title,
            details: `Task ${task.id} failed${task.error ? `: ${task.error}` : ""}`,
            metadata: task.error ? { error: task.error } : undefined,
          },
          "task:updated",
        );
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
        this.recordActivityFromListener(
          {
            type: "settings:updated",
            details: `Settings updated: ${importantChanges.join(", ")}`,
            metadata: { changes: importantChanges },
          },
          "settings:updated",
        );
      }
    });

    // Task deleted
    this.on("task:deleted", (task) => {
      this.recordActivityFromListener(
        {
          type: "task:deleted",
          taskId: task.id,
          taskTitle: task.title,
          details: `Task ${task.id} deleted${task.title ? `: ${task.title}` : ""}`,
        },
        "task:deleted",
      );
    });
  }

  private recordActivityFromListener(
    entry: Omit<ActivityLogEntry, "id" | "timestamp">,
    sourceEvent: string,
  ): void {
    this.recordActivity(entry).catch((err) => {
      storeLog.warn("Activity logging listener failed", {
        sourceEvent,
        type: entry.type,
        taskId: entry.taskId,
        error: err instanceof Error ? err.message : String(err),
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
      fileTask.priority = normalizeTaskPriority(fileTask.priority);
      return fileTask;
    } catch (err) {
      throw new Error(
        `Failed to parse task.json at ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  private async writeTaskJsonFile(dir: string, task: Task): Promise<void> {
    const taskJsonPath = join(dir, "task.json");
    const tmpPath = join(dir, "task.json.tmp");
    this.suppressWatcher(taskJsonPath);
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(task));
    await rename(tmpPath, taskJsonPath);
  }

  /**
   * Write a task to SQLite (primary store) and also write task.json to disk
   * for backward compatibility and debugging.
   */
  private async atomicWriteTaskJson(dir: string, task: Task): Promise<void> {
    this.upsertTask(task);
    // Also write to disk for backward compatibility
    await this.writeTaskJsonFile(dir, task);
  }

  /**
   * Write a task to SQLite and optionally record a run-audit event, all in a single
   * SQLite transaction. If the audit insert fails, the task mutation is rolled back.
   *
   * @param dir - Task directory path
   * @param task - Task to write
   * @param auditInput - Optional audit event input to record atomically with the task write
   */
  private async atomicWriteTaskJsonWithAudit(
    dir: string,
    task: Task,
    auditInput?: RunAuditEventInput,
  ): Promise<void> {
    this.db.transaction(() => {
      // Upsert the task
      this.upsertTask(task);

      // Optionally record the audit event in the same transaction
      if (auditInput) {
        const eventId = randomUUID();
        const timestamp = auditInput.timestamp ?? new Date().toISOString();
        this.db.prepare(`
          INSERT INTO runAuditEvents (
            id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          eventId,
          timestamp,
          auditInput.taskId ?? null,
          auditInput.agentId,
          auditInput.runId,
          auditInput.domain,
          auditInput.mutationType,
          auditInput.target,
          toJsonNullable(auditInput.metadata),
        );
      }
    });

    // File writes are not part of the SQLite transaction
    await this.writeTaskJsonFile(dir, task);
  }

  /**
   * Get merged settings: global defaults ← global user prefs ← project overrides.
   *
   * Returns the combined view that most consumers should use. Project-level
   * values in `.fusion/config.json` override global values from `~/.fusion/settings.json`.
   *
   *
   */
  async getSettings(): Promise<Settings> {
    const [globalSettings, config] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.readConfig(),
    ]);
    return canonicalizeSettings({
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...config.settings,
    });
  }

  /**
   * Fast-path settings read that skips the expensive workflow steps query.
   *
   * This method reads only the `settings` column from the SQLite config row
   * (avoiding `readConfig()` which always calls `listWorkflowSteps()`), and
   * uses the cached global settings from `GlobalSettingsStore`. Use this for
   * read-heavy paths like the settings page that don't need workflow steps.
   *
   * Note: Do NOT use this method when you need workflow steps — use `getSettings()` instead.
   *
   *
   */
  async getSettingsFast(): Promise<Settings> {
    const [globalSettings, row] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined,
    ]);

    const projectSettings = row?.settings ? fromJson<Settings>(row.settings) : undefined;

    return canonicalizeSettings({
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...projectSettings,
    });
  }

  /**
   * Get settings separated by scope. Returns both the global and
   * project-level settings independently (useful for the UI to show
   * which scope a value comes from).
   *
   *
   */
  async getSettingsByScope(): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    const [globalSettings, config] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.readConfig(),
    ]);

    // Extract only project-level keys from config.settings
    const projectSettings: Partial<ProjectSettings> = {};
    if (config.settings) {
      for (const key of Object.keys(config.settings)) {
        if (!isGlobalSettingsKey(key)) {
          (projectSettings as Record<string, unknown>)[key] = (config.settings as Record<string, unknown>)[key];
        }
      }
    }

    // Apply canonicalization to both the project settings and the merged result
    const canonicalizedProject = canonicalizeSettings(projectSettings as Settings);

    return { global: globalSettings, project: canonicalizedProject };
  }

  /**
   * Fast-path version of `getSettingsByScope()` that skips the expensive
   * `listWorkflowSteps()` query.
   *
   * This method reads only the `settings` column from the SQLite config row
   * (avoiding `readConfig()` which always calls `listWorkflowSteps()`), and
   * uses the cached global settings from `GlobalSettingsStore`. Use this for
   * read-heavy paths like the settings page that don't need workflow steps.
   *
   *
   */
  async getSettingsByScopeFast(): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    const [globalSettings, row] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined,
    ]);

    const projectSettings = row?.settings ? fromJson<Settings>(row.settings) : undefined;

    // Extract only project-level keys from config.settings
    const projectScoped: Partial<ProjectSettings> = {};
    if (projectSettings) {
      for (const key of Object.keys(projectSettings)) {
        if (!isGlobalSettingsKey(key)) {
          (projectScoped as Record<string, unknown>)[key] = (projectSettings as Record<string, unknown>)[key];
        }
      }
    }

    // Apply canonicalization to the project settings
    const canonicalizedProject = canonicalizeSettings(projectScoped as Settings);

    return { global: globalSettings, project: canonicalizedProject };
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
      if (!isGlobalSettingsKey(key)) {
        (projectPatch as Record<string, unknown>)[key] = value;
      }
    }

    return this.withConfigLock(async () => {
      const config = this.readConfigFast();

      // Handle null values as "delete this key from settings"
      // This allows the frontend to explicitly clear a setting by sending null
      // (since JSON.stringify drops undefined keys, we use null as a sentinel)

      // Handle special null-as-delete semantics for promptOverrides
      const incomingPromptOverrides = (projectPatch as Record<string, unknown>)["promptOverrides"];
      if (incomingPromptOverrides === null) {
        // promptOverrides: null → clear the entire promptOverrides object
        delete (config.settings as unknown as Record<string, unknown>)["promptOverrides"];
        delete (projectPatch as Record<string, unknown>)["promptOverrides"];
      } else if (
        incomingPromptOverrides !== undefined &&
        typeof incomingPromptOverrides === "object" &&
        incomingPromptOverrides !== null
      ) {
        // promptOverrides: { key: value } → merge with existing, treating null values as delete
        const incomingMap = incomingPromptOverrides as Record<string, unknown>;
        const existingMap = ((config.settings as unknown as Record<string, unknown>)["promptOverrides"] as Record<string, string>) ?? {};
        const mergedMap: Record<string, string> = { ...existingMap };

        for (const [key, value] of Object.entries(incomingMap)) {
          if (value === null) {
            // null → delete this specific key
            delete mergedMap[key];
          } else if (typeof value === "string" && value !== "") {
            // non-empty string → set this key
            // Empty strings are treated as "clear" and not stored
            mergedMap[key] = value;
          }
          // Empty strings are silently ignored (treated as "clear")
        }

        // If merged map is empty, remove the entire promptOverrides
        if (Object.keys(mergedMap).length === 0) {
          delete (config.settings as unknown as Record<string, unknown>)["promptOverrides"];
          delete (projectPatch as Record<string, unknown>)["promptOverrides"];
        } else {
          (config.settings as unknown as Record<string, unknown>)["promptOverrides"] = mergedMap;
          (projectPatch as Record<string, unknown>)["promptOverrides"] = mergedMap;
        }
      }

      // Handle deep merge + targeted null clear semantics for remoteAccess
      const incomingRemoteAccess = (projectPatch as Record<string, unknown>)["remoteAccess"];
      if (incomingRemoteAccess === null) {
        delete (config.settings as unknown as Record<string, unknown>)["remoteAccess"];
        delete (projectPatch as Record<string, unknown>)["remoteAccess"];
      } else if (isPlainObject(incomingRemoteAccess)) {
        const existingRemoteAccess = (config.settings as unknown as Record<string, unknown>)["remoteAccess"];
        const mergedRemoteAccess = deepMergeWithNullDelete(existingRemoteAccess, incomingRemoteAccess);

        if (mergedRemoteAccess === undefined) {
          delete (config.settings as unknown as Record<string, unknown>)["remoteAccess"];
          delete (projectPatch as Record<string, unknown>)["remoteAccess"];
        } else {
          (config.settings as unknown as Record<string, unknown>)["remoteAccess"] = mergedRemoteAccess;
          (projectPatch as Record<string, unknown>)["remoteAccess"] = mergedRemoteAccess;
        }
      }

      // Handle null values for other top-level keys (non-promptOverrides)
      for (const key of Object.keys(projectPatch)) {
        if ((projectPatch as Record<string, unknown>)[key] === null) {
          delete (config.settings as unknown as Record<string, unknown>)[key];
          delete (projectPatch as Record<string, unknown>)[key];
        }
      }

      // Handle experimentalFeatures merging (similar to promptOverrides)
      const incomingExperimentalFeatures = (projectPatch as Record<string, unknown>)["experimentalFeatures"];
      if (
        incomingExperimentalFeatures !== undefined &&
        typeof incomingExperimentalFeatures === "object" &&
        incomingExperimentalFeatures !== null &&
        !Array.isArray(incomingExperimentalFeatures)
      ) {
        // experimentalFeatures: { key: value } → merge with existing
        const incomingMap = incomingExperimentalFeatures as Record<string, unknown>;
        const existingMap = ((config.settings as unknown as Record<string, unknown>)["experimentalFeatures"] as Record<string, boolean>) ?? {};
        const mergedMap: Record<string, boolean> = { ...existingMap };

        for (const [key, value] of Object.entries(incomingMap)) {
          // null values remove the feature
          if (value === null) {
            delete mergedMap[key];
          } else if (typeof value === "boolean") {
            mergedMap[key] = value;
          }
        }

        (config.settings as unknown as Record<string, unknown>)["experimentalFeatures"] = mergedMap;
        (projectPatch as Record<string, unknown>)["experimentalFeatures"] = mergedMap;
      }

      const globalSettings = await this.globalSettingsStore.getSettings();
      const previousMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...config.settings } as Settings;
      const updatedProjectSettings = { ...config.settings, ...projectPatch };
      config.settings = updatedProjectSettings as Settings;
      await this.writeConfig(config);
      const updatedMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...updatedProjectSettings } as Settings;
      this.emit("settings:updated", { settings: updatedMerged, previous: previousMerged });

      // Bootstrap project memory file when memory is toggled on
      if (updatedMerged.memoryEnabled !== false && previousMerged.memoryEnabled === false) {
        try {
          // Use backend-aware bootstrap to honor memoryBackendType setting
          await ensureMemoryFileWithBackend(this.rootDir, updatedMerged);
        } catch (err) {
          // Non-fatal — memory bootstrap failure should not block settings update
          storeLog.warn("Project-memory bootstrap failed after memory toggle-on", {
            phase: "updateSettings:memory-toggle-on",
            rootDir: this.rootDir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return updatedMerged;
    });
  }

  /**
   * Update global (user-level) settings in `~/.fusion/settings.json`.
   *
   * These settings persist across all fn projects for the current user.
   * Only fields defined in `GlobalSettings` are accepted.
   */
  async updateGlobalSettings(patch: Partial<GlobalSettings>): Promise<Settings> {
    // Read previous state BEFORE writing so the diff is correct
    const previousGlobal = await this.globalSettingsStore.getSettings();
    const config = this.readConfigFast();
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
    const row = this.db.prepare("SELECT * FROM config WHERE id = 1").get() as unknown as ConfigRow | undefined;
    if (!row) {
      return { nextId: 1 };
    }
    const config: BoardConfig = {
      nextId: row.nextId || 1,
      settings: fromJson<Settings>(row.settings),
    };

    // Backward-compatibility for internal callers/tests that still access these fields.
    // Keep them non-enumerable so config.json writes don't include workflow steps.
    const workflowSteps = this.listWorkflowSteps();
    Object.defineProperty(config, "workflowSteps", {
      value: await workflowSteps,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(config, "nextWorkflowStepId", {
      value: row.nextWorkflowStepId || 1,
      writable: true,
      configurable: true,
      enumerable: false,
    });

    return config;
  }

  /**
   * Fast-path config read that skips the expensive listWorkflowSteps() query.
   * Returns only the core config fields needed for config.json serialization.
   */
  private readConfigFast(): BoardConfig {
    const row = this.db.prepare("SELECT * FROM config WHERE id = 1").get() as ConfigRow | undefined;
    if (!row) {
      return { nextId: 1 };
    }
    return {
      nextId: row.nextId || 1,
      settings: fromJson<Settings>(row.settings),
    };
  }

  private async writeConfig(
    config: BoardConfig,
    options?: { nextWorkflowStepId?: number },
  ): Promise<void> {
    const now = new Date().toISOString();
    const row = this.db
      .prepare("SELECT nextWorkflowStepId FROM config WHERE id = 1")
      .get() as { nextWorkflowStepId?: number } | undefined;
    const nextWorkflowStepId = options?.nextWorkflowStepId ?? row?.nextWorkflowStepId ?? 1;

    const legacyWorkflowSteps = (config as { workflowSteps?: unknown }).workflowSteps;
    const workflowStepsJson = Array.isArray(legacyWorkflowSteps)
      ? JSON.stringify(legacyWorkflowSteps)
      : "[]";

    // Use INSERT OR REPLACE to ensure the config row exists (handles edge case where row is missing)
    this.db.prepare(
      `INSERT OR REPLACE INTO config (id, nextId, nextWorkflowStepId, settings, workflowSteps, updatedAt) 
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      config.nextId || 1,
      nextWorkflowStepId,
      JSON.stringify(config.settings || {}),
      workflowStepsJson,
      now,
    );
    this.db.bumpLastModified();
    // Also write config.json to disk for backward compatibility
    try {
      const tmpPath = this.configPath + ".tmp";
      await writeFile(tmpPath, JSON.stringify(config, null, 2));
      await rename(tmpPath, this.configPath);
    } catch (err) {
      // Best-effort: SQLite is the primary store
      storeLog.warn("Backward-compat config.json sync failed after config write", {
        phase: "writeConfig:disk-sync",
        configPath: this.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async allocateId(): Promise<string> {
    // Use withConfigLock to ensure the entire ID allocation + config sync is serialized
    return this.withConfigLock(async () => {
      const id = this.db.transaction(() => {
        const row = this.db.prepare("SELECT nextId, settings FROM config WHERE id = 1").get() as unknown as { nextId: number; settings: string | null } | undefined;
        const settings = fromJson<Settings>(row?.settings ?? null);
        const prefix = settings?.taskPrefix || "KB";
        const nextId = row?.nextId || 1;
        const taskId = `${prefix}-${String(nextId).padStart(3, "0")}`;
        this.db.prepare("UPDATE config SET nextId = ? WHERE id = 1").run(nextId + 1);
        this.db.bumpLastModified();
        return taskId;
      }); // Database.transaction() directly executes and returns the result

      // Sync config.json to disk for backward compatibility.
      // Use readConfigFast() to avoid the expensive listWorkflowSteps() query.
      try {
        const config = this.readConfigFast();
        const tmpPath = this.configPath + ".tmp";
        await writeFile(tmpPath, JSON.stringify(config, null, 2));
        await rename(tmpPath, this.configPath);
      } catch (err) {
        // Non-fatal: SQLite is the primary store
        storeLog.warn("Backward-compat config.json sync failed after ID allocation", {
          phase: "allocateId:disk-sync",
          configPath: this.configPath,
          taskId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return id;
    });
  }

  private taskDir(id: string): string {
    return join(this.tasksDir, id);
  }

  private getBuiltInWorkflowTemplate(templateId: string): import("./types.js").WorkflowStepTemplate | undefined {
    return WORKFLOW_STEP_TEMPLATES.find((template) => template.id === templateId);
  }

  private toBuiltInWorkflowStep(template: import("./types.js").WorkflowStepTemplate): import("./types.js").WorkflowStep {
    const now = new Date().toISOString();
    return {
      id: template.id,
      templateId: template.id,
      name: template.name,
      description: template.description,
      mode: "prompt",
      phase: "pre-merge",
      prompt: template.prompt,
      toolMode: template.toolMode || "readonly",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  private toStoredWorkflowStep(row: {
    id: string;
    templateId: string | null;
    name: string;
    description: string;
    mode: string;
    phase: string | null;
    prompt: string;
    toolMode: string | null;
    scriptName: string | null;
    enabled: number;
    defaultOn: number | null;
    modelProvider: string | null;
    modelId: string | null;
    createdAt: string;
    updatedAt: string;
  }): import("./types.js").WorkflowStep {
    return {
      id: row.id,
      templateId: row.templateId ?? undefined,
      name: row.name,
      description: row.description,
      mode: row.mode === "script" ? "script" : "prompt",
      phase: row.phase === "post-merge" ? "post-merge" : "pre-merge",
      prompt: row.prompt || "",
      toolMode: row.toolMode === "coding" || row.toolMode === "readonly" ? row.toolMode : undefined,
      scriptName: row.scriptName ?? undefined,
      enabled: Boolean(row.enabled),
      defaultOn: row.defaultOn === null || row.defaultOn === undefined ? undefined : Boolean(row.defaultOn),
      modelProvider: row.modelProvider ?? undefined,
      modelId: row.modelId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private getLegacyWorkflowStepSnapshot(id: string, templateId?: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare("SELECT workflowSteps FROM config WHERE id = 1")
      .get() as { workflowSteps?: string | null } | undefined;
    const legacySteps = fromJson<Array<Record<string, unknown>>>(row?.workflowSteps);
    if (!Array.isArray(legacySteps)) {
      return undefined;
    }

    return legacySteps.find((legacy) => {
      if (!legacy || typeof legacy !== "object") return false;
      if (legacy.id === id) return true;
      return Boolean(templateId && legacy.templateId === templateId);
    });
  }

  private applyLegacyWorkflowStepOverrides(step: import("./types.js").WorkflowStep): import("./types.js").WorkflowStep {
    const legacy = this.getLegacyWorkflowStepSnapshot(step.id, step.templateId);
    if (!legacy) {
      return step;
    }

    const normalized = { ...step };
    if (!Object.prototype.hasOwnProperty.call(legacy, "mode")) {
      normalized.mode = "prompt";
    }
    if (!Object.prototype.hasOwnProperty.call(legacy, "phase")) {
      normalized.phase = undefined;
    }

    return normalized;
  }

  private async ensureWorkflowStepForTemplate(templateId: string): Promise<import("./types.js").WorkflowStep> {
    const template = this.getBuiltInWorkflowTemplate(templateId);
    if (!template) {
      throw new Error(`Workflow step template '${templateId}' not found`);
    }

    const existing = await this.getWorkflowStep(templateId);
    if (existing && existing.id !== templateId) {
      return existing;
    }

    const allSteps = await this.listWorkflowSteps();
    const byName = allSteps.find((step) => step.name.toLowerCase() === template.name.toLowerCase());
    if (byName) {
      return byName;
    }

    return this.createWorkflowStep({
      templateId: template.id,
      name: template.name,
      description: template.description,
      mode: "prompt",
      phase: "pre-merge",
      prompt: template.prompt,
      toolMode: template.toolMode || "readonly",
      enabled: true,
    });
  }

  private async resolveEnabledWorkflowSteps(stepIds?: string[]): Promise<string[] | undefined> {
    if (!stepIds?.length) return undefined;

    const resolved: string[] = [];
    const seen = new Set<string>();

    for (const rawId of stepIds) {
      const stepId = rawId.trim();
      if (!stepId) continue;

      const template = this.getBuiltInWorkflowTemplate(stepId);
      const resolvedId = template
        ? (await this.ensureWorkflowStepForTemplate(stepId)).id
        : stepId;

      if (!seen.has(resolvedId)) {
        seen.add(resolvedId);
        resolved.push(resolvedId);
      }
    }

    return resolved.length > 0 ? resolved : undefined;
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
    const title = input.title?.trim() || undefined;
    const shouldSummarize =
      !title && // Only if no title provided
      input.description.length > 200 && // Only if description is long enough
      (input.summarize === true || // Explicit request
        options?.settings?.autoSummarizeTitles === true); // Auto-enabled

    // Determine enabledWorkflowSteps: explicit input takes precedence, otherwise auto-apply default-on steps
    let resolvedWorkflowSteps: string[] | undefined = input.enabledWorkflowSteps?.length
      ? await this.resolveEnabledWorkflowSteps(input.enabledWorkflowSteps)
      : undefined;

    // When enabledWorkflowSteps is not provided at all (undefined), auto-apply default-on workflow steps
    if (input.enabledWorkflowSteps === undefined) {
      try {
        const allSteps = await this.listWorkflowSteps();
        const defaultOnSteps = allSteps
          .filter((ws) => ws.enabled && ws.defaultOn)
          .map((ws) => ws.id);
        if (defaultOnSteps.length > 0) {
          resolvedWorkflowSteps = defaultOnSteps;
        }
      } catch (err) {
        // Non-fatal: default-on resolution is best-effort
        storeLog.warn("Failed to auto-apply default workflow steps during task creation; auto-defaulting skipped", {
          phase: "createTask:workflow-auto-default",
          skippedAutoDefaulting: true,
          error: err instanceof Error ? err.message : String(err),
          descriptionLength: input.description.length,
        });
      }
    } else if (input.enabledWorkflowSteps.length === 0) {
      // Explicitly empty array — user intentionally selected no steps
      resolvedWorkflowSteps = undefined;
    }

    // Create the task immediately with current title (may be undefined)
    const task = await this._createTaskInternal(input, title, resolvedWorkflowSteps, id);

    // Fire async background handler for title summarization (non-blocking)
    if (shouldSummarize && options?.onSummarize) {
      Promise.resolve().then(async () => {
        try {
          const generatedTitle = await options.onSummarize!(input.description);
          const normalizedTitle = generatedTitle?.trim();
          if (normalizedTitle) {
            // Guard against races: read directly from SQLite to avoid extra
            // prompt/step file I/O in this background path.
            const currentTask = this.readTaskFromDb(id);
            if (currentTask && !currentTask.title) {
              await this.updateTask(id, { title: normalizedTitle });
            }
          }
        } catch (err) {
          const autoEnabled = options?.settings?.autoSummarizeTitles === true;
          const errorMessage = err instanceof Error ? err.message : String(err);
          storeLog.warn(
            `Title summarization failed for task ${id}: ${errorMessage} (desc length: ${input.description.length}, auto-summarize: ${autoEnabled})`,
            {
              taskId: id,
              descriptionLength: input.description.length,
              autoSummarizeEnabled: autoEnabled,
              error: errorMessage,
            },
          );
        }
      }).catch((err) => {
        const autoEnabled = options?.settings?.autoSummarizeTitles === true;
        storeLog.error("Unexpected title summarization promise-chain failure", {
          taskId: id,
          descriptionLength: input.description.length,
          autoSummarizeEnabled: autoEnabled,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return task;
  }

  /**
   * Internal helper for task creation. Used by createTask() and potentially other
   * internal methods that need to create tasks without triggering summarization.
   */
  private async _createTaskInternal(
    input: TaskCreateInput,
    title: string | undefined,
    resolvedWorkflowSteps: string[] | undefined,
    id: string
  ): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id,
      title,
      description: input.description,
      priority: normalizeTaskPriority(input.priority),
      tokenUsage: input.tokenUsage,
      sourceIssue: input.sourceIssue,
      column: input.column || "triage",
      dependencies: input.dependencies || [],
      breakIntoSubtasks: input.breakIntoSubtasks === true ? true : undefined,
      enabledWorkflowSteps: resolvedWorkflowSteps,
      modelPresetId: input.modelPresetId,
      assignedAgentId: input.assignedAgentId,
      assigneeUserId: input.assigneeUserId,
      nodeId: input.nodeId,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      validatorModelProvider: input.validatorModelProvider,
      validatorModelId: input.validatorModelId,
      planningModelProvider: input.planningModelProvider,
      planningModelId: input.planningModelId,
      thinkingLevel: input.thinkingLevel,
      reviewLevel: input.reviewLevel,
      executionMode: input.executionMode,
      missionId: input.missionId,
      sliceId: input.sliceId,
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
      priority: normalizeTaskPriority(sourceTask.priority),
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

    // Derive a readable source label for the refinement title.
    // Precedence: title → first non-empty line of description (collapsed) → task ID
    let sourceLabel: string;
    if (sourceTask.title?.trim()) {
      sourceLabel = sourceTask.title.trim();
    } else {
      const firstLine = sourceTask.description
        .split("\n")
        .map((line: string) => line.trim())
        .find((line: string) => line.length > 0);
      if (firstLine) {
        sourceLabel = firstLine.replace(/\s+/g, " ");
      } else {
        sourceLabel = sourceTask.id;
      }
    }

    // Create new refinement task
    const newTask: Task = {
      id: newId,
      title: `Refinement: ${sourceLabel}`,
      description: `${feedback.trim()}\n\nRefines: ${id}`,
      priority: normalizeTaskPriority(sourceTask.priority),
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
  async getTask(id: string, options?: { activityLogLimit?: number }): Promise<TaskDetail> {
    return this.withTaskLock(id, async () => {
      const task = this.readTaskFromDb(id, options);
      if (!task) {
        const archived = this.archiveDb.get(id);
        if (!archived) {
          throw new Error(`Task ${id} not found`);
        }
        const archivedTask = this.archiveEntryToTask(archived, false);
        return {
          ...archivedTask,
          prompt: archived.prompt ?? this.generatePromptFromArchiveEntry(archived),
        };
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
    });
  }

  async listTasks(options?: {
    limit?: number;
    offset?: number;
    /** When false, exclude tasks in the `archived` column. Default: true (backward compatible). */
    includeArchived?: boolean;
    /** When true, omit heavy fields (log, comments, steps, workflowStepResults, steeringComments)
     *  from each row to make list responses cheap for board-style consumers. Detail fields default
     *  to empty arrays in the returned Task objects; use `getTask(id)` to load full data. */
    slim?: boolean;
    /** Restrict to a single column (e.g. 'in-review' for the auto-merge sweep). */
    column?: Column;
  }): Promise<Task[]> {
    const includeArchived = options?.includeArchived ?? true;
    const slim = options?.slim ?? false;
    const columnFilter = options?.column;

    // Slim mode drops ONLY the agent log column. On busy boards `log` accounts
    // for ~99% of the row payload (60+ MB across 1200 tasks); every other JSON
    // column combined is under 500 KB and is needed by the board UI:
    //   - `steps`            → step progress badge on TaskCard
    //   - `comments`         → comment count badge on TaskCard
    //   - `workflowStepResults` → workflow status indicators
    //   - `steeringComments` → steering badge
    // Use `getTask(id)` to load the full row (including `log`) for the
    // TaskDetailModal's Activity tab and Agent Log subview.
    const selectClause = this.getTaskSelectClause(slim);
    const whereParts: string[] = [];
    const params: string[] = [];
    if (columnFilter) {
      whereParts.push(`"column" = ?`);
      params.push(columnFilter);
    } else if (!includeArchived) {
      whereParts.push(`"column" != 'archived'`);
    }
    const whereClause = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const sql = `SELECT ${selectClause} FROM tasks${whereClause} ORDER BY createdAt ASC`;

    const rows = this.db.prepare(sql).all(...params);
    const activeTasks = await Promise.all((rows as unknown as TaskRow[]).map(async (row) => {
      const task = this.rowToTask(row);

      // Slim path: aggregate the timed-execution total server-side, then
      // strip the heavy log payload from the wire response. Without this
      // the board card has no way to display the same total-execution
      // figure that the task detail panel shows.
      if (slim) {
        task.timedExecutionMs = this.computeTimedExecutionMs(task.log);
        task.log = [];
      }

      if (!slim || task.steps.length > 0) {
        return task;
      }

      const steps = await this.parseStepsFromPrompt(task.id);
      return steps.length > 0 ? { ...task, steps } : task;
    }));
    const archivedTasks = includeArchived && (!columnFilter || columnFilter === "archived")
      ? this.archiveDb.list().map((entry) => this.archiveEntryToTask(entry, slim))
      : [];
    const tasks = [...activeTasks, ...archivedTasks];

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

  /**
   * Returns the ID of a task currently in an active merge status ("merging" or
   * "merging-pr"), optionally excluding a specific task ID.
   *
   * This is a lightweight database-level check used as a cross-process guard:
   * multiple engine processes share the same SQLite database, but each has its
   * own in-memory merge queue. Without this check, two processes can start
   * merging different tasks simultaneously.
   */
  getActiveMergingTask(excludeTaskId?: string): string | undefined {
    const sql = excludeTaskId
      ? `SELECT id FROM tasks WHERE status IN ('merging', 'merging-pr') AND id != ? LIMIT 1`
      : `SELECT id FROM tasks WHERE status IN ('merging', 'merging-pr') LIMIT 1`;
    const params = excludeTaskId ? [excludeTaskId] : [];
    const row = this.db.prepare(sql).get(...params) as { id: string } | undefined;
    return row?.id;
  }

  /**
   * Search tasks by full-text query across title, ID, description, and comments.
   * Uses SQLite FTS5 for fast tokenized matching with relevance ranking.
   * Falls back to listTasks() for empty/whitespace-only queries.
   *
   * @param query - The search query string
   * @param options - Optional limit and offset for pagination
   */
  async searchTasks(query: string, options?: { limit?: number; offset?: number; slim?: boolean; includeArchived?: boolean }): Promise<Task[]> {
    // Fall back to listTasks for empty/whitespace-only queries
    const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      return this.listTasks(options);
    }

    // Sanitize query: strip FTS5 operators so both code paths see the same token set
    const sanitizedTokens = trimmedQuery
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => token.replace(/["{}:*^+()]/g, ""))
      .filter((token) => token.length > 0);

    if (sanitizedTokens.length === 0) {
      return this.listTasks(options);
    }

    const limit = options?.limit ?? -1;
    const offset = options?.offset ?? 0;
    const offsetClause = offset > 0 ? ` OFFSET ${offset}` : "";
    const includeArchived = options?.includeArchived ?? true;
    const slim = options?.slim ?? false;
    const selectClause = this.getTaskSelectClause(slim, "t");

    let rows: TaskRow[];
    if (this.db.fts5Available) {
      // For FTS5 MATCH, quote tokens that contain special characters like hyphens
      // to prevent them from being interpreted as operators
      const ftsQuery = sanitizedTokens
        .map((token) => {
          if (/[":(){}*^+-]/.test(token)) {
            return `"${token.replace(/"/g, '\\"')}"`;
          }
          return token;
        })
        .join(" OR ");
      const whereClause = includeArchived ? "" : ` AND t."column" != 'archived'`;
      rows = this.db.prepare(`
        SELECT ${selectClause} FROM tasks t
        JOIN tasks_fts fts ON t.rowid = fts.rowid
        WHERE tasks_fts MATCH ?
        ${whereClause}
        ORDER BY rank
        LIMIT ${limit >= 0 ? limit : -1}${offsetClause}
      `).all(ftsQuery) as unknown as TaskRow[];
    } else {
      // LIKE fallback: any token matching any searchable column counts as a hit.
      // Tokens are OR'd; per token we OR across id/title/description/comments.
      // ESCAPE '\\' lets us include user input containing % or _ literally.
      const searchColumns = ["id", "title", "description", "comments"];
      const perTokenClause = `(${searchColumns
        .map((c) => `t."${c}" LIKE ? ESCAPE '\\'`)
        .join(" OR ")})`;
      const whereTokens = sanitizedTokens.map(() => perTokenClause).join(" OR ");
      const params: string[] = [];
      for (const token of sanitizedTokens) {
        const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
        for (let i = 0; i < searchColumns.length; i++) params.push(pattern);
      }
      const archivedClause = includeArchived ? "" : ` AND t."column" != 'archived'`;
      rows = this.db.prepare(`
        SELECT ${selectClause} FROM tasks t
        WHERE (${whereTokens})${archivedClause}
        ORDER BY t.createdAt ASC
        LIMIT ${limit >= 0 ? limit : -1}${offsetClause}
      `).all(...params) as unknown as TaskRow[];
    }

    const activeMatches = await Promise.all(rows.map(async (row) => {
      const task = this.rowToTask(row);

      // Slim path mirrors `listTasks`: aggregate timed execution server-side
      // before stripping the heavy log payload from the wire response.
      if (slim) {
        task.timedExecutionMs = this.computeTimedExecutionMs(task.log);
        task.log = [];
      }

      if (task.steps.length > 0) {
        return task;
      }

      const steps = await this.parseStepsFromPrompt(task.id);
      return steps.length > 0 ? { ...task, steps } : task;
    }));
    const archiveMatches = includeArchived
      ? this.archiveDb.search(trimmedQuery, limit >= 0 ? limit : 100).map((entry) => this.archiveEntryToTask(entry, slim))
      : [];

    const matches = [...activeMatches, ...archiveMatches];
    return limit >= 0 ? matches.slice(0, limit) : matches;
  }

  async selectNextTaskForAgent(agentId: string): Promise<InboxTask | null> {
    const tasks = await this.listTasks({ slim: true });
    if (tasks.length === 0) {
      return null;
    }

    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const isCheckoutAware = "checkoutTask" in this && typeof (this as Record<string, unknown>).checkoutTask === "function";
    const isDoneLike = (task: Task | undefined) => task?.column === "done" || task?.column === "archived";
    const sortByOldestColumnMove = (a: Task, b: Task) => {
      const aSortAt = a.columnMovedAt ?? a.createdAt;
      const bSortAt = b.columnMovedAt ?? b.createdAt;
      return aSortAt.localeCompare(bSortAt);
    };

    const assignedTasks = tasks.filter((task) => task.assignedAgentId === agentId);

    const inProgress = assignedTasks.filter((task) => task.column === "in-progress").sort(sortByOldestColumnMove);
    if (inProgress.length > 0) {
      return {
        task: inProgress[0],
        priority: "in_progress",
        reason: "Resuming in-progress task assigned to this agent",
      };
    }

    const todoCandidates = assignedTasks.filter((task) => task.column === "todo" && task.paused !== true);

    const readyTodo = todoCandidates
      .filter((task) => {
        if (isCheckoutAware && task.checkedOutBy && task.checkedOutBy !== agentId) {
          return false;
        }
        return this.areAllDependenciesDone(task.dependencies, tasksById);
      })
      .sort(sortByOldestColumnMove);

    if (readyTodo.length > 0) {
      return {
        task: readyTodo[0],
        priority: "todo",
        reason: "Selecting oldest ready todo task assigned to this agent",
      };
    }

    const actionableBlocked = todoCandidates
      .filter((task) => {
        if (isCheckoutAware && task.checkedOutBy && task.checkedOutBy !== agentId) {
          return false;
        }

        if (this.areAllDependenciesDone(task.dependencies, tasksById)) {
          return false;
        }

        return task.dependencies.some((dependencyId) => isDoneLike(tasksById.get(dependencyId)));
      })
      .sort(sortByOldestColumnMove);

    if (actionableBlocked.length > 0) {
      return {
        task: actionableBlocked[0],
        priority: "blocked",
        reason: "Selecting partially actionable blocked task assigned to this agent",
      };
    }

    return null;
  }

  private areAllDependenciesDone(dependencies: string[], tasksById: Map<string, Task>): boolean {
    return dependencies.every((dependencyId) => {
      const dependency = tasksById.get(dependencyId);
      return dependency?.column === "done" || dependency?.column === "archived";
    });
  }

  async moveTask(id: string, toColumn: Column): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      let task: Task;
      try {
        task = await this.readTaskJson(dir);
      } catch (error) {
        const archived = this.archiveDb.get(id);
        if (!archived) {
          throw error;
        }
        task = this.archiveEntryToTask(archived, false);
      }

      if (task.column === "done" && toColumn === "done") {
        if (this.clearDoneTransientFields(task)) {
          task.updatedAt = new Date().toISOString();
          await this.atomicWriteTaskJson(dir, task);
          if (this.isWatching) this.taskCache.set(id, { ...task });
          this.emit("task:updated", task);
        }
        return task;
      }

      const validTargets = VALID_TRANSITIONS[task.column];
      if (!validTargets.includes(toColumn)) {
        throw new Error(
          `Invalid transition: '${task.column}' → '${toColumn}'. ` +
            `Valid targets: ${validTargets.join(", ") || "none"}`,
        );
      }

      const fromColumn = task.column;
      if (fromColumn === "in-review" && toColumn === "done") {
        const mergeBlocker = getTaskMergeBlocker(task);
        if (mergeBlocker) {
          throw new Error(`Cannot move ${id} to done: ${mergeBlocker}`);
        }
      }
      task.column = toColumn;
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;

      // Clear transient fields when moving to done (matches moveToDone behavior)
      if (toColumn === "done") {
        this.clearDoneTransientFields(task);
      }

      // Clear transient fields when reopening/resetting a task into todo/triage.
      // This ensures failed tasks don't show failed status after being moved for retry.
      // Note: recovery metadata (recoveryRetryCount, nextRecoveryAt) is intentionally
      // preserved here — the recovery-policy module manages those fields. They are
      // only cleared on terminal transitions (in-review, done, archived).
      if (
        (fromColumn === "in-progress" || fromColumn === "done" || fromColumn === "in-review")
        && (toColumn === "todo" || toColumn === "triage")
      ) {
        task.status = undefined;
        task.error = undefined;
        task.worktree = undefined;
        task.blockedBy = undefined;
      }

      // Clear recovery metadata when task reaches in-review (successful completion)
      if (toColumn === "in-review") {
        task.recoveryRetryCount = undefined;
        task.nextRecoveryAt = undefined;
      }

      // Clear workflow step results when reopening from review/completed states.
      // This ensures fresh workflow step runs on retry
      if (
        (fromColumn === "in-review" && (toColumn === "todo" || toColumn === "in-progress"))
        || (fromColumn === "done" && (toColumn === "todo" || toColumn === "triage"))
      ) {
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
    updates: { title?: string; description?: string; priority?: TaskPriority | null; prompt?: string; worktree?: string | null; status?: string | null; dependencies?: string[]; steps?: import("./types.js").TaskStep[]; currentStep?: number; blockedBy?: string | null; assignedAgentId?: string | null; assigneeUserId?: string | null; nodeId?: string | null; checkedOutBy?: string | null; checkedOutAt?: string | null; paused?: boolean; baseBranch?: string | null; branch?: string | null; baseCommitSha?: string | null; size?: "S" | "M" | "L"; reviewLevel?: number; executionMode?: import("./types.js").ExecutionMode | null; mergeRetries?: number; workflowStepRetries?: number; stuckKillCount?: number | null; postReviewFixCount?: number | null; recoveryRetryCount?: number | null; taskDoneRetryCount?: number | null; verificationFailureCount?: number | null; nextRecoveryAt?: string | null; enabledWorkflowSteps?: string[]; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null; thinkingLevel?: string | null; error?: string | null; summary?: string | null; sessionFile?: string | null; workflowStepResults?: import("./types.js").WorkflowStepResult[] | null; mergeDetails?: import("./types.js").MergeDetails | null; sourceIssue?: import("./types.js").TaskSourceIssue | null; tokenUsage?: import("./types.js").TaskTokenUsage | null; modifiedFiles?: string[] | null; missionId?: string | null; sliceId?: string | null },
    runContext?: RunMutationContext,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      // Validate that task doesn't depend on itself
      if (updates.dependencies?.includes(id)) {
        throw new Error(`Task ${id} cannot depend on itself`);
      }

      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      if (updates.nodeId !== undefined) {
        const validation = validateNodeOverrideChange(task, updates.nodeId ?? null);
        if (!validation.allowed) {
          throw new Error(validation.message);
        }
      }

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (updates.title !== undefined) task.title = updates.title;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.priority === null) {
        task.priority = normalizeTaskPriority(undefined);
      } else if (updates.priority !== undefined) {
        task.priority = normalizeTaskPriority(updates.priority);
      }
      if (updates.worktree === null) {
        task.worktree = undefined;
      } else if (updates.worktree !== undefined) {
        task.worktree = updates.worktree;
      }
      // Detect new dependencies being added to a todo task → auto-move to triage
      let movedToTriage = false;
      if (updates.dependencies !== undefined) {
        const oldDeps = new Set(task.dependencies);
        const hasNewDeps = updates.dependencies.some((d) => !oldDeps.has(d));
        task.dependencies = updates.dependencies;

        if (hasNewDeps && task.column === "todo") {
          task.column = "triage";
          task.status = undefined;
          task.columnMovedAt = new Date().toISOString();
          const depLogEntry: TaskLogEntry = {
            timestamp: new Date().toISOString(),
            action: "Moved to triage for re-specification — new dependency added",
          };
          if (runContext) {
            depLogEntry.runContext = runContext;
          }
          task.log.push(depLogEntry);
          movedToTriage = true;
        }
      }
      if (updates.steps !== undefined) task.steps = updates.steps;
      if (updates.currentStep !== undefined) task.currentStep = updates.currentStep;
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
      if (updates.assignedAgentId === null) {
        task.assignedAgentId = undefined;
      } else if (updates.assignedAgentId !== undefined) {
        task.assignedAgentId = updates.assignedAgentId;
      }
      if (updates.assigneeUserId === null) {
        task.assigneeUserId = undefined;
      } else if (updates.assigneeUserId !== undefined) {
        task.assigneeUserId = updates.assigneeUserId;
      }
      if (updates.nodeId === null) {
        task.nodeId = undefined;
      } else if (updates.nodeId !== undefined) {
        task.nodeId = updates.nodeId;
      }
      if (updates.checkedOutBy === null) {
        task.checkedOutBy = undefined;
        task.checkedOutAt = undefined;
      } else if (updates.checkedOutBy !== undefined) {
        task.checkedOutBy = updates.checkedOutBy;
        // Auto-set checkedOutAt when acquiring a lease (use provided value or generate timestamp)
        task.checkedOutAt = updates.checkedOutAt ?? new Date().toISOString();
      }
      if (updates.paused !== undefined) task.paused = updates.paused || undefined;
      if (updates.baseBranch === null) {
        task.baseBranch = undefined;
      } else if (updates.baseBranch !== undefined) {
        task.baseBranch = updates.baseBranch;
      }
      if (updates.branch === null) {
        task.branch = undefined;
      } else if (updates.branch !== undefined) {
        task.branch = updates.branch;
      }
      if (updates.baseCommitSha === null) {
        task.baseCommitSha = undefined;
      } else if (updates.baseCommitSha !== undefined) {
        task.baseCommitSha = updates.baseCommitSha;
      }
      if (updates.size !== undefined) task.size = updates.size;
      if (updates.reviewLevel !== undefined) task.reviewLevel = updates.reviewLevel;
      if (updates.mergeRetries !== undefined) task.mergeRetries = updates.mergeRetries;
      if (updates.workflowStepRetries !== undefined) task.workflowStepRetries = updates.workflowStepRetries;
      if (updates.stuckKillCount === null) {
        task.stuckKillCount = undefined;
      } else if (updates.stuckKillCount !== undefined) {
        task.stuckKillCount = updates.stuckKillCount;
      }
      if (updates.postReviewFixCount === null) {
        task.postReviewFixCount = undefined;
      } else if (updates.postReviewFixCount !== undefined) {
        task.postReviewFixCount = updates.postReviewFixCount;
      }
      if (updates.recoveryRetryCount === null) {
        task.recoveryRetryCount = undefined;
      } else if (updates.recoveryRetryCount !== undefined) {
        task.recoveryRetryCount = updates.recoveryRetryCount;
      }
      if (updates.taskDoneRetryCount === null) {
        task.taskDoneRetryCount = undefined;
      } else if (updates.taskDoneRetryCount !== undefined) {
        task.taskDoneRetryCount = updates.taskDoneRetryCount;
      }
      if (updates.verificationFailureCount === null) {
        task.verificationFailureCount = undefined;
      } else if (updates.verificationFailureCount !== undefined) {
        task.verificationFailureCount = updates.verificationFailureCount;
      }
      if (updates.nextRecoveryAt === null) {
        task.nextRecoveryAt = undefined;
      } else if (updates.nextRecoveryAt !== undefined) {
        task.nextRecoveryAt = updates.nextRecoveryAt;
      }
      if (updates.enabledWorkflowSteps !== undefined) {
        task.enabledWorkflowSteps = await this.resolveEnabledWorkflowSteps(updates.enabledWorkflowSteps);
      }
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
      if (updates.planningModelProvider === null) {
        task.planningModelProvider = undefined;
      } else if (updates.planningModelProvider !== undefined) {
        task.planningModelProvider = updates.planningModelProvider;
      }
      if (updates.planningModelId === null) {
        task.planningModelId = undefined;
      } else if (updates.planningModelId !== undefined) {
        task.planningModelId = updates.planningModelId;
      }
      if (updates.thinkingLevel === null) {
        task.thinkingLevel = undefined;
      } else if (updates.thinkingLevel !== undefined) {
        task.thinkingLevel = updates.thinkingLevel as import("./types.js").ThinkingLevel;
      }
      if (updates.executionMode === null) {
        task.executionMode = undefined;
      } else if (updates.executionMode !== undefined) {
        task.executionMode = updates.executionMode as import("./types.js").ExecutionMode;
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
      if (updates.sessionFile === null) {
        task.sessionFile = undefined;
      } else if (updates.sessionFile !== undefined) {
        task.sessionFile = updates.sessionFile;
      }
      if (updates.workflowStepResults === null) {
        task.workflowStepResults = undefined;
      } else if (updates.workflowStepResults !== undefined) {
        task.workflowStepResults = updates.workflowStepResults;
      }
      if (updates.mergeDetails === null) {
        task.mergeDetails = undefined;
      } else if (updates.mergeDetails !== undefined) {
        task.mergeDetails = updates.mergeDetails;
      }
      if (updates.sourceIssue === null) {
        task.sourceIssue = undefined;
      } else if (updates.sourceIssue !== undefined) {
        task.sourceIssue = updates.sourceIssue;
      }
      if (updates.tokenUsage === null) {
        task.tokenUsage = undefined;
      } else if (updates.tokenUsage !== undefined) {
        task.tokenUsage = updates.tokenUsage;
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

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await this.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:update",
          target: task.id,
          metadata: { updatedFields: Object.keys(updates).filter((k) => (updates as Record<string, unknown>)[k] !== undefined) },
        });
      } else {
        await this.atomicWriteTaskJson(dir, task);
      }

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
  async pauseTask(id: string, paused: boolean, runContext?: RunMutationContext): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      task.paused = paused || undefined;
      // When pausing an in-progress/in-review task, set status so the UI can show the state.
      // When unpausing, clear the "paused" status.
      if (task.column === "in-progress" || task.column === "in-review") {
        task.status = paused ? "paused" : undefined;
      }
      const now = new Date().toISOString();
      task.updatedAt = now;
      const logEntry: TaskLogEntry = {
        timestamp: now,
        action: paused ? "Task paused" : "Task unpaused",
      };
      if (runContext) {
        logEntry.runContext = runContext;
      }
      task.log.push(logEntry);

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await this.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: paused ? "task:pause" : "task:unpause",
          target: task.id,
        });
      } else {
        await this.atomicWriteTaskJson(dir, task);
      }
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
  async logEntry(id: string, action: string, outcome?: string, runContext?: RunMutationContext): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const entry: TaskLogEntry = {
        timestamp: new Date().toISOString(),
        action,
        outcome: truncateTaskLogOutcome(outcome),
      };
      if (runContext) {
        const dir = this.taskDir(id);
        const task = await this.readTaskJson(dir);

        // Initialize log array if missing (for legacy tasks)
        if (!task.log) {
          task.log = [];
        }

        entry.runContext = runContext;
        task.log.push(entry);
        if (task.log.length > TASK_ACTIVITY_LOG_ENTRY_LIMIT) {
          task.log.splice(0, task.log.length - TASK_ACTIVITY_LOG_ENTRY_LIMIT);
        }
        task.updatedAt = new Date().toISOString();

        // When runContext is provided, record audit event atomically with task mutation.
        await this.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:log",
          target: task.id,
          metadata: { action, outcome },
        });

        if (this.isWatching) this.taskCache.set(id, { ...task });
        this.emit("task:updated", task);
        return task;
      }

      // Fast path for high-volume log entries: update only the log + updatedAt fields
      // instead of reading/writing the entire task payload on every append.
      const row = this.db.prepare("SELECT log FROM tasks WHERE id = ?").get(id) as { log: string | null } | undefined;
      if (!row) {
        throw new Error(`Task ${id} not found`);
      }

      const log = fromJson<TaskLogEntry[]>(row.log) || [];
      log.push(entry);
      if (log.length > TASK_ACTIVITY_LOG_ENTRY_LIMIT) {
        log.splice(0, log.length - TASK_ACTIVITY_LOG_ENTRY_LIMIT);
      }
      const updatedAt = new Date().toISOString();

      this.db.prepare("UPDATE tasks SET log = ?, updatedAt = ? WHERE id = ?").run(toJson(log), updatedAt, id);
      this.db.bumpLastModified();

      const current = this.readTaskFromDb(id);
      if (current) {
        await this.writeTaskJsonFile(this.taskDir(id), current);
        if (this.isWatching) {
          this.taskCache.set(id, { ...current });
        }
        this.emit("task:updated", current);
        return current;
      }

      const emittedTask = ({ id, log, updatedAt } as unknown) as Task;
      this.emit("task:updated", emittedTask);
      return emittedTask;
    });
  }

  /**
   * Get all task log entries correlated with a specific run ID.
   * Scans all tasks' logs for entries whose runContext.runId matches.
   */
  async getMutationsForRun(runId: string): Promise<TaskLogEntry[]> {
    const rows = this.db.prepare("SELECT log FROM tasks").all() as Array<{ log: string | null }>;
    const mutations: TaskLogEntry[] = [];
    for (const row of rows) {
      const logEntries = fromJson<TaskLogEntry[]>(row.log) || [];
      for (const entry of logEntries) {
        if (entry.runContext?.runId === runId) {
          mutations.push(entry);
        }
      }
    }
    // Sort by timestamp ascending
    return mutations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // ── Run Audit APIs ───────────────────────────────────────────────────

  /**
   * Convert a database row to a RunAuditEvent object.
   */
  private rowToRunAuditEvent(row: RunAuditEventRow): RunAuditEvent {
    return {
      id: row.id,
      timestamp: row.timestamp,
      taskId: row.taskId || undefined,
      agentId: row.agentId,
      runId: row.runId,
      domain: row.domain as RunAuditEvent["domain"],
      mutationType: row.mutationType,
      target: row.target,
      metadata: fromJson<Record<string, unknown>>(row.metadata),
    };
  }

  /**
   * Record a run-audit event.
   *
   * Persists a structured audit trail entry correlating a mutation to the
   * heartbeat run that caused it. Use this to track database mutations,
   * git operations, and filesystem changes initiated by agent runs.
   *
   * @param input - The audit event input (runId, agentId, domain, mutationType, target, optional metadata)
   * @returns The persisted RunAuditEvent with generated id and timestamp
   */
  recordRunAuditEvent(input: RunAuditEventInput): RunAuditEvent {
    const id = randomUUID();
    const timestamp = input.timestamp ?? new Date().toISOString();

    const event: RunAuditEvent = {
      id,
      timestamp,
      taskId: input.taskId,
      agentId: input.agentId,
      runId: input.runId,
      domain: input.domain,
      mutationType: input.mutationType,
      target: input.target,
      metadata: input.metadata,
    };

    this.db.prepare(`
      INSERT INTO runAuditEvents (
        id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.timestamp,
      event.taskId ?? null,
      event.agentId,
      event.runId,
      event.domain,
      event.mutationType,
      event.target,
      toJsonNullable(event.metadata),
    );

    return event;
  }

  /**
   * Query run-audit events with optional filters.
   *
   * @param options - Filter options (runId, taskId, startTime, endTime, domain, mutationType, limit)
   * @returns Array of matching RunAuditEvent records, ordered by timestamp DESC, rowid DESC
   *
   * @remarks
   * Time-range filtering uses **inclusive bounds**: `timestamp >= startTime` and `timestamp <= endTime`.
   * When no time range is specified, all matching records are returned.
   *
   * Query results are ordered by timestamp descending with a stable rowid tiebreaker:
   * `ORDER BY timestamp DESC, rowid DESC`. This ensures deterministic ordering
   * when multiple events share the same millisecond timestamp.
   */
  getRunAuditEvents(options: RunAuditEventFilter = {}): RunAuditEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.runId) {
      conditions.push("runId = ?");
      params.push(options.runId);
    }

    if (options.taskId) {
      conditions.push("taskId = ?");
      params.push(options.taskId);
    }

    if (options.agentId) {
      conditions.push("agentId = ?");
      params.push(options.agentId);
    }

    if (options.domain) {
      conditions.push("domain = ?");
      params.push(options.domain);
    }

    if (options.mutationType) {
      conditions.push("mutationType = ?");
      params.push(options.mutationType);
    }

    // Inclusive time range: timestamp >= startTime AND timestamp <= endTime
    if (options.startTime) {
      conditions.push("timestamp >= ?");
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push("timestamp <= ?");
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT ${Math.max(1, options.limit)}` : "";
    const orderClause = "ORDER BY timestamp DESC, rowid DESC";

    // Cast params to the expected SQLite input type
    const sqlParams = params as (string | number | null)[];

    const rows = this.db.prepare(`
      SELECT * FROM runAuditEvents
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `).all(...sqlParams) as unknown as RunAuditEventRow[];

    return rows.map((row) => this.rowToRunAuditEvent(row));
  }

  // ── End Run Audit APIs ───────────────────────────────────────────────

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

  async deleteTask(id: string, options?: { removeDependencyReferences?: boolean }): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const task = this.readTaskFromDb(id);
      if (!task) {
        throw new Error(`Task ${id} not found`);
      }

      // Refuse to delete a task that is still referenced as a dependency
      // by another live task unless the caller explicitly opts into
      // removing those incoming references as part of this delete.
      const dependentIds = this.findLiveDependents(id);
      if (dependentIds.length > 0 && !options?.removeDependencyReferences) {
        throw new TaskHasDependentsError(id, dependentIds);
      }

      // Clean up the task's branch before deleting from DB
      const cleanedBranches = await this.cleanupBranchForTask(task);
      if (cleanedBranches.length > 0) {
        if (!task.log) task.log = [];
        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Cleaned up branch: ${cleanedBranches.join(", ")}`,
        });
      }

      const rewrittenDependents = this.rewriteDependentsAndDeleteTask(id, dependentIds);

      // Remove from cache if watcher is active
      if (this.isWatching) this.taskCache.delete(id);

      // Delete directory from disk
      const dir = this.taskDir(id);
      if (existsSync(dir)) {
        const { rm } = await import("node:fs/promises");
        await rm(dir, { recursive: true });
      }

      for (const dependentTask of rewrittenDependents) {
        this.emit("task:updated", dependentTask);
      }

      this.emit("task:deleted", task);
      return task;
    });
  }

  private rewriteDependentsAndDeleteTask(taskId: string, dependentIds: string[]): Task[] {
    const rewrittenDependents: Task[] = [];

    this.db.transaction(() => {
      for (const dependentId of dependentIds) {
        const dependentTask = this.readTaskFromDb(dependentId);
        if (!dependentTask) continue;

        const nextDependencies = dependentTask.dependencies.filter((dependencyId) => dependencyId !== taskId);
        if (nextDependencies.length === dependentTask.dependencies.length) {
          continue;
        }

        const updatedDependent = {
          ...dependentTask,
          dependencies: nextDependencies,
          updatedAt: new Date().toISOString(),
        };

        this.db.prepare("UPDATE tasks SET dependencies = ?, updatedAt = ? WHERE id = ?").run(
          toJson(updatedDependent.dependencies),
          updatedDependent.updatedAt,
          updatedDependent.id,
        );
        if (this.isWatching) {
          this.taskCache.set(updatedDependent.id, updatedDependent);
        }
        rewrittenDependents.push(updatedDependent);
      }

      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      this.db.bumpLastModified();
    });

    return rewrittenDependents;
  }

  /**
   * Clean up the git branch associated with a task.
   *
   * Branch name resolution:
   * 1. Use `task.branch` if set
   * 2. Fall back to `fusion/${taskId.toLowerCase()}`
   *
   * Uses force delete (`git branch -D`) since the task is being removed or archived.
   * Silently skips if neither branch exists (idempotent).
   *
   * @returns Array of branch names that were successfully deleted
   */
  private async runGitCommand(command: string, timeoutMs = 10_000) {
    return runCommandAsync(command, {
      cwd: this.rootDir,
      timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  private async cleanupBranchForTask(task: Task): Promise<string[]> {
    const branches = new Set<string>();
    if (task.branch) {
      branches.add(task.branch);
    }
    branches.add(`fusion/${task.id.toLowerCase()}`);

    const deleted: string[] = [];
    for (const branch of branches) {
      try {
        assertSafeGitBranchName(branch);
      } catch {
        // Skip branches whose names would be unsafe to pass through a shell.
        // A malformed stored value should not become a command-injection vector.
        continue;
      }
      const verify = await this.runGitCommand(`git rev-parse --verify "${branch}"`);
      if (verify.exitCode !== 0) {
        continue;
      }

      const remove = await this.runGitCommand(`git branch -D "${branch}"`);
      if (remove.exitCode === 0) {
        deleted.push(branch);
      }
    }
    if (deleted.length > 0) {
      this.clearStaleBaseBranchReferences(deleted, task.id);
    }
    return deleted;
  }

  /**
   * Clear `baseBranch` on any live task whose stored value matches one of the
   * provided (now-deleted) branch names. Prevents the scenario where a
   * dependent task was dispatched with baseBranch set to an upstream dep's
   * conflict-suffixed branch, the upstream dep was later merged and its
   * branch deleted, and the dependent task then failed permanently trying
   * to create a worktree from the vanished ref (FN-2165).
   *
   * Excludes the owner task (when provided) so a task's own archival doesn't
   * null its own baseBranch.
   *
   * @returns IDs of tasks whose baseBranch was cleared
   */
  clearStaleBaseBranchReferences(deletedBranches: string[], ownerTaskId?: string): string[] {
    if (deletedBranches.length === 0) return [];
    const placeholders = deletedBranches.map(() => "?").join(",");
    const params: string[] = [...deletedBranches];
    let whereClause = `baseBranch IN (${placeholders})`;
    if (ownerTaskId) {
      whereClause += ` AND id != ?`;
      params.push(ownerTaskId);
    }
    const rows = this.db
      .prepare(`SELECT id FROM tasks WHERE ${whereClause}`)
      .all(...params) as Array<{ id: string }>;

    if (rows.length === 0) return [];
    const update = this.db.prepare(
      `UPDATE tasks SET baseBranch = NULL, updatedAt = ? WHERE id = ?`,
    );
    const now = new Date().toISOString();
    const clearedIds: string[] = [];
    for (const row of rows) {
      update.run(now, row.id);
      clearedIds.push(row.id);
      if (this.isWatching) {
        const cached = this.taskCache.get(row.id);
        if (cached) {
          cached.baseBranch = undefined;
          cached.updatedAt = now;
        }
      }
    }
    this.db.bumpLastModified();
    return clearedIds;
  }

  private async collectMergeDetails(_id: string, _branch: string, task: Task, commitMessage: string): Promise<import("./types.js").MergeDetails> {
    const mergedAt = new Date().toISOString();
    let commitSha: string | undefined;
    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;

    const headResult = await this.runGitCommand("git rev-parse HEAD");
    if (headResult.exitCode === 0) {
      commitSha = headResult.stdout.trim() || undefined;
    } else {
      commitSha = undefined;
    }

    const statsResult = await this.runGitCommand("git show --shortstat --format= HEAD");
    if (statsResult.exitCode === 0) {
      const statsOutput = statsResult.stdout.trim();
      const normalized = statsOutput.replace(/\n/g, " ");
      const filesMatch = normalized.match(/(\d+) files? changed/);
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      filesChanged = filesMatch ? Number.parseInt(filesMatch[1], 10) : 0;
      insertions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;
    } else {
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
      const branch = `fusion/${id.toLowerCase()}`;
      // Branch is derived from the task id (already validated at create time),
      // but assert as defense-in-depth against future id-format changes.
      assertSafeGitBranchName(branch);

      if (task.column === "done") {
        const result: MergeResult = {
          task,
          branch,
          merged: false,
          worktreeRemoved: false,
          branchDeleted: false,
        };

        const worktreePath = task.worktree;
        const changed = this.clearDoneTransientFields(task);

        if (worktreePath && existsSync(worktreePath)) {
          assertSafeAbsolutePath(worktreePath);
          const removeWorktree = await this.runGitCommand(`git worktree remove "${worktreePath}" --force`, 120_000);
          if (removeWorktree.exitCode === 0) {
            result.worktreeRemoved = true;
          }
        }

        const deleteBranch = await this.runGitCommand(`git branch -d "${branch}"`);
        if (deleteBranch.exitCode === 0) {
          result.branchDeleted = true;
        } else {
          const forceDeleteBranch = await this.runGitCommand(`git branch -D "${branch}"`);
          if (forceDeleteBranch.exitCode === 0) {
            result.branchDeleted = true;
          }
        }

        if (changed) {
          task.updatedAt = new Date().toISOString();
          await this.atomicWriteTaskJson(dir, task);
          if (this.isWatching) this.taskCache.set(id, { ...task });
          this.emit("task:updated", task);
        }

        result.task = task;
        return result;
      }

      const mergeBlocker = getTaskMergeBlocker(task);
      if (mergeBlocker) {
        throw new Error(`Cannot merge ${id}: ${mergeBlocker}`);
      }

      const worktreePath = task.worktree;
      const result: MergeResult = {
        task,
        branch,
        merged: false,
        worktreeRemoved: false,
        branchDeleted: false,
      };

      // 1. Check the branch exists
      const verifyBranch = await this.runGitCommand(`git rev-parse --verify "${branch}"`);
      if (verifyBranch.exitCode !== 0) {
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
      const merge = await this.runGitCommand(`git merge --squash "${branch}"`, 120_000);
      const commit = merge.exitCode === 0
        ? await this.runGitCommand(`git commit --no-edit -m "${mergeCommitMessage}"`, 120_000)
        : merge;

      if (merge.exitCode === 0 && commit.exitCode === 0) {
        result.merged = true;
        const mergeDetails = await this.collectMergeDetails(id, branch, task, mergeCommitMessage);
        task.mergeDetails = mergeDetails;
        Object.assign(result, mergeDetails);
      } else {
        // Squash conflict — reset and report
        await this.runGitCommand("git reset --merge");
        throw new Error(
          `Merge conflict merging '${branch}'. Resolve manually:\n` +
            `  cd ${this.rootDir}\n` +
            `  git merge --squash ${branch}\n` +
            `  # resolve conflicts, then: fn task move ${id} done`,
        );
      }

      // 3. Remove worktree
      if (worktreePath && existsSync(worktreePath)) {
        assertSafeAbsolutePath(worktreePath);
        const removeWorktree = await this.runGitCommand(`git worktree remove "${worktreePath}" --force`, 120_000);
        if (removeWorktree.exitCode === 0) {
          result.worktreeRemoved = true;
        }
      }

      // 4. Delete the branch
      const deleteBranch = await this.runGitCommand(`git branch -d "${branch}"`);
      if (deleteBranch.exitCode === 0) {
        result.branchDeleted = true;
      } else {
        // Branch might not be fully merged in some edge cases; try force
        const forceDeleteBranch = await this.runGitCommand(`git branch -D "${branch}"`);
        if (forceDeleteBranch.exitCode === 0) {
          result.branchDeleted = true;
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
    const doneTasks = await this.listTasks({ slim: true, column: "done" });
    
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
   * @param cleanup - When true, also attempts branch cleanup before writing the
   *                  cold archive entry. Active task storage is always removed.
   */
  async archiveTask(id: string, cleanup: boolean = true): Promise<Task> {
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

      if (!cleanup) {
        await this.atomicWriteTaskJson(dir, task);
        if (this.isWatching) this.taskCache.set(id, { ...task });
        this.emit("task:moved", { task, from: "done" as Column, to: "archived" as Column });
        return task;
      }

      const cleanedBranches = await this.cleanupBranchForTask(task);
      if (cleanedBranches.length > 0) {
        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Cleaned up branch: ${cleanedBranches.join(", ")}`,
        });
      }

      const entry = await this.taskToArchiveEntry(task, task.columnMovedAt);
      this.archiveDb.upsert(entry);

      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      this.db.bumpLastModified();

      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });

      if (this.isWatching) {
        this.taskCache.delete(id);
      }

      this.emit("task:moved", { task, from: "done" as Column, to: "archived" as Column });
      return this.archiveEntryToTask(entry, false);
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
   * If the active task row was cleaned up, restores from archive.db first.
   * Logs the action and emits `task:moved` event.
   */
  async unarchiveTask(id: string): Promise<Task> {
    const dir = this.taskDir(id);

    // If the active row is gone, restore from cold archive storage before
    // taking the task lock. A stale directory may still exist after manual
    // filesystem edits, so database presence is the source of truth.
    if (!this.readTaskFromDb(id)) {
      const entry = await this.findInArchive(id);
      if (!entry) {
        throw new Error(
          `Cannot unarchive ${id}: task is missing from active storage and not found in archive`,
        );
      }
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

      // NOTE: No getTaskMergeBlocker check here — intentionally.
      // The merge blocker validates in-review → done transitions (ensuring code
      // has been properly reviewed before merging). An unarchived task was already
      // merged in its previous lifecycle; this is just a restoration. The transient
      // field clearing above ensures no stale blocker state leaks through.
      task.column = "done";
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;

      // Clear transient fields that should not persist into "done" column.
      // Matches the clearing done by moveTask() for consistency — archived
      // tasks may have been archived with stale worktree/status/error/recovery
      // state that should not reappear after unarchiving.
      task.status = undefined;
      task.error = undefined;
      task.worktree = undefined;
      task.blockedBy = undefined;
      task.recoveryRetryCount = undefined;
      task.nextRecoveryAt = undefined;

      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task unarchived",
      });

      await this.atomicWriteTaskJson(dir, task);
      this.archiveDb.delete(id);

      // Update cache if watcher is active
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:moved", { task, from: "archived" as Column, to: "done" as Column });
      return task;
    });
  }

  private async moveToDone(task: Task, dir: string): Promise<void> {
    if (task.column === "done") {
      return;
    }

    const fromColumn = task.column;
    const mergeBlocker = getTaskMergeBlocker(task);
    if (mergeBlocker) {
      throw new Error(`Cannot move ${task.id} to done: ${mergeBlocker}`);
    }

    task.column = "done";
    this.clearDoneTransientFields(task);
    task.columnMovedAt = new Date().toISOString();
    task.updatedAt = task.columnMovedAt;

    await this.atomicWriteTaskJson(dir, task);

    // Update cache if watcher is active
    if (this.isWatching) this.taskCache.set(task.id, { ...task });

    this.emit("task:moved", { task, from: fromColumn, to: "done" as Column });
  }

  private clearDoneTransientFields(task: Task): boolean {
    const changed = task.status !== undefined
      || task.error !== undefined
      || task.worktree !== undefined
      || task.blockedBy !== undefined
      || task.recoveryRetryCount !== undefined
      || task.nextRecoveryAt !== undefined;

    task.status = undefined;
    task.error = undefined;
    task.worktree = undefined;
    task.blockedBy = undefined;
    task.recoveryRetryCount = undefined;
    task.nextRecoveryAt = undefined;

    return changed;
  }

  // ── File-system watcher ───────────────────────────────────────────

  /**
   * Start watching for changes via SQLite polling.
   * Populates the in-memory cache and begins emitting events for
   * any task mutations.
   */
  async watch(): Promise<void> {
    if (this.watcher || this.pollInterval) return; // already watching

    // Populate cache with current state. The watcher only needs metadata to
    // detect created/updated/moved/deleted events; full task logs stay on the
    // detail path.
    const tasks = await this.listTasks({ slim: true });
    this.taskCache.clear();
    for (const task of tasks) {
      this.taskCache.set(task.id, { ...task });
    }

    // Store current lastModified
    this.lastKnownModified = this.db.getLastModified();
    // Initialize lastPollTime so the first checkForChanges() cycle filters by
    // "modified since now" instead of doing a full SELECT * + emitting an
    // update event for every cached task. Without this, dashboard startup
    // re-loaded the entire tasks table 1s after watch() began.
    this.lastPollTime = new Date().toISOString();

    // Use a sentinel watcher object so existing code that checks `this.watcher` still works
    try {
      this.watcher = watch(this.tasksDir, { recursive: true }, (_event, _filename) => {
        // No-op - we use polling now, but keep watcher for API compat
      });
      this.watcher.on("error", (err) => {
        storeLog.warn("fs.watch emitted an error; polling will continue", {
          phase: "watch:fs-watch-error",
          error: err instanceof Error ? err.message : String(err),
          tasksDir: this.tasksDir,
        });
      });
    } catch (err) {
      // fs.watch may not be available - that's fine
      storeLog.warn("fs.watch unavailable; falling back to polling-only updates", {
        phase: "watch:fs-watch-setup",
        error: err instanceof Error ? err.message : String(err),
        tasksDir: this.tasksDir,
      });
    }

    // Poll for changes every second
    this.pollInterval = setInterval(() => {
      void this.checkForChanges();
    }, 1000);
  }

  /**
   * Check for changes by comparing lastModified timestamps.
   * Optimized: only loads tasks modified since the last poll instead of
   * doing a full table scan + JSON.stringify comparison every cycle.
   *
   * This method yields to the event loop between expensive SQLite operations
   * to prevent blocking HTTP request handlers. Uses a pollingInProgress guard
   * to skip overlapping poll cycles.
   */
  private async checkForChanges(): Promise<void> {
    const startTime = Date.now();

    // Guard against overlapping poll cycles
    if (this.pollingInProgress) return;
    this.pollingInProgress = true;

    try {
      const currentModified = this.db.getLastModified();
      if (currentModified <= this.lastKnownModified) return;
      this.lastKnownModified = currentModified;

      // Detect deletions cheaply: compare ID sets without loading full rows.
      // A row missing from `tasks` can mean two things: the task was actually
      // deleted, OR it was archived (archiveTask removes it from `tasks` after
      // copying into `archived_tasks`). Other TaskStore instances polling the
      // same DB can't tell the difference from this view alone — without the
      // archive check below they emit spurious task:deleted events for every
      // archived task, which the activity log records as a deletion.
      const idRows = this.db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>;
      const currentIds = new Set(idRows.map((r) => r.id));
      const missingIds: string[] = [];
      for (const id of this.taskCache.keys()) {
        if (!currentIds.has(id)) missingIds.push(id);
      }
      if (missingIds.length > 0) {
        const archivedSet = this.archiveDb.filterArchived(missingIds);
        for (const id of missingIds) {
          const cached = this.taskCache.get(id);
          if (!cached) continue;
          this.taskCache.delete(id);
          if (archivedSet.has(id)) {
            // Task moved to archive — emit task:moved (matching what
            // archiveTask emits in-process) so the activity-log listener
            // records it correctly.
            this.emit("task:moved", { task: cached, from: cached.column, to: "archived" as Column });
          } else {
            this.emit("task:deleted", cached);
          }
        }
      }

      // Yield to event loop before the expensive SELECT query
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Only load tasks modified since our last known timestamp.
      // Use lastKnownPollTime (ISO string) to filter — much cheaper than full scan.
      const selectClause = this.getTaskSelectClause(true);
      const changedRows = this.lastPollTime
        ? this.db.prepare(`SELECT ${selectClause} FROM tasks WHERE updatedAt > ? OR columnMovedAt > ?`).all(this.lastPollTime, this.lastPollTime) as unknown as TaskRow[]
        : this.db.prepare(`SELECT ${selectClause} FROM tasks`).all() as unknown as TaskRow[];
      this.lastPollTime = new Date().toISOString();

      for (let i = 0; i < changedRows.length; i++) {
        const row = changedRows[i];
        const task = this.rowToTask(row);
        const cached = this.taskCache.get(task.id);
        if (!cached) {
          this.taskCache.set(task.id, { ...task });
          this.emit("task:created", task);
        } else if (cached.column !== task.column) {
          const from = cached.column;
          this.taskCache.set(task.id, { ...task });
          this.emit("task:moved", { task, from, to: task.column });
        } else {
          this.taskCache.set(task.id, { ...task });
          this.emit("task:updated", task);
        }

        // Yield every ~50 rows to prevent blocking the event loop during large updates
        if (i > 0 && i % 50 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 100) {
        storeLog.warn("checkForChanges took longer than expected", {
          elapsedMs: elapsed,
          thresholdMs: 100,
        });
      }
    } catch (err) {
      storeLog.warn("checkForChanges poll cycle failed", {
        lastKnownModified: this.lastKnownModified,
        lastPollTime: this.lastPollTime,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.pollingInProgress = false;
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
   * Insert an agent log entry into the agentLogEntries SQLite table.
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
    const timestamp = new Date().toISOString();
    const entry: AgentLogEntry = {
      timestamp,
      taskId,
      text,
      type,
      ...(detail !== undefined && { detail }),
      ...(agent !== undefined && { agent }),
    };

    this.db.prepare(`
      INSERT INTO agentLogEntries (taskId, timestamp, text, type, detail, agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, timestamp, text, type, detail ?? null, agent ?? null);

    this.db.bumpLastModified();
    this.emit("agent:log", entry);
  }

  private mapAgentLogRow(row: Record<string, unknown>): AgentLogEntry {
    return {
      timestamp: row.timestamp as string,
      taskId: row.taskId as string,
      text: row.text as string,
      type: row.type as AgentLogEntry["type"],
      ...(row.detail != null && { detail: row.detail as string }),
      ...(row.agent != null && { agent: row.agent as AgentLogEntry["agent"] }),
    };
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
  async addSteeringComment(id: string, text: string, author: "user" | "agent" = "user", runContext?: RunMutationContext): Promise<Task> {
    // Write to unified comments (skip refinement — steering is for agent injection, not follow-up tasks)
    const task = await this.addComment(id, text, author, { skipRefinement: true }, runContext);

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
    runContext?: RunMutationContext,
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
      const logEntry: TaskLogEntry = {
        timestamp: task.updatedAt,
        action: `Comment added by ${author}`,
      };
      if (runContext) {
        logEntry.runContext = runContext;
      }
      task.log.push(logEntry);

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await this.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:comment",
          target: task.id,
          metadata: { author, commentId },
        });
      } else {
        await this.atomicWriteTaskJson(dir, task);
      }
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });

    const commentContextBase: Record<string, unknown> = {
      taskId: id,
      author,
      commentLength: text.length,
      column: task.column,
      priorStatus: task.status ?? null,
    };
    if (runContext) {
      commentContextBase.runId = runContext.runId;
      commentContextBase.agentId = runContext.agentId;
      if (runContext.source) {
        commentContextBase.runSource = runContext.source;
      }
    }

    // Phase 2: Auto-refinement OUTSIDE the lock (to avoid lock contention)
    // Only create refinement for user comments on done tasks.
    // This remains best-effort: failures are logged for observability but never
    // fail the comment add operation itself.
    // Steering comments skip refinement — they are injected into the agent stream instead.
    if (task.column === "done" && author === "user" && !options?.skipRefinement) {
      try {
        await this.refineTask(id, text);
      } catch (err) {
        storeLog.warn("Best-effort post-comment auto-refinement failed", {
          ...commentContextBase,
          phase: "addComment:auto-refinement",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 3: Invalidate stale spec approval when a user comments on
    // a triage task that is awaiting manual approval. The new comment
    // means the spec is now stale and must be re-specified/re-reviewed.
    // This remains best-effort: failures are logged for observability but
    // never fail the comment add operation itself.
    // Note: The `task` returned above reflects the state BEFORE this
    // transition. Callers that need the post-transition status should
    // re-read the task (e.g., via getTask).
    if (
      task.column === "triage"
      && task.status === "awaiting-approval"
      && author === "user"
    ) {
      let invalidatedStatus = false;
      try {
        await this.updateTask(id, {
          status: "needs-replan",
        });
        invalidatedStatus = true;
      } catch (err) {
        storeLog.warn("Best-effort post-comment awaiting-approval invalidation failed", {
          ...commentContextBase,
          phase: "addComment:awaiting-approval-invalidation",
          stage: "status-update",
          nextStatus: "needs-replan",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (invalidatedStatus) {
        try {
          await this.logEntry(
            id,
            `User comment invalidated spec approval — task needs re-specification`,
            undefined,
            runContext,
          );
        } catch (err) {
          storeLog.warn("Best-effort post-comment awaiting-approval invalidation failed", {
            ...commentContextBase,
            phase: "addComment:awaiting-approval-invalidation",
            stage: "post-invalidation-log-entry",
            nextStatus: "needs-replan",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return task;
  }

  /**
   * List all current task documents for a task, ordered by key.
   */
  async getTaskDocuments(taskId: string): Promise<TaskDocument[]> {
    const rows = this.db
      .prepare("SELECT * FROM task_documents WHERE taskId = ? ORDER BY key")
      .all(taskId) as unknown as TaskDocumentRow[];
    return rows.map((row) => this.rowToTaskDocument(row));
  }

  /**
   * List all documents across all tasks, optionally filtered by search query.
   * Each document includes its parent task's title and column for display.
   */
  async getAllDocuments(options?: {
    searchQuery?: string;
    limit?: number;
    offset?: number;
  }): Promise<TaskDocumentWithTask[]> {
    const limit = Math.min(Math.max(1, options?.limit ?? 200), 1000);
    const offset = Math.max(0, options?.offset ?? 0);

    let sql = `
      SELECT td.*, t.title as taskTitle, t.description as taskDescription, t.column as taskColumn
      FROM task_documents td
      JOIN tasks t ON td.taskId = t.id
    `;
    const params: (string | number)[] = [];

    if (options?.searchQuery && options.searchQuery.trim() !== "") {
      const query = `%${options.searchQuery.trim()}%`;
      sql += ` WHERE td.key LIKE ? OR td.content LIKE ? OR t.title LIKE ?`;
      params.push(query, query, query);
    }

    sql += ` ORDER BY td.updatedAt DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as unknown as (TaskDocumentRow & { taskTitle: string; taskDescription: string; taskColumn: string })[];
    return rows.map((row) => {
      const doc = this.rowToTaskDocument(row);
      return {
        ...doc,
        taskTitle: row.taskTitle,
        taskDescription: row.taskDescription,
        taskColumn: row.taskColumn,
      };
    });
  }

  /**
   * Get the current revision of a specific task document.
   */
  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    const row = this.db
      .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
      .get(taskId, key) as unknown as TaskDocumentRow | undefined;
    if (!row) return null;
    return this.rowToTaskDocument(row);
  }

  /**
   * Create or update a task document while archiving previous revisions.
   */
  async upsertTaskDocument(taskId: string, input: TaskDocumentCreateInput): Promise<TaskDocument> {
    try {
      validateDocumentKey(input.key);
    } catch {
      throw new Error(
        `Invalid document key: "${input.key}". Must be 1-64 alphanumeric characters, hyphens, or underscores.`,
      );
    }

    const taskExists = this.db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as
      | { id: string }
      | undefined;
    if (!taskExists) {
      throw new Error(`Task ${taskId} not found`);
    }

    const now = new Date().toISOString();
    const author = input.author ?? "user";
    const metadata = toJsonNullable(input.metadata);

    const document = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
        .get(taskId, input.key) as TaskDocumentRow | undefined;

      if (existing) {
        this.db.prepare(
          `INSERT INTO task_document_revisions (taskId, key, content, revision, author, metadata, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          taskId,
          input.key,
          existing.content,
          existing.revision,
          existing.author,
          existing.metadata ?? null,
          now,
        );

        this.db.prepare(
          `UPDATE task_documents
           SET content = ?, revision = ?, author = ?, metadata = ?, updatedAt = ?
           WHERE taskId = ? AND key = ?`
        ).run(
          input.content,
          existing.revision + 1,
          author,
          metadata,
          now,
          taskId,
          input.key,
        );
      } else {
        this.db.prepare(
          `INSERT INTO task_documents (id, taskId, key, content, revision, author, metadata, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          taskId,
          input.key,
          input.content,
          1,
          author,
          metadata,
          now,
          now,
        );
      }

      const row = this.db
        .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
        .get(taskId, input.key) as TaskDocumentRow | undefined;

      if (!row) {
        throw new Error(`Failed to upsert document ${input.key} for task ${taskId}`);
      }

      return this.rowToTaskDocument(row);
    });

    this.db.bumpLastModified();
    const task = await this.getTask(taskId);
    this.emit("task:updated", task);

    return document;
  }

  /**
   * List archived revisions for a task document, newest first.
   */
  async getTaskDocumentRevisions(
    taskId: string,
    key: string,
    options?: { limit?: number },
  ): Promise<TaskDocumentRevision[]> {
    const hasLimit = options?.limit !== undefined;
    const rows = hasLimit
      ? (this.db
          .prepare(
            "SELECT * FROM task_document_revisions WHERE taskId = ? AND key = ? ORDER BY revision DESC LIMIT ?",
          )
          .all(taskId, key, Math.max(0, options.limit ?? 0)) as unknown as TaskDocumentRevisionRow[])
      : (this.db
          .prepare(
            "SELECT * FROM task_document_revisions WHERE taskId = ? AND key = ? ORDER BY revision DESC",
          )
          .all(taskId, key) as unknown as TaskDocumentRevisionRow[]);

    return rows.map((row) => this.rowToTaskDocumentRevision(row));
  }

  /**
   * Delete a task document and all archived revisions for its key.
   */
  async deleteTaskDocument(taskId: string, key: string): Promise<void> {
    const existing = this.db
      .prepare("SELECT id FROM task_documents WHERE taskId = ? AND key = ?")
      .get(taskId, key) as { id: string } | undefined;

    if (!existing) {
      throw new Error(`Document ${key} not found for task ${taskId}`);
    }

    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM task_document_revisions WHERE taskId = ? AND key = ?")
        .run(taskId, key);

      const result = this.db
        .prepare("DELETE FROM task_documents WHERE taskId = ? AND key = ?")
        .run(taskId, key) as { changes?: number };

      if ((result.changes ?? 0) === 0) {
        throw new Error(`Document ${key} not found for task ${taskId}`);
      }
    });

    this.db.bumpLastModified();
    const task = await this.getTask(taskId);
    this.emit("task:updated", task);
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
   * Read historical agent log entries for a task from SQLite.
   * Returns entries in chronological order (oldest first).
   *
   * Each entry's `text` and `detail` fields are returned in full — there is
   * no per-entry truncation at the persistence layer. The 500-entry cap
   * (`MAX_LOG_ENTRIES`) in the dashboard hooks is a whole-list limit only.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @param options - Optional pagination options
   * @param options.limit - Maximum number of entries to return (most recent)
   * @param options.offset - Number of most-recent entries to skip (for pagination)
   * @returns Array of agent log entries
   */
  async getAgentLogs(
    taskId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<AgentLogEntry[]> {
    const limit = options?.limit !== undefined
      ? (Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 0)
      : undefined;
    const offset = options?.offset !== undefined
      ? (Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0)
      : 0;

    if (limit === 0) return [];

    if (limit !== undefined) {
      const readCount = offset > 0 ? limit + offset : limit;
      const rows = this.db.prepare(`
        SELECT * FROM agentLogEntries
        WHERE taskId = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      `).all(taskId, readCount) as Array<Record<string, unknown>>;
      const entries = rows.map((row) => this.mapAgentLogRow(row)).reverse();
      if (offset > 0) {
        return entries.slice(0, Math.max(0, entries.length - offset));
      }
      return entries;
    }

    const rows = this.db.prepare(`
      SELECT * FROM agentLogEntries
      WHERE taskId = ?
      ORDER BY timestamp ASC, id ASC
    `).all(taskId) as Array<Record<string, unknown>>;
    const entries = rows.map((row) => this.mapAgentLogRow(row));
    if (offset > 0) {
      return entries.slice(0, Math.max(0, entries.length - offset));
    }
    return entries;
  }

  /**
   * Count total number of persisted agent log entries for a task in SQLite.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @returns Total number of log entries
   */
  async getAgentLogCount(taskId: string): Promise<number> {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM agentLogEntries WHERE taskId = ?",
    ).get(taskId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Get persisted agent log entries for a task filtered by an inclusive time range.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @param startIso - ISO-8601 start timestamp (inclusive)
   * @param endIso - ISO-8601 end timestamp (inclusive), or null for "now"
   * @returns Filtered array of agent log entries
   */
  async getAgentLogsByTimeRange(
    taskId: string,
    startIso: string,
    endIso: string | null,
  ): Promise<AgentLogEntry[]> {
    const end = endIso ?? new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM agentLogEntries
      WHERE taskId = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC, id ASC
    `).all(taskId, startIso, end) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapAgentLogRow(row));
  }

  async importLegacyAgentLogs(): Promise<number> {
    if (!existsSync(this.tasksDir)) return 0;

    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    let imported = 0;
    const insertStmt = this.db.prepare(`
      INSERT INTO agentLogEntries (taskId, timestamp, text, type, detail, agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const logPath = join(this.tasksDir, entry.name, "agent.log");
      if (!existsSync(logPath)) continue;

      try {
        const content = await readFile(logPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
            const parsedTaskId = typeof parsed.taskId === "string" ? parsed.taskId : null;
            const type = typeof parsed.type === "string" ? parsed.type : null;
            if (!timestamp || !parsedTaskId || !type) continue;

            const text = typeof parsed.text === "string" ? parsed.text : "";
            const detail = typeof parsed.detail === "string" ? parsed.detail : null;
            const agent = typeof parsed.agent === "string" ? parsed.agent : null;

            insertStmt.run(parsedTaskId, timestamp, text, type, detail, agent);
            imported += 1;
          } catch {
            // Skip malformed JSONL lines.
          }
        }
      } catch (err) {
        storeLog.warn("Skipping unreadable legacy agent.log file during import", {
          phase: "importLegacyAgentLogs:read-file",
          taskId: entry.name,
          logPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (imported > 0) {
      this.db.bumpLastModified();
    }

    return imported;
  }

  private async importLegacyAgentLogsOnce(): Promise<void> {
    const migrationKey = "agentLogLegacyFileImportVersion";
    const migrationVersion = "1";
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;

    if (row?.value === migrationVersion) {
      return;
    }

    await this.importLegacyAgentLogs();
    this.db.prepare(`
      INSERT INTO __meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(migrationKey, migrationVersion);
    this.db.bumpLastModified();
  }

  // ── Archive Cleanup Methods ─────────────────────────────────────────

  /**
   * Read all archived task entries from SQLite.
   */
  async readArchiveLog(): Promise<import("./types.js").ArchivedTaskEntry[]> {
    return this.archiveDb.list();
  }

  /**
   * Find a specific task in the archive by ID.
   */
  async findInArchive(id: string): Promise<import("./types.js").ArchivedTaskEntry | undefined> {
    return this.archiveDb.get(id);
  }

  private migrateLegacyArchiveEntriesToArchiveDb(): void {
    const rows = this.db.prepare("SELECT id, data FROM archivedTasks").all() as Array<{ id: string; data: string }>;
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      const entry = JSON.parse(row.data) as ArchivedTaskEntry;
      this._archiveDb?.upsert({
        ...entry,
        log: compactTaskActivityLog(entry.log ?? []),
      });
    }

    this.db.prepare("DELETE FROM archivedTasks").run();
    this.db.bumpLastModified();
  }

  private async migrateActiveArchivedTasksToArchiveDb(): Promise<void> {
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE "column" = 'archived'`).all() as unknown as TaskRow[];
    if (rows.length === 0) {
      return;
    }

    const { rm } = await import("node:fs/promises");
    for (const row of rows) {
      const task = this.rowToTask(row);
      const archivedAt = task.columnMovedAt ?? task.updatedAt ?? new Date().toISOString();
      const entry = await this.taskToArchiveEntry(task, archivedAt);
      this.archiveDb.upsert(entry);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
      await rm(this.taskDir(task.id), { recursive: true, force: true });
      if (this.isWatching) {
        this.taskCache.delete(task.id);
      }
    }

    this.db.bumpLastModified();
  }

  /**
   * Cleanup any legacy active archived tasks by writing compact entries to
   * archive.db and removing task directories.
   */
  async cleanupArchivedTasks(): Promise<string[]> {
    const archivedTasks = await this.listTasks({ column: "archived" });

    const cleanedUpIds: string[] = [];

    for (const task of archivedTasks) {
      const dir = this.taskDir(task.id);

      // Skip if directory already cleaned up
      if (!existsSync(dir)) {
        continue;
      }

      const entry = await this.taskToArchiveEntry(task, new Date().toISOString());
      this.archiveDb.upsert(entry);

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
   * Agent log entries are stored in SQLite and are deleted by FK cascade when
   * the task row is removed; archive snapshots (`agentLogFull`/`agentLogSnapshot`)
   * preserve point-in-time log data inside the archived task record.
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
      priority: normalizeTaskPriority(entry.priority),
      column: "archived", // Will be changed to "done" by unarchiveTask
      dependencies: entry.dependencies,
      steps: entry.steps,
      currentStep: entry.currentStep,
      size: entry.size,
      reviewLevel: entry.reviewLevel,
      prInfo: entry.prInfo,
      issueInfo: entry.issueInfo,
      sourceIssue: entry.sourceIssue,
      attachments: entry.attachments,
      log: [...entry.log, { timestamp: new Date().toISOString(), action: "Task restored from archive" }],
      comments: entry.comments,
      createdAt: entry.createdAt,
      updatedAt: new Date().toISOString(),
      columnMovedAt: entry.columnMovedAt,
      modelPresetId: entry.modelPresetId,
      modelProvider: entry.modelProvider,
      modelId: entry.modelId,
      validatorModelProvider: entry.validatorModelProvider,
      validatorModelId: entry.validatorModelId,
      planningModelProvider: entry.planningModelProvider,
      planningModelId: entry.planningModelId,
      breakIntoSubtasks: entry.breakIntoSubtasks,
      modifiedFiles: entry.modifiedFiles,
      // Intentionally NOT restoring: worktree, status, blockedBy, paused, baseBranch, baseCommitSha, error
    };

    // Write task.json
    await this.atomicWriteTaskJson(dir, restoredTask);

    // Generate PROMPT.md with preserved steps
    const prompt = entry.prompt ?? this.generatePromptFromArchiveEntry(entry);
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
   * Generates a unique ID (WS-001, WS-002, etc.) and stores in the workflow_steps table.
   */
  async createWorkflowStep(input: import("./types.js").WorkflowStepInput): Promise<import("./types.js").WorkflowStep> {
    return this.withConfigLock(async () => {
      const counterRow = this.db
        .prepare("SELECT nextWorkflowStepId FROM config WHERE id = 1")
        .get() as { nextWorkflowStepId?: number } | undefined;
      const nextWsId = counterRow?.nextWorkflowStepId || 1;
      const id = `WS-${String(nextWsId).padStart(3, "0")}`;

      const mode = input.mode || "prompt";

      // Validate: script mode requires scriptName
      if (mode === "script" && !input.scriptName?.trim()) {
        throw new Error("Script mode requires a scriptName");
      }

      const now = new Date().toISOString();
      const step: import("./types.js").WorkflowStep = {
        id,
        templateId: input.templateId,
        name: input.name,
        description: input.description,
        mode,
        phase: input.phase || "pre-merge",
        prompt: mode === "prompt" ? (input.prompt || "") : "",
        toolMode: mode === "prompt" ? (input.toolMode || "readonly") : undefined,
        scriptName: mode === "script" ? input.scriptName : undefined,
        enabled: input.enabled !== undefined ? input.enabled : true,
        defaultOn: input.defaultOn !== undefined ? input.defaultOn : undefined,
        modelProvider: mode === "prompt" ? input.modelProvider : undefined,
        modelId: mode === "prompt" ? input.modelId : undefined,
        createdAt: now,
        updatedAt: now,
      };

      this.db.prepare(
        `INSERT INTO workflow_steps (
          id,
          templateId,
          name,
          description,
          mode,
          phase,
          prompt,
          toolMode,
          scriptName,
          enabled,
          defaultOn,
          modelProvider,
          modelId,
          createdAt,
          updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        step.id,
        step.templateId ?? null,
        step.name,
        step.description,
        step.mode,
        step.phase || "pre-merge",
        step.prompt,
        step.toolMode ?? null,
        step.scriptName ?? null,
        step.enabled ? 1 : 0,
        step.defaultOn === undefined ? null : step.defaultOn ? 1 : 0,
        step.modelProvider ?? null,
        step.modelId ?? null,
        step.createdAt,
        step.updatedAt,
      );

      const config = await this.readConfig();
      await this.writeConfig(config, { nextWorkflowStepId: nextWsId + 1 });
      this.workflowStepsCache = null;

      return step;
    });
  }

  /**
   * List all workflow step definitions from workflow_steps.
   * Results are cached and invalidated on create/update/delete.
   */
  async listWorkflowSteps(): Promise<import("./types.js").WorkflowStep[]> {
    if (this.workflowStepsCache) return this.workflowStepsCache;
    const rows = this.db.prepare("SELECT * FROM workflow_steps ORDER BY createdAt ASC").all() as Array<{
      id: string;
      templateId: string | null;
      name: string;
      description: string;
      mode: string;
      phase: string | null;
      prompt: string;
      toolMode: string | null;
      scriptName: string | null;
      enabled: number;
      defaultOn: number | null;
      modelProvider: string | null;
      modelId: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    this.workflowStepsCache = rows.map((row) => this.applyLegacyWorkflowStepOverrides(this.toStoredWorkflowStep(row)));
    return this.workflowStepsCache;
  }

  /**
   * Get a single workflow step by ID.
   */
  async getWorkflowStep(id: string): Promise<import("./types.js").WorkflowStep | undefined> {
    const byId = this.db.prepare("SELECT * FROM workflow_steps WHERE id = ?").get(id) as
      | {
          id: string;
          templateId: string | null;
          name: string;
          description: string;
          mode: string;
          phase: string | null;
          prompt: string;
          toolMode: string | null;
          scriptName: string | null;
          enabled: number;
          defaultOn: number | null;
          modelProvider: string | null;
          modelId: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (byId) {
      return this.applyLegacyWorkflowStepOverrides(this.toStoredWorkflowStep(byId));
    }

    const byTemplate = this.db
      .prepare("SELECT * FROM workflow_steps WHERE templateId = ? ORDER BY createdAt ASC LIMIT 1")
      .get(id) as
      | {
          id: string;
          templateId: string | null;
          name: string;
          description: string;
          mode: string;
          phase: string | null;
          prompt: string;
          toolMode: string | null;
          scriptName: string | null;
          enabled: number;
          defaultOn: number | null;
          modelProvider: string | null;
          modelId: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (byTemplate) {
      return this.applyLegacyWorkflowStepOverrides(this.toStoredWorkflowStep(byTemplate));
    }

    const template = this.getBuiltInWorkflowTemplate(id);
    return template ? this.toBuiltInWorkflowStep(template) : undefined;
  }

  /**
   * Update a workflow step definition.
   * @throws Error if the workflow step is not found
   */
  async updateWorkflowStep(id: string, updates: Partial<import("./types.js").WorkflowStepInput>): Promise<import("./types.js").WorkflowStep> {
    const row = this.db.prepare("SELECT * FROM workflow_steps WHERE id = ?").get(id) as
      | {
          id: string;
          templateId: string | null;
          name: string;
          description: string;
          mode: string;
          phase: string | null;
          prompt: string;
          toolMode: string | null;
          scriptName: string | null;
          enabled: number;
          defaultOn: number | null;
          modelProvider: string | null;
          modelId: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) {
      throw new Error(`Workflow step '${id}' not found`);
    }

    const step = this.toStoredWorkflowStep(row);

    // Handle mode change
    if (updates.mode !== undefined) {
      const newMode = updates.mode;
      // Validate: script mode requires scriptName
      if (newMode === "script" && !updates.scriptName?.trim() && !step.scriptName?.trim()) {
        throw new Error("Script mode requires a scriptName");
      }
      step.mode = newMode;
      // When switching to script mode, clear prompt and model overrides
      if (newMode === "script") {
        step.prompt = "";
        step.toolMode = undefined;
        step.modelProvider = undefined;
        step.modelId = undefined;
      }
      // When switching to prompt mode, clear scriptName
      if (newMode === "prompt") {
        step.scriptName = undefined;
        step.toolMode = step.toolMode || "readonly";
      }
    }

    if (updates.name !== undefined) step.name = updates.name;
    if (updates.description !== undefined) step.description = updates.description;
    if (updates.phase !== undefined) step.phase = updates.phase;
    if (updates.prompt !== undefined && step.mode === "prompt") step.prompt = updates.prompt;
    if (updates.toolMode !== undefined && step.mode === "prompt") step.toolMode = updates.toolMode;
    if (updates.scriptName !== undefined && step.mode === "script") step.scriptName = updates.scriptName;
    if (updates.enabled !== undefined) step.enabled = updates.enabled;
    if (updates.defaultOn !== undefined) step.defaultOn = updates.defaultOn;
    if (step.mode === "script" && !step.scriptName?.trim()) {
      throw new Error("Script mode requires a scriptName");
    }
    if (step.mode === "prompt") {
      if ("modelProvider" in updates) step.modelProvider = updates.modelProvider;
      if ("modelId" in updates) step.modelId = updates.modelId;
    }
    step.updatedAt = new Date().toISOString();

    this.db.prepare(
      `UPDATE workflow_steps
       SET templateId = ?,
           name = ?,
           description = ?,
           mode = ?,
           phase = ?,
           prompt = ?,
           toolMode = ?,
           scriptName = ?,
           enabled = ?,
           defaultOn = ?,
           modelProvider = ?,
           modelId = ?,
           updatedAt = ?
       WHERE id = ?`,
    ).run(
      step.templateId ?? null,
      step.name,
      step.description,
      step.mode,
      step.phase || "pre-merge",
      step.prompt,
      step.toolMode ?? null,
      step.scriptName ?? null,
      step.enabled ? 1 : 0,
      step.defaultOn === undefined ? null : step.defaultOn ? 1 : 0,
      step.modelProvider ?? null,
      step.modelId ?? null,
      step.updatedAt,
      step.id,
    );
    this.db.bumpLastModified();
    this.workflowStepsCache = null;

    return step;
  }

  /**
   * Delete a workflow step definition.
   * Also removes the ID from any tasks that reference it in enabledWorkflowSteps.
   * @throws Error if the workflow step is not found
   */
  async deleteWorkflowStep(id: string): Promise<void> {
    const deleted = this.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(id) as {
      changes?: number;
    };

    if ((deleted.changes || 0) === 0) {
      throw new Error(`Workflow step '${id}' not found`);
    }

    this.db.bumpLastModified();
    this.workflowStepsCache = null;

    // Clean up references from existing tasks (best-effort, outside config lock)
    try {
      const tasks = await this.listTasks({ slim: true });
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
    if (this._archiveDb) {
      this._archiveDb.close();
      this._archiveDb = null;
    }
  }

  /**
   * Run a WAL checkpoint to truncate the WAL file and reclaim disk space.
   * Safe to call periodically from the self-healing maintenance timer.
   */
  walCheckpoint(): { busy: number; log: number; checkpointed: number } {
    return this.db.walCheckpoint();
  }

  getRootDir(): string {
    return this.rootDir;
  }

  /** Return the `.fusion` directory path (e.g. `/project/.fusion`). */
  getFusionDir(): string {
    return this.fusionDir;
  }

  getTasksDir(): string {
    return this.tasksDir;
  }

  /** Expose the shared Database instance for co-located stores (e.g. AiSessionStore). */
  getDatabase(): Database {
    return this.db;
  }

  /**
   * Perform a simple database health check.
   * Returns true if the database responds correctly, false otherwise.
   * Used for periodic health diagnostics.
   */
  healthCheck(): boolean {
    try {
      // Simple query to verify database responsiveness
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
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

- [ ] Lint passes
- [ ] All tests pass
- [ ] Typecheck passes
- [ ] No regressions introduced

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation

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
      const row = this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings: string | null } | undefined;
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
      storeLog.error("Failed to record activity", {
        id: fullEntry.id,
        type: fullEntry.type,
        taskId: fullEntry.taskId,
        taskTitle: fullEntry.taskTitle,
        detailsLength: fullEntry.details.length,
        hasMetadata: fullEntry.metadata !== undefined,
        error: err instanceof Error ? err.message : String(err),
      });
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
    const params: (string | number)[] = [];

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

    const rows = this.db.prepare(sql).all(...params) as unknown as ActivityLogRow[];
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
      this.missionStore = new MissionStore(this.fusionDir, this.db, this);
    }
    return this.missionStore;
  }

  /**
   * Get the PluginStore instance for plugin registry operations.
   * Lazily initializes the PluginStore on first access.
   */
  getPluginStore(): PluginStore {
    if (!this.pluginStore) {
      this.pluginStore = new PluginStore(this.rootDir);
    }
    return this.pluginStore;
  }

  /**
   * Get the RoadmapStore instance for standalone roadmap operations.
   * Lazily initializes the RoadmapStore on first access.
   */
  getRoadmapStore(): RoadmapStore {
    if (!this.roadmapStore) {
      this.roadmapStore = new RoadmapStore(this.db);
    }
    return this.roadmapStore;
  }

  /**
   * Get the InsightStore instance for project insights operations.
   * Lazily initializes the InsightStore on first access.
   */
  getInsightStore(): InsightStore {
    if (!this.insightStore) {
      this.insightStore = new InsightStore(this.db);
    }
    return this.insightStore;
  }

  /**
   * Get the TodoStore instance for project-scoped todo list operations.
   * Lazily initializes the TodoStore on first access.
   */
  getTodoStore(): TodoStore {
    if (!this.todoStore) {
      this.todoStore = new TodoStore(this.db);
    }
    return this.todoStore;
  }

  // ── Backward Compatibility (Multi-Project Support) ────────────────────────

}
