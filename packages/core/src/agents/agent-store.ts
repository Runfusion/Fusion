/**
 * AgentStore - persistence for agent lifecycle management.
 *
 * FNXC:PostgresRuntimeStorage 2026-07-14-18:49:
 * Agent records, heartbeat events, runs, task sessions, API keys, config
 * revisions, and blocked-state snapshots are stored in project-scoped PostgreSQL tables.
 * Managed instruction bundle markdown files remain on disk because they are
 * edited as normal project files.
 */

import { mkdir, readFile, writeFile, readdir, unlink, rename, access, appendFile } from "node:fs/promises";
import { constants as fsConstants, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Agent,
  AgentState,
  AgentCapability,
  AgentCreateInput,
  AgentUpdateInput,
  AgentApiKey,
  AgentApiKeyCreateResult,
  AgentHeartbeatEvent,
  AgentHeartbeatRun,
  BlockedStateSnapshot,
  AgentDetail,
  AgentBudgetConfig,
  AgentBudgetStatus,
  AgentTaskSession,
  AgentConfigRevision,
  AgentConfigSnapshot,
  AgentAccessState,
  AgentPermissionPolicy,
  OrgTreeNode,
  InstructionsBundleConfig,
  AgentRating,
  AgentRatingSummary,
  AgentRatingInput,
  Task,
  AgentLogEntry,
} from "../types.js";
import {
  AGENT_VALID_TRANSITIONS,
  agentToConfigSnapshot,
  diffConfigSnapshots,
  isEphemeralAgent,
  CheckoutConflictError,
  DEFAULT_HEARTBEAT_PROCEDURE_PATH,
  getDefaultHeartbeatProcedurePath,
  getCanonicalAgentInstructionsBundleDirName,
  getLegacyAgentAssetDirectoryName,
  getLegacyAgentInstructionsBundleDirName,
  getSafeAgentAssetIdSegment,
} from "../types.js";
import type { CentralClaimStore, CheckoutClaimContext, RunMutationContext } from "../types.js";
import type { TaskStore } from "../store.js";
import {resolveTaskLifecycleColumns} from "../workflows/workflow-lifecycle-traits.js";
import { computeAccessState, normalizePermissions } from "./agent-permissions.js";
import { assertImplementationTaskBindAllowed, evaluateImplementationTaskBind } from "./agent-role-policy.js";
import { normalizeAgentPermissionPolicy } from "./agent-permission-policy.js";
import { normalizeAgentRoles } from "../types/agents/agents.js";
import { Database } from "../db/db.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { appendAgentActivityEvent } from "../task-store/async/async-agent-activity.js";
import { resolveAgentActivityAttribution } from "../task-store/agent-activity-outbox.js";
import * as postgresSchema from "../postgres/schema/index.js";
import { and, eq, gt, lte, sql } from "drizzle-orm";
/*
 * FNXC:SqliteFinalRemoval 2026-06-25-23:30:
 * Async Drizzle helpers for backend-mode (PostgreSQL) AgentStore operations.
 * Each helper targets the project-schema tables via Drizzle and is the async
 * equivalent of the sync this.db.prepare() call sites below.
 */
import type { QueryHandle } from "../async-stores/async-mission-store-queries.js";
import {
  writeAgent as writeAgentAsync,
  readAgent as readAgentAsync,
  listAgentRows as listAgentRowsAsync,
  findAgentRowsByName as findAgentRowsByNameAsync,
  deleteAgent as deleteAgentAsync,
  recordHeartbeat as recordHeartbeatAsync,
  getHeartbeatHistory as getHeartbeatHistoryAsync,
  appendConfigRevision as appendConfigRevisionAsync,
  readConfigRevisions as readConfigRevisionsAsync,
  findConfigRevisionById as findConfigRevisionByIdAsync,
  addRating as addRatingAsync,
  getRatings as getRatingsAsync,
  deleteRating as deleteRatingAsync,
  saveRun as saveRunAsync,
  getRunDetail as getRunDetailAsync,
  getRecentRuns as getRecentRunsAsync,
  getRunById as getRunByIdAsync,
  listActiveHeartbeatRuns as listActiveHeartbeatRunsAsync,
  getRunStatusCounts as getRunStatusCountsAsync,
  getTaskSession as getTaskSessionAsync,
  upsertTaskSession as upsertTaskSessionAsync,
  deleteTaskSession as deleteTaskSessionAsync,
  readApiKeys as readApiKeysAsync,
  insertApiKey as insertApiKeyAsync,
  revokeApiKeyRow as revokeApiKeyRowAsync,
  getLastBlockedState as getLastBlockedStateAsync,
  setLastBlockedState as setLastBlockedStateAsync,
  clearLastBlockedState as clearLastBlockedStateAsync,
} from "../async-stores/async-agent-store.js";
import { createLogger } from "../process/logger.js";
import { truncateAgentLogDetail } from "./agent-log-constants.js";
import { FsWatchPollController } from "../process/fs-watch-poll-controller.js";
import {
  BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG,
  BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST,
  type BuiltinWorkflowRole,
} from "./workflow-role-agent-defaults.js";
import {
  BUILTIN_MEMORY_AGENT_DEFAULT,
  BUILTIN_MEMORY_AGENT_FALLBACK_NAME,
  BUILTIN_MEMORY_AGENT_NAME,
  BUILTIN_MEMORY_AGENT_PROVENANCE_KEY,
} from "./memory-agent-defaults.js";

const agentStoreLog = createLogger("agent-store");

/*
FNXC:WorkflowAgentIdentities 2026-08-08-06:11:
Only a unique subset of the two managed mirror names is an incomplete default bundle eligible for
repair. Extra or duplicate inventory entries are operator-owned configuration and must not be
silently normalized during startup.
*/
function isCanonicalOrPartialBuiltinWorkflowBundle(config: InstructionsBundleConfig | undefined): boolean {
  if (config?.mode !== "managed" || config.entryFile !== "AGENTS.md") return false;
  return config.files.every((file) => (file === "AGENTS.md" || file === "soul.md")
    && config.files.indexOf(file) === config.files.lastIndexOf(file));
}

function isCompleteBuiltinWorkflowBundle(config: InstructionsBundleConfig | undefined): boolean {
  return isCanonicalOrPartialBuiltinWorkflowBundle(config)
    && config!.files.length === BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG.files.length;
}

function compareBuiltinWorkflowOwnerAge(a: Agent, b: Agent): number {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) return aTime - bTime;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Database row shape returned by SELECT on agentRatings. */
interface AgentRatingRow {
  id: string;
  agentId: string;
  raterType: string;
  raterId: string | null;
  score: number;
  category: string | null;
  comment: string | null;
  runId: string | null;
  taskId: string | null;
  createdAt: string;
}

/** Events emitted by AgentStore */
export interface AgentStoreEvents {
  /** Emitted when an agent is created */
  "agent:created": (agent: Agent) => void;
  /** Emitted when an agent is updated */
  "agent:updated": (agent: Agent, previousState?: AgentState) => void;
  /** Emitted when an agent is deleted */
  "agent:deleted": (agentId: string) => void;
  /** Emitted when a heartbeat is recorded */
  "agent:heartbeat": (agentId: string, event: AgentHeartbeatEvent) => void;
  /** Emitted when an agent state changes */
  "agent:stateChanged": (agentId: string, from: AgentState, to: AgentState) => void;
  /** Emitted when a config revision is recorded */
  "agent:configRevision": (agentId: string, revision: AgentConfigRevision) => void;
  /** Emitted when a task is assigned to an agent (taskId is non-empty) */
  "agent:assigned": (agent: Agent, taskId: string) => void;
  /** Emitted when a rating is added */
  "rating:added": (rating: AgentRating) => void;
  /** Emitted when a log entry is appended to a run's JSONL log. */
  "run:log": (agentId: string, runId: string, entry: AgentLogEntry) => void;
}

/** Options for AgentStore constructor */
export interface AgentStoreOptions {
  /** Root directory for kb data (default: .fusion) */
  rootDir?: string;
  /** Optional TaskStore for checkout/release operations */
  taskStore?: TaskStore;
  /** Optional authoritative central claim store for cross-node checkout mutex. */
  claimStore?: CentralClaimStore;
  /** Project ID for central claim ownership rows (required when claimStore is set). */
  projectId?: string;
  /** Optional default nodeId when checkout leaseContext omits one. */
  nodeId?: string;
  /**
  /**
   * FNXC:SqliteFinalRemoval 2026-06-25-23:10:
   * When an AsyncDataLayer is injected, AgentStore operates in "backend mode":
   * all data access delegates to PostgreSQL via Drizzle and no SQLite Database
   * is constructed. When absent, the legacy SQLite path is byte-identical to
   * pre-migration. This mirrors the TaskStore dual-path pattern from
   * runtime-backend-injection. (The inMemoryDb test-only option was removed
   * as part of the SQLite runtime removal.)
   */
  asyncLayer?: AsyncDataLayer;
}

/** Agent data as stored in SQLite JSON columns */
interface AgentData {
  id: string;
  name: string;
  roles?: AgentCapability[];
  /** Deprecated compatibility projection persisted for legacy consumers. */
  role: AgentCapability;
  state: AgentState;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt?: string;
  metadata: Record<string, unknown>;
  title?: string;
  icon?: string;
  imageUrl?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  pauseReason?: string;
  permissions?: Record<string, boolean>;
  permissionPolicy?: AgentPermissionPolicy;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  lastError?: string;
  instructionsPath?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  bundleConfig?: InstructionsBundleConfig;
  heartbeatProcedurePath?: string;
}
interface AgentRow {
  id: string;
  name: string;
  role: AgentCapability;
  state: AgentState;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  metadata: string | null;
  data: string | null;
}
interface AgentLock {
  promise: Promise<unknown>;
}

/**
 * Default recurring heartbeat interval (1 hour). The engine's
 * HeartbeatTriggerScheduler already falls back to this value when an agent
 * has no explicit interval, but we also write it onto non-ephemeral agents at
 * creation time so the persisted config mirrors the effective schedule.
 */
export const DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS = 3_600_000;

export function formatCurrentTaskLine(taskId: string, linkedTask: Pick<Task, "column"> | null | undefined): string {
  /*
  FNXC:AgentTaskStateDrift 2026-06-27-16:05:
  FN-7138 requires human-readable agent surfaces to include the linked task column so coordinators can distinguish legitimate transient triage/planning ownership from stale execution drift.
  */
  if (!linkedTask) {
    return `Current Task: ${taskId} (unresolved)`;
  }
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-08:10 (fleet phase — FLAGGED AND LEFT COUNTED):
  DELIBERATE-LITERAL — marked so it is no longer merely flagged. The note below already decided this
  stays; it said so in prose, which the census cannot read, so the site kept reading as backlog and
  every later pass re-derived the same answer. The marker moves it to `deliberateByFile`.
  A pure formatter over `Pick<Task, "column">` — no store, no task id, and its output PRINTS the column
  name for a human reader. Same class as `github-tracking-comments.ts:165` and
  `in-process-runtime`'s duration helpers: threading a resolution into a string builder to pick a word is
  the wrong trade, and the line degrades gracefully (it says "(not active — <column>)" only for the
  built-in completion id; on a renamed board it falls through to "(<column>)", which is still accurate, just
  specific).
  */
  /*
  DELIBERATE-LITERAL — reviewed 2026-07-31-12:10 (fleet). This picks a WORD for a human reader, not
  a lifecycle decision: `(not active — done)` versus `(done)`. It degrades gracefully on a renamed
  board — it falls through to `(<column>)`, still accurate, just less specific — and threading a
  resolution into a synchronous string builder to choose an adjective is the wrong trade.

  Marked rather than left counted because three separate workers have now independently re-derived
  this same conclusion. An unmarked correct site costs a fleet cycle every time the census points
  at it.
  */
  if (linkedTask.column === "done") {
    return `Current Task: ${taskId} (not active — ${linkedTask.column})`;
  }
  return `Current Task: ${taskId} (${linkedTask.column})`;
}

/**
 * Compute the runtimeConfig to persist for a newly created agent.
 *
 * - Ephemeral/task-worker agents (see {@link isEphemeralAgent}) keep whatever
 *   the caller supplied — task workers explicitly opt out of heartbeats via
 *   `runtimeConfig.enabled: false` and must not get a timer reintroduced.
 * - Every other agent has `heartbeatIntervalMs` filled in with the default
 *   when the caller omitted it, matching the scheduler's fallback behavior.
 *
 * Returns `undefined` when there's nothing to persist (only possible for
 * ephemeral agents with no incoming config).
 */
function normalizeStoredPermissions(raw: Record<string, boolean> | undefined): Record<string, boolean> | undefined {
  if (!raw) return undefined;
  const normalized = normalizePermissions(raw);
  if (normalized.size === 0) return undefined;
  return Object.fromEntries([...normalized].map((permission) => [permission, true]));
}

function resolveCreationRuntimeConfig(
  incoming: Record<string, unknown> | undefined,
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const isEphemeral = isEphemeralAgent({ metadata });
  if (isEphemeral) {
    return incoming;
  }
  const rc: Record<string, unknown> = { ...(incoming ?? {}) };
  if (typeof rc.enabled !== "boolean") {
    rc.enabled = true;
  }
  if (typeof rc.autoClaimRelevantTasks !== "boolean") {
    rc.autoClaimRelevantTasks = true;
  }
  if (typeof rc.heartbeatIntervalMs !== "number" || !Number.isFinite(rc.heartbeatIntervalMs)) {
    rc.heartbeatIntervalMs = DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS;
  }
  return rc;
}

/**
 * Process-wide cache of initialized Database connections, keyed by absolute
 * rootDir. Without this, callers that re-instantiate AgentStore per request
 * (the dashboard does this in ~65 places) reopen the SQLite file, re-run the
 * full schema migration, and re-execute `PRAGMA integrity_check` (a full table
 * scan) every time — on a multi-hundred-MB DB that's seconds per request and
 * leaks file handles. Sharing one Database object reduces all of that to a
 * one-time cost per process.
 *
 * In-memory DBs are intentionally *not* cached: they're test-only and each
 * test wants its own isolated `:memory:` connection.
 */
const agentStoreDbCache = new Map<string, Database>();

/**
 * AgentStore manages agent lifecycle with SQLite-backed persistence.
 * Follows the same patterns as TaskStore for consistency.
 */
export class AgentStore extends EventEmitter {
  private rootDir: string;
  private agentsDir: string;
  private locks: Map<string, AgentLock> = new Map();
  private _db: Database | null = null;
  private taskStore?: TaskStore;
  private readonly claimStore?: CentralClaimStore;
  private readonly claimProjectId?: string;
  private readonly defaultNodeId?: string;

  /**
   * FNXC:SqliteFinalRemoval 2026-06-25-23:15:
   * When set, AgentStore operates in backend mode (PostgreSQL via Drizzle).
   * All data access delegates to async helpers. No SQLite Database is
   * constructed. This mirrors the TaskStore dual-path pattern.
   */
  public readonly asyncLayer: AsyncDataLayer | null = null;

  /*
  FNXC:IncompletePgPorts 2026-07-26-20:40:
  In-memory agent rows filled by getAgent() so getCachedAgent can serve sync
  heartbeat config resolution under PostgreSQL (no sync SQLite handle).
  */
  private readonly agentMemoryCache = new Map<string, Agent>();

  /** True when AsyncDataLayer was injected. Gates all SQLite construction. */
  public get backendMode(): boolean {
    return this.asyncLayer !== null;
  }

  /*
   * FNXC:AgentStore 2026-07-09-08:15:
   * FN-7723 — `fn agent stop`/`start` mutate the agent row from a SEPARATE
   * process (the CLI opens its own AgentStore, writes, and exits), so the
   * engine's long-lived in-process `agent:updated`/`agent:stateChanged`
   * listeners (HeartbeatTriggerScheduler.watchAgentLifecycle) never fire for
   * those transitions — the only prior reconciliation was the 60s
   * `auditTimerRegistrations` sweep. This opt-in fs.watch+poll lifecycle
   * (started ONLY by the long-lived engine store, never the CLI/dashboard
   * short-lived stores) mirrors TaskStore's proven watch()/checkForChanges()
   * pattern: watch the `.fusion` dir for a fast-path nudge, always run a
   * poll fallback gated by db.getLastModified(), diff agent rows against a
   * last-seen snapshot, and re-emit the EXISTING `agent:updated`/
   * `agent:stateChanged` events (no new event names) so the engine's current
   * listeners react within a bounded latency instead of waiting up to 60s.
   * The audit sweep is retained unmodified as the durable backstop.
   *
   * FNXC:AgentStore 2026-07-09-14:20:
   * FN-7726 — the mechanical fs.watch+poll lifecycle (fail-soft watch setup,
   * setInterval, teardown) is now owned by the shared `FsWatchPollController`
   * (see fs-watch-poll-controller.ts) instead of being duplicated inline;
   * this store still owns the `agentSnapshotCache`/`lastKnownModified`/
   * `pollingInProgress` diff/gating state and the actual diff body in
   * checkForChanges(), passed to the controller as `onPoll`.
   */
  private readonly watchPoll = new FsWatchPollController();
  /** Back-compat accessor so existing tests can reach the live FSWatcher via `storeAny.watcher`. */
  private get watcher(): FSWatcher | null {
    return this.watchPoll.watcher;
  }
  /** Last-seen (state, updatedAt) per agent id, used to diff external changes. Populated on startWatching() and kept current by every in-process write via touchWatchSnapshot(). */
  private agentSnapshotCache: Map<string, { state: AgentState; updatedAt: string }> = new Map();
  private lastKnownModified = 0;
  private pollingInProgress = false;

  constructor(options: AgentStoreOptions = {}) {
    super();

    if (!options.rootDir && process.env.VITEST === "true") {
      throw new Error(
        "AgentStore requires an explicit rootDir during test execution. Pass an absolute path to avoid writing to unintended locations.",
      );
    }

    this.rootDir = options.rootDir ?? resolve(".fusion");
    this.agentsDir = join(this.rootDir, "agents");
    this.taskStore = options.taskStore;
    this.claimStore = options.claimStore;
    this.claimProjectId = options.projectId;
    this.defaultNodeId = options.nodeId;
    if (this.claimStore && !this.claimProjectId) {
      throw new Error("AgentStore requires projectId when claimStore is configured");
    }
    this.asyncLayer = options.asyncLayer ?? null;
  }

  private get backendProjectId(): string {
    const projectId = this.asyncLayer?.projectId;
    /*
    FNXC:AgentHeartbeatIsolation 2026-07-14-00:37:
    Backend heartbeat runs are project-owned. Reject unbound backend heartbeat/run access instead of silently reading or writing the legacy empty-string partition, which could mix ownership on a shared PostgreSQL cluster.
    */
    if (!projectId) {
      throw new Error("AgentStore backend heartbeat/run operations require asyncLayer.projectId");
    }
    return projectId;
  }

  /** The durable project partition used by workflow routing and capacity leases. */
  public get workflowProjectId(): string | undefined {
    return this.asyncLayer?.projectId;
  }

  /**
   * FNXC:WorkflowAgentRouting 2026-08-07-05:52:
   * Workflow capacity is a PostgreSQL lease rather than a process-local count.
   * The project advisory lock serializes project then agent admission across
   * engine processes; model work starts only after this short transaction ends.
   */
  public async acquireWorkflowSessionCapacity(input: {
    agentId: string;
    attemptId: string;
    maxProjectSessions?: number;
    maxAgentSessions?: number;
    leaseDurationMs?: number;
  }): Promise<"acquired" | "project-capacity" | "agent-capacity"> {
    if (!this.asyncLayer) return "acquired";
    const projectId = this.backendProjectId;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.leaseDurationMs ?? 10 * 60_000)).toISOString();
    return this.asyncLayer.transactionImmediate(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}), hashtext('workflow-agent-capacity'))`);
      /*
       * FNXC:WorkflowAgentRouting 2026-08-07-07:16:
       * Capacity is a crash-safe lease, not a permanent counter. Reclaim only
       * expired rows while holding the same project admission lock used for the
       * count and insert, so a dead engine frees slots without oversubscription.
       */
      await tx.delete(postgresSchema.project.workflowAgentCapacityLeases).where(and(
        eq(postgresSchema.project.workflowAgentCapacityLeases.projectId, projectId),
        lte(postgresSchema.project.workflowAgentCapacityLeases.expiresAt, now.toISOString()),
      ));
      const existing = await tx.select({ attemptId: postgresSchema.project.workflowAgentCapacityLeases.attemptId })
        .from(postgresSchema.project.workflowAgentCapacityLeases)
        .where(and(
          eq(postgresSchema.project.workflowAgentCapacityLeases.projectId, projectId),
          eq(postgresSchema.project.workflowAgentCapacityLeases.attemptId, input.attemptId),
        )).limit(1);
      if (existing[0]) return "acquired";
      const projectCount = await tx.select({ count: sql<number>`count(*)::int` })
        .from(postgresSchema.project.workflowAgentCapacityLeases)
        .where(eq(postgresSchema.project.workflowAgentCapacityLeases.projectId, projectId));
      if (input.maxProjectSessions !== undefined && (projectCount[0]?.count ?? 0) >= input.maxProjectSessions) return "project-capacity";
      const agentCount = await tx.select({ count: sql<number>`count(*)::int` })
        .from(postgresSchema.project.workflowAgentCapacityLeases)
        .where(and(
          eq(postgresSchema.project.workflowAgentCapacityLeases.projectId, projectId),
          eq(postgresSchema.project.workflowAgentCapacityLeases.agentId, input.agentId),
        ));
      if (input.maxAgentSessions !== undefined && (agentCount[0]?.count ?? 0) >= input.maxAgentSessions) return "agent-capacity";
      await tx.insert(postgresSchema.project.workflowAgentCapacityLeases).values({
        projectId, agentId: input.agentId, attemptId: input.attemptId, createdAt: now.toISOString(), expiresAt,
      });
      return "acquired";
    });
  }

  /** Renew only the caller's project-scoped attempt; a reclaimed lease never resurrects. */
  public async renewWorkflowSessionCapacity(attemptId: string, leaseDurationMs = 10 * 60_000): Promise<boolean> {
    if (!this.asyncLayer) return true;
    const now = new Date();
    const result = await this.asyncLayer.db.update(postgresSchema.project.workflowAgentCapacityLeases)
      .set({ expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString() })
      .where(and(
        eq(postgresSchema.project.workflowAgentCapacityLeases.projectId, this.backendProjectId),
        eq(postgresSchema.project.workflowAgentCapacityLeases.attemptId, attemptId),
        /*
         * FNXC:WorkflowAgentRouting 2026-08-07-07:30:
         * Renew a currently live lease only. An expired row may already have
         * been reclaimed by another engine's admission transaction.
         */
        gt(postgresSchema.project.workflowAgentCapacityLeases.expiresAt, now.toISOString()),
      ))
      .returning({ attemptId: postgresSchema.project.workflowAgentCapacityLeases.attemptId });
    return result.length > 0;
  }

  /** Release is project-scoped and idempotent so cancellation and recovery may race safely. */
  public async releaseWorkflowSessionCapacity(attemptId: string): Promise<void> {
    if (!this.asyncLayer) return;
    await this.asyncLayer.db.delete(postgresSchema.project.workflowAgentCapacityLeases).where(and(
      eq(postgresSchema.project.workflowAgentCapacityLeases.projectId, this.backendProjectId),
      eq(postgresSchema.project.workflowAgentCapacityLeases.attemptId, attemptId),
    ));
  }

  private get db(): Database {
        throw new Error("SQLite Database is not available in backend mode (asyncLayer injected)");
}

  /**
   * Initialize the store by creating necessary directories.
   * Should be called before other operations.
   *
   * FNXC:SqliteFinalRemoval 2026-06-25-23:20:
   * In backend mode (asyncLayer injected), skip all SQLite construction and
   * one-shot SQLite migrations. The PostgreSQL schema baseline already
   * covers these migrations. Only create the agents directory.
   */
  async init(): Promise<void> {
    await mkdir(this.agentsDir, { recursive: true });
    /*
    FNXC:WorkflowAgentRouting 2026-08-07-03:12:
    Every upgraded or new project must have the four durable workflow owners
    once storage is ready. Their heartbeat remains disabled; graph routing may
    still invoke them independently of the heartbeat scheduler.
    */
    await this.provisionBuiltinWorkflowRoleAgents();
    // Memory upkeep is optional; its collision-safe provisioning must never prevent startup.
    try {
      await this.provisionBuiltinMemoryAgent();
    } catch (error) {
      agentStoreLog.warn(`Unable to provision built-in memory agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One-shot migration that re-points every non-ephemeral agent off the
   * legacy shared `.fusion/HEARTBEAT.md` path onto their own per-agent
   * `.fusion/agents/<id>/HEARTBEAT.md` file. The legacy file's contents
   * are copied to the new location when present so operator edits are
   * preserved across the upgrade. The legacy file itself is left in place
   * — the migration is non-destructive in case the operator wants a
   * reference copy.
   *
   * Idempotent: tracks completion in the `__meta` table and short-circuits
   * on subsequent calls. Failures during file copy are logged via the
   * legacy console (no log dependency in core) and do not block startup —
   * the agent's `heartbeatProcedurePath` is still flipped, and the engine's
   * heartbeat resolver will fall back to the built-in template until the
   * file is seeded on next dashboard interaction.
   */
  private async migrateHeartbeatProcedurePathOnce(): Promise<void> {
    const migrationKey = "heartbeatProcedurePathPerAgent";
    const migrationVersion = "1";
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;
    if (row?.value === migrationVersion) {
      return;
    }

    // The legacy shared file lives at <projectRoot>/.fusion/HEARTBEAT.md.
    // `this.rootDir` is already `<projectRoot>/.fusion`, so the file is just
    // "HEARTBEAT.md" relative to it.
    let legacyContent: string | null = null;
    try {
      legacyContent = await readFile(join(this.rootDir, "HEARTBEAT.md"), "utf-8");
    } catch {
      legacyContent = null;
    }

    const agents = await this.listAgents({ includeEphemeral: false });
    let migratedCount = 0;
    for (const agent of agents) {
      if (agent.heartbeatProcedurePath !== DEFAULT_HEARTBEAT_PROCEDURE_PATH) {
        continue;
      }

      const newRelPath = await this.resolveCompatibleHeartbeatProcedurePath(agent);
      const newAbsPath = join(this.rootDir, "..", newRelPath);

      // Best-effort copy of operator edits to the new per-agent location.
      // Skip the write when the per-agent file already exists (someone
      // could have set this up manually) so we never clobber it.
      if (legacyContent !== null) {
        try {
          await mkdir(dirname(newAbsPath), { recursive: true });
          // Only seed the file if it doesn't already exist.
          try {
            await access(newAbsPath, fsConstants.F_OK);
          } catch {
            await writeFile(newAbsPath, legacyContent, "utf-8");
          }
        } catch {
          // Non-fatal — proceed with path flip even if the file copy failed.
        }
      }

      const updated: Agent = {
        ...agent,
        heartbeatProcedurePath: newRelPath,
        updatedAt: new Date().toISOString(),
      };
      await this.writeAgent(updated);
      migratedCount += 1;
    }

    this.db.prepare(`
      INSERT INTO __meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(migrationKey, migrationVersion);
    if (migratedCount > 0) {
      this.db.bumpLastModified();
    }
  }

  /**
   * One-way migration helper for projects that still have legacy agent JSON
   * files. Runtime code does not read these files after startup migration.
   */
  async importLegacyFileAgents(): Promise<number> {
    const files = await readdir(this.agentsDir).catch(() => [] as string[]);
    const agentFiles = files.filter((file) =>
      file.endsWith(".json") &&
      !file.includes("-heartbeats") &&
      !file.includes("-sessions") &&
      !file.includes("-runs") &&
      !file.includes("-revisions") &&
      !file.includes("-last-blocked")
    );

    let imported = 0;
    for (const file of agentFiles) {
      const agentId = file.replace(/\.json$/, "");
      const existing = await this.getAgent(agentId);
      if (existing) {
        continue;
      }

      try {
        const content = await readFile(join(this.agentsDir, file), "utf-8");
        const agent = this.parseAgent(JSON.parse(content) as AgentData);
        await this.writeAgent(agent);
        imported += 1;
      } catch {
        // Legacy files may be partially written or manually edited; ignore them.
      }
    }

    return imported;
  }

  /**
   * One-way migration helper for legacy structured run JSON files.
   * Runtime reads come from SQLite; this only seeds old projects.
   */
  async importLegacyFileRuns(): Promise<number> {
    /*
    FNXC:PostgresOnlyDataAccess 2026-07-17-14:20:
    One-shot legacy SQLite migration. In backend mode the INSERT below hits the
    removed-SQLite stub, and this method's per-file try/catch would swallow the
    throw and silently report "0 imported". There are no legacy SQLite file runs
    to import against PostgreSQL (the PG baseline already covers this), so no-op
    cleanly instead of laundering a stub throw into a false success.
    */
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:15: legacy run-dir import is SQLite-only; no-op under PG. */
    return 0;
  }

  private async importLegacyFileDataOnce(): Promise<void> {
    const migrationKey = "agentLegacyFileImportVersion";
    const migrationVersion = "2";
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;
    if (row?.value === migrationVersion) {
      return;
    }

    await this.importLegacyFileAgents();
    await this.importLegacyFileRuns();
    this.db.prepare(`
      INSERT INTO __meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(migrationKey, migrationVersion);
    this.db.bumpLastModified();
  }

  /**
   * One-shot migration that rewrites legacy `state = "terminated"` agents to
   * `state = "paused"` and preserves the origin via
   * `pauseReason = "migrated-from-terminated"`.
   *
   * Heartbeat run rows intentionally keep their independent `terminated`
   * terminal status; this migration only normalizes the agent lifecycle state.
   */
  private async migrateTerminatedAgentStateOnce(): Promise<void> {
    const migrationKey = "removeTerminatedAgentState";
    const migrationVersion = "1";
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;
    if (row?.value === migrationVersion) {
      return;
    }

    const rows = this.db.prepare("SELECT * FROM agents WHERE state = 'terminated'").all() as unknown as AgentRow[];
    let migratedCount = 0;
    for (const row of rows) {
      const agent = this.mapAgentRow(row);
      const updated: Agent = {
        ...agent,
        state: "paused",
        pauseReason: "migrated-from-terminated",
        updatedAt: new Date().toISOString(),
      };
      await this.writeAgent(updated);
      migratedCount += 1;
    }

    this.db.prepare(`
      INSERT INTO __meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(migrationKey, migrationVersion);
    if (migratedCount > 0) {
      this.db.bumpLastModified();
    }
  }

  /**
   * Find the first non-ephemeral agent by exact name.
   *
   * Ephemeral task-worker/spawned agents are excluded so callers can use this
   * for durable identity checks without transient runtime workers conflicting.
   *
   * @param name - Agent name to match exactly
   * @returns Matching non-ephemeral agent, or null when none exists
   */
  async findAgentByName(name: string, executor?: QueryHandle): Promise<Agent | null> {
    // FNXC:SqliteFinalRemoval 2026-06-25-23:45:
    // Backend mode: read via async Drizzle helper, filter ephemeral in-memory.
        const agents = await findAgentRowsByNameAsync(
      executor ?? this.asyncLayer!.db,
      name,
      this.workflowProjectId,
    );
    for (const agent of agents) {
      if (!isEphemeralAgent(agent)) {
        return this.parseAgent(agent as unknown as AgentData);
      }
    }
    return null;
}

  async hasNonEphemeralAgentWithName(name: string): Promise<boolean> {
    const normalizedName = name.trim();
    if (!normalizedName) {
      return false;
    }

    const existing = await this.findAgentByName(normalizedName);
    return existing !== null;
  }

  /**
   * Create a new agent with a default state based on ephemeral classification.
   *
   * For non-ephemeral agents, ensures `runtimeConfig.heartbeatIntervalMs` is
   * persisted at creation time — previously it was only ever written when the
   * user interacted with the dashboard dropdown, so agents created and never
   * touched would end up with no interval on disk. That made the dashboard's
   * freshness check behave inconsistently between agents that had been
   * configured and agents that hadn't, even though the scheduler applied the
   * same default (1h) to both at runtime. Writing the default explicitly
   * removes that divergence and keeps the persisted config truthful.
   *
   * Also enforces non-ephemeral name uniqueness: durable agents cannot share a
   * name, while ephemeral task-worker agents are allowed to duplicate names.
   *
   * @param input - Creation parameters
   * @returns The created agent
   * @throws Error if input is invalid or a duplicate non-ephemeral name exists
   */
  async createAgent(input: AgentCreateInput, executor?: QueryHandle): Promise<Agent> {
    if (!input.name?.trim()) {
      throw new Error("Agent name is required");
    }
    const roles = normalizeAgentRoles(input.roles, input.role);

    const normalizedName = input.name.trim();
    const metadata = input.metadata ?? {};
    const ephemeral = isEphemeralAgent({ metadata, name: input.name, role: roles[0], reportsTo: input.reportsTo });

    if (!ephemeral) {
      const existing = await this.findAgentByName(normalizedName, executor);
      if (existing) {
        throw new Error(`Agent with name "${normalizedName}" already exists (agentId: ${existing.id})`);
      }
    }

    const now = new Date().toISOString();
    const agentId = `agent-${randomUUID().slice(0, 8)}`;

    const runtimeConfig = resolveCreationRuntimeConfig(input.runtimeConfig, metadata);

    // Default heartbeatProcedurePath for new non-ephemeral agents so operators
    // get an editable HEARTBEAT.md file from day one. Each agent gets its
    // own per-agent file (under `.fusion/agents/<id>/HEARTBEAT.md`) so
    // tweaks to one agent's procedure do not bleed into the rest of the
    // team. Ephemeral task workers skip this — they're short-lived and
    // don't need persistent procedure files.
    const resolvedHeartbeatProcedurePath = input.heartbeatProcedurePath
      ?? (ephemeral ? undefined : getDefaultHeartbeatProcedurePath(agentId, input.name));

    /*
    FNXC:AgentPermissions 2026-07-02-00:00:
    FN-7413 makes permission configuration lifetime-agnostic: durable identity agents and ephemeral task-worker agents may both store explicit capability grants and runtime permission policies. Missing policies stay absent for every lifetime so legacy rows and newly created agents inherit the project default at runtime instead of being materialized as explicit unrestricted overrides.
    */
    const normalizedPermissionPolicy = input.permissionPolicy
      ? normalizeAgentPermissionPolicy(input.permissionPolicy)
      : undefined;

    const agent: Agent = {
      id: agentId,
      name: normalizedName,
      roles,
      role: roles[0],
      // Non-ephemeral agents start active so they immediately participate in
      // heartbeat scheduling; ephemeral/task-worker agents start idle and are
      // activated by the engine when work is assigned.
      state: ephemeral ? "idle" : "active",
      createdAt: now,
      updatedAt: now,
      metadata,
      ...(input.title && { title: input.title }),
      ...(input.icon && { icon: input.icon }),
      ...(input.imageUrl && { imageUrl: input.imageUrl }),
      ...(input.reportsTo && { reportsTo: input.reportsTo }),
      ...(runtimeConfig && { runtimeConfig }),
      ...(normalizeStoredPermissions(input.permissions) && { permissions: normalizeStoredPermissions(input.permissions) }),
      ...(normalizedPermissionPolicy && { permissionPolicy: normalizedPermissionPolicy }),
      ...(input.instructionsPath && { instructionsPath: input.instructionsPath }),
      ...(input.instructionsText && { instructionsText: input.instructionsText }),
      ...(input.soul && { soul: input.soul }),
      ...(input.memory && { memory: input.memory }),
      ...(input.bundleConfig && { bundleConfig: input.bundleConfig }),
      ...(resolvedHeartbeatProcedurePath && { heartbeatProcedurePath: resolvedHeartbeatProcedurePath }),
    };

    await this.writeAgent(agent, executor);
    this.emit("agent:created", agent);

    return agent;
  }

  /**
   * Get an agent by ID.
   * @param agentId - The agent ID
   * @returns The agent, or null if not found
   */
  async getAgent(agentId: string): Promise<Agent | null> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:05:
    Agent reads are PostgreSQL-only via readAgentAsync. Populate getCachedAgent memory so sync heartbeat resolveAgentConfig can honor per-agent runtimeConfig without a SQLite handle.
    */
    const agent = await readAgentAsync(this.asyncLayer!.db, agentId, this.workflowProjectId);
    const parsed = agent ? this.parseAgent(agent) : null;
    if (parsed) this.agentMemoryCache.set(agentId, parsed);
    else this.agentMemoryCache.delete(agentId);
    return parsed;
  }

  /**
   * Get computed access capabilities for an agent.
   * @param agentId - The agent ID
   * @returns Computed access state, or null if agent not found
   */
  async getAccessState(agentId: string): Promise<AgentAccessState | null> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      return null;
    }

    return computeAccessState(agent);
  }

  /**
   * Get computed budget usage status for an agent.
   * @param agentId - The agent ID
   * @returns Computed budget usage status
   * @throws Error if agent not found
   */
  async getBudgetStatus(agentId: string): Promise<AgentBudgetStatus> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const totalInputTokens = agent.totalInputTokens ?? 0;
    const totalOutputTokens = agent.totalOutputTokens ?? 0;
    const currentUsage = totalInputTokens + totalOutputTokens;

    const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const budgetConfig = runtimeConfig.budgetConfig as AgentBudgetConfig | undefined;
    const rawLastResetAt = runtimeConfig.budgetResetAt;
    const lastResetAt = typeof rawLastResetAt === "string" ? rawLastResetAt : null;

    if (!budgetConfig || budgetConfig.tokenBudget === undefined) {
      return {
        agentId,
        currentUsage,
        budgetLimit: null,
        usagePercent: null,
        thresholdPercent: null,
        isOverBudget: false,
        isOverThreshold: false,
        lastResetAt,
        nextResetAt: null,
      };
    }

    const tokenBudget = budgetConfig.tokenBudget;
    const usagePercent = Math.min((currentUsage / tokenBudget) * 100, 100);
    const usageThreshold = budgetConfig.usageThreshold ?? 0.8;
    const thresholdPercent = usageThreshold * 100;

    return {
      agentId,
      currentUsage,
      budgetLimit: tokenBudget,
      usagePercent,
      thresholdPercent,
      isOverBudget: currentUsage >= tokenBudget,
      isOverThreshold: usagePercent >= thresholdPercent,
      lastResetAt,
      nextResetAt: this.computeNextResetAt(budgetConfig.budgetPeriod, budgetConfig.resetDay),
    };
  }

  /**
   * Get detailed agent info including heartbeat history.
   * @param agentId - The agent ID
   * @param heartbeatLimit - Max number of heartbeat events to return (default: 50)
   * @returns Agent detail, or null if not found
   */
  async getAgentDetail(agentId: string, heartbeatLimit = 50): Promise<AgentDetail | null> {
    const agent = await this.getAgent(agentId);
    if (!agent) return null;

    const [history, activeRun, completedRuns] = await Promise.all([
      this.getHeartbeatHistory(agentId, heartbeatLimit),
      this.getActiveHeartbeatRun(agentId),
      this.getCompletedHeartbeatRuns(agentId),
    ]);

    return {
      ...agent,
      heartbeatHistory: history,
      activeRun: activeRun ?? undefined,
      completedRuns,
    };
  }

  private mapRatingRow(row: AgentRatingRow): AgentRating {
    return {
      id: row.id,
      agentId: row.agentId,
      raterType: row.raterType as AgentRating["raterType"],
      raterId: row.raterId ?? undefined,
      score: row.score,
      category: row.category ?? undefined,
      comment: row.comment ?? undefined,
      runId: row.runId ?? undefined,
      taskId: row.taskId ?? undefined,
      createdAt: row.createdAt,
    };
  }

  async addRating(agentId: string, input: AgentRatingInput): Promise<AgentRating> {
    if (input.score < 1 || input.score > 5) {
      throw new Error("Rating score must be between 1 and 5");
    }

    const rating: AgentRating = {
      id: `rating-${randomUUID().slice(0, 8)}`,
      agentId,
      raterType: input.raterType,
      raterId: input.raterId,
      score: input.score,
      category: input.category,
      comment: input.comment,
      runId: input.runId,
      taskId: input.taskId,
      createdAt: new Date().toISOString(),
    };

    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:15:
     * Backend-mode: delegate to async Drizzle addRating helper. The score CHECK
     * constraint is enforced by PostgreSQL (VAL-SCHEMA-005).
     *
     * FNXC:AgentRatingsProjectIsolation 2026-08-12-01:00:
     * Ratings use the soft workflow project accessor: unbound compatibility stores
     * must retain trigger-stamped writes rather than throw like heartbeat operations.
     */
    const saved = await addRatingAsync(this.asyncLayer!.db, rating, this.workflowProjectId);
    this.emit("rating:added", saved);
    return saved;
}

  async getRatings(agentId: string, options?: { limit?: number; category?: string }): Promise<AgentRating[]> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:15:
     * Backend-mode: delegate to async Drizzle getRatings helper.
     *
     * FNXC:AgentRatingsProjectIsolation 2026-08-12-01:00:
     * workflowProjectId is intentionally soft so an unbound store keeps its historic
     * unscoped compatibility read instead of invoking backendProjectId's hard guard.
     */
    return getRatingsAsync(this.asyncLayer!.db, agentId, options, this.workflowProjectId);
}

  async getRatingSummary(agentId: string): Promise<AgentRatingSummary> {
    const ratings = await this.getRatings(agentId);

    if (ratings.length === 0) {
      return {
        agentId,
        averageScore: 0,
        totalRatings: 0,
        categoryAverages: {},
        recentRatings: [],
        trend: "insufficient-data",
      };
    }

    const averageScore = Math.round((ratings.reduce((sum, rating) => sum + rating.score, 0) / ratings.length) * 100) / 100;

    const categoryBuckets = new Map<string, { total: number; count: number }>();
    for (const rating of ratings) {
      if (rating.category === undefined) {
        continue;
      }
      const existing = categoryBuckets.get(rating.category) ?? { total: 0, count: 0 };
      existing.total += rating.score;
      existing.count += 1;
      categoryBuckets.set(rating.category, existing);
    }

    const categoryAverages: Record<string, number> = {};
    for (const [category, bucket] of categoryBuckets) {
      categoryAverages[category] = Math.round((bucket.total / bucket.count) * 100) / 100;
    }

    const recentRatings = ratings.slice(0, 10);

    let trend: AgentRatingSummary["trend"] = "insufficient-data";
    if (ratings.length >= 10) {
      const recentWindow = ratings.slice(0, 5);
      const previousWindow = ratings.slice(5, 10);
      const recentAvg = recentWindow.reduce((sum, rating) => sum + rating.score, 0) / recentWindow.length;
      const previousAvg = previousWindow.reduce((sum, rating) => sum + rating.score, 0) / previousWindow.length;

      if (Math.abs(recentAvg - previousAvg) <= 0.01) {
        trend = "stable";
      } else if (recentAvg > previousAvg) {
        trend = "improving";
      } else {
        trend = "declining";
      }
    }

    return {
      agentId,
      averageScore,
      totalRatings: ratings.length,
      categoryAverages,
      recentRatings,
      trend,
    };
  }

  async deleteRating(ratingId: string): Promise<void> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:15:
     * Backend-mode: delegate to async Drizzle deleteRating helper.
     *
     * FNXC:AgentRatingsProjectIsolation 2026-08-12-01:00:
     * Use the soft workflow project binding to scope bound deletes without breaking
     * the documented unbound compatibility path.
     */
    await deleteRatingAsync(this.asyncLayer!.db, ratingId, this.workflowProjectId);
    return;
}

  /**
   * Get the managed instructions directory path for an agent.
   * Does not create the directory.
   */
  getInstructionsDir(agentId: string): string {
    const agent = this.readAgent(agentId);
    const agentName = agent?.name ?? "";
    return join(this.agentsDir, getCanonicalAgentInstructionsBundleDirName(agentName, agentId));
  }

  /**
   * List markdown files in an agent's managed instructions bundle.
   * Returns [] when the bundle directory does not exist.
   */
  async listBundleFiles(agentId: string): Promise<string[]> {
    const bundleDir = await this.resolveCompatibleBundleDir(agentId, false);

    try {
      const entries = await readdir(bundleDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  /**
   * Read a markdown file from an agent's managed instructions bundle.
   */
  async readBundleFile(agentId: string, filePath: string): Promise<string> {
    this.validateBundleFilePath(filePath);
    const bundleDir = await this.resolveCompatibleBundleDir(agentId, false);
    const resolvedPath = join(bundleDir, filePath);
    return readFile(resolvedPath, "utf-8");
  }

  /**
   * Write a markdown file to an agent's managed instructions bundle.
   */
  async writeBundleFile(agentId: string, filePath: string, content: string): Promise<void> {
    return this.withLock(agentId, async () => {
      this.validateBundleFilePath(filePath);

      const bundleDir = await this.resolveCompatibleBundleDir(agentId, true);
      await mkdir(bundleDir, { recursive: true });

      const existingFiles = await this.listBundleFiles(agentId);
      const isOverwrite = existingFiles.includes(filePath);
      if (!isOverwrite && existingFiles.length >= 10) {
        throw new Error("Instruction bundles are limited to 10 markdown files");
      }

      const resolvedPath = join(bundleDir, filePath);
      const tempPath = `${resolvedPath}.tmp.${Date.now()}`;
      await writeFile(tempPath, content, "utf-8");
      await rename(tempPath, resolvedPath);
    });
  }

  /**
   * Delete a markdown file from an agent's managed instructions bundle.
   */
  async deleteBundleFile(agentId: string, filePath: string): Promise<void> {
    return this.withLock(agentId, async () => {
      this.validateBundleFilePath(filePath);
      const bundleDir = await this.resolveCompatibleBundleDir(agentId, false);
      await unlink(join(bundleDir, filePath));
    });
  }

  /**
   * Set an agent's instructions bundle configuration.
   */
  async setBundleConfig(agentId: string, config: InstructionsBundleConfig): Promise<Agent> {
    const entryFile = config.entryFile?.trim();
    if (!entryFile) {
      throw new Error("Bundle config entryFile is required");
    }

    if (config.mode === "external" && !config.externalPath?.trim()) {
      throw new Error("Bundle config externalPath is required when mode is 'external'");
    }

    const normalizedConfig: InstructionsBundleConfig = {
      ...config,
      entryFile,
      files: [...(config.files ?? [])],
      ...(config.externalPath !== undefined ? { externalPath: config.externalPath } : {}),
    };

    const updated = await this.updateAgent(agentId, { bundleConfig: normalizedConfig });

    if (normalizedConfig.mode === "managed") {
      await mkdir(await this.resolveCompatibleBundleDir(agentId, true), { recursive: true });
    }

    return updated;
  }

  /**
   * Migrate legacy instructionsText/instructionsPath fields into bundleConfig.
   */
  async migrateLegacyInstructions(agentId: string): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (agent.bundleConfig) {
      return agent;
    }

    const entryFile = "AGENTS.md";
    const hasInstructionsText = typeof agent.instructionsText === "string" && agent.instructionsText.length > 0;
    const hasInstructionsPath = typeof agent.instructionsPath === "string" && agent.instructionsPath.length > 0;

    if (!hasInstructionsText && !hasInstructionsPath) {
      return this.updateAgent(agentId, {
        bundleConfig: { mode: "managed", entryFile, files: [] },
      });
    }

    await mkdir(await this.resolveCompatibleBundleDir(agentId, true), { recursive: true });

    const files: string[] = [];

    if (hasInstructionsText) {
      await this.writeBundleFile(agentId, entryFile, agent.instructionsText ?? "");
      files.push(entryFile);
    }

    if (hasInstructionsPath) {
      const sourcePath = join(this.rootDir, agent.instructionsPath ?? "");
      const sourceContent = await readFile(sourcePath, "utf-8");

      if (hasInstructionsText) {
        const secondaryFile = basename(agent.instructionsPath ?? "");
        await this.writeBundleFile(agentId, secondaryFile, sourceContent);
        if (!files.includes(secondaryFile)) {
          files.push(secondaryFile);
        }
      } else {
        await this.writeBundleFile(agentId, entryFile, sourceContent);
        files.push(entryFile);
      }
    }

    return this.updateAgent(agentId, {
      instructionsPath: undefined,
      instructionsText: undefined,
      bundleConfig: {
        mode: "managed",
        entryFile,
        files,
      },
    });
  }

  /**
   * Update an agent with partial updates.
   * @param agentId - The agent ID
   * @param updates - Fields to update
   * @returns The updated agent
   * @throws Error if agent not found
   */
  async updateAgent(agentId: string, updates: AgentUpdateInput): Promise<Agent> {
    return this.withLock(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const nextName = "name" in updates && typeof updates.name === "string" ? updates.name.trim() : undefined;
      if (nextName !== undefined && !nextName) {
        throw new Error("Agent name cannot be empty");
      }

      const beforeSnapshot = agentToConfigSnapshot(agent);
      const updatedAt = new Date().toISOString();

      const normalizedUpdatedPermissionPolicy =
        "permissionPolicy" in updates && updates.permissionPolicy !== undefined
          ? normalizeAgentPermissionPolicy(updates.permissionPolicy)
          : updates.permissionPolicy;

      const roles = updates.roles !== undefined || updates.role !== undefined
        ? normalizeAgentRoles(updates.roles, updates.role)
        : agent.roles;
      const updated: Agent = {
        ...agent,
        name: nextName ?? agent.name,
        roles,
        role: roles[0],
        metadata: updates.metadata !== undefined ? updates.metadata : agent.metadata,
        updatedAt,
        ...("title" in updates && { title: updates.title }),
        ...("icon" in updates && { icon: updates.icon }),
        ...("imageUrl" in updates && { imageUrl: updates.imageUrl }),
        ...("reportsTo" in updates && { reportsTo: updates.reportsTo }),
        ...("runtimeConfig" in updates && { runtimeConfig: updates.runtimeConfig }),
        ...("pauseReason" in updates && { pauseReason: updates.pauseReason }),
        ...("permissions" in updates && { permissions: normalizeStoredPermissions(updates.permissions) }),
        ...("permissionPolicy" in updates && { permissionPolicy: normalizedUpdatedPermissionPolicy }),
        ...("lastError" in updates && { lastError: updates.lastError }),
        ...("totalInputTokens" in updates && { totalInputTokens: updates.totalInputTokens }),
        ...("totalOutputTokens" in updates && { totalOutputTokens: updates.totalOutputTokens }),
        ...("instructionsPath" in updates && { instructionsPath: updates.instructionsPath }),
        ...("instructionsText" in updates && { instructionsText: updates.instructionsText }),
        ...(updates.soul !== undefined && { soul: updates.soul }),
        ...(updates.memory !== undefined && { memory: updates.memory }),
        ...("bundleConfig" in updates && { bundleConfig: updates.bundleConfig }),
        ...("heartbeatProcedurePath" in updates && { heartbeatProcedurePath: updates.heartbeatProcedurePath }),
      };

      await this.writeAgent(updated);

      const afterSnapshot = agentToConfigSnapshot(updated);
      const diffs = diffConfigSnapshots(beforeSnapshot, afterSnapshot);

      if (diffs.length > 0) {
        const revision = this.createConfigRevision({
          agentId,
          before: beforeSnapshot,
          after: afterSnapshot,
          diffs,
          source: "user",
          createdAt: updatedAt,
        });
        await this.appendConfigRevision(revision);
        this.emit("agent:configRevision", agentId, revision);
      }

      this.emit("agent:updated", updated);

      return updated;
    });
  }

  /**
   * Get config revision history for an agent (most recent first).
   */
  async getConfigRevisions(agentId: string, limit?: number): Promise<AgentConfigRevision[]> {
    const revisions = await this.readConfigRevisions(agentId);
    const ordered = revisions.reverse();

    if (limit === undefined) {
      return ordered;
    }

    const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    return ordered.slice(0, normalizedLimit);
  }

  /**
   * Get a specific config revision for an agent.
   */
  async getConfigRevision(agentId: string, revisionId: string): Promise<AgentConfigRevision | null> {
    const revisions = await this.readConfigRevisions(agentId);
    return revisions.find((revision) => revision.id === revisionId) ?? null;
  }

  /**
   * Roll back agent to a previous configuration revision.
   */
  async rollbackConfig(agentId: string, revisionId: string): Promise<{ agent: Agent; revision: AgentConfigRevision }> {
    return this.withLock(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const targetRevision = await this.getConfigRevision(agentId, revisionId);
      if (!targetRevision) {
        const revisionOwner = await this.findConfigRevisionAcrossAgents(revisionId);
        if (revisionOwner && revisionOwner.agentId !== agentId) {
          throw new Error(`Config revision ${revisionId} belongs to agent ${revisionOwner.agentId}`);
        }

        throw new Error(`Config revision ${revisionId} not found for agent ${agentId}`);
      }

      if (targetRevision.agentId !== agentId) {
        throw new Error(`Config revision ${revisionId} belongs to agent ${targetRevision.agentId}`);
      }

      const beforeSnapshot = agentToConfigSnapshot(agent);
      const updatedAt = new Date().toISOString();
      const restoredAgent: Agent = {
        ...agent,
        ...this.snapshotToAgentConfig(targetRevision.before),
        updatedAt,
      };

      await this.writeAgent(restoredAgent);

      const rollbackRevision = this.createConfigRevision({
        agentId,
        before: beforeSnapshot,
        after: agentToConfigSnapshot(restoredAgent),
        source: "rollback",
        rollbackToRevisionId: revisionId,
        createdAt: updatedAt,
      });

      await this.appendConfigRevision(rollbackRevision);
      this.emit("agent:updated", restoredAgent);
      this.emit("agent:configRevision", agentId, rollbackRevision);

      return {
        agent: restoredAgent,
        revision: rollbackRevision,
      };
    });
  }

  /**
   * Update an agent's state with validation.
   * @param agentId - The agent ID
   * @param newState - The target state
   * @returns The updated agent
   * @throws Error if transition is invalid or agent not found
   */
  async updateAgentState(agentId: string, newState: AgentState): Promise<Agent> {
    return this.withLock(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const currentState = agent.state;

      // Validate transition
      if (currentState === newState) {
        return agent; // No change needed
      }

      const validTransitions = AGENT_VALID_TRANSITIONS[currentState];
      if (!validTransitions.includes(newState)) {
        throw new Error(
          `Invalid state transition: ${currentState} -> ${newState}. Valid transitions: ${validTransitions.join(", ")}`
        );
      }

      /*
       * FNXC:AgentStore 2026-07-24-12:00:
       * FN-8569 observed CEO Reports Health rows with a live state and stale
       * `error-unrecoverable` marker. Resuming from paused/error performs
       * best-effort pauseReason cleanup only; it is not an atomicity guarantee
       * because independent updateAgent marker writes can recreate desync. The
       * engine-side reports-health classifier remains the authoritative defense.
       * Preserve lastError as diagnostic history for operator triage.
       */
      const clearsPauseReasonOnResume = (currentState === "paused" || currentState === "error")
        && (newState === "active" || newState === "idle" || newState === "running");
      const updated: Agent = {
        ...agent,
        state: newState,
        ...(clearsPauseReasonOnResume && { pauseReason: undefined }),
        updatedAt: new Date().toISOString(),
      };

      await this.writeAgent(updated);
      this.emit("agent:stateChanged", agentId, currentState, newState);
      /*
      FNXC:AgentActivityStream 2026-08-14-19:18:
      FN-9041 removes roster state churn from the durable work-activity feed. State remains
      observable through the roster and this live agent:stateChanged event without consuming
      outbox retention reserved for task and workflow activity.
      */
      this.emit("agent:updated", updated, currentState);

      return updated;
    });
  }

  /**
   * Assign a task to an agent.
   * @param agentId - The agent ID
   * @param taskId - The task ID to assign, or undefined to unassign
   * @returns The updated agent
   */
  async assignTask(agentId: string, taskId: string | undefined, runContext?: RunMutationContext): Promise<Agent> {
    /*
    FNXC:AgentRouting 2026-07-12-11:55:
    FN-7851 / issue #2015: assignTask was an UNGUARDED binding primitive. Guard new assignments with the shared
    bind evaluator (assignTask is an explicit route: a caller chose this agent). Clearing (taskId undefined) is
    always allowed, and hosts without a TaskStore or with an unresolvable task stay fail-open because this
    primitive is also used for display-only linkage in stores that cannot resolve tasks.
    */
    if (taskId !== undefined) {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }
      let task: Task | null = null;
      if (this.taskStore) {
        try {
          task = await this.taskStore.getTask(taskId);
        } catch {
          task = null;
        }
      }
      if (task) {
        assertImplementationTaskBindAllowed(agent, task, {
          explicitRouting: true,
          executorRoleOverride: task.sourceMetadata?.executorRoleOverride === true,
        });
      }
    }

    const updated = await this.syncExecutionTaskLink(agentId, taskId);

    // Emit agent:assigned only when assigning a task (not when clearing)
    if (taskId !== undefined) {
      this.emit("agent:assigned", updated, taskId);
      // FNXC:AgentActivityStream 2026-08-09-09:09: assignment does not observe an acting manager, so no fromAgentId is inferred.
      if (this.asyncLayer) try { await appendAgentActivityEvent(this.asyncLayer, { type: "task:handed-off", attributionClaim: resolveAgentActivityAttribution([{ id: agentId, provenance: "roster" }], "executor"), toAgentIdClaim: resolveAgentActivityAttribution([{ id: agentId, provenance: "roster" }], "executor"), taskId, occurredAt: updated.updatedAt, discriminator: `${taskId}:${updated.updatedAt}`, metadata: { reason: "unlisted", source: "executor", delegationDirection: "unknown" } }); } catch { /* monitoring must not block assignment */ }
    }

    // Log the assignment to the task when a non-empty taskId is provided
    if (taskId && this.taskStore) {
      await this.taskStore.logEntry(taskId, `Task assigned to agent ${agentId}`, undefined, runContext);
    }

    return updated;
  }

  /**
   * Synchronize execution task ownership on an agent without firing
   * assignment-side effects (`agent:assigned`, task assignment logs).
   *
   * Used by runtime execution bookkeeping so durable assigned agents can
   * reflect active task ownership without triggering heartbeat assignment wakeups.
   */
  async resolveCurrentTaskLink(taskId: string): Promise<Pick<Task, "id" | "column"> | null> {
    /*
    FNXC:AgentTaskStateDrift 2026-06-27-16:05:
    AgentStore owns agent.taskId but may not have a TaskStore in every host. Expose a null-safe lookup for display-only column context without making task lookup a hard dependency.
    */
    if (!this.taskStore) {
      return null;
    }
    try {
      const task = await this.taskStore.getTask(taskId);
      return task ? { id: task.id, column: task.column } : null;
    } catch {
      return null;
    }
  }

  async syncExecutionTaskLink(agentId: string, taskId: string | undefined): Promise<Agent> {
    return this.withLock(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const updated: Agent = {
        ...agent,
        taskId,
        updatedAt: new Date().toISOString(),
      };

      await this.writeAgent(updated);
      this.emit("agent:updated", updated);
      return updated;
    });
  }

  /**
   * Claim task ownership for the calling agent with safety guards.
   *
   * Guards:
   * - task must exist and not be paused
   * - task must not be in its workflow's Complete column
   * - task must not already be assigned to another agent
   * - task checkout must be unheld or already held by this agent
   *
   * On success, updates both durable task assignment (assignedAgentId) and the
   * agent's active execution linkage (agent.taskId). Task linkage is only updated
   * after ownership + checkout checks pass.
   */
  async claimTaskForAgent(agentId: string, taskId: string, runContext?: RunMutationContext): Promise<{ ok: true; task: Task } | { ok: false; reason: string; task?: Task }> {
    if (!this.taskStore) {
      throw new Error("TaskStore not configured for task-claim operations");
    }

    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    let task: Task | null = null;
    try {
      task = await this.taskStore.getTask(taskId);
    } catch {
      task = null;
    }
    if (!task) {
      return { ok: false, reason: "task_not_found" };
    }

    if (task.paused) {
      return { ok: false, reason: "paused", task };
    }

    /*
    FNXC:AgentRouting 2026-07-12-11:50:
    FN-7851 / issue #2015: route the claim through the shared bind evaluator so role AND per-agent
    assignmentPolicy are enforced identically to every other binding surface. executorRoleOverride is honored
    only for explicit routing (task already assigned to this agent) — an override-marked task must not become
    auto-claimable by role-incompatible agents; policy "none" is never overridable.
    */
    const isExplicitlyAssignedToAgent = task.assignedAgentId === agentId;
    const bindVerdict = evaluateImplementationTaskBind(agent, task, {
      explicitRouting: isExplicitlyAssignedToAgent,
      executorRoleOverride: isExplicitlyAssignedToAgent && task.sourceMetadata?.executorRoleOverride === true,
    });
    if (!bindVerdict.allowed) {
      return { ok: false, reason: bindVerdict.reason, task };
    }

    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-08:10 (fleet phase):
    The terminal guard on a claim. On a renamed board neither literal matched, so an agent could CLAIM a
    finished card — the claim succeeded and the agent began work on completed output. `this.taskStore` is
    already in hand two lines up, so this costs one resolution on a path that already does a task read.
    */
    const claimLifecycle = await resolveTaskLifecycleColumns(this.taskStore, taskId);
    if (task.column === (claimLifecycle?.complete ?? "done")) {
      return { ok: false, reason: "terminal", task };
    }

    if (task.assignedAgentId && task.assignedAgentId !== agentId) {
      return { ok: false, reason: "assigned_to_other", task };
    }

    if (task.checkedOutBy && task.checkedOutBy !== agentId) {
      return { ok: false, reason: "checkout_conflict", task };
    }

    try {
      await this.checkoutTask(agentId, taskId, undefined, runContext);
    } catch (error) {
      if (error instanceof CheckoutConflictError) {
        return { ok: false, reason: "checkout_conflict", task };
      }
      throw error;
    }

    const claimedTask = await this.taskStore.updateTask(taskId, { assignedAgentId: agentId }, runContext);
    await this.syncExecutionTaskLink(agentId, taskId);

    return { ok: true, task: claimedTask };
  }

  /**
   * Acquire a checkout lease for a task.
   * Throws CheckoutConflictError when another agent already holds the lease.
   */
  async checkoutTask(
    agentId: string,
    taskId: string,
    leaseContext?: CheckoutClaimContext,
    runContext?: RunMutationContext,
  ): Promise<Task> {
    if (!this.taskStore) {
      throw new Error("TaskStore not configured for checkout operations");
    }

    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const task = await this.taskStore.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.checkedOutBy && task.checkedOutBy !== agentId) {
      throw new CheckoutConflictError(taskId, task.checkedOutBy, agentId);
    }

    /*
    FNXC:AgentRouting 2026-07-12-11:55:
    FN-7851 / issue #2015: checkout was an UNGUARDED binding primitive — a role-incompatible or policy-excluded
    agent (e.g. a liaison) could acquire the lease directly (dashboard POST /tasks/:id/checkout, direct callers)
    even though claimTaskForAgent would have refused. Guard fresh checkouts with the shared bind evaluator.
    Lease renewals (agent already holds the lease, e.g. executor renewTaskLease) stay exempt so recovery of an
    existing hold never strands; policy "none" still cannot acquire a NEW hold by any path.
    */
    if (task.checkedOutBy !== agentId) {
      assertImplementationTaskBindAllowed(agent, task, {
        explicitRouting: task.assignedAgentId === agentId,
        executorRoleOverride: task.assignedAgentId === agentId && task.sourceMetadata?.executorRoleOverride === true,
      });
    }

    const nextRenewedAt = leaseContext?.renewedAt ?? new Date().toISOString();
    const existingNodeId = task.checkoutNodeId ?? null;
    const existingEpoch = task.checkoutLeaseEpoch ?? 0;
    const tryClaimCheckout = "tryClaimCheckout" in this.taskStore
      ? (this.taskStore as TaskStore & {
        tryClaimCheckout: NonNullable<TaskStore["tryClaimCheckout"]>;
      }).tryClaimCheckout
      : undefined;

    if (tryClaimCheckout) {
      const requestNodeId = this.claimStore
        ? (leaseContext?.nodeId ?? this.defaultNodeId)
        : (leaseContext?.nodeId ?? existingNodeId ?? "");
      if (this.claimStore && !requestNodeId) {
        throw new Error("checkoutTask requires leaseContext.nodeId or AgentStore nodeId when claimStore is configured");
      }

      if (this.claimStore && this.claimProjectId) {
        const isSameAgentHolder = task.checkedOutBy === agentId;
        const isSameNodeHolder = existingNodeId !== null && requestNodeId === existingNodeId;
        const expectedEpoch = isSameAgentHolder && isSameNodeHolder ? existingEpoch : undefined;

        const centralResult = await Promise.resolve(this.claimStore.tryClaimTask({
          projectId: this.claimProjectId,
          taskId,
          nodeId: requestNodeId!,
          agentId,
          runId: leaseContext?.runId ?? task.checkoutRunId ?? null,
          renewedAt: nextRenewedAt,
          expectedEpoch,
        }));

        if (!centralResult.ok) {
          throw new CheckoutConflictError(taskId, centralResult.current.ownerAgentId, agentId);
        }

        const claim = centralResult.claim;
        const mirrorLease = {
          agentId,
          nodeId: claim.ownerNodeId,
          runId: claim.ownerRunId,
          renewedAt: claim.leaseRenewedAt,
          leaseEpoch: claim.leaseEpoch,
        };
        const mirrorPrecondition = {
          expectedCheckedOutBy: task.checkedOutBy ?? null,
          expectedNodeId: existingNodeId,
          expectedLeaseEpoch: existingEpoch,
        };

        let result = await tryClaimCheckout.call(this.taskStore, taskId, mirrorLease, mirrorPrecondition);
        if (!result.ok) {
          const mirrorTask = await this.taskStore.getTask(taskId);
          if (mirrorTask) {
            result = await tryClaimCheckout.call(this.taskStore, taskId, mirrorLease, {
              expectedCheckedOutBy: mirrorTask.checkedOutBy ?? null,
              expectedNodeId: mirrorTask.checkoutNodeId ?? null,
              expectedLeaseEpoch: mirrorTask.checkoutLeaseEpoch ?? 0,
            });
          }
          if (!result.ok) {
            await this.taskStore.logEntry(
              taskId,
              "Warning: central checkout claim succeeded but per-project mirror update failed",
              undefined,
              runContext,
            );
            const latestTask = await this.taskStore.getTask(taskId);
            if (!latestTask) {
              throw new Error(`Task ${taskId} not found`);
            }
            return latestTask;
          }
        }

        await this.taskStore.logEntry(taskId, `Checked out by agent ${agentId}`, undefined, runContext);
        return result.task;
      }

      const isSameAgentHolder = task.checkedOutBy === agentId;
      const isRenewal = isSameAgentHolder
        && existingNodeId !== null
        && leaseContext?.nodeId === existingNodeId
        && leaseContext?.leaseEpoch === existingEpoch;

      if (isSameAgentHolder && !isRenewal) {
        throw new CheckoutConflictError(taskId, agentId, agentId);
      }

      const result = await tryClaimCheckout.call(this.taskStore, taskId, {
        agentId,
        nodeId: leaseContext?.nodeId ?? existingNodeId ?? "",
        runId: leaseContext?.runId ?? task.checkoutRunId ?? null,
        renewedAt: nextRenewedAt,
        leaseEpoch: isRenewal ? existingEpoch : existingEpoch + 1,
      }, {
        expectedCheckedOutBy: task.checkedOutBy ?? null,
        expectedNodeId: existingNodeId,
        expectedLeaseEpoch: existingEpoch,
      });

      if (!result.ok) {
        if (result.reason === "row_not_found") {
          throw new Error(`Task ${taskId} not found`);
        }
        const currentHolder = result.current?.checkedOutBy;
        throw new CheckoutConflictError(taskId, currentHolder ?? "unknown", agentId);
      }

      await this.taskStore.logEntry(taskId, `Checked out by agent ${agentId}`, undefined, runContext);
      return result.task;
    }

    const nextEpoch = leaseContext?.leaseEpoch ?? task.checkoutLeaseEpoch ?? 0;
    if (
      task.checkedOutBy === agentId
      && existingNodeId === (leaseContext?.nodeId ?? existingNodeId)
      && existingEpoch === nextEpoch
    ) {
      return this.taskStore.updateTask(taskId, {
        checkoutRunId: leaseContext?.runId ?? task.checkoutRunId ?? null,
        checkoutLeaseRenewedAt: nextRenewedAt,
      });
    }

    const updated = await this.taskStore.updateTask(taskId, {
      checkedOutBy: agentId,
      checkedOutAt: task.checkedOutBy === agentId ? task.checkedOutAt : undefined,
      checkoutNodeId: leaseContext?.nodeId ?? null,
      checkoutRunId: leaseContext?.runId ?? null,
      checkoutLeaseRenewedAt: nextRenewedAt,
      checkoutLeaseEpoch: nextEpoch,
    });
    await this.taskStore.logEntry(taskId, `Checked out by agent ${agentId}`, undefined, runContext);
    return updated;
  }

  /**
   * Release a checkout lease for a task.
   */
  async releaseTask(agentId: string, taskId: string, runContext?: RunMutationContext): Promise<Task> {
    if (!this.taskStore) {
      throw new Error("TaskStore not configured for checkout operations");
    }

    const task = await this.taskStore.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.checkedOutBy && task.checkedOutBy !== agentId) {
      throw new Error("Cannot release: not the checkout holder");
    }

    if (!task.checkedOutBy) {
      return task;
    }

    if (this.claimStore && this.claimProjectId && task.checkoutNodeId) {
      await this.claimStore.releaseTaskClaim({
        projectId: this.claimProjectId,
        taskId,
        nodeId: task.checkoutNodeId,
        agentId,
      });
    }

    const updated = await this.taskStore.updateTask(taskId, {
      checkedOutBy: null,
      checkedOutAt: null,
      checkoutNodeId: null,
      checkoutRunId: null,
      checkoutLeaseRenewedAt: null,
    });
    await this.taskStore.logEntry(taskId, `Released by agent ${agentId}`, undefined, runContext);
    return updated;
  }

  /**
   * Force release a task checkout lease regardless of holder.
   */
  async forceReleaseTask(taskId: string, runContext?: RunMutationContext): Promise<Task> {
    if (!this.taskStore) {
      throw new Error("TaskStore not configured for checkout operations");
    }

    const updated = await this.taskStore.updateTask(taskId, {
      checkedOutBy: null,
      checkedOutAt: null,
      checkoutNodeId: null,
      checkoutRunId: null,
      checkoutLeaseRenewedAt: null,
      checkoutLeaseEpoch: null,
    });
    await this.taskStore.logEntry(taskId, "Checkout force-released", undefined, runContext);
    return updated;
  }

  /**
   * Get the current checkout lease holder for a task.
   */
  async getCheckedOutBy(taskId: string): Promise<string | undefined> {
    if (!this.taskStore) {
      throw new Error("TaskStore not configured for checkout operations");
    }

    const task = await this.taskStore.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    return task.checkedOutBy;
  }

  /**
   * Reset budget token usage counters for an agent.
   * @param agentId - The agent ID
   * @throws Error if agent not found
   */
  async resetBudgetUsage(agentId: string): Promise<void> {
    await this.withLock(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const budgetResetAt = new Date().toISOString();
      const updated: Agent = {
        ...agent,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        runtimeConfig: {
          ...(agent.runtimeConfig ?? {}),
          budgetResetAt,
        },
        updatedAt: budgetResetAt,
      };

      await this.writeAgent(updated);
      this.emit("agent:updated", updated);
    });
  }

  /**
   * Reset an agent from any state back to "idle".
   * Clears transient execution state (taskId, lastError, pauseReason)
   * and ends any active heartbeat run.
   * @param agentId - The agent ID
   * @returns The reset agent
   * @throws Error if agent not found or transition is invalid
   */
  async resetAgent(agentId: string): Promise<Agent> {
    let agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // End any active heartbeat run before transitioning
    const activeRun = await this.getActiveHeartbeatRun(agentId);
    if (activeRun) {
      await this.endHeartbeatRun(activeRun.id, "terminated");
    }

    // Any non-idle state can transition directly to idle in the new
    // lifecycle (see AGENT_VALID_TRANSITIONS in types.ts), so no
    // intermediate hop is required.
    if (agent.state !== "idle") {
      agent = await this.updateAgentState(agentId, "idle");
    }

    if (agent.taskId !== undefined) {
      agent = await this.assignTask(agentId, undefined);
    }

    if (agent.lastError !== undefined || agent.pauseReason !== undefined) {
      agent = await this.updateAgent(agentId, {
        lastError: undefined,
        pauseReason: undefined,
      });
    }

    return agent;
  }

  /**
   * List all agents, optionally filtered by state.
   * @param filter - Optional filter criteria
   * @returns Array of agents
   */
  async listAgents(
    filter?: { state?: AgentState; role?: AgentCapability; includeEphemeral?: boolean },
    executor?: QueryHandle,
  ): Promise<Agent[]> {
    // FNXC:WorkflowAgentRouting 2026-08-07-03:12:
    // Role-pool membership is canonical multi-tag state, so SQL must not use the
    // deprecated singular projection to exclude a matching durable principal.
    const agents = await listAgentRowsAsync(
      executor ?? this.asyncLayer!.db,
      { state: filter?.state },
      this.workflowProjectId,
    );
    return agents
      .map((a) => this.parseAgent(a as unknown as AgentData))
      .filter((agent) => !filter?.role || agent.roles.includes(filter.role))
      .filter((agent) => filter?.includeEphemeral === true || !isEphemeralAgent(agent));
  }

  /**
   * Idempotently seed the permanent owners that route built-in workflow stages.
   * Matching operator-created agents are intentionally not reused: provenance
   * makes upgrade repair deterministic while operators remain free to add pool
   * members with the same tag.
   */
  async provisionBuiltinWorkflowRoleAgents(): Promise<Agent[]> {
    const provision = async (executor?: QueryHandle): Promise<Agent[]> => {
      const existing = await this.listAgents({ includeEphemeral: true }, executor);
      const supportedRoles = new Set<BuiltinWorkflowRole>(BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.map(({ role }) => role));
      const groups = new Map<BuiltinWorkflowRole, Agent[]>();
      for (const agent of existing) {
        const role = agent.metadata?.workflowRole;
        if (agent.metadata?.builtInWorkflowRole === true && typeof role === "string" && supportedRoles.has(role as BuiltinWorkflowRole)) {
          const group = groups.get(role as BuiltinWorkflowRole) ?? [];
          group.push(agent);
          groups.set(role as BuiltinWorkflowRole, group);
        }
      }

      /*
      FNXC:WorkflowAgentIdentities 2026-08-08-06:11:
      Corrupt legacy data can contain multiple provenance owners. Select by creation time then id,
      not query order, and demote only the two built-in provenance keys so every losing durable
      agent remains usable with its operator-owned identity and policy intact.
      */
      const winners = new Map<BuiltinWorkflowRole, Agent>();
      for (const [role, group] of groups) {
        group.sort(compareBuiltinWorkflowOwnerAge);
        winners.set(role, group[0]!);
        for (const loser of group.slice(1)) {
          const { builtInWorkflowRole: _builtIn, workflowRole: _role, ...metadata } = loser.metadata;
          await this.writeAgent({ ...loser, metadata, updatedAt: new Date().toISOString() }, executor);
        }
      }

      const result: Agent[] = [];
      for (const definition of BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST) {
        let agent = winners.get(definition.role);
        if (!agent) {
          agent = await this.createAgent({
            name: definition.name,
            roles: [definition.role],
            title: definition.title,
            metadata: { builtInWorkflowRole: true, workflowRole: definition.role },
            /*
            FNXC:WorkflowAgentRouting 2026-08-10-01:15:
            Heartbeat OFF and auto-claim OFF is correct for these four: they are invoked BY the workflow engine
            as stage principals and must not run autonomous loops or claim work on their own. This no longer
            costs routability — `isWorkflowPrincipalEligible` treats built-in owners as routable structurally,
            precisely so the heartbeat setting and the routing question stay separate concerns.
            */
            runtimeConfig: { enabled: false, autoClaimRelevantTasks: false },
            instructionsText: definition.instructionsText,
            soul: definition.soul,
            bundleConfig: { ...BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG, files: [...BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG.files] },
          }, executor);
        } else {
          const canonicalOrPartialBundle = isCanonicalOrPartialBuiltinWorkflowBundle(agent.bundleConfig);
          const customInstructions = Boolean(agent.instructionsPath?.trim())
            || agent.bundleConfig?.mode === "external"
            || (agent.bundleConfig !== undefined && !canonicalOrPartialBundle)
            || (Boolean(agent.instructionsText?.trim()) && agent.instructionsText !== definition.instructionsText);
          const updates: Partial<Agent> = {};
          if (!customInstructions && !agent.instructionsText?.trim()) updates.instructionsText = definition.instructionsText;
          if (!agent.soul?.trim()) updates.soul = definition.soul;
          // FNXC:WorkflowAgentIdentities 2026-08-08-06:38: Do not rewrite complete canonical
          // rows on every startup; partial default-owned inventories converge once, while
          // noncanonical inventories remain operator-owned.
          if (!customInstructions && !isCompleteBuiltinWorkflowBundle(agent.bundleConfig)) {
            updates.bundleConfig = { ...BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG, files: [...BUILTIN_WORKFLOW_AGENT_BUNDLE_CONFIG.files] };
          }
          if (Object.keys(updates).length > 0) {
            agent = { ...agent, ...updates, updatedAt: new Date().toISOString() };
            await this.writeAgent(agent, executor);
          }
        }
        result.push(agent);
      }
      return result;
    };
    if (!this.asyncLayer) {
      const agents = await provision();
      await Promise.all(agents.map((agent) => this.materializeBuiltinWorkflowRoleBundle(agent)));
      return agents;
    }
    /*
     * FNXC:WorkflowAgentRouting 2026-08-07-07:16:
     * Startup and onboarding can run in separate engine processes. Serialize the
     * read/repair/create sequence with a project-scoped advisory lock so both
     * callers observe the first four durable built-ins instead of racing to add
     * duplicate owners. User-created same-role agents are intentionally outside
     * this provenance lock and remain valid pool members.
     */
    /*
     * FNXC:WorkflowAgentRouting 2026-08-07-16:22:
     * The provisioning work MUST run on `tx`, not on the pool. The lock holder
     * previously called provision() with no executor, so its reads/writes asked
     * the pool for a SECOND connection while concurrent callers occupied the
     * remaining slots blocking on this same advisory lock. With DEFAULT_POOL_MAX=3
     * that self-deadlocks: the holder can never finish, the waiters can never take
     * the lock, and every later query — i.e. every DB-backed API route — queues
     * forever behind an exhausted pool. Keep the lock and the work on one connection.
     */
    const agents = await this.asyncLayer.transactionImmediate(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${this.backendProjectId}), hashtext('builtin-workflow-role-provisioning'))`);
      return provision(tx);
    });
    /*
    FNXC:WorkflowAgentIdentities 2026-08-08-06:11:
    Commit durable ownership before writing managed mirrors. A filesystem failure leaves a complete,
    retryable row state; later provisioning can converge without holding an agent file lock while it
    waits for the project advisory lock.
    */
    await Promise.all(agents.map((agent) => this.materializeBuiltinWorkflowRoleBundle(agent)));
    return agents;
  }

  /*
  FNXC:MemoryAgent 2026-08-16-02:31:
  Memory Keeper is custom because it is not a workflow-stage principal. Its heartbeat defaults off
  until an operator opts in, while auto-claim remains off because it only maintains memory. This
  runs during init, where createAgent name collisions would abort startup; preflight probes,
  a fallback name, a null degraded result, and the init-side catch keep an operator's same-named
  agent untouched and the project runnable.
  */
  async provisionBuiltinMemoryAgent(): Promise<Agent | null> {
    const provision = async (executor?: QueryHandle): Promise<Agent | null> => {
      const existing = await this.listAgents({ includeEphemeral: true }, executor);
      const owners = existing
        .filter((agent) => agent.metadata?.[BUILTIN_MEMORY_AGENT_PROVENANCE_KEY] === true)
        .sort(compareBuiltinWorkflowOwnerAge);
      let owner = owners[0];
      for (const loser of owners.slice(1)) {
        const { [BUILTIN_MEMORY_AGENT_PROVENANCE_KEY]: _builtInMemoryAgent, ...metadata } = loser.metadata ?? {};
        await this.writeAgent({ ...loser, metadata, updatedAt: new Date().toISOString() }, executor);
      }
      if (!owner) {
        /*
        FNXC:MemoryAgent 2026-08-11-10:17:
        Probe through the provisioning transaction executor. Opening a second pooled query while the
        startup advisory lock is held can exhaust a small pool behind concurrent startup callers.
        */
        const canonicalTaken = (await this.findAgentByName(BUILTIN_MEMORY_AGENT_NAME, executor)) !== null;
        const name = canonicalTaken ? BUILTIN_MEMORY_AGENT_FALLBACK_NAME : BUILTIN_MEMORY_AGENT_NAME;
        if (canonicalTaken && (await this.findAgentByName(BUILTIN_MEMORY_AGENT_FALLBACK_NAME, executor)) !== null) {
          agentStoreLog.warn(`Built-in memory agent not provisioned: both "${BUILTIN_MEMORY_AGENT_NAME}" and "${BUILTIN_MEMORY_AGENT_FALLBACK_NAME}" are in use`);
          return null;
        }
        try {
          owner = await this.createAgent({
            name,
            roles: [...BUILTIN_MEMORY_AGENT_DEFAULT.roles],
            title: BUILTIN_MEMORY_AGENT_DEFAULT.title,
            metadata: { [BUILTIN_MEMORY_AGENT_PROVENANCE_KEY]: true },
            /*
            FNXC:MemoryAgent 2026-08-16-02:31:
            Memory consolidation is opt-in: newly provisioned Memory Keepers must not begin
            hourly autonomous heartbeats until an operator enables the existing heartbeat toggle.
            Keep auto-claim off and the one-hour interval ready for that later opt-in.
            */
            runtimeConfig: { enabled: false, autoClaimRelevantTasks: false, heartbeatIntervalMs: 3_600_000 },
            instructionsText: BUILTIN_MEMORY_AGENT_DEFAULT.instructionsText,
            soul: BUILTIN_MEMORY_AGENT_DEFAULT.soul,
            bundleConfig: { ...BUILTIN_MEMORY_AGENT_DEFAULT.bundleConfig, files: [...BUILTIN_MEMORY_AGENT_DEFAULT.bundleConfig.files] },
          }, executor);
        } catch (error) {
          if (error instanceof Error && error.message.includes("already exists")) {
            agentStoreLog.warn(`Built-in memory agent not provisioned because its candidate name was claimed during creation`);
            return null;
          }
          throw error;
        }
        return owner;
      }
      const metadata = { ...(owner.metadata ?? {}), [BUILTIN_MEMORY_AGENT_PROVENANCE_KEY]: true };
      const currentRuntimeConfig = owner.runtimeConfig ?? {};
      /*
      FNXC:MemoryAgent 2026-08-16-02:31:
      Startup convergence owns the safe maintenance defaults but never an operator's explicit
      heartbeat choice. Preserve either boolean direction across init runs; missing legacy config
      adopts the opt-in default without unnecessarily rewriting an already-converged owner.
      */
      const enabled = typeof currentRuntimeConfig.enabled === "boolean" ? currentRuntimeConfig.enabled : false;
      const runtimeConfig = currentRuntimeConfig.enabled === enabled
        && currentRuntimeConfig.autoClaimRelevantTasks === false
        && currentRuntimeConfig.heartbeatIntervalMs === DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS
        ? currentRuntimeConfig
        : { ...currentRuntimeConfig, enabled, autoClaimRelevantTasks: false, heartbeatIntervalMs: DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS };
      const updates: Partial<Agent> = {
        roles: [...BUILTIN_MEMORY_AGENT_DEFAULT.roles],
        role: "custom",
        title: owner.title ?? BUILTIN_MEMORY_AGENT_DEFAULT.title,
        metadata,
        runtimeConfig,
        instructionsText: owner.instructionsText?.trim() ? owner.instructionsText : BUILTIN_MEMORY_AGENT_DEFAULT.instructionsText,
        soul: owner.soul?.trim() ? owner.soul : BUILTIN_MEMORY_AGENT_DEFAULT.soul,
      };
      const nextOwner = { ...owner, ...updates };
      if (JSON.stringify(nextOwner) === JSON.stringify(owner)) return owner;
      owner = { ...nextOwner, updatedAt: new Date().toISOString() };
      await this.writeAgent(owner, executor);
      return owner;
    };
    if (!this.asyncLayer) return provision();
    return this.asyncLayer.transactionImmediate(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${this.backendProjectId}), hashtext('builtin-memory-agent-provisioning'))`);
      return provision(tx);
    });
  }

  /**
   * Create an API key for an agent.
   * Persists only the SHA-256 token hash; plaintext token is returned once.
   */
  async createApiKey(agentId: string, options?: { label?: string }): Promise<AgentApiKeyCreateResult> {
    return this.withLock(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const createdAt = new Date().toISOString();
      const label = options?.label?.trim();

      const key: AgentApiKey = {
        id: `key-${randomUUID().slice(0, 8)}`,
        agentId,
        tokenHash,
        createdAt,
        ...(label ? { label } : {}),
      };

      /*
       * FNXC:SqliteFinalRemoval 2026-06-26-09:20:
       * Backend-mode: delegate to async Drizzle insertApiKey helper.
       */
            await insertApiKeyAsync(this.asyncLayer!.db, key, this.workflowProjectId);

      return { key, token };
    });
  }

  /**
   * List all API keys for an agent, including revoked keys.
   */
  async listApiKeys(agentId: string): Promise<AgentApiKey[]> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return this.readApiKeys(agentId);
  }

  /**
   * Revoke an API key for an agent.
   * Revoking an already-revoked key is a no-op.
   */
  async revokeApiKey(agentId: string, keyId: string): Promise<AgentApiKey> {
    return this.withLock(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const keys = await this.readApiKeys(agentId);
      const keyIndex = keys.findIndex((key) => key.id === keyId);
      if (keyIndex === -1) {
        throw new Error(`API key ${keyId} not found for agent ${agentId}`);
      }

      const existing = keys[keyIndex];
      if (existing.revokedAt) {
        return existing;
      }

      const revoked: AgentApiKey = {
        ...existing,
        revokedAt: new Date().toISOString(),
      };

      /*
       * FNXC:SqliteFinalRemoval 2026-06-26-09:20:
       * Backend-mode: delegate to async Drizzle revokeApiKeyRow helper.
       */
            await revokeApiKeyRowAsync(this.asyncLayer!.db, keyId, agentId, revoked, this.workflowProjectId);

      return revoked;
    });
  }

  /**
   * Delete an agent and its heartbeat history.
   * @param agentId - The agent ID
   * @throws Error if agent not found
   */
  async deleteAgent(agentId: string, options?: { force?: boolean; reassignTo?: string }): Promise<void> {
    await this.withLock(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      if (this.taskStore && typeof (this.taskStore as { getTasksByAssignedAgent?: unknown }).getTasksByAssignedAgent === "function") {
        const assignedTasks = await this.taskStore.getTasksByAssignedAgent(agentId);
        for (const task of assignedTasks) {
          if (task.checkedOutBy === agentId && options?.force !== true) {
            throw new Error(`Agent ${agentId} holds checkout for task ${task.id}; pass force=true to delete`);
          }

          await this.taskStore.updateTask(task.id, {
            assignedAgentId: options?.reassignTo ?? null,
            checkedOutBy: task.checkedOutBy === agentId ? null : undefined,
          });
        }
      }

      // FNXC:SqliteFinalRemoval 2026-06-25-23:55:
      // Backend mode: delete via async Drizzle helper (cascading FKs handle
      // heartbeats, runs, task sessions, API keys, config revisions, etc.).
            await deleteAgentAsync(this.asyncLayer!.db, agentId, this.workflowProjectId);

      // FN-7723: keep this instance's own change-detection snapshot in sync
      // with its own delete so a later poll never mistakes the row's absence
      // for an external delete (deletes are pruned from the cache, not
      // re-emitted, since agent:deleted already fires below).
      this.agentSnapshotCache.delete(agentId);

      this.emit("agent:deleted", agentId);
    });
  }

  /**
   * Record a heartbeat event for an agent.
   * @param agentId - The agent ID
   * @param status - Heartbeat status
   * @param runId - Optional run ID (uses active run if not provided)
   * @returns The recorded heartbeat event
   */
  async recordHeartbeat(
    agentId: string,
    status: AgentHeartbeatEvent["status"],
    runId?: string
  ): Promise<AgentHeartbeatEvent> {
    if (this.backendMode) {
      void this.backendProjectId;
    }
    return this.withLock(agentId, async () => {
      // Verify agent exists
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      // Get or determine run ID
      let effectiveRunId = runId;
      if (!effectiveRunId) {
        const activeRun = await this.getActiveHeartbeatRun(agentId);
        effectiveRunId = activeRun?.id ?? `run-${randomUUID().slice(0, 8)}`;
      }

      const event: AgentHeartbeatEvent = {
        timestamp: new Date().toISOString(),
        status,
        runId: effectiveRunId,
      };

      // FNXC:SqliteFinalRemoval 2026-06-26-00:00:
      // Backend mode: record heartbeat via async Drizzle helper.
            await recordHeartbeatAsync(this.asyncLayer!.db, {
        agentId,
        timestamp: event.timestamp,
        status: event.status,
        runId: event.runId,
      }, this.workflowProjectId);

      // Update agent's lastHeartbeatAt if status is ok
      if (status === "ok") {
        const updated: Agent = {
          ...agent,
          lastHeartbeatAt: event.timestamp,
          updatedAt: event.timestamp,
        };
        await this.writeAgent(updated);
      }

      /*
      FNXC:SqliteDualPathCleanup 2026-07-27-06:15:
      Dual-path collapse left a bare `else` that made this emit the else-body, so
      status==="ok" heartbeats never fired agent:heartbeat after a successful write.
      Emit for every persisted heartbeat (ok and non-ok).
      */
      this.emit("agent:heartbeat", agentId, event);

      return event;
    });
  }

  /**
   * Get heartbeat history for an agent.
   * @param agentId - The agent ID
   * @param limit - Maximum number of events to return (default: 50)
   * @returns Array of heartbeat events (newest first)
   */
  async getHeartbeatHistory(agentId: string, limit = 50): Promise<AgentHeartbeatEvent[]> {
    // FNXC:SqliteFinalRemoval 2026-06-26-00:05:
    // Backend mode: read via async Drizzle helper.
    void this.backendProjectId;
    return getHeartbeatHistoryAsync(this.asyncLayer!.db, agentId, limit, this.workflowProjectId);
}

  /**
   * Start a new heartbeat run for an agent.
   * Persists the run to structured storage as the source of truth.
   * @param agentId - The agent ID
   * @returns The created run
   */
  async startHeartbeatRun(agentId: string): Promise<AgentHeartbeatRun> {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const run: AgentHeartbeatRun = {
      id: runId,
      agentId,
      startedAt: now,
      endedAt: null,
      status: "active",
    };

    // Persist to structured storage as source of truth
    await this.saveRun(run);

    await this.recordHeartbeat(agentId, "ok", runId);

    return run;
  }

  /**
   * End a heartbeat run.
   * Updates the persisted run's terminal state in structured storage.
   * Also records a heartbeat event for history views.
   * @param runId - The run ID
   * @param status - End status (completed or terminated)
   */
  async endHeartbeatRun(runId: string, status: "completed" | "terminated"): Promise<void> {
    const now = new Date().toISOString();

    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:25:
     * Backend-mode: read the run via async getRunById helper instead of sync
     * this.db.prepare(). The saveRun + recordHeartbeat calls below already
     * have backend-mode branches.
     */
    const found = await getRunByIdAsync(this.asyncLayer!.db, this.backendProjectId, runId);
    if (!found) {
      return;
    }
    const agentId = found.agentId;
    const existingRun: AgentHeartbeatRun = found.run ?? {
      id: runId,
      agentId: found.agentId,
      startedAt: now,
      endedAt: null,
      status: "active",
    };

    const updatedRun: AgentHeartbeatRun = {
      ...existingRun,
      endedAt: now,
      status,
    };
    await this.saveRun(updatedRun);
    await this.recordHeartbeat(agentId, status === "terminated" ? "missed" : "ok", runId);
  }

  /**
   * Get the active heartbeat run for an agent.
   * Reads from structured run storage first (source of truth),
   * falls back to heartbeat event reconstruction for legacy data.
   * @param agentId - The agent ID
   * @returns The active run, or null if none
   */
  async getActiveHeartbeatRun(agentId: string): Promise<AgentHeartbeatRun | null> {
    const recentRuns = await this.getRecentRuns(agentId, 50);
    return recentRuns.find((run) => run.status === "active") ?? null;
  }

  /**
   * Get all completed heartbeat runs for an agent.
   * Reads from structured run storage first (source of truth),
   * falls back to heartbeat event reconstruction for legacy data.
   * Returns terminal runs (completed, terminated, failed) in newest-first order.
   * @param agentId - The agent ID
   * @returns Array of completed runs
   */
  async getCompletedHeartbeatRuns(agentId: string): Promise<AgentHeartbeatRun[]> {
    const recentRuns = await this.getRecentRuns(agentId, 50);
    return recentRuns
      .filter((run) => run.status !== "active")
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  /**
   * List every heartbeat run currently in `status = 'active'` across all
   * agents. Used by self-healing to detect orphaned runs from prior process
   * incarnations that crashed before calling endHeartbeatRun(). Without this
   * sweep an active row blocks all subsequent timer ticks for the agent
   * because HeartbeatTriggerScheduler.onTimerTick treats any active run as
   * "already running".
   */
  async listActiveHeartbeatRuns(): Promise<AgentHeartbeatRun[]> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:25:
     * Backend-mode: delegate to async Drizzle listActiveHeartbeatRuns helper.
     */
        return listActiveHeartbeatRunsAsync(this.asyncLayer!.db, this.backendProjectId);
}

  // ─────────────────────────────────────────────────────────────────────────
  // Task Session Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a task session for an agent.
   * @param agentId - The agent ID
   * @param taskId - The task ID
   * @returns The session, or null if not found
   */
  async getTaskSession(agentId: string, taskId: string): Promise<AgentTaskSession | null> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
     * Backend-mode: delegate to async Drizzle getTaskSession helper.
     */
        return getTaskSessionAsync(this.asyncLayer!.db, agentId, taskId, this.workflowProjectId);
}

  /**
   * Create or update a task session for an agent.
   * @param session - The session data
   * @returns The saved session
   */
  async upsertTaskSession(session: AgentTaskSession): Promise<AgentTaskSession> {
    const now = new Date().toISOString();
    const existing = await this.getTaskSession(session.agentId, session.taskId);

    const saved: AgentTaskSession = {
      ...session,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
     * Backend-mode: delegate to async Drizzle upsertTaskSession helper.
     */
        await upsertTaskSessionAsync(this.asyncLayer!.db, saved, this.workflowProjectId);

    return saved;
  }

  /**
   * Delete a task session.
   * @param agentId - The agent ID
   * @param taskId - The task ID
   */
  async deleteTaskSession(agentId: string, taskId: string): Promise<void> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
     * Backend-mode: delegate to async Drizzle deleteTaskSession helper.
     */
        await deleteTaskSessionAsync(this.asyncLayer!.db, agentId, taskId, this.workflowProjectId);
    return;
}

  // ─────────────────────────────────────────────────────────────────────────
  // Org Hierarchy
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get agents that report to a specific agent.
   * @param agentId - The parent agent ID
   * @returns Array of agents that report to this agent
   */
  async getAgentsByReportsTo(agentId: string): Promise<Agent[]> {
    const all = await this.listAgents();
    return all.filter((a) => a.reportsTo === agentId);
  }

  /**
   * Walk the chain of command for an agent.
   * @param agentId - Starting agent ID
   * @returns Ordered chain [self, manager, grandManager, ...]
   */
  async getChainOfCommand(agentId: string): Promise<Agent[]> {
    const chain: Agent[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = agentId;

    for (let depth = 0; depth < 20 && currentId; depth += 1) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);

      const agent = await this.getAgent(currentId);
      if (!agent) {
        return depth === 0 ? [] : chain;
      }

      chain.push(agent);
      currentId = agent.reportsTo;
    }

    return chain;
  }

  /**
   * Build the recursive org tree for all agents.
   * @param filter - Optional filter for listing agents
   * @returns Root nodes with nested children
   */
  async getOrgTree(filter?: { includeEphemeral?: boolean }): Promise<OrgTreeNode[]> {
    const agents = await this.listAgents(filter);
    if (agents.length === 0) {
      return [];
    }

    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const childrenByParent = new Map<string, Agent[]>();
    const roots: Agent[] = [];

    for (const agent of agents) {
      if (!agent.reportsTo || !agentsById.has(agent.reportsTo)) {
        roots.push(agent);
        continue;
      }

      const siblings = childrenByParent.get(agent.reportsTo) ?? [];
      siblings.push(agent);
      childrenByParent.set(agent.reportsTo, siblings);
    }

    const sortByCreatedAtAsc = (a: Agent, b: Agent): number =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

    for (const children of childrenByParent.values()) {
      children.sort(sortByCreatedAtAsc);
    }
    roots.sort(sortByCreatedAtAsc);

    const buildNode = (agent: Agent): OrgTreeNode => ({
      agent,
      children: (childrenByParent.get(agent.id) ?? []).map((child) => buildNode(child)),
    });

    return roots.map((root) => buildNode(root));
  }

  /**
   * Resolve an agent by exact ID or normalized shortname derived from display name.
   * @param shortname - Agent ID or normalized agent name
   * @returns Matching agent when unambiguous; otherwise null
   */
  async resolveAgent(shortname: string): Promise<Agent | null> {
    const normalize = (value: string): string =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    const all = await this.listAgents();

    const exact = all.find((agent) => agent.id === shortname);
    if (exact) {
      return exact;
    }

    const normalizedTarget = normalize(shortname);
    if (!normalizedTarget) {
      return null;
    }

    const matches = all.filter((agent) => normalize(agent.name) === normalizedTarget);
    return matches.length === 1 ? matches[0] : null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rich Run Storage
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Save a rich heartbeat run record (structured JSON, not JSONL events).
   * @param run - The heartbeat run data
   */
  async saveRun(run: AgentHeartbeatRun): Promise<void> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:35:
     * Backend-mode: delegate to async Drizzle saveRun helper.
     */
        await saveRunAsync(this.asyncLayer!.db, this.backendProjectId, run);
    return;
}

  /**
   * Get a specific run by ID.
   * @param agentId - The agent ID
   * @param runId - The run ID
   * @returns The run detail, or null if not found
   */
  async getRunDetail(agentId: string, runId: string): Promise<AgentHeartbeatRun | null> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:35:
     * Backend-mode: delegate to async Drizzle getRunDetail helper.
     */
        return getRunDetailAsync(this.asyncLayer!.db, this.backendProjectId, agentId, runId);
}

  /**
   * Get recent runs for an agent from structured run storage.
   * @param agentId - The agent ID
   * @param limit - Max number of runs to return (default: 20)
   * @returns Array of runs (newest first)
   */
  async getRecentRuns(agentId: string, limit = 20): Promise<AgentHeartbeatRun[]> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:35:
     * Backend-mode: delegate to async Drizzle getRecentRuns helper.
     */
        return getRecentRunsAsync(this.asyncLayer!.db, this.backendProjectId, agentId, limit);
}

  async getRunStatusCounts(agentIds?: readonly string[]): Promise<{ completedRuns: number; failedRuns: number }> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:35:
     * Backend-mode: delegate to async Drizzle getRunStatusCounts helper.
     */
        return getRunStatusCountsAsync(this.asyncLayer!.db, this.backendProjectId, agentIds);
}

  // ─────────────────────────────────────────────────────────────────────────
  // Run-scoped log storage (JSONL files alongside run JSON in agentsDir)
  // ─────────────────────────────────────────────────────────────────────────

  /** Maximum byte size for any single log entry field (64 KB) to bound disk growth. */
  private static readonly RUN_LOG_ENTRY_MAX_BYTES = 64 * 1024;

  /** Return the path to the JSONL run-log file for a given agent/run pair. */
  private runLogPath(agentId: string, runId: string): string {
    return join(this.agentsDir, `${agentId}-runlogs-${runId}.jsonl`);
  }

  /**
   * Append a single {@link AgentLogEntry} to the JSONL run log for the given run.
   * Individual `text` and `detail` fields are capped at 64 KB so one large tool
   * result cannot grow the file unboundedly.
   * @param agentId - The agent ID
   * @param runId - The run ID
   * @param entry - The log entry to append
   */
  /*
  FNXC:AgentLogging 2026-08-29-05:06:
  FN-253 makes tool detail default-persisted and dual-sunk by heartbeat loggers. Run logs previously
  bypassed the shared task-log detail bound, so normalize tool detail before the existing 64 KB outer
  guard while writing and emitting the same safe entry for reconnect-safe live viewers.
  */
  async appendRunLog(agentId: string, runId: string, entry: AgentLogEntry): Promise<void> {
    const cap = AgentStore.RUN_LOG_ENTRY_MAX_BYTES;
    const normalizedDetail = truncateAgentLogDetail(entry.detail, entry.type);
    const safeEntry: AgentLogEntry = {
      ...entry,
      text: entry.text.length > cap ? `${entry.text.slice(0, cap)}\n\n... (truncated, ${entry.text.length} chars)` : entry.text,
      ...(normalizedDetail !== undefined && {
        detail: normalizedDetail.length > cap ? `${normalizedDetail.slice(0, cap)}\n\n... (truncated, ${normalizedDetail.length} chars)` : normalizedDetail,
      }),
    };
    const line = JSON.stringify(safeEntry) + "\n";
    await appendFile(this.runLogPath(agentId, runId), line, "utf-8");
    this.emit("run:log", agentId, runId, safeEntry);
  }

  /**
   * Read all log entries for a given run from its JSONL file.
   * Returns an empty array when the file does not exist (e.g., the run had no
   * logs or was recorded before this feature was added).
   * @param agentId - The agent ID
   * @param runId - The run ID
   * @param opts.limit - Optional maximum number of entries to return (newest-first capped)
   */
  async getRunLogs(agentId: string, runId: string, opts?: { limit?: number }): Promise<AgentLogEntry[]> {
    const filePath = this.runLogPath(agentId, runId);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const entries: AgentLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AgentLogEntry);
      } catch {
        // Skip malformed lines — append-only means partial writes can occur on crash
      }
    }
    if (opts?.limit !== undefined && entries.length > opts.limit) {
      return entries.slice(entries.length - opts.limit);
    }
    return entries;
  }

  /**
   * Get the most recently persisted blocked-task dedup state for an agent.
   */
  async getLastBlockedState(agentId: string): Promise<BlockedStateSnapshot | null> {
    // FNXC:PostgresCutover 2026-07-04: delegate to async Drizzle helper in backend mode.
        return getLastBlockedStateAsync(this.asyncLayer!.db, agentId, this.workflowProjectId);
}

  /**
   * Persist the latest blocked-task dedup state for an agent.
   */
  async setLastBlockedState(agentId: string, state: BlockedStateSnapshot): Promise<void> {
    await this.withLock(agentId, async () => {
      // FNXC:PostgresCutover 2026-07-04: delegate to async Drizzle helper in backend mode.
            await setLastBlockedStateAsync(this.asyncLayer!.db, agentId, state, this.workflowProjectId);
      return;
});
  }

  /**
   * Clear any persisted blocked-task dedup state for an agent.
   */
  async clearLastBlockedState(agentId: string): Promise<void> {
    await this.withLock(agentId, async () => {
      // FNXC:PostgresCutover 2026-07-04: delegate to async Drizzle helper in backend mode.
            await clearLastBlockedStateAsync(this.asyncLayer!.db, agentId, this.workflowProjectId);
      return;
});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getConfigRevisionsPath(agentId: string): string {
    return join(this.agentsDir, `${agentId}-revisions.jsonl`);
  }

  private async appendConfigRevision(revision: AgentConfigRevision): Promise<void> {
    // FNXC:SqliteFinalRemoval 2026-06-26-00:10: backend mode async delegation.
        await appendConfigRevisionAsync(this.asyncLayer!.db, revision, this.workflowProjectId);
    return;
}

  private async readConfigRevisions(agentId: string): Promise<AgentConfigRevision[]> {
    // FNXC:SqliteFinalRemoval 2026-06-26-00:10: backend mode async delegation.
        return readConfigRevisionsAsync(this.asyncLayer!.db, agentId, this.workflowProjectId);
}

  private createConfigRevision(params: {
    agentId: string;
    before: AgentConfigSnapshot;
    after: AgentConfigSnapshot;
    source: AgentConfigRevision["source"];
    createdAt?: string;
    rollbackToRevisionId?: string;
    diffs?: AgentConfigRevision["diffs"];
  }): AgentConfigRevision {
    const diffs = params.diffs ?? diffConfigSnapshots(params.before, params.after);

    const changedFields = diffs.map((diff) => diff.field).join(", ");
    const summary =
      params.source === "rollback"
        ? diffs.length > 0
          ? `Rolled back config fields: ${changedFields}`
          : `Rolled back to revision ${params.rollbackToRevisionId ?? "unknown"}`
        : diffs.length > 0
          ? `Updated ${changedFields}`
          : "No config changes";

    return {
      id: `revision-${randomUUID().slice(0, 8)}`,
      agentId: params.agentId,
      createdAt: params.createdAt ?? new Date().toISOString(),
      before: params.before,
      after: params.after,
      diffs,
      summary,
      source: params.source,
      ...(params.rollbackToRevisionId ? { rollbackToRevisionId: params.rollbackToRevisionId } : {}),
    };
  }

  private snapshotToAgentConfig(
    snapshot: AgentConfigSnapshot,
  ): Pick<
    Agent,
    | "name"
    | "role"
    | "title"
    | "icon"
    | "imageUrl"
    | "reportsTo"
    | "runtimeConfig"
    | "permissions"
    | "permissionPolicy"
    | "instructionsPath"
    | "instructionsText"
    | "soul"
    | "memory"
    | "bundleConfig"
    | "heartbeatProcedurePath"
    | "metadata"
  > {
    return {
      name: snapshot.name,
      role: snapshot.role,
      title: snapshot.title,
      icon: snapshot.icon,
      imageUrl: snapshot.imageUrl,
      reportsTo: snapshot.reportsTo,
      runtimeConfig: snapshot.runtimeConfig ? { ...snapshot.runtimeConfig } : undefined,
      permissions: snapshot.permissions ? { ...snapshot.permissions } : undefined,
      permissionPolicy: snapshot.permissionPolicy
        ? {
            presetId: snapshot.permissionPolicy.presetId,
            rules: { ...snapshot.permissionPolicy.rules },
          }
        : undefined,
      instructionsPath: snapshot.instructionsPath,
      instructionsText: snapshot.instructionsText,
      soul: snapshot.soul,
      memory: snapshot.memory,
      bundleConfig: snapshot.bundleConfig
        ? {
            ...snapshot.bundleConfig,
            files: [...snapshot.bundleConfig.files],
          }
        : undefined,
      heartbeatProcedurePath: snapshot.heartbeatProcedurePath,
      metadata: { ...snapshot.metadata },
    };
  }

  private async findConfigRevisionAcrossAgents(revisionId: string): Promise<AgentConfigRevision | null> {
    // FNXC:PostgresCutover 2026-07-04: delegate to async Drizzle helper in backend mode.
        return findConfigRevisionByIdAsync(this.asyncLayer!.db, revisionId, this.workflowProjectId);
}

  private computeNextResetAt(period: AgentBudgetConfig["budgetPeriod"], resetDay?: number): string | null {
    if (!period || period === "lifetime") {
      return null;
    }

    const now = new Date();

    if (period === "daily") {
      const nextMidnight = new Date(now);
      nextMidnight.setHours(0, 0, 0, 0);
      nextMidnight.setDate(nextMidnight.getDate() + 1);
      return nextMidnight.toISOString();
    }

    if (period === "weekly") {
      const normalizedResetDay =
        typeof resetDay === "number" && Number.isFinite(resetDay)
          ? Math.max(0, Math.min(6, Math.floor(resetDay)))
          : 0;
      const nextWeeklyReset = new Date(now);
      nextWeeklyReset.setHours(0, 0, 0, 0);

      const currentDay = nextWeeklyReset.getDay();
      let daysUntilReset = (normalizedResetDay - currentDay + 7) % 7;
      if (daysUntilReset === 0) {
        daysUntilReset = 7;
      }

      nextWeeklyReset.setDate(nextWeeklyReset.getDate() + daysUntilReset);
      return nextWeeklyReset.toISOString();
    }

    if (period === "monthly") {
      const normalizedResetDay =
        typeof resetDay === "number" && Number.isFinite(resetDay)
          ? Math.max(1, Math.min(31, Math.floor(resetDay)))
          : 1;

      const createMonthlyReset = (year: number, month: number): Date => {
        const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
        const clampedResetDay = Math.min(normalizedResetDay, lastDayOfMonth);
        return new Date(year, month, clampedResetDay, 0, 0, 0, 0);
      };

      let nextMonthlyReset = createMonthlyReset(now.getFullYear(), now.getMonth());
      if (nextMonthlyReset <= now) {
        nextMonthlyReset = createMonthlyReset(now.getFullYear(), now.getMonth() + 1);
      }

      return nextMonthlyReset.toISOString();
    }

    return null;
  }

  /** Seed only missing or blank default-owned mirror files after the provisioning transaction commits. */
  private async materializeBuiltinWorkflowRoleBundle(agent: Agent): Promise<void> {
    // FNXC:WorkflowAgentIdentities 2026-08-08-06:38: Take the per-agent file lock only after
    // the advisory transaction commits, serializing default seeding with dashboard file edits
    // without creating inverse DB/file waits.
    return this.withLock(agent.id, async () => {
      const role = agent.metadata?.workflowRole;
      const definition = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.find((candidate) => candidate.role === role);
      if (!definition || agent.metadata?.builtInWorkflowRole !== true) return;
      const config = agent.bundleConfig;
      if (!isCanonicalOrPartialBuiltinWorkflowBundle(config)) return;
      /*
      FNXC:WorkflowAgentIdentities 2026-08-08-06:27:
      A non-default inline body or any path is an operator-owned instruction source, even when a
      legacy canonical mirror config remains on the row. Do not create default mirror files beside
      that source: startup may repair default-owned rows, but it must never inject a competing setup.
      */
      if (agent.instructionsPath?.trim()
        || (agent.instructionsText?.trim() && agent.instructionsText !== definition.instructionsText)) return;
      // FNXC:WorkflowAgentIdentities 2026-08-08-06:38: Follow the public bundle APIs'
      // legacy/display-name compatibility rule so upgrades never strand existing managed files
      // in a second directory.
      const bundleDir = await this.resolveCompatibleBundleDir(agent.id, true);
      await mkdir(bundleDir, { recursive: true });
      for (const [file, content] of [["AGENTS.md", definition.instructionsText], ["soul.md", definition.soul]] as const) {
        const path = join(bundleDir, file);
        let current = "";
        try { current = await readFile(path, "utf-8"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!current.trim()) await writeFile(path, content, "utf-8");
      }
    });
  }

  private getCanonicalBundleDir(agent: Agent): string {
    return join(this.agentsDir, getCanonicalAgentInstructionsBundleDirName(agent.name, agent.id));
  }

  private getLegacyBundleDir(agentId: string): string {
    return join(this.agentsDir, getLegacyAgentInstructionsBundleDirName(agentId));
  }

  private async resolveCompatibleBundleDir(agentId: string, createIfMissing: boolean): Promise<string> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const canonicalDir = this.getCanonicalBundleDir(agent);
    if (await this.pathExists(canonicalDir)) {
      return canonicalDir;
    }

    const compatibleDir = await this.findExistingDisplayNameBundleDir(agent);
    if (compatibleDir) {
      return compatibleDir;
    }

    const legacyDir = this.getLegacyBundleDir(agent.id);
    if (await this.pathExists(legacyDir)) {
      return legacyDir;
    }

    return createIfMissing ? canonicalDir : canonicalDir;
  }

  private async findExistingDisplayNameBundleDir(agent: Agent): Promise<string | null> {
    const safeId = getSafeAgentAssetIdSegment(agent.id);
    try {
      const entries = await readdir(this.agentsDir, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith("-instructions"))
        .map((entry) => entry.name)
        .filter((name) => {
          const base = name.slice(0, -"-instructions".length);
          return base.endsWith(`-${safeId}`);
        })
        .sort((a, b) => a.localeCompare(b));

      if (candidates.length === 0) {
        return null;
      }

      const canonicalName = getCanonicalAgentInstructionsBundleDirName(agent.name, agent.id);
      const selected = candidates.find((candidate) => candidate === canonicalName) ?? candidates[0];
      return join(this.agentsDir, selected);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  private async resolveCompatibleHeartbeatProcedurePath(agent: Agent): Promise<string> {
    const canonicalPath = getDefaultHeartbeatProcedurePath(agent.id, agent.name);
    const canonicalAbs = join(this.rootDir, "..", canonicalPath);
    if (await this.pathExists(canonicalAbs)) {
      return canonicalPath;
    }

    const safeId = getSafeAgentAssetIdSegment(agent.id);
    try {
      const entries = await readdir(this.agentsDir, { withFileTypes: true });
      const compatibleDir = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .find((name) => name.endsWith(`-${safeId}`));
      if (compatibleDir) {
        const candidatePath = `.fusion/agents/${compatibleDir}/HEARTBEAT.md`;
        if (await this.pathExists(join(this.rootDir, "..", candidatePath))) {
          return candidatePath;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    const legacyPath = `.fusion/agents/${getLegacyAgentAssetDirectoryName(agent.id)}/HEARTBEAT.md`;
    const legacyAbs = join(this.rootDir, "..", legacyPath);
    if (await this.pathExists(legacyAbs)) {
      return legacyPath;
    }

    return canonicalPath;
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private validateBundleFilePath(filePath: string): void {
    if (typeof filePath !== "string") {
      throw new Error("Bundle file path must be a string");
    }

    const trimmedPath = filePath.trim();
    if (!trimmedPath) {
      throw new Error("Bundle file path cannot be empty");
    }

    const normalizedPath = trimmedPath.replace(/\\/g, "/");
    if (normalizedPath.startsWith("/")) {
      throw new Error("Bundle file path must be relative (absolute paths are not allowed)");
    }

    const segments = normalizedPath.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error("Bundle file path cannot include '..' path traversal segments");
    }

    if (!normalizedPath.endsWith(".md")) {
      throw new Error("Bundle file path must end with .md");
    }

    const filename = basename(normalizedPath);
    if (!filename) {
      throw new Error("Bundle file name cannot be empty");
    }

    if (filename.length > 500) {
      throw new Error("Bundle file name cannot exceed 500 characters");
    }
  }

  private async readApiKeys(agentId: string): Promise<AgentApiKey[]> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-09:20:
     * Backend-mode: delegate to async Drizzle readApiKeys helper.
     */
        return readApiKeysAsync(this.asyncLayer!.db, agentId, this.workflowProjectId);
}

  private readAgent(_agentId: string): Agent | null {
    // SQLite sync read path. In PG backend mode there is no synchronous DB
    // handle, so this returns null — the async path is wired via getAgent()
    // (which delegates to readAgentAsync). The remaining internal sync caller
    // (getInstructionsDir) uses it only for non-critical path computation;
    // resolveCompatibleBundleDir now uses getAgent() directly.
        return null;
}

  private mapAgentRow(row: AgentRow): Agent {
    const data = this.parseJson<Partial<AgentData>>(row.data, {});
    const metadata = this.parseJson<Record<string, unknown>>(row.metadata, {});
    return this.parseAgent({
      ...data,
      id: row.id,
      name: row.name,
      roles: (data.roles?.length ? data.roles : [row.role]),
      role: row.role,
      state: row.state,
      taskId: row.taskId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastHeartbeatAt: row.lastHeartbeatAt ?? undefined,
      metadata,
    } as AgentData);
  }

  private parseJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) {
      return fallback;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * Synchronously read an agent from SQLite (for use in synchronous hot paths).
   * Returns null if the agent does not exist, cannot be parsed, or the store is
   * in PG backend mode (no synchronous DB handle — async callers must use
   * {@link getAgent} which delegates to `readAgentAsync`).
   * @param agentId - The agent ID
   */
  getCachedAgent(agentId: string): Agent | null {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:40:
    PostgreSQL path: return agentMemoryCache populated by getAgent(). Still
    null until the first async getAgent warms the cache (heartbeat timer path
    uses async getAgentConfig as authority).
    */
    /* FNXC:SqliteDualPathCleanup 2026-07-26-14:15: getCachedAgent is memory/PG-only; no SQLite readAgent. */
    return this.agentMemoryCache.get(agentId) ?? null;
  }

  private parseAgent(data: AgentData): Agent {
    return {
      id: data.id,
      name: data.name,
      roles: normalizeAgentRoles(data.roles, data.role),
      role: normalizeAgentRoles(data.roles, data.role)[0],
      state: data.state,
      taskId: data.taskId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      lastHeartbeatAt: data.lastHeartbeatAt,
      metadata: data.metadata ?? {},
      title: data.title,
      icon: data.icon,
      imageUrl: data.imageUrl,
      reportsTo: data.reportsTo,
      runtimeConfig: data.runtimeConfig,
      pauseReason: data.pauseReason,
      permissions: normalizeStoredPermissions(data.permissions),
      permissionPolicy: data.permissionPolicy ? normalizeAgentPermissionPolicy(data.permissionPolicy) : undefined,
      totalInputTokens: data.totalInputTokens,
      totalOutputTokens: data.totalOutputTokens,
      lastError: data.lastError,
      instructionsPath: data.instructionsPath,
      instructionsText: data.instructionsText,
      soul: data.soul,
      memory: data.memory,
      bundleConfig: data.bundleConfig,
      heartbeatProcedurePath: data.heartbeatProcedurePath,
    };
  }

  private async writeAgent(agent: Agent, executor?: QueryHandle): Promise<void> {
    // FNXC:SqliteFinalRemoval 2026-06-25-23:40:
    // Backend mode: delegate to async Drizzle writeAgent helper.
        await writeAgentAsync(executor ?? this.asyncLayer!.db, agent, this.asyncLayer!.projectId);
    return;
}

  /**
   * FN-7723: build the change-detection snapshot for an agent.
   *
   * Deliberately does NOT key equality on `updatedAt` alone: `updatedAt` is a
   * millisecond-resolution ISO string, and two writes issued in quick
   * succession (e.g. `createAgent()` immediately followed by
   * `updateAgentState()` in a test, or two rapid CLI mutations) can land in
   * the SAME millisecond, producing an identical `updatedAt` even though
   * `state` genuinely changed. Comparing `state` explicitly (in addition to
   * `updatedAt`, which still catches non-state metadata churn) closes that
   * race so a stop/start transition is never silently missed.
   */
  private watchSnapshotOf(agent: Agent): { state: AgentState; updatedAt: string } {
    return { state: agent.state, updatedAt: agent.updatedAt };
  }

  // ── Cross-process change detection (FN-7723) ────────────────────────────────────

  /**
   * Whether this store is actively watching for cross-process changes
   * (fs.watch and/or poll fallback registered).
   */
  isWatching(): boolean {
    return this.watchPoll.isWatching();
  }

  /**
   * Start opt-in cross-process change detection.
   *
   * Only the long-lived engine `AgentStore` instance should call this (see
   * packages/engine/src/runtimes/in-process-runtime.ts). The CLI's
   * short-lived `AgentStore` (packages/cli/src/commands/agent.ts) and
   * per-request dashboard stores must NOT call this — they mutate and exit
   * (or are ephemeral) so there is nothing for them to watch.
   *
   * Mirrors TaskStore.watch(): a sentinel `fs.watch` on the rootDir for a
   * fast-path nudge (fail-soft if unavailable), plus an always-on poll
   * fallback gated by `db.getLastModified()` so a no-op tick is one cheap
   * `__meta` read.
   */
  async startWatching(pollIntervalMs = 2000): Promise<void> {
    if (this.watchPoll.isWatching()) return; // already watching

    const agents = await this.listAgents({ includeEphemeral: true });
    this.agentSnapshotCache.clear();
    for (const agent of agents) {
      this.agentSnapshotCache.set(agent.id, this.watchSnapshotOf(agent));
    }
    /*
    FNXC:PostgresCutover 2026-07-10 (fork review): db.getLastModified() is the
    sqlite __meta counter and throws in backend mode — startWatching previously
    logged "SQLite Database is not available in backend mode" at startup and
    fell back to the 60s audit sweep. In backend mode there is no cheap
    cross-process modified counter, so the gate is disabled and every poll tick
    runs the (already bounded) listAgents diff directly.
    */
    this.lastKnownModified = this.backendMode ? 0 : this.db.getLastModified();

    this.watchPoll.start({
      dir: this.rootDir,
      pollIntervalMs,
      onPoll: () => this.checkForChanges(),
      log: agentStoreLog,
      errorContext: { rootDir: this.rootDir },
    });
  }

  /**
   * Diff current agent rows against the last-seen snapshot and re-emit the
   * EXISTING `agent:updated`/`agent:stateChanged` events for any agent whose
   * `state` or `updatedAt` advanced since this instance last observed it.
   * Gated by `db.getLastModified()` so an unchanged DB costs one `__meta`
   * SELECT. Compares `state` explicitly (not just `updatedAt`) so a genuine
   * transition is never masked by an `updatedAt` millisecond collision
   * between two rapid writes (see `watchSnapshotOf()`).
   *
   * Exposed (not private) so tests can drive a poll cycle directly instead
   * of waiting on the real setInterval, per docs/testing.md's "no real
   * polling waits" rule — mirrors TaskStore's own testable checkForChanges().
   */
  async checkForChanges(): Promise<void> {
    if (this.pollingInProgress) return;
    this.pollingInProgress = true;
    try {
      

      const agents = await this.listAgents({ includeEphemeral: true });
      const seenIds = new Set<string>();
      for (const agent of agents) {
        seenIds.add(agent.id);
        const cached = this.agentSnapshotCache.get(agent.id);
        if (!cached) {
          // A brand-new agent row this instance has never seen. createAgent()
          // already emits agent:created in-process; a cross-process create is
          // out of scope for this task (agents are created via the dashboard/
          // CLI in the same flow that would also emit agent:created there).
          // Just seed the cache so future updates to it diff correctly.
          this.agentSnapshotCache.set(agent.id, this.watchSnapshotOf(agent));
          continue;
        }
        const stateChanged = cached.state !== agent.state;
        const updatedAtChanged = cached.updatedAt !== agent.updatedAt;
        if (!stateChanged && !updatedAtChanged) continue;

        const previousState = cached.state;
        this.agentSnapshotCache.set(agent.id, this.watchSnapshotOf(agent));

        if (stateChanged) {
          this.emit("agent:stateChanged", agent.id, previousState, agent.state);
          /*
          FNXC:AgentActivityStream 2026-08-14-19:18:
          FN-9041 keeps cross-process reconciliation on the roster/live state channel rather than
          writing state churn to the durable work-activity outbox. Cache updates and both emitted
          events remain intact so separate-process state observers still receive this transition.
          */
          this.emit("agent:updated", agent, previousState);
        } else {
          this.emit("agent:updated", agent);
        }
      }

      // Prune cache entries for agents deleted by another process. deleteAgent()
      // already emits agent:deleted in-process for the originating instance;
      // cross-process delete detection is not required by this task's scope
      // (delete is a rare, operator-driven action, unlike stop/start), so we
      // just keep the cache from growing unbounded.
      for (const id of this.agentSnapshotCache.keys()) {
        if (!seenIds.has(id)) this.agentSnapshotCache.delete(id);
      }
    } catch (err) {
      agentStoreLog.warn("checkForChanges poll cycle failed", {
        lastKnownModified: this.lastKnownModified,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.pollingInProgress = false;
    }
  }

  /**
   * Stop cross-process change detection and clear all handles.
   */
  stopWatching(): void {
    this.watchPoll.stop();
    this.agentSnapshotCache.clear();
  }

  /**
   * Close the underlying SQLite connection and release resources.
   */
  close(): void {
    this.stopWatching();

    if (!this._db) {
      return;
    }

    if (agentStoreDbCache.get(this.rootDir) === this._db) {
      agentStoreDbCache.delete(this.rootDir);
    }

    try {
      this._db.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("database is not open")) {
        throw error;
      }
    } finally {
      this._db = null;
    }
  }

  private async withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    // Get or create lock for this agent
    let lock = this.locks.get(agentId);
    if (!lock) {
      lock = { promise: Promise.resolve() };
      this.locks.set(agentId, lock);
    }

    // Chain operations
    const operation = lock.promise.then(fn, fn);
    lock.promise = operation;

    return operation as Promise<T>;
  }
}
