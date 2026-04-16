/**
 * AgentStore - Filesystem-based persistence for agent lifecycle management
 * 
 * Agents are stored at `.fusion/agents/{agentId}.json` with their metadata.
 * Heartbeat events are appended to `.fusion/agents/{agentId}-heartbeats.jsonl`.
 * API keys are stored in `.fusion/agents/{agentId}-keys.jsonl` (hash-only).
 * Config revisions are stored in `.fusion/agents/{agentId}-revisions.jsonl` (append-only snapshots).
 * 
 * File Structure:
 * - agents/{agentId}.json: Agent metadata (id, name, role, state, taskId, timestamps, metadata)
 * - agents/{agentId}-heartbeats.jsonl: Append-only heartbeat events
 * - agents/{agentId}-keys.jsonl: API key records with SHA-256 token hashes
 * - agents/{agentId}-revisions.jsonl: Config revision history
 */

import { mkdir, readFile, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  OrgTreeNode,
  InstructionsBundleConfig,
  AgentRating,
  AgentRatingSummary,
  AgentRatingInput,
  Task,
} from "./types.js";
import { AGENT_VALID_TRANSITIONS, agentToConfigSnapshot, diffConfigSnapshots, CheckoutConflictError } from "./types.js";
import type { RunMutationContext } from "./types.js";
import type { TaskStore } from "./store.js";
import { computeAccessState } from "./agent-permissions.js";
import { Database } from "./db.js";

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
}

type TypedEventEmitter<Events extends Record<string, unknown[]>> = {
  [K in keyof Events]: {
    emit(event: K, ...args: Events[K]): boolean;
    on(event: K, listener: (...args: Events[K]) => void): TypedEventEmitter<Events>;
    once(event: K, listener: (...args: Events[K]) => void): TypedEventEmitter<Events>;
    off(event: K, listener: (...args: Events[K]) => void): TypedEventEmitter<Events>;
  };
}[keyof Events] & EventEmitter;

/** Options for AgentStore constructor */
export interface AgentStoreOptions {
  /** Root directory for kb data (default: .fusion) */
  rootDir?: string;
  /** Optional TaskStore for checkout/release operations */
  taskStore?: TaskStore;
}

/** Agent data as stored on disk */
interface AgentData {
  id: string;
  name: string;
  role: AgentCapability;
  state: AgentState;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt?: string;
  metadata: Record<string, unknown>;
  title?: string;
  icon?: string;
  reportsTo?: string;
  runtimeConfig?: Record<string, unknown>;
  pauseReason?: string;
  permissions?: Record<string, boolean>;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  lastError?: string;
  instructionsPath?: string;
  instructionsText?: string;
  soul?: string;
  memory?: string;
  bundleConfig?: InstructionsBundleConfig;
}
interface AgentLock {
  promise: Promise<unknown>;
}

/**
 * AgentStore manages agent lifecycle with filesystem-based persistence.
 * Follows the same patterns as TaskStore for consistency.
 */
export class AgentStore extends EventEmitter {
  private rootDir: string;
  private agentsDir: string;
  private locks: Map<string, AgentLock> = new Map();
  private _db: Database | null = null;
  private taskStore?: TaskStore;

  constructor(options: AgentStoreOptions = {}) {
    super();
    this.rootDir = options.rootDir ?? ".fusion";
    this.agentsDir = join(this.rootDir, "agents");
    this.taskStore = options.taskStore;
  }

  private get db(): Database {
    if (!this._db) {
      this._db = new Database(this.rootDir);
      this._db.init();
    }
    return this._db;
  }

  /**
   * Initialize the store by creating necessary directories.
   * Should be called before other operations.
   */
  async init(): Promise<void> {
    const _ = this.db;
    await mkdir(this.agentsDir, { recursive: true });
  }

  /**
   * Create a new agent with "idle" state.
   * @param input - Creation parameters
   * @returns The created agent
   * @throws Error if input is invalid
   */
  async createAgent(input: AgentCreateInput): Promise<Agent> {
    if (!input.name?.trim()) {
      throw new Error("Agent name is required");
    }
    if (!input.role) {
      throw new Error("Agent role is required");
    }

    const now = new Date().toISOString();
    const agentId = `agent-${randomUUID().slice(0, 8)}`;

    const agent: Agent = {
      id: agentId,
      name: input.name.trim(),
      role: input.role,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
      ...(input.title && { title: input.title }),
      ...(input.icon && { icon: input.icon }),
      ...(input.reportsTo && { reportsTo: input.reportsTo }),
      ...(input.runtimeConfig && { runtimeConfig: input.runtimeConfig }),
      ...(input.permissions && { permissions: input.permissions }),
      ...(input.instructionsPath && { instructionsPath: input.instructionsPath }),
      ...(input.instructionsText && { instructionsText: input.instructionsText }),
      ...(input.soul && { soul: input.soul }),
      ...(input.memory && { memory: input.memory }),
      ...(input.bundleConfig && { bundleConfig: input.bundleConfig }),
    };

    await this.writeAgent(agent);
    this.emit("agent:created", agent);

    return agent;
  }

  /**
   * Get an agent by ID.
   * @param agentId - The agent ID
   * @returns The agent, or null if not found
   */
  async getAgent(agentId: string): Promise<Agent | null> {
    try {
      const data = await this.readAgentFile(agentId);
      return this.parseAgent(data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
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

  private mapRatingRow(row: any): AgentRating {
    return {
      id: row.id,
      agentId: row.agentId,
      raterType: row.raterType,
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

    this.db.prepare(`
      INSERT INTO agentRatings (id, agentId, raterType, raterId, score, category, comment, runId, taskId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rating.id,
      rating.agentId,
      rating.raterType,
      rating.raterId ?? null,
      rating.score,
      rating.category ?? null,
      rating.comment ?? null,
      rating.runId ?? null,
      rating.taskId ?? null,
      rating.createdAt,
    );

    this.db.bumpLastModified();
    this.emit("rating:added", rating);

    return rating;
  }

  async getRatings(agentId: string, options?: { limit?: number; category?: string }): Promise<AgentRating[]> {
    const params: Array<string | number> = [agentId];
    let query = "SELECT * FROM agentRatings WHERE agentId = ?";

    if (options?.category !== undefined) {
      query += " AND category = ?";
      params.push(options.category);
    }

    query += " ORDER BY createdAt DESC";

    if (options?.limit !== undefined) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(query).all(...params);
    return rows.map((row) => this.mapRatingRow(row));
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
    this.db.prepare("DELETE FROM agentRatings WHERE id = ?").run(ratingId);
    this.db.bumpLastModified();
  }

  /**
   * Get the managed instructions directory path for an agent.
   * Does not create the directory.
   */
  getInstructionsDir(agentId: string): string {
    return this.getBundleDir(agentId);
  }

  /**
   * List markdown files in an agent's managed instructions bundle.
   * Returns [] when the bundle directory does not exist.
   */
  async listBundleFiles(agentId: string): Promise<string[]> {
    const bundleDir = this.getBundleDir(agentId);

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
    const resolvedPath = join(this.getBundleDir(agentId), filePath);
    return readFile(resolvedPath, "utf-8");
  }

  /**
   * Write a markdown file to an agent's managed instructions bundle.
   */
  async writeBundleFile(agentId: string, filePath: string, content: string): Promise<void> {
    return this.withLock(agentId, async () => {
      this.validateBundleFilePath(filePath);

      const bundleDir = this.getBundleDir(agentId);
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
      await unlink(join(this.getBundleDir(agentId), filePath));
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
      await mkdir(this.getBundleDir(agentId), { recursive: true });
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

    await mkdir(this.getBundleDir(agentId), { recursive: true });

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

      const updated: Agent = {
        ...agent,
        name: nextName ?? agent.name,
        role: updates.role ?? agent.role,
        metadata: updates.metadata !== undefined ? updates.metadata : agent.metadata,
        updatedAt,
        ...("title" in updates && { title: updates.title }),
        ...("icon" in updates && { icon: updates.icon }),
        ...("reportsTo" in updates && { reportsTo: updates.reportsTo }),
        ...("runtimeConfig" in updates && { runtimeConfig: updates.runtimeConfig }),
        ...("pauseReason" in updates && { pauseReason: updates.pauseReason }),
        ...("permissions" in updates && { permissions: updates.permissions }),
        ...("lastError" in updates && { lastError: updates.lastError }),
        ...("totalInputTokens" in updates && { totalInputTokens: updates.totalInputTokens }),
        ...("totalOutputTokens" in updates && { totalOutputTokens: updates.totalOutputTokens }),
        ...("instructionsPath" in updates && { instructionsPath: updates.instructionsPath }),
        ...("instructionsText" in updates && { instructionsText: updates.instructionsText }),
        ...(updates.soul !== undefined && { soul: updates.soul }),
        ...(updates.memory !== undefined && { memory: updates.memory }),
        ...("bundleConfig" in updates && { bundleConfig: updates.bundleConfig }),
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

      const updated: Agent = {
        ...agent,
        state: newState,
        updatedAt: new Date().toISOString(),
        // Clear lastError when transitioning away from terminated
        ...(currentState === "terminated" && newState !== "terminated" && { lastError: undefined }),
      };

      await this.writeAgent(updated);
      this.emit("agent:stateChanged", agentId, currentState, newState);
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

      // Emit agent:assigned only when assigning a task (not when clearing)
      if (taskId !== undefined) {
        this.emit("agent:assigned", updated, taskId);
      }

      // Log the assignment to the task when a non-empty taskId is provided
      if (taskId && this.taskStore) {
        await this.taskStore.logEntry(taskId, `Task assigned to agent ${agentId}`, undefined, runContext);
      }

      return updated;
    });
  }

  /**
   * Acquire a checkout lease for a task.
   * Throws CheckoutConflictError when another agent already holds the lease.
   */
  async checkoutTask(agentId: string, taskId: string, runContext?: RunMutationContext): Promise<Task> {
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

    if (task.checkedOutBy === agentId) {
      return task;
    }

    const updated = await this.taskStore.updateTask(taskId, { checkedOutBy: agentId });
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

    const updated = await this.taskStore.updateTask(taskId, { checkedOutBy: null });
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

    const updated = await this.taskStore.updateTask(taskId, { checkedOutBy: null });
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

    // Normalize to terminated first when idle is not directly reachable.
    if (agent.state !== "idle" && agent.state !== "terminated") {
      agent = await this.updateAgentState(agentId, "terminated");
    }

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
   * Check if an agent is a system-generated ephemeral agent (task-worker or spawned child).
   * These agents are created at runtime by the engine and should typically be hidden
   * from the default agents page view.
   */
  private isSystemAgent(agent: Agent): boolean {
    const metadata = agent.metadata ?? {};
    return (
      metadata.agentKind === "task-worker" ||
      metadata.type === "spawned" ||
      metadata.taskWorker === true ||
      metadata.managedBy === "task-executor"
    );
  }

  /**
   * List all agents, optionally filtered by state.
   * @param filter - Optional filter criteria
   * @returns Array of agents
   */
  async listAgents(filter?: { state?: AgentState; role?: AgentCapability; includeSystem?: boolean }): Promise<Agent[]> {
    const files = await readdir(this.agentsDir).catch(() => [] as string[]);
    const agentFiles = files.filter((f) => f.endsWith(".json") && !f.includes("-heartbeats") && !f.includes("-sessions") && !f.includes("-runs") && !f.includes("-revisions"));

    const agents: Agent[] = [];
    for (const file of agentFiles) {
      try {
        const data = await this.readAgentFile(file.replace(".json", ""));
        const agent = this.parseAgent(data);

        // Apply filters
        if (filter?.state && agent.state !== filter.state) continue;
        if (filter?.role && agent.role !== filter.role) continue;

        // When includeSystem is explicitly false, filter out system agents
        if (filter?.includeSystem === false && this.isSystemAgent(agent)) continue;

        agents.push(agent);
      } catch {
        // Skip corrupted files
      }
    }

    // Sort by createdAt desc
    return agents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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

      const keyPath = this.getApiKeysPath(agentId);
      await writeFile(keyPath, `${JSON.stringify(key)}\n`, { flag: "a" });

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

      keys[keyIndex] = revoked;
      await this.writeApiKeys(agentId, keys);

      return revoked;
    });
  }

  /**
   * Delete an agent and its heartbeat history.
   * @param agentId - The agent ID
   * @throws Error if agent not found
   */
  async deleteAgent(agentId: string): Promise<void> {
    await this.withLock(agentId, async () => {
      const agentPath = join(this.agentsDir, `${agentId}.json`);
      const heartbeatPath = join(this.agentsDir, `${agentId}-heartbeats.jsonl`);
      const revisionsPath = this.getConfigRevisionsPath(agentId);
      const blockedStatePath = this.getLastBlockedStatePath(agentId);

      // Verify agent exists
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      // Delete files
      await unlink(agentPath).catch(() => {});
      await unlink(heartbeatPath).catch(() => {});
      await unlink(revisionsPath).catch(() => {});
      await unlink(blockedStatePath).catch(() => {});

      // Clean up sessions and runs directories
      const { rm } = await import("node:fs/promises");
      const sessionsDir = join(this.agentsDir, `${agentId}-sessions`);
      const runsDir = join(this.agentsDir, `${agentId}-runs`);
      await rm(sessionsDir, { recursive: true, force: true }).catch(() => {});
      await rm(runsDir, { recursive: true, force: true }).catch(() => {});

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

      // Append to heartbeat log
      const heartbeatPath = join(this.agentsDir, `${agentId}-heartbeats.jsonl`);
      const line = JSON.stringify(event) + "\n";
      await writeFile(heartbeatPath, line, { flag: "a" });

      // Update agent's lastHeartbeatAt if status is ok
      if (status === "ok") {
        const updated: Agent = {
          ...agent,
          lastHeartbeatAt: event.timestamp,
          updatedAt: event.timestamp,
        };
        await this.writeAgent(updated);
      }

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
    const heartbeatPath = join(this.agentsDir, `${agentId}-heartbeats.jsonl`);

    if (!existsSync(heartbeatPath)) {
      return [];
    }

    try {
      const content = await readFile(heartbeatPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      // Parse events and reverse (newest first)
      const events: AgentHeartbeatEvent[] = lines
        .map((line) => JSON.parse(line) as AgentHeartbeatEvent)
        .reverse()
        .slice(0, limit);

      return events;
    } catch {
      return [];
    }
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

    // Also record as heartbeat event for legacy compatibility
    await this.recordHeartbeat(agentId, "ok", runId);

    return run;
  }

  /**
   * End a heartbeat run.
   * Updates the persisted run's terminal state in structured storage.
   * Also records a heartbeat event for legacy compatibility.
   * @param runId - The run ID
   * @param status - End status (completed or terminated)
   */
  async endHeartbeatRun(runId: string, status: "completed" | "terminated"): Promise<void> {
    const now = new Date().toISOString();

    // Find the agent for this run by scanning heartbeat files
    const files = await readdir(this.agentsDir).catch(() => [] as string[]);
    const heartbeatFiles = files.filter((f) => f.endsWith("-heartbeats.jsonl"));

    for (const file of heartbeatFiles) {
      const agentId = file.replace("-heartbeats.jsonl", "");
      const history = await this.getHeartbeatHistory(agentId, 1000);

      // Check if this run exists in the history
      const hasRun = history.some((h) => h.runId === runId);
      if (hasRun) {
        // Try to update the persisted run with terminal state
        const existingRun = await this.getRunDetail(agentId, runId);
        if (existingRun) {
          // Update the persisted run in structured storage
          const updatedRun: AgentHeartbeatRun = {
            ...existingRun,
            endedAt: now,
            status,
          };
          await this.saveRun(updatedRun);
        }

        // Also record heartbeat event for legacy compatibility
        await this.recordHeartbeat(agentId, status === "terminated" ? "missed" : "ok", runId);
        return;
      }
    }
  }

  /**
   * Get the active heartbeat run for an agent.
   * Reads from structured run storage first (source of truth),
   * falls back to heartbeat event reconstruction for legacy data.
   * @param agentId - The agent ID
   * @returns The active run, or null if none
   */
  async getActiveHeartbeatRun(agentId: string): Promise<AgentHeartbeatRun | null> {
    // First check structured run storage (source of truth)
    const recentRuns = await this.getRecentRuns(agentId, 50);

    // If we have structured run data, use it exclusively
    if (recentRuns.length > 0) {
      for (const run of recentRuns) {
        if (run.status === "active") {
          return run;
        }
      }
      // We have structured data but no active runs - don't fall back
      return null;
    }

    // Fallback: reconstruct from heartbeat events for legacy data
    // This handles runs created before structured storage was used
    const history = await this.getHeartbeatHistory(agentId, 100);

    // Find the most recent run that started but hasn't ended
    // A run is considered ended if there's a terminal state transition
    const runs = new Map<string, AgentHeartbeatRun>();

    for (const event of history) {
      if (!runs.has(event.runId)) {
        runs.set(event.runId, {
          id: event.runId,
          agentId,
          startedAt: event.timestamp,
          endedAt: null,
          status: "active",
        });
      }

      // Update based on event status
      const run = runs.get(event.runId)!;
      if (event.status === "missed") {
        run.endedAt = event.timestamp;
        run.status = "terminated";
      }
    }

    // Return the most recent active run
    for (const run of runs.values()) {
      if (run.status === "active") {
        return run;
      }
    }

    return null;
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
    // First check structured run storage (source of truth)
    const recentRuns = await this.getRecentRuns(agentId, 50);

    // If we have structured run data, use it exclusively
    if (recentRuns.length > 0) {
      return recentRuns
        .filter((run) => run.status !== "active")
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    }

    // Fallback: reconstruct from heartbeat events for legacy data
    const history = await this.getHeartbeatHistory(agentId, 1000);
    const runs = new Map<string, AgentHeartbeatRun>();

    for (const event of history) {
      if (!runs.has(event.runId)) {
        runs.set(event.runId, {
          id: event.runId,
          agentId,
          startedAt: event.timestamp,
          endedAt: null,
          status: "active",
        });
      }

      const run = runs.get(event.runId)!;
      if (event.status === "missed") {
        run.endedAt = event.timestamp;
        run.status = "terminated";
      }
    }

    return Array.from(runs.values())
      .filter((r) => r.status !== "active")
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
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
    const sessionsDir = join(this.agentsDir, `${agentId}-sessions`);
    const sessionPath = join(sessionsDir, `${taskId}.json`);

    try {
      const content = await readFile(sessionPath, "utf-8");
      return JSON.parse(content) as AgentTaskSession;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Create or update a task session for an agent.
   * @param session - The session data
   * @returns The saved session
   */
  async upsertTaskSession(session: AgentTaskSession): Promise<AgentTaskSession> {
    const sessionsDir = join(this.agentsDir, `${session.agentId}-sessions`);
    await mkdir(sessionsDir, { recursive: true });

    const now = new Date().toISOString();
    const existing = await this.getTaskSession(session.agentId, session.taskId);

    const saved: AgentTaskSession = {
      ...session,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const sessionPath = join(sessionsDir, `${session.taskId}.json`);
    await writeFile(sessionPath, JSON.stringify(saved, null, 2));

    return saved;
  }

  /**
   * Delete a task session.
   * @param agentId - The agent ID
   * @param taskId - The task ID
   */
  async deleteTaskSession(agentId: string, taskId: string): Promise<void> {
    const sessionPath = join(this.agentsDir, `${agentId}-sessions`, `${taskId}.json`);
    await unlink(sessionPath).catch(() => {});
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
  async getOrgTree(filter?: { includeSystem?: boolean }): Promise<OrgTreeNode[]> {
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
    const runsDir = join(this.agentsDir, `${run.agentId}-runs`);
    await mkdir(runsDir, { recursive: true });
    const runPath = join(runsDir, `${run.id}.json`);
    await writeFile(runPath, JSON.stringify(run, null, 2));
  }

  /**
   * Get a specific run by ID.
   * @param agentId - The agent ID
   * @param runId - The run ID
   * @returns The run detail, or null if not found
   */
  async getRunDetail(agentId: string, runId: string): Promise<AgentHeartbeatRun | null> {
    const runPath = join(this.agentsDir, `${agentId}-runs`, `${runId}.json`);
    try {
      const content = await readFile(runPath, "utf-8");
      return JSON.parse(content) as AgentHeartbeatRun;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Get recent runs for an agent from structured run storage.
   * @param agentId - The agent ID
   * @param limit - Max number of runs to return (default: 20)
   * @returns Array of runs (newest first)
   */
  async getRecentRuns(agentId: string, limit = 20): Promise<AgentHeartbeatRun[]> {
    const runsDir = join(this.agentsDir, `${agentId}-runs`);
    let files: string[];
    try {
      files = await readdir(runsDir);
    } catch {
      return [];
    }

    const runFiles = files.filter((f) => f.endsWith(".json"));
    const runs: AgentHeartbeatRun[] = [];

    for (const file of runFiles) {
      try {
        const content = await readFile(join(runsDir, file), "utf-8");
        runs.push(JSON.parse(content) as AgentHeartbeatRun);
      } catch {
        // Skip corrupted files
      }
    }

    // Sort by startedAt desc and limit
    return runs
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit);
  }

  /**
   * Get the most recently persisted blocked-task dedup state for an agent.
   */
  async getLastBlockedState(agentId: string): Promise<BlockedStateSnapshot | null> {
    const blockedStatePath = this.getLastBlockedStatePath(agentId);
    try {
      const content = await readFile(blockedStatePath, "utf-8");
      return JSON.parse(content) as BlockedStateSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Persist the latest blocked-task dedup state for an agent.
   */
  async setLastBlockedState(agentId: string, state: BlockedStateSnapshot): Promise<void> {
    await this.withLock(agentId, async () => {
      const blockedStatePath = this.getLastBlockedStatePath(agentId);
      await writeFile(blockedStatePath, JSON.stringify(state, null, 2));
    });
  }

  /**
   * Clear any persisted blocked-task dedup state for an agent.
   */
  async clearLastBlockedState(agentId: string): Promise<void> {
    await this.withLock(agentId, async () => {
      await unlink(this.getLastBlockedStatePath(agentId)).catch(() => {});
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getConfigRevisionsPath(agentId: string): string {
    return join(this.agentsDir, `${agentId}-revisions.jsonl`);
  }

  private async appendConfigRevision(revision: AgentConfigRevision): Promise<void> {
    const revisionsPath = this.getConfigRevisionsPath(revision.agentId);
    await writeFile(revisionsPath, `${JSON.stringify(revision)}\n`, { flag: "a" });
  }

  private async readConfigRevisions(agentId: string): Promise<AgentConfigRevision[]> {
    const revisionsPath = this.getConfigRevisionsPath(agentId);
    if (!existsSync(revisionsPath)) {
      return [];
    }

    try {
      const content = await readFile(revisionsPath, "utf-8");
      if (!content.trim()) {
        return [];
      }

      const revisions: AgentConfigRevision[] = [];
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const revision = JSON.parse(line) as AgentConfigRevision;
          if (revision.agentId === agentId) {
            revisions.push(revision);
          }
        } catch {
          // Skip malformed lines
        }
      }

      return revisions;
    } catch {
      return [];
    }
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
    | "reportsTo"
    | "runtimeConfig"
    | "permissions"
    | "instructionsPath"
    | "instructionsText"
    | "soul"
    | "memory"
    | "bundleConfig"
    | "metadata"
  > {
    return {
      name: snapshot.name,
      role: snapshot.role,
      title: snapshot.title,
      icon: snapshot.icon,
      reportsTo: snapshot.reportsTo,
      runtimeConfig: snapshot.runtimeConfig ? { ...snapshot.runtimeConfig } : undefined,
      permissions: snapshot.permissions ? { ...snapshot.permissions } : undefined,
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
      metadata: { ...snapshot.metadata },
    };
  }

  private async findConfigRevisionAcrossAgents(revisionId: string): Promise<AgentConfigRevision | null> {
    const files = await readdir(this.agentsDir).catch(() => [] as string[]);
    const revisionFiles = files.filter((file) => file.endsWith("-revisions.jsonl"));

    for (const file of revisionFiles) {
      const agentId = file.replace(/-revisions\.jsonl$/, "");
      const revisions = await this.readConfigRevisions(agentId);
      const match = revisions.find((revision) => revision.id === revisionId);
      if (match) {
        return match;
      }
    }

    return null;
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

  private getBundleDir(agentId: string): string {
    return join(this.agentsDir, `${agentId}-instructions`);
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

  private getApiKeysPath(agentId: string): string {
    return join(this.agentsDir, `${agentId}-keys.jsonl`);
  }

  private getLastBlockedStatePath(agentId: string): string {
    return join(this.agentsDir, `${agentId}-last-blocked.json`);
  }

  private async readApiKeys(agentId: string): Promise<AgentApiKey[]> {
    const keyPath = this.getApiKeysPath(agentId);
    if (!existsSync(keyPath)) {
      return [];
    }

    const content = await readFile(keyPath, "utf-8");
    if (!content.trim()) {
      return [];
    }

    const keys: AgentApiKey[] = [];
    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const key = JSON.parse(line) as AgentApiKey;
        if (key.agentId === agentId) {
          keys.push(key);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return keys;
  }

  private async writeApiKeys(agentId: string, keys: AgentApiKey[]): Promise<void> {
    const keyPath = this.getApiKeysPath(agentId);
    const content = keys.map((key) => JSON.stringify(key)).join("\n");
    await writeFile(keyPath, content ? `${content}\n` : "");
  }

  private async readAgentFile(agentId: string): Promise<AgentData> {
    const path = join(this.agentsDir, `${agentId}.json`);
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as AgentData;
  }

  /**
   * Synchronously read an agent from disk (for use in synchronous hot paths).
   * Returns null if the agent file does not exist or cannot be parsed.
   * @param agentId - The agent ID
   */
  getCachedAgent(agentId: string): Agent | null {
    try {
      const path = join(this.agentsDir, `${agentId}.json`);
      const content = readFileSync(path, "utf-8");
      return this.parseAgent(JSON.parse(content) as AgentData);
    } catch {
      return null;
    }
  }

  private parseAgent(data: AgentData): Agent {
    return {
      id: data.id,
      name: data.name,
      role: data.role,
      state: data.state,
      taskId: data.taskId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      lastHeartbeatAt: data.lastHeartbeatAt,
      metadata: data.metadata ?? {},
      title: data.title,
      icon: data.icon,
      reportsTo: data.reportsTo,
      runtimeConfig: data.runtimeConfig,
      pauseReason: data.pauseReason,
      permissions: data.permissions,
      totalInputTokens: data.totalInputTokens,
      totalOutputTokens: data.totalOutputTokens,
      lastError: data.lastError,
      instructionsPath: data.instructionsPath,
      instructionsText: data.instructionsText,
      soul: data.soul,
      memory: data.memory,
      bundleConfig: data.bundleConfig,
    };
  }

  private async writeAgent(agent: Agent): Promise<void> {
    const path = join(this.agentsDir, `${agent.id}.json`);
    const data: AgentData = {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      state: agent.state,
      taskId: agent.taskId,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      metadata: agent.metadata,
      title: agent.title,
      icon: agent.icon,
      reportsTo: agent.reportsTo,
      runtimeConfig: agent.runtimeConfig,
      pauseReason: agent.pauseReason,
      permissions: agent.permissions,
      totalInputTokens: agent.totalInputTokens,
      totalOutputTokens: agent.totalOutputTokens,
      lastError: agent.lastError,
      instructionsPath: agent.instructionsPath,
      instructionsText: agent.instructionsText,
      soul: agent.soul,
      memory: agent.memory,
      bundleConfig: agent.bundleConfig,
    };

    // Write atomically using temp file
    const tempPath = `${path}.tmp.${Date.now()}`;
    await writeFile(tempPath, JSON.stringify(data, null, 2));

    // Rename temp file to final path (atomic on most filesystems)
    await rename(tempPath, path);
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