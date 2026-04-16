/**
 * CentralCore — Main API for fn's multi-project central infrastructure.
 *
 * Provides project registry, health tracking, unified activity feed,
 * and global concurrency management across all registered projects.
 *
 * The central database is located at `~/.fusion/fusion-central.db`.
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
import { createHash, randomUUID } from "node:crypto";
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
  AgentCapability,
  NodeConfig,
  NodeStatus,
  SystemMetrics,
  NodeMeshState,
  PeerInfo,
  PeerNode,
  DiscoveryConfig,
  DiscoveredNode,
  NodeVersionInfo,
  NodeVersionInfoInput,
  PluginSyncResult,
  VersionCompatibilityResult,
  SettingsSyncPayload,
  SettingsSyncState,
  SettingsSyncResult,
  GlobalSettings,
  ProviderAuthEntry,
} from "./types.js";
import { getAppVersion, parseSemver } from "./app-version.js";
import { CentralDatabase, toJson, toJsonNullable, fromJson } from "./central-db.js";
import { resolveGlobalDir } from "./global-settings.js";
import { NodeConnection } from "./node-connection.js";
import { NodeDiscovery } from "./node-discovery.js";
import { collectSystemMetrics } from "./system-metrics.js";
import type { ConnectionOptions, ConnectionResult } from "./node-connection.js";

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
  /** Emitted when a node is registered */
  "node:registered": [node: NodeConfig];
  /** Emitted when a node is unregistered */
  "node:unregistered": [nodeId: string];
  /** Emitted when node metadata is updated */
  "node:updated": [node: NodeConfig];
  /** Emitted when node health status changes */
  "node:health:changed": [node: NodeConfig];
  /** Emitted when node metrics is updated */
  "node:metrics:updated": [payload: { nodeId: string; metrics: SystemMetrics }];
  /** Emitted when a mesh peer is added for a node */
  "mesh:peer:added": [payload: { nodeId: string; peer: PeerNode }];
  /** Emitted when a mesh peer is removed for a node */
  "mesh:peer:removed": [payload: { nodeId: string; peerNodeId: string }];
  /** Emitted when a node mesh snapshot changes */
  "mesh:state:changed": [payload: { nodeId: string; state: NodeMeshState }];
  /** Emitted when a new node is discovered via gossip peer exchange */
  "gossip:peer:registered": [payload: { nodeId: string; peer: PeerInfo }];
  /** Emitted after a remote node connection test completes */
  "node:connection:test": [result: ConnectionResult];
  /** Emitted when network discovery starts */
  "discovery:started": [config: DiscoveryConfig];
  /** Emitted when network discovery stops */
  "discovery:stopped": [];
  /** Emitted when a node is discovered via mDNS */
  "discovery:node:found": [node: DiscoveredNode];
  /** Emitted when a discovered node is lost */
  "discovery:node:lost": [name: string];
  /** Emitted when global concurrency state changes */
  "concurrency:changed": [state: GlobalConcurrencyState];
  /** Emitted when a node's version info is updated */
  "node:version:updated": [payload: { nodeId: string; versionInfo: NodeVersionInfo }];
  /** Emitted when plugin sync comparison completes */
  "node:plugins:synced": [result: PluginSyncResult];
  /** Emitted when settings sync between nodes completes */
  "settings:sync:completed": [payload: { nodeId: string; remoteNodeId: string; state: SettingsSyncState }];
}

// ── CentralCore Class ─────────────────────────────────────────────────────

export class CentralCore extends EventEmitter<CentralCoreEvents> {
  private db: CentralDatabase | null = null;
  private readonly globalDir: string;
  private initialized = false;
  private nodeDiscovery: NodeDiscovery | null = null;
  private discoveryConfig: DiscoveryConfig | null = null;
  private readonly discoveredNodes = new Map<string, DiscoveredNode>();

  private readonly onDiscoveryNodeDiscovered = (node: DiscoveredNode): void => {
    void this.handleDiscoveryNodeDiscovered(node).catch((error) => {
      console.warn("[central-core] Failed to process discovered node", error);
    });
  };

  private readonly onDiscoveryNodeUpdated = (node: DiscoveredNode): void => {
    void this.handleDiscoveryNodeUpdated(node).catch((error) => {
      console.warn("[central-core] Failed to process discovery node update", error);
    });
  };

  private readonly onDiscoveryNodeLost = (name: string): void => {
    void this.handleDiscoveryNodeLost(name).catch((error) => {
      console.warn("[central-core] Failed to process discovery node loss", error);
    });
  };

  /**
   * Create a CentralCore instance.
   * @param globalDir — Directory for central database. Defaults to `~/.fusion/`.
   *                  Accepts a custom path for testing.
   */
  constructor(globalDir?: string) {
    super();
    this.setMaxListeners(100);
    this.globalDir = resolveGlobalDir(globalDir);
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

    const existingLocal = this.db
      .prepare("SELECT id FROM nodes WHERE type = 'local' LIMIT 1")
      .get() as { id: string } | undefined;

    if (!existingLocal) {
      const concurrency = this.db
        .prepare("SELECT globalMaxConcurrent FROM globalConcurrency WHERE id = 1")
        .get() as { globalMaxConcurrent: number } | undefined;
      const maxConcurrent = concurrency?.globalMaxConcurrent ?? 2;

      const localNode = await this.registerNode({
        name: "local",
        type: "local",
        maxConcurrent,
      });
      await this.updateNode(localNode.id, { status: "online" });
    }
  }

  /**
   * Close the central infrastructure.
   * Closes database connections and releases resources.
   */
  async close(): Promise<void> {
    if (this.nodeDiscovery) {
      this.stopDiscovery();
    }

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
          nodeId: string | null;
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
          nodeId: string | null;
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
      nodeId: string | null;
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
        nodeId = ?,
        settings = ?
       WHERE id = ?`
    ).run(
      updated.name,
      updated.path,
      updated.status,
      updated.isolationMode,
      updated.updatedAt,
      updated.lastActivityAt ?? null,
      updated.nodeId ?? null,
      toJsonNullable(updated.settings),
      id
    );

    this.db!.bumpLastModified();
    this.emit("project:updated", updated);
    return updated;
  }

  /**
   * Reconcile stale project statuses.
   *
   * Projects stuck in `status: "initializing"` are considered stale because
   * all current registration paths (`autoRegisterProject`, CLI commands, and
   * the dashboard POST endpoint) immediately promote to `"active"` after
   * registration. Any project still in `"initializing"` was created before
   * those fixes and should be promoted to `"active"`.
   *
   * Updates both the `projects` and `projectHealth` tables atomically.
   * Non-initializing projects are not affected.
   *
   * @returns Array of reconciled projects with their previous status
   */
  async reconcileProjectStatuses(): Promise<Array<{ projectId: string; previousStatus: string }>> {
    this.ensureInitialized();

    const staleProjects = this.db!.prepare(
      "SELECT id, status FROM projects WHERE status = ?"
    ).all("initializing") as Array<{ id: string; status: string }>;

    if (staleProjects.length === 0) return [];

    const now = new Date().toISOString();
    const reconciled: Array<{ projectId: string; previousStatus: string }> = [];

    this.db!.transaction(() => {
      for (const project of staleProjects) {
        // Update projects table
        this.db!.prepare(
          `UPDATE projects SET status = ?, updatedAt = ? WHERE id = ?`
        ).run("active", now, project.id);

        // Update projectHealth table (if row exists)
        this.db!.prepare(
          `UPDATE projectHealth SET status = ?, updatedAt = ? WHERE projectId = ?`
        ).run("active", now, project.id);

        reconciled.push({ projectId: project.id, previousStatus: project.status });
      }
    });

    if (reconciled.length > 0) {
      this.db!.bumpLastModified();
    }

    return reconciled;
  }

  // ── Node Registry API ───────────────────────────────────────────────────

  /**
   * Register a new runtime node.
   *
   * @param input — Node registration input
   * @returns The registered node
   * @throws Error if constraints are violated or name already exists
   */
  async registerNode(input: {
    name: string;
    type: "local" | "remote";
    url?: string;
    apiKey?: string;
    capabilities?: AgentCapability[];
    maxConcurrent?: number;
  }): Promise<NodeConfig> {
    this.ensureInitialized();

    const name = input.name.trim();
    if (!name) {
      throw new Error("Node name is required");
    }

    const existingByName = await this.getNodeByName(name);
    if (existingByName) {
      throw new Error(`Node already exists with name: ${name}`);
    }

    const normalizedUrl = input.url?.trim();
    if (input.type === "remote" && !normalizedUrl) {
      throw new Error("Remote nodes must include a url");
    }
    if (input.type === "local" && (normalizedUrl || input.apiKey)) {
      throw new Error("Local nodes must not include url or apiKey");
    }

    const maxConcurrent = input.maxConcurrent ?? 2;
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`Node maxConcurrent must be >= 1: ${maxConcurrent}`);
    }

    const now = new Date().toISOString();
    const node: NodeConfig = {
      id: `node_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name,
      type: input.type,
      url: normalizedUrl || undefined,
      apiKey: input.apiKey || undefined,
      status: "offline",
      capabilities: input.capabilities,
      maxConcurrent,
      createdAt: now,
      updatedAt: now,
    };

    this.db!.prepare(
      `INSERT INTO nodes (id, name, type, url, apiKey, status, capabilities, maxConcurrent, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      node.id,
      node.name,
      node.type,
      node.url ?? null,
      node.apiKey ?? null,
      node.status,
      toJsonNullable(node.capabilities),
      node.maxConcurrent,
      node.createdAt,
      node.updatedAt
    );

    this.db!.bumpLastModified();
    this.emit("node:registered", node);
    return node;
  }

  /**
   * Register a remote peer node from gossip exchange.
   *
   * This method is used during peer merge to register nodes discovered via
   * the gossip protocol. It preserves the remote node's ID (rather than
   * generating a new one) so that cross-node lookups work correctly.
   *
   * @param peer — Peer info from the gossip exchange
   * @returns The registered node
   */
  async registerGossipPeer(peer: PeerInfo): Promise<NodeConfig> {
    this.ensureInitialized();

    const now = new Date().toISOString();

    // Handle name uniqueness by appending suffix if needed
    let name = peer.nodeName;
    let suffix = 1;
    while (true) {
      const existing = await this.getNodeByName(name);
      if (!existing) break;
      suffix++;
      name = `${peer.nodeName}-${suffix}`;
    }

    // Determine URL - use provided URL or empty string for local-style
    const normalizedUrl = peer.nodeUrl || undefined;

    const node: NodeConfig = {
      id: peer.nodeId,
      name,
      type: "remote",
      url: normalizedUrl,
      status: peer.status,
      capabilities: peer.capabilities,
      systemMetrics: peer.metrics ?? undefined,
      maxConcurrent: peer.maxConcurrent,
      createdAt: now,
      updatedAt: now,
    };

    this.db!.prepare(
      `INSERT INTO nodes (id, name, type, url, status, capabilities, systemMetrics, maxConcurrent, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      node.id,
      node.name,
      node.type,
      node.url ?? null,
      node.status,
      toJsonNullable(node.capabilities),
      toJsonNullable(node.systemMetrics),
      node.maxConcurrent,
      node.createdAt,
      node.updatedAt
    );

    this.db!.bumpLastModified();
    this.emit("node:registered", node);
    return node;
  }

  /**
   * Unregister a runtime node.
   *
   * Idempotent. Projects assigned to this node are automatically unassigned.
   *
   * @param id — Node ID to unregister
   */
  async unregisterNode(id: string): Promise<void> {
    this.ensureInitialized();

    const node = await this.getNode(id);
    if (!node) {
      return;
    }

    const now = new Date().toISOString();
    this.db!.transaction(() => {
      this.db!.prepare("UPDATE projects SET nodeId = NULL, updatedAt = ? WHERE nodeId = ?").run(now, id);
      this.db!.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    });

    this.db!.bumpLastModified();
    this.emit("node:unregistered", id);
  }

  /**
   * Get a node by ID.
   */
  async getNode(id: string): Promise<NodeConfig | undefined> {
    this.ensureInitialized();

    const row = this.db!.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | {
          id: string;
          name: string;
          type: string;
          url: string | null;
          apiKey: string | null;
          status: string;
          capabilities: string | null;
          systemMetrics: string | null;
          knownPeers: string | null;
          versionInfo: string | null;
          pluginVersions: string | null;
          maxConcurrent: number;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) return undefined;
    return this.rowToNode(row);
  }

  /**
   * Get a node by unique name.
   */
  async getNodeByName(name: string): Promise<NodeConfig | undefined> {
    this.ensureInitialized();

    const row = this.db!.prepare("SELECT * FROM nodes WHERE name = ?").get(name) as
      | {
          id: string;
          name: string;
          type: string;
          url: string | null;
          apiKey: string | null;
          status: string;
          capabilities: string | null;
          systemMetrics: string | null;
          knownPeers: string | null;
          versionInfo: string | null;
          pluginVersions: string | null;
          maxConcurrent: number;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) return undefined;
    return this.rowToNode(row);
  }

  /**
   * List all nodes ordered by name.
   */
  async listNodes(): Promise<NodeConfig[]> {
    this.ensureInitialized();

    const rows = this.db!.prepare("SELECT * FROM nodes ORDER BY name").all() as Array<{
      id: string;
      name: string;
      type: string;
      url: string | null;
      apiKey: string | null;
      status: string;
      capabilities: string | null;
      systemMetrics: string | null;
      knownPeers: string | null;
      versionInfo: string | null;
      pluginVersions: string | null;
      maxConcurrent: number;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => this.rowToNode(row));
  }

  /**
   * Update node metadata.
   */
  async updateNode(
    id: string,
    updates: Partial<Omit<NodeConfig, "id" | "createdAt">>
  ): Promise<NodeConfig> {
    this.ensureInitialized();

    const node = await this.getNode(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }

    const now = new Date().toISOString();
    const updated: NodeConfig = {
      ...node,
      ...updates,
      id,
      createdAt: node.createdAt,
      updatedAt: now,
    };

    if (!Number.isFinite(updated.maxConcurrent) || updated.maxConcurrent < 1) {
      throw new Error(`Node maxConcurrent must be >= 1: ${updated.maxConcurrent}`);
    }

    if (updated.type === "remote" && !updated.url) {
      throw new Error("Remote nodes must include a url");
    }
    if (updated.type === "local" && (updated.url || updated.apiKey)) {
      throw new Error("Local nodes must not include url or apiKey");
    }

    this.db!.prepare(
      `UPDATE nodes SET
        name = ?,
        type = ?,
        url = ?,
        apiKey = ?,
        status = ?,
        capabilities = ?,
        systemMetrics = ?,
        knownPeers = ?,
        versionInfo = ?,
        pluginVersions = ?,
        maxConcurrent = ?,
        updatedAt = ?
       WHERE id = ?`
    ).run(
      updated.name,
      updated.type,
      updated.url ?? null,
      updated.apiKey ?? null,
      updated.status,
      toJsonNullable(updated.capabilities),
      toJsonNullable(updated.systemMetrics),
      toJsonNullable(updated.knownPeers),
      toJsonNullable(updated.versionInfo),
      toJsonNullable(updated.pluginVersions),
      updated.maxConcurrent,
      updated.updatedAt,
      id
    );

    this.db!.bumpLastModified();
    this.emit("node:updated", updated);
    return updated;
  }

  /**
   * Check node health and update stored status.
   */
  async checkNodeHealth(id: string): Promise<NodeStatus> {
    this.ensureInitialized();

    const node = await this.getNode(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }

    let nextStatus: NodeStatus;

    if (node.type === "local") {
      nextStatus = "online";
    } else if (!node.url) {
      nextStatus = "error";
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      try {
        const healthUrl = new URL("/api/health", node.url).toString();
        const response = await fetch(healthUrl, {
          method: "GET",
          headers: node.apiKey ? { Authorization: `Bearer ${node.apiKey}` } : undefined,
          signal: controller.signal,
        });
        nextStatus = response.ok ? "online" : "offline";
      } catch {
        nextStatus = "error";
      } finally {
        clearTimeout(timeout);
      }
    }

    if (nextStatus !== node.status) {
      const now = new Date().toISOString();
      const updated: NodeConfig = {
        ...node,
        status: nextStatus,
        updatedAt: now,
      };

      this.db!
        .prepare("UPDATE nodes SET status = ?, updatedAt = ? WHERE id = ?")
        .run(nextStatus, now, id);
      this.db!.bumpLastModified();
      this.emit("node:health:changed", updated);
    }

    return nextStatus;
  }

  /**
   * Update metrics for a registered node.
   */
  async updateNodeMetrics(id: string, metrics: SystemMetrics): Promise<NodeConfig> {
    this.ensureInitialized();

    const node = await this.getNode(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }

    const now = new Date().toISOString();
    this.db!
      .prepare("UPDATE nodes SET systemMetrics = ?, updatedAt = ? WHERE id = ?")
      .run(toJsonNullable(metrics), now, id);

    this.db!.bumpLastModified();

    const updated = await this.getNode(id);
    if (!updated) {
      throw new Error(`Node not found after metrics update: ${id}`);
    }

    this.emit("node:metrics:updated", { nodeId: id, metrics });
    this.emit("node:updated", updated);

    const state = await this.getMeshState(id);
    this.emit("mesh:state:changed", { nodeId: id, state });

    return updated;
  }

  /**
   * List all known peers for a node.
   */
  async listPeers(nodeId: string): Promise<PeerNode[]> {
    this.ensureInitialized();

    const rows = this.db!
      .prepare("SELECT * FROM peerNodes WHERE nodeId = ? ORDER BY name")
      .all(nodeId) as Array<{
      id: string;
      nodeId: string;
      peerNodeId: string;
      name: string;
      url: string;
      status: string;
      lastSeen: string;
      connectedAt: string;
    }>;

    return rows.map((row) => this.rowToPeerNode(row));
  }

  /**
   * Register or update a peer node for mesh discovery.
   */
  async registerPeerNode(input: {
    nodeId: string;
    peerNodeId: string;
    name: string;
    url: string;
  }): Promise<PeerNode> {
    this.ensureInitialized();

    const node = await this.getNode(input.nodeId);
    if (!node) {
      throw new Error(`Node not found: ${input.nodeId}`);
    }

    const now = new Date().toISOString();

    this.db!.transaction(() => {
      this.db!
        .prepare(
          `INSERT INTO peerNodes (id, nodeId, peerNodeId, name, url, status, lastSeen, connectedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(nodeId, peerNodeId) DO UPDATE SET
             name = excluded.name,
             url = excluded.url,
             status = excluded.status,
             lastSeen = excluded.lastSeen`
        )
        .run(
          `peer_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          input.nodeId,
          input.peerNodeId,
          input.name,
          input.url,
          "offline",
          now,
          now,
        );

      const knownPeers = new Set(node.knownPeers ?? []);
      knownPeers.add(input.peerNodeId);

      this.db!
        .prepare("UPDATE nodes SET knownPeers = ?, updatedAt = ? WHERE id = ?")
        .run(toJson(Array.from(knownPeers)), now, input.nodeId);
    });

    this.db!.bumpLastModified();

    const row = this.db!
      .prepare("SELECT * FROM peerNodes WHERE nodeId = ? AND peerNodeId = ?")
      .get(input.nodeId, input.peerNodeId) as
      | {
          id: string;
          nodeId: string;
          peerNodeId: string;
          name: string;
          url: string;
          status: string;
          lastSeen: string;
          connectedAt: string;
        }
      | undefined;

    if (!row) {
      throw new Error(
        `Failed to load peer node after registration: ${input.nodeId}/${input.peerNodeId}`,
      );
    }

    const peer = this.rowToPeerNode(row);
    this.emit("mesh:peer:added", { nodeId: input.nodeId, peer });

    const updatedNode = await this.getNode(input.nodeId);
    if (updatedNode) {
      this.emit("node:updated", updatedNode);
    }

    const state = await this.getMeshState(input.nodeId);
    this.emit("mesh:state:changed", { nodeId: input.nodeId, state });

    return peer;
  }

  /**
   * Remove a peer node relationship.
   */
  async unregisterPeerNode(nodeId: string, peerNodeId: string): Promise<void> {
    this.ensureInitialized();

    const node = await this.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const now = new Date().toISOString();

    this.db!.transaction(() => {
      this.db!.prepare("DELETE FROM peerNodes WHERE nodeId = ? AND peerNodeId = ?").run(nodeId, peerNodeId);

      const knownPeers = (node.knownPeers ?? []).filter((id) => id !== peerNodeId);
      this.db!
        .prepare("UPDATE nodes SET knownPeers = ?, updatedAt = ? WHERE id = ?")
        .run(toJson(knownPeers), now, nodeId);
    });

    this.db!.bumpLastModified();
    this.emit("mesh:peer:removed", { nodeId, peerNodeId });

    const updatedNode = await this.getNode(nodeId);
    if (updatedNode) {
      this.emit("node:updated", updatedNode);
    }

    const state = await this.getMeshState(nodeId);
    this.emit("mesh:state:changed", { nodeId, state });
  }

  /**
   * Get mesh state for a node (or the local node by default).
   */
  async getMeshState(nodeId?: string): Promise<NodeMeshState> {
    this.ensureInitialized();

    const node = nodeId ? await this.getNode(nodeId) : await this.getLocalNode();
    if (!node) {
      throw new Error(nodeId ? `Node not found: ${nodeId}` : "Local node not found");
    }

    const peers = await this.listPeers(node.id);

    return {
      nodeId: node.id,
      nodeName: node.name,
      nodeUrl: node.url,
      status: node.status,
      metrics: node.systemMetrics ?? null,
      lastSeen: node.updatedAt,
      connectedAt: node.createdAt,
      knownPeers: peers,
    };
  }

  /**
   * Collect a fresh local mesh state snapshot.
   */
  async reportMeshState(): Promise<NodeMeshState> {
    this.ensureInitialized();

    const localNode = await this.getLocalNode();
    if (!localNode) {
      throw new Error("Local node not found");
    }

    const metrics = await collectSystemMetrics(this.db!.getPath());
    await this.updateNodeMetrics(localNode.id, metrics);

    return this.getMeshState(localNode.id);
  }

  /**
   * Merge incoming peer information from a gossip exchange.
   *
   * This method processes a list of peers received from another node during
   * the gossip protocol. It adds new peers, updates stale entries, and
   * emits appropriate events for mesh state changes.
   *
   * @param incomingPeers — List of peer info from gossip exchange
   * @returns Object with lists of added and updated node IDs
   */
  async mergePeers(incomingPeers: PeerInfo[]): Promise<{ added: string[]; updated: string[] }> {
    this.ensureInitialized();

    const added: string[] = [];
    const updated: string[] = [];

    for (const peer of incomingPeers) {
      const existing = await this.getNode(peer.nodeId);

      if (!existing) {
        // New peer - register it
        const newNode = await this.registerGossipPeer(peer);
        added.push(newNode.id);
        this.emit("gossip:peer:registered", { nodeId: newNode.id, peer });
      } else if (existing.type === "local") {
        // Never overwrite the local node from incoming peer data
        continue;
      } else {
        // Existing remote node - check if incoming data is fresher
        const incomingLastSeen = new Date(peer.lastSeen);
        const localUpdatedAt = new Date(existing.updatedAt);

        if (incomingLastSeen > localUpdatedAt) {
          // Incoming data is fresher - update the node
          await this.updateNode(existing.id, {
            status: peer.status,
            url: peer.nodeUrl || undefined,
            capabilities: peer.capabilities,
            maxConcurrent: peer.maxConcurrent,
          });

          // Update metrics if provided
          if (peer.metrics) {
            await this.updateNodeMetrics(existing.id, peer.metrics);
          }

          updated.push(existing.id);
        }
      }
    }

    // Emit mesh state changed if any modifications were made
    if (added.length > 0 || updated.length > 0) {
      const localNode = await this.getLocalNode();
      if (localNode) {
        const state = await this.getMeshState(localNode.id);
        this.emit("mesh:state:changed", { nodeId: localNode.id, state });
      }
    }

    return { added, updated };
  }

  /**
   * Get a PeerInfo snapshot of the local node for gossip transmission.
   *
   * @returns PeerInfo for the local node with current metrics
   */
  async getLocalPeerInfo(): Promise<PeerInfo> {
    this.ensureInitialized();

    const localNode = await this.getLocalNode();
    if (!localNode) {
      throw new Error("Local node not found");
    }

    return {
      nodeId: localNode.id,
      nodeName: localNode.name,
      nodeUrl: localNode.url || "",
      status: localNode.status,
      metrics: localNode.systemMetrics ?? null,
      lastSeen: new Date().toISOString(),
      capabilities: localNode.capabilities,
      maxConcurrent: localNode.maxConcurrent,
    };
  }

  /**
   * Get PeerInfo snapshots for all known nodes.
   *
   * @returns Array of PeerInfo for all nodes in the registry
   */
  async getAllKnownPeerInfo(): Promise<PeerInfo[]> {
    this.ensureInitialized();

    const nodes = await this.listNodes();

    return nodes.map((node) => ({
      nodeId: node.id,
      nodeName: node.name,
      nodeUrl: node.url || "",
      status: node.status,
      metrics: node.systemMetrics ?? null,
      lastSeen: node.updatedAt,
      capabilities: node.capabilities,
      maxConcurrent: node.maxConcurrent,
    }));
  }

  /**
   * Test connectivity to a remote Fusion node without registering it.
   */
  async testNodeConnection(options: ConnectionOptions): Promise<ConnectionResult> {
    this.ensureInitialized();

    const connection = new NodeConnection();
    const result = await connection.test(options);
    this.emit("node:connection:test", result);
    return result;
  }

  /**
   * Test a remote node connection and register it when successful.
   */
  async connectToRemoteNode(input: {
    name: string;
    host: string;
    port: number;
    secure?: boolean;
    apiKey?: string;
    timeoutMs?: number;
    maxConcurrent?: number;
  }): Promise<{ result: ConnectionResult; node?: NodeConfig }> {
    this.ensureInitialized();

    const name = input.name.trim();
    if (!name) {
      throw new Error("Node name is required");
    }
    if (name.length > 64) {
      throw new Error("Node name must be 1-64 characters");
    }

    const existingByName = await this.getNodeByName(name);
    if (existingByName) {
      throw new Error(`Node already exists with name: ${name}`);
    }

    const connection = new NodeConnection();
    const result = await connection.test({
      host: input.host,
      port: input.port,
      secure: input.secure,
      apiKey: input.apiKey,
      timeoutMs: input.timeoutMs,
    });

    this.emit("node:connection:test", result);

    if (!result.success) {
      return { result };
    }

    const node = await this.registerNode({
      name,
      type: "remote",
      url: result.url,
      apiKey: input.apiKey,
      maxConcurrent: input.maxConcurrent,
    });
    await this.checkNodeHealth(node.id);

    return { result, node };
  }

  /**
   * Start mDNS/DNS-SD node discovery for this process.
   */
  async startDiscovery(config: DiscoveryConfig): Promise<NodeDiscovery> {
    this.ensureInitialized();

    if (this.nodeDiscovery) {
      return this.nodeDiscovery;
    }

    const localNode = (await this.listNodes()).find((node) => node.type === "local");
    if (!localNode) {
      throw new Error("Local node not found");
    }

    this.discoveryConfig = {
      ...config,
    };
    this.discoveredNodes.clear();

    const discovery = new NodeDiscovery(this.discoveryConfig);
    this.nodeDiscovery = discovery;

    discovery.on("node:discovered", this.onDiscoveryNodeDiscovered);
    discovery.on("node:updated", this.onDiscoveryNodeUpdated);
    discovery.on("node:lost", this.onDiscoveryNodeLost);

    discovery.start(localNode.id, localNode.name);
    this.emit("discovery:started", this.discoveryConfig);

    return discovery;
  }

  /**
   * Stop mDNS/DNS-SD node discovery.
   */
  stopDiscovery(): void {
    if (!this.nodeDiscovery) {
      return;
    }

    const discovery = this.nodeDiscovery;
    discovery.off("node:discovered", this.onDiscoveryNodeDiscovered);
    discovery.off("node:updated", this.onDiscoveryNodeUpdated);
    discovery.off("node:lost", this.onDiscoveryNodeLost);
    discovery.stop();

    this.nodeDiscovery = null;
    this.discoveryConfig = null;
    this.discoveredNodes.clear();
    this.emit("discovery:stopped");
  }

  /**
   * List currently discovered nodes.
   */
  getDiscoveredNodes(): DiscoveredNode[] {
    return Array.from(this.discoveredNodes.values());
  }

  /**
   * Return whether discovery is currently active.
   */
  isDiscoveryActive(): boolean {
    return this.nodeDiscovery !== null;
  }

  /**
   * Return active discovery config (if started).
   */
  getDiscoveryConfig(): DiscoveryConfig | null {
    if (!this.discoveryConfig) {
      return null;
    }

    return { ...this.discoveryConfig };
  }

  /**
   * Assign a project to a node.
   */
  async assignProjectToNode(projectId: string, nodeId: string): Promise<RegisteredProject> {
    this.ensureInitialized();

    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const node = await this.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const now = new Date().toISOString();
    this.db!.prepare("UPDATE projects SET nodeId = ?, updatedAt = ? WHERE id = ?").run(node.id, now, projectId);
    this.db!.bumpLastModified();

    const updated: RegisteredProject = {
      ...project,
      nodeId: node.id,
      updatedAt: now,
    };
    this.emit("project:updated", updated);
    return updated;
  }

  /**
   * Unassign a project from any node.
   */
  async unassignProjectFromNode(projectId: string): Promise<RegisteredProject> {
    this.ensureInitialized();

    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const now = new Date().toISOString();
    this.db!.prepare("UPDATE projects SET nodeId = NULL, updatedAt = ? WHERE id = ?").run(now, projectId);
    this.db!.bumpLastModified();

    const updated: RegisteredProject = {
      ...project,
      nodeId: undefined,
      updatedAt: now,
    };
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

    if (
      updates.globalMaxConcurrent !== undefined &&
      (!Number.isFinite(updates.globalMaxConcurrent) || updates.globalMaxConcurrent < 1 || updates.globalMaxConcurrent > 10000)
    ) {
      throw new Error("globalMaxConcurrent must be between 1 and 10000");
    }

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
   * @returns Absolute path to fusion-central.db
   */
  getDatabasePath(): string {
    return this.db?.getPath() ?? join(this.globalDir, "fusion-central.db");
  }

  /**
   * Get the global directory path.
   *
   * @returns Absolute path to global fn directory
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

  private async handleDiscoveryNodeDiscovered(node: DiscoveredNode): Promise<void> {
    const existingNode = await this.getNodeByName(node.name);

    if (!existingNode) {
      this.discoveredNodes.set(node.name, node);
    } else {
      this.discoveredNodes.delete(node.name);

      if (existingNode.status === "offline") {
        await this.updateNode(existingNode.id, { status: "online" });
      }
    }

    this.emit("discovery:node:found", node);
  }

  private async handleDiscoveryNodeUpdated(node: DiscoveredNode): Promise<void> {
    if (!this.discoveredNodes.has(node.name)) {
      return;
    }

    this.discoveredNodes.set(node.name, node);
  }

  private async handleDiscoveryNodeLost(name: string): Promise<void> {
    this.discoveredNodes.delete(name);

    const existingNode = await this.getNodeByName(name);
    if (existingNode && existingNode.status !== "offline") {
      await this.updateNode(existingNode.id, { status: "offline" });
    }

    this.emit("discovery:node:lost", name);
  }

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
    nodeId: string | null;
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
      nodeId: row.nodeId ?? undefined,
      settings: fromJson<ProjectSettings>(row.settings),
    };
  }

  private rowToNode(row: {
    id: string;
    name: string;
    type: string;
    url: string | null;
    apiKey: string | null;
    status: string;
    capabilities: string | null;
    systemMetrics: string | null;
    knownPeers: string | null;
    versionInfo: string | null;
    pluginVersions: string | null;
    maxConcurrent: number;
    createdAt: string;
    updatedAt: string;
  }): NodeConfig {
    return {
      id: row.id,
      name: row.name,
      type: row.type as NodeConfig["type"],
      url: row.url ?? undefined,
      apiKey: row.apiKey ?? undefined,
      status: row.status as NodeStatus,
      capabilities: fromJson<AgentCapability[]>(row.capabilities),
      systemMetrics: fromJson<SystemMetrics>(row.systemMetrics),
      knownPeers: fromJson<string[]>(row.knownPeers),
      versionInfo: fromJson<NodeVersionInfo>(row.versionInfo),
      pluginVersions: fromJson<Record<string, string>>(row.pluginVersions),
      maxConcurrent: row.maxConcurrent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToPeerNode(row: {
    id: string;
    nodeId: string;
    peerNodeId: string;
    name: string;
    url: string;
    status: string;
    lastSeen: string;
    connectedAt: string;
  }): PeerNode {
    return {
      id: row.id,
      nodeId: row.nodeId,
      peerNodeId: row.peerNodeId,
      name: row.name,
      url: row.url,
      status: row.status as NodeStatus,
      lastSeen: row.lastSeen,
      connectedAt: row.connectedAt,
    };
  }

  private async getLocalNode(): Promise<NodeConfig | undefined> {
    const row = this.db!
      .prepare("SELECT * FROM nodes WHERE type = 'local' ORDER BY createdAt ASC LIMIT 1")
      .get() as
      | {
          id: string;
          name: string;
          type: string;
          url: string | null;
          apiKey: string | null;
          status: string;
          capabilities: string | null;
          systemMetrics: string | null;
          knownPeers: string | null;
          versionInfo: string | null;
          pluginVersions: string | null;
          maxConcurrent: number;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    return row ? this.rowToNode(row) : undefined;
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

  // ── Node Version Sync API ──────────────────────────────────────────────

  /**
   * Update version information for a node.
   * Auto-fills appVersion with current app version if not provided.
   *
   * @param id - Node ID
   * @param versionInfo - Version info to store
   * @returns Updated node config
   * @throws Error if node not found
   */
  async updateNodeVersionInfo(id: string, versionInfo: NodeVersionInfoInput): Promise<NodeConfig> {
    this.ensureInitialized();

    const node = await this.getNode(id);
    if (!node) {
      throw new Error(`Node not found: ${id}`);
    }

    const now = new Date().toISOString();
    const fullVersionInfo: NodeVersionInfo = {
      appVersion: versionInfo.appVersion ?? getAppVersion(),
      pluginVersions: versionInfo.pluginVersions,
      lastSyncedAt: versionInfo.lastSyncedAt ?? now,
    };

    this.db!.prepare(
      `UPDATE nodes SET
        versionInfo = ?,
        pluginVersions = ?,
        updatedAt = ?
       WHERE id = ?`
    ).run(
      toJsonNullable(fullVersionInfo),
      toJsonNullable(fullVersionInfo.pluginVersions),
      now,
      id
    );

    this.db!.bumpLastModified();

    const updated = await this.getNode(id);
    if (!updated) {
      throw new Error(`Node not found after update: ${id}`);
    }

    this.emit("node:version:updated", { nodeId: id, versionInfo: fullVersionInfo });
    this.emit("node:updated", updated);

    return updated;
  }

  /**
   * Get version information for a node.
   *
   * @param id - Node ID
   * @returns Version info or undefined if not set
   */
  async getNodeVersionInfo(id: string): Promise<NodeVersionInfo | undefined> {
    this.ensureInitialized();

    const node = await this.getNode(id);
    return node?.versionInfo;
  }

  /**
   * Compare plugin versions between two nodes and generate sync recommendations.
   *
   * @param localNodeId - Local node ID
   * @param remoteNodeId - Remote node ID to compare against
   * @returns Sync result with recommendations for each plugin
   * @throws Error if either node not found
   */
  async syncPlugins(localNodeId: string, remoteNodeId: string): Promise<PluginSyncResult> {
    this.ensureInitialized();

    const localNode = await this.getNode(localNodeId);
    const remoteNode = await this.getNode(remoteNodeId);

    if (!localNode) {
      throw new Error(`Local node not found: ${localNodeId}`);
    }
    if (!remoteNode) {
      throw new Error(`Remote node not found: ${remoteNodeId}`);
    }

    const localPlugins = localNode.versionInfo?.pluginVersions ?? {};
    const remotePlugins = remoteNode.versionInfo?.pluginVersions ?? {};

    const allPluginIds = new Set([...Object.keys(localPlugins), ...Object.keys(remotePlugins)]);
    const plugins: PluginSyncResult["plugins"] = [];

    for (const pluginId of allPluginIds) {
      const localVersion = localPlugins[pluginId];
      const remoteVersion = remotePlugins[pluginId];
      const localParsed = localVersion ? parseSemver(localVersion) : null;
      const remoteParsed = remoteVersion ? parseSemver(remoteVersion) : null;

      if (localVersion && !remoteVersion) {
        // Plugin on local but not remote
        plugins.push({
          pluginId,
          action: "install",
          targetVersion: localVersion,
          localVersion,
          remoteVersion: undefined,
          reason: "Plugin installed on local node but missing on remote",
        });
      } else if (!localVersion && remoteVersion) {
        // Plugin on remote but not local
        plugins.push({
          pluginId,
          action: "remove",
          localVersion: undefined,
          remoteVersion,
          reason: "Plugin installed on remote node but missing on local",
        });
      } else if (localParsed && remoteParsed) {
        // Both have the plugin - compare versions
        if (localParsed.major !== remoteParsed.major) {
          if (localParsed.major > remoteParsed.major) {
            plugins.push({
              pluginId,
              action: "update",
              targetVersion: localVersion,
              localVersion,
              remoteVersion,
              reason: `Local has newer major version (${localVersion} > ${remoteVersion})`,
            });
          } else {
            plugins.push({
              pluginId,
              action: "update",
              targetVersion: remoteVersion,
              localVersion,
              remoteVersion,
              reason: `Remote has newer major version (${remoteVersion} > ${localVersion})`,
            });
          }
        } else if (localParsed.minor !== remoteParsed.minor) {
          if (localParsed.minor > remoteParsed.minor) {
            plugins.push({
              pluginId,
              action: "update",
              targetVersion: localVersion,
              localVersion,
              remoteVersion,
              reason: `Local has newer minor version (${localVersion} > ${remoteVersion})`,
            });
          } else {
            plugins.push({
              pluginId,
              action: "update",
              targetVersion: remoteVersion,
              localVersion,
              remoteVersion,
              reason: `Remote has newer minor version (${remoteVersion} > ${localVersion})`,
            });
          }
        } else if (localParsed.patch !== remoteParsed.patch) {
          // Patch-only difference - still a "no-action" per spec
          plugins.push({
            pluginId,
            action: "no-action",
            localVersion,
            remoteVersion,
            reason: "Versions match (patch difference only)",
          });
        } else {
          // Exact match
          plugins.push({
            pluginId,
            action: "no-action",
            localVersion,
            remoteVersion,
            reason: "Versions match",
          });
        }
      } else {
        // Invalid semver - can't compare
        plugins.push({
          pluginId,
          action: "no-action",
          localVersion,
          remoteVersion,
          reason: "Cannot compare - invalid version format",
        });
      }
    }

    const comparedAt = new Date().toISOString();
    const actionsNeeded = plugins.filter((p) => p.action !== "no-action");
    const isCompatible = actionsNeeded.length === 0;

    const inSync = plugins.filter((p) => p.action === "no-action").length;
    const needUpdate = plugins.filter((p) => p.action === "update").length;
    const needInstall = plugins.filter((p) => p.action === "install").length;
    const needRemove = plugins.filter((p) => p.action === "remove").length;

    const summaryParts: string[] = [];
    if (inSync > 0) summaryParts.push(`${inSync} plugin${inSync !== 1 ? "s" : ""} in sync`);
    if (needUpdate > 0) summaryParts.push(`${needUpdate} need${needUpdate === 1 ? "s" : ""} update`);
    if (needInstall > 0) summaryParts.push(`${needInstall} need${needInstall === 1 ? "s" : ""} install`);
    if (needRemove > 0) summaryParts.push(`${needRemove} need${needRemove === 1 ? "s" : ""} removal`);

    const result: PluginSyncResult = {
      localNodeId,
      remoteNodeId,
      plugins,
      comparedAt,
      isCompatible,
      summary: summaryParts.join(", ") || "No plugins to compare",
    };

    this.emit("node:plugins:synced", result);
    return result;
  }

  /**
   * Check version compatibility between two version strings.
   *
   * @param local - Local version string
   * @param remote - Remote version string
   * @returns Compatibility result
   */
  checkVersionCompatibility(
    local: string,
    remote: string,
  ): VersionCompatibilityResult {
    const localParsed = parseSemver(local);
    const remoteParsed = parseSemver(remote);

    if (!localParsed || !remoteParsed) {
      return {
        localVersion: local,
        remoteVersion: remote,
        status: "incompatible",
        message: "Invalid version format",
      };
    }

    if (
      localParsed.major === remoteParsed.major &&
      localParsed.minor === remoteParsed.minor &&
      localParsed.patch === remoteParsed.patch
    ) {
      return {
        localVersion: local,
        remoteVersion: remote,
        status: "compatible",
        message: "Versions match",
      };
    }

    if (localParsed.major !== remoteParsed.major) {
      return {
        localVersion: local,
        remoteVersion: remote,
        status: "major-difference",
        message: `Major version mismatch: local ${local} vs remote ${remote}`,
      };
    }

    if (localParsed.minor !== remoteParsed.minor) {
      return {
        localVersion: local,
        remoteVersion: remote,
        status: "minor-difference",
        message: `Minor version difference: local ${local} vs remote ${remote}`,
      };
    }

    return {
      localVersion: local,
      remoteVersion: remote,
      status: "compatible",
      message: `Patch version difference only: local ${local} vs remote ${remote}`,
    };
  }

  // ── Settings Sync API ─────────────────────────────────────────────────

  /**
   * Collect global settings, project settings, and provider auth into a sync payload.
   *
   * Note: CentralCore does NOT have access to GlobalSettingsStore or AuthStorage.
   * The caller (dashboard route) must supply the global settings and auth data.
   *
   * @param globalSettings - Global settings snapshot from the caller
   * @param options - Optional provider auth credentials
   * @returns SettingsSyncPayload with checksum
   */
  async getSettingsForSync(
    globalSettings: GlobalSettings,
    options?: { providerAuth?: Record<string, ProviderAuthEntry> }
  ): Promise<SettingsSyncPayload> {
    this.ensureInitialized();

    // Collect project settings keyed by project name (not ID, since paths differ between nodes)
    const projects = await this.listProjects();
    const projectSettings: Record<string, ProjectSettings> = {};
    for (const project of projects) {
      if (project.settings) {
        projectSettings[project.name] = project.settings;
      }
    }

    // Build the payload without checksum first
    const exportedAt = new Date().toISOString();
    const payloadWithoutChecksum: Omit<SettingsSyncPayload, "checksum"> = {
      global: globalSettings,
      projects: Object.keys(projectSettings).length > 0 ? projectSettings : undefined,
      providerAuth: options?.providerAuth,
      exportedAt,
      version: 1,
    };

    // Compute checksum before adding it
    const checksum = createHash("sha256")
      .update(JSON.stringify(payloadWithoutChecksum))
      .digest("hex");

    return {
      ...payloadWithoutChecksum,
      checksum,
    };
  }

  /**
   * Apply incoming settings from a remote node.
   *
   * Merge semantics:
   * - Global settings: shallow merge, local-wins (only applies remote values where local is undefined)
   * - Project settings: matches by name, merges settings (local-wins), skips non-existent projects
   * - Provider auth: NOT applied to local storage (caller handles auth application)
   *
   * @param payload - Settings sync payload from remote node
   * @returns Sync result with counts of applied settings
   */
  async applyRemoteSettings(payload: SettingsSyncPayload): Promise<SettingsSyncResult> {
    this.ensureInitialized();

    // Validate version
    if (payload.version !== 1) {
      return {
        success: false,
        globalCount: 0,
        projectCount: 0,
        authCount: 0,
        error: `Unsupported settings sync version: ${payload.version}`,
      };
    }

    // Validate checksum
    const payloadWithoutChecksum: Omit<SettingsSyncPayload, "checksum"> = {
      global: payload.global,
      projects: payload.projects,
      providerAuth: payload.providerAuth,
      exportedAt: payload.exportedAt,
      version: payload.version,
    };
    const computedChecksum = createHash("sha256")
      .update(JSON.stringify(payloadWithoutChecksum))
      .digest("hex");

    if (computedChecksum !== payload.checksum) {
      return {
        success: false,
        globalCount: 0,
        projectCount: 0,
        authCount: 0,
        error: "Checksum mismatch - payload may have been corrupted",
      };
    }

    let globalCount = 0;
    let projectCount = 0;
    const authCount = payload.providerAuth ? Object.keys(payload.providerAuth).length : 0;

    // Apply global settings (shallow merge, local-wins)
    if (payload.global) {
      // The actual application of global settings is handled by the caller (dashboard route)
      // since CentralCore doesn't have access to GlobalSettingsStore.
      // We simply count the number of global settings entries for reporting.
      globalCount = Object.keys(payload.global).length;
    }

    // Apply project settings (match by name, local-wins merge)
    if (payload.projects) {
      const localProjects = await this.listProjects();
      const projectsByName = new Map(localProjects.map((p) => [p.name, p]));

      for (const [projectName, remoteSettings] of Object.entries(payload.projects)) {
        const localProject = projectsByName.get(projectName);
        if (localProject) {
          // Merge settings: local values take precedence
          const mergedSettings: ProjectSettings = {
            ...remoteSettings,
            ...localProject.settings,
          };
          await this.updateProject(localProject.id, { settings: mergedSettings });
          projectCount++;
        }
      }
    }

    // Provider auth is transported but NOT applied here
    // The caller (dashboard route) handles auth application

    return {
      success: true,
      globalCount,
      projectCount,
      authCount,
    };
  }

  /**
   * Get settings sync state between local node and a remote node.
   *
   * @param remoteNodeId - Remote node ID
   * @returns SettingsSyncState or null if no sync has occurred
   */
  async getSettingsSyncState(remoteNodeId: string): Promise<SettingsSyncState | null> {
    this.ensureInitialized();

    const localNode = await this.getLocalNode();
    if (!localNode) {
      throw new Error("Local node not found");
    }

    const row = this.db!.prepare(
      "SELECT * FROM settingsSyncState WHERE nodeId = ? AND remoteNodeId = ?"
    ).get(localNode.id, remoteNodeId) as
      | {
          nodeId: string;
          remoteNodeId: string;
          lastSyncedAt: string | null;
          localChecksum: string | null;
          remoteChecksum: string | null;
          syncCount: number;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;

    return this.rowToSettingsSyncState(row);
  }

  /**
   * Update settings sync state between local node and a remote node.
   * Creates a new row on first call, updates on subsequent calls.
   * Auto-increments syncCount.
   *
   * @param remoteNodeId - Remote node ID
   * @param updates - Fields to update
   * @returns Updated SettingsSyncState
   */
  async updateSettingsSyncState(
    remoteNodeId: string,
    updates: Partial<Pick<SettingsSyncState, "lastSyncedAt" | "localChecksum" | "remoteChecksum" | "syncCount">>
  ): Promise<SettingsSyncState> {
    this.ensureInitialized();

    const localNode = await this.getLocalNode();
    if (!localNode) {
      throw new Error("Local node not found");
    }

    const now = new Date().toISOString();
    const existing = await this.getSettingsSyncState(remoteNodeId);

    const syncCount = existing ? (updates.syncCount ?? existing.syncCount + 1) : 1;
    const lastSyncedAt = updates.lastSyncedAt ?? existing?.lastSyncedAt ?? null;
    const localChecksum = updates.localChecksum ?? existing?.localChecksum ?? null;
    const remoteChecksum = updates.remoteChecksum ?? existing?.remoteChecksum ?? null;

    if (existing) {
      // Update existing row
      this.db!.prepare(
        `UPDATE settingsSyncState SET
          lastSyncedAt = ?,
          localChecksum = ?,
          remoteChecksum = ?,
          syncCount = ?,
          updatedAt = ?
         WHERE nodeId = ? AND remoteNodeId = ?`
      ).run(lastSyncedAt, localChecksum, remoteChecksum, syncCount, now, localNode.id, remoteNodeId);
    } else {
      // Insert new row
      this.db!.prepare(
        `INSERT INTO settingsSyncState (nodeId, remoteNodeId, lastSyncedAt, localChecksum, remoteChecksum, syncCount, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(localNode.id, remoteNodeId, lastSyncedAt, localChecksum, remoteChecksum, syncCount, now, now);
    }

    this.db!.bumpLastModified();

    const updated = await this.getSettingsSyncState(remoteNodeId);
    if (!updated) {
      throw new Error("Failed to retrieve updated settings sync state");
    }

    this.emit("settings:sync:completed", {
      nodeId: localNode.id,
      remoteNodeId,
      state: updated,
    });

    return updated;
  }

  private rowToSettingsSyncState(row: {
    nodeId: string;
    remoteNodeId: string;
    lastSyncedAt: string | null;
    localChecksum: string | null;
    remoteChecksum: string | null;
    syncCount: number;
    createdAt: string;
    updatedAt: string;
  }): SettingsSyncState {
    return {
      nodeId: row.nodeId,
      remoteNodeId: row.remoteNodeId,
      lastSyncedAt: row.lastSyncedAt,
      localChecksum: row.localChecksum,
      remoteChecksum: row.remoteChecksum,
      syncCount: row.syncCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
