/**
 * AgentStore - Filesystem-based persistence for agent lifecycle management
 * 
 * Agents are stored at `.fusion/agents/{agentId}.json` with their metadata.
 * Heartbeat events are appended to `.fusion/agents/{agentId}-heartbeats.jsonl`.
 * 
 * File Structure:
 * - agents/{agentId}.json: Agent metadata (id, name, role, state, taskId, timestamps, metadata)
 * - agents/{agentId}-heartbeats.jsonl: Append-only heartbeat events
 */

import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Agent,
  AgentState,
  AgentCapability,
  AgentCreateInput,
  AgentUpdateInput,
  AgentHeartbeatEvent,
  AgentHeartbeatRun,
  AgentDetail,
  AgentTaskSession,
} from "./types.js";
import { AGENT_VALID_TRANSITIONS } from "./types.js";

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
}

/** Per-agent write lock for serialization */
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

  constructor(options: AgentStoreOptions = {}) {
    super();
    this.rootDir = options.rootDir ?? ".fusion";
    this.agentsDir = join(this.rootDir, "agents");
  }

  /**
   * Initialize the store by creating necessary directories.
   * Should be called before other operations.
   */
  async init(): Promise<void> {
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

      const updated: Agent = {
        ...agent,
        name: updates.name?.trim() ?? agent.name,
        role: updates.role ?? agent.role,
        metadata: updates.metadata !== undefined ? updates.metadata : agent.metadata,
        updatedAt: new Date().toISOString(),
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.icon !== undefined && { icon: updates.icon }),
        ...(updates.reportsTo !== undefined && { reportsTo: updates.reportsTo }),
        ...(updates.runtimeConfig !== undefined && { runtimeConfig: updates.runtimeConfig }),
        ...(updates.pauseReason !== undefined && { pauseReason: updates.pauseReason }),
        ...(updates.permissions !== undefined && { permissions: updates.permissions }),
        ...(updates.lastError !== undefined && { lastError: updates.lastError }),
        ...(updates.totalInputTokens !== undefined && { totalInputTokens: updates.totalInputTokens }),
        ...(updates.totalOutputTokens !== undefined && { totalOutputTokens: updates.totalOutputTokens }),
      };

      await this.writeAgent(updated);
      this.emit("agent:updated", updated);

      return updated;
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

      if (currentState === "terminated") {
        throw new Error(`Cannot transition from terminated state to ${newState}`);
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
      };

      await this.writeAgent(updated);
      this.emit("agent:stateChanged", agentId, currentState, newState);
      this.emit("agent:updated", updated, currentState);

      // Handle heartbeat run lifecycle
      if (newState === "active" && !agent.lastHeartbeatAt) {
        // Starting first activity - start a heartbeat run
        await this.startHeartbeatRun(agentId);
      } else if (newState === "terminated") {
        // End the active run if any
        const activeRun = await this.getActiveHeartbeatRun(agentId);
        if (activeRun) {
          await this.endHeartbeatRun(activeRun.id, "terminated");
        }
      }

      return updated;
    });
  }

  /**
   * Assign a task to an agent.
   * @param agentId - The agent ID
   * @param taskId - The task ID to assign, or undefined to unassign
   * @returns The updated agent
   */
  async assignTask(agentId: string, taskId: string | undefined): Promise<Agent> {
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
   * List all agents, optionally filtered by state.
   * @param filter - Optional filter criteria
   * @returns Array of agents
   */
  async listAgents(filter?: { state?: AgentState; role?: AgentCapability }): Promise<Agent[]> {
    const files = await readdir(this.agentsDir).catch(() => [] as string[]);
    const agentFiles = files.filter((f) => f.endsWith(".json") && !f.includes("-heartbeats") && !f.includes("-sessions") && !f.includes("-runs"));

    const agents: Agent[] = [];
    for (const file of agentFiles) {
      try {
        const data = await this.readAgentFile(file.replace(".json", ""));
        const agent = this.parseAgent(data);

        // Apply filters
        if (filter?.state && agent.state !== filter.state) continue;
        if (filter?.role && agent.role !== filter.role) continue;

        agents.push(agent);
      } catch {
        // Skip corrupted files
      }
    }

    // Sort by createdAt desc
    return agents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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

      // Verify agent exists
      const agent = await this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      // Delete files
      await unlink(agentPath).catch(() => {});
      await unlink(heartbeatPath).catch(() => {});

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
   * @param agentId - The agent ID
   * @returns The created run
   */
  async startHeartbeatRun(agentId: string): Promise<AgentHeartbeatRun> {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const run: AgentHeartbeatRun = {
      id: runId,
      agentId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
    };

    // Record as heartbeat event to track runs
    await this.recordHeartbeat(agentId, "ok", runId);

    return run;
  }

  /**
   * End a heartbeat run.
   * @param runId - The run ID
   * @param status - End status (completed or terminated)
   */
  async endHeartbeatRun(runId: string, status: "completed" | "terminated"): Promise<void> {
    // Find the agent for this run by scanning heartbeat files
    const files = await readdir(this.agentsDir).catch(() => [] as string[]);
    const heartbeatFiles = files.filter((f) => f.endsWith("-heartbeats.jsonl"));

    for (const file of heartbeatFiles) {
      const agentId = file.replace("-heartbeats.jsonl", "");
      const history = await this.getHeartbeatHistory(agentId, 1000);

      // Check if this run exists in the history
      const hasRun = history.some((h) => h.runId === runId);
      if (hasRun) {
        // Record end as special event
        await this.recordHeartbeat(agentId, status === "terminated" ? "missed" : "ok", runId);
        return;
      }
    }
  }

  /**
   * Get the active heartbeat run for an agent.
   * @param agentId - The agent ID
   * @returns The active run, or null if none
   */
  async getActiveHeartbeatRun(agentId: string): Promise<AgentHeartbeatRun | null> {
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
   * @param agentId - The agent ID
   * @returns Array of completed runs
   */
  async getCompletedHeartbeatRuns(agentId: string): Promise<AgentHeartbeatRun[]> {
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

    return Array.from(runs.values()).filter((r) => r.status !== "active");
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

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async readAgentFile(agentId: string): Promise<AgentData> {
    const path = join(this.agentsDir, `${agentId}.json`);
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as AgentData;
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
    };

    // Write atomically using temp file
    const tempPath = `${path}.tmp.${Date.now()}`;
    await writeFile(tempPath, JSON.stringify(data, null, 2));
    
    // Rename temp file to final path (atomic on most filesystems)
    const { rename } = await import("node:fs/promises");
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