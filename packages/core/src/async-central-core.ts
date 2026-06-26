/**
 * Async Drizzle CentralCore helpers (migrate-central-core-to-postgres).
 *
 * FNXC:CentralCore 2026-06-26-12:00:
 * Async equivalents of the sync SQLite CentralCore call sites in
 * central-core.ts. In the new single-database topology ALL central data
 * (project registry, node registry, project health, unified activity feed,
 * global concurrency, peer nodes, mesh shared state, managed docker nodes,
 * settings sync, project/node path mappings) lives in the SAME embedded
 * PostgreSQL database as the project + archive data, addressed via the
 * `central` Drizzle schema namespace. CentralCore receives the SAME
 * AsyncDataLayer/connection that TaskStore and the satellite stores use — NOT
 * a separate connection. When backendMode is active, CentralCore delegates to
 * these helpers via the shared connection pool.
 *
 * SQLite → PostgreSQL notes (see library/satellite-store-migration-pattern.md):
 *   - `db.prepare(sql).get/run/all()` → awaited Drizzle queries against
 *     `schema.central.*` table refs.
 *   - `db.transaction(fn)` (BEGIN IMMEDIATE + SAVEPOINT nesting) →
 *     `layer.transactionImmediate(async (tx) => ...)` (READ WRITE access mode;
 *     PostgreSQL uses MVCC, no BEGIN IMMEDIATE). All writes inside the callback
 *     commit atomically; a thrown error rolls back every write (VAL-DATA-002,
 *     VAL-DATA-003).
 *   - JSON columns (`settings`, `capabilities`, `systemMetrics`, `knownPeers`,
 *     `versionInfo`, `pluginVersions`, `dockerConfig`, `metadata`, `payload`)
 *     are `jsonb` in PostgreSQL, so Drizzle returns them already-parsed as JS
 *     values. On write, pass the JS value directly. The sync store used
 *     `toJson()`/`fromJson()` against TEXT columns; the helpers pass objects
 *     and use `null` for absent values.
 *   - The integer-as-boolean columns (`enabled`, `aiScanOnLoad`,
 *     `persistentStorage`) stay integer (0/1); `row.persistentStorage === 1`
 *     checks still work.
 *   - `INSERT ... ON CONFLICT(...) DO UPDATE` upserts map directly to
 *     Drizzle `insert().onConflictDoUpdate()`.
 *   - Composite-key upserts map to `onConflictDoUpdate({ target: [...] })`.
 *
 * Single-database topology (architecture.md "Single-database topology"):
 *   The central schema and the project/archive schemas share one PostgreSQL
 *   cluster. Cross-table foreign keys (project_node_path_mappings → projects,
 *   project_health → projects, central_activity_log → projects) reference the
 *   central.projects table and cascade correctly.
 *
 * These helpers program against the stable `AsyncDataLayer` interface so the
 * backend swap is invisible to the CentralCore contract. The sync SQLite path
 * remains as the legacy fallback for `FUSION_NO_EMBEDDED_PG` mode.
 */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import type {
  ActivityEventType,
  AgentCapability,
  CentralActivityLogEntry,
  DockerHostConfig,
  DockerNodeConfig,
  DockerNodeStatus,
  GlobalConcurrencyState,
  IsolationMode,
  ManagedDockerNode,
  MeshSnapshotQuery,
  MeshSnapshotRecord,
  MeshSnapshotRecordInput,
  MeshWriteQueueEntry,
  MeshWriteQueueFilter,
  MeshWriteQueueInput,
  NodeConfig,
  NodeStatus,
  NodeVersionInfo,
  PeerNode,
  ProjectHealth,
  ProjectNodePathMapping,
  ProjectSettings,
  ProjectStatus,
  RegisteredProject,
  SettingsSyncState,
  SystemMetrics,
} from "./types.js";
import { randomUUID } from "node:crypto";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

// ── Column-select helpers ──────────────────────────────────────────────────
// CentralCore's sync path used SELECT * and read every column. The async
// helpers project explicit column sets so the row shapes are stable and the
// jsonb columns come back already-parsed.

const projectColumns = {
  id: schema.central.projects.id,
  name: schema.central.projects.name,
  path: schema.central.projects.path,
  status: schema.central.projects.status,
  isolationMode: schema.central.projects.isolationMode,
  createdAt: schema.central.projects.createdAt,
  updatedAt: schema.central.projects.updatedAt,
  lastActivityAt: schema.central.projects.lastActivityAt,
  nodeId: schema.central.projects.nodeId,
  settings: schema.central.projects.settings,
};

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  status: string;
  isolationMode: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  nodeId: string | null;
  settings: unknown;
}

function mapProjectRow(row: ProjectRow | undefined): RegisteredProject | undefined {
  if (!row) return undefined;
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
    settings: (row.settings as ProjectSettings | null) ?? undefined,
  };
}

const nodeColumns = {
  id: schema.central.nodes.id,
  name: schema.central.nodes.name,
  type: schema.central.nodes.type,
  url: schema.central.nodes.url,
  apiKey: schema.central.nodes.apiKey,
  status: schema.central.nodes.status,
  capabilities: schema.central.nodes.capabilities,
  systemMetrics: schema.central.nodes.systemMetrics,
  knownPeers: schema.central.nodes.knownPeers,
  versionInfo: schema.central.nodes.versionInfo,
  pluginVersions: schema.central.nodes.pluginVersions,
  dockerConfig: schema.central.nodes.dockerConfig,
  maxConcurrent: schema.central.nodes.maxConcurrent,
  createdAt: schema.central.nodes.createdAt,
  updatedAt: schema.central.nodes.updatedAt,
};

interface NodeRow {
  id: string;
  name: string;
  type: string;
  url: string | null;
  apiKey: string | null;
  status: string;
  capabilities: unknown;
  systemMetrics: unknown;
  knownPeers: unknown;
  versionInfo: unknown;
  pluginVersions: unknown;
  dockerConfig: unknown;
  maxConcurrent: number;
  createdAt: string;
  updatedAt: string;
}

function mapNodeRow(row: NodeRow | undefined): NodeConfig | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type as NodeConfig["type"],
    url: row.url ?? undefined,
    apiKey: row.apiKey ?? undefined,
    status: row.status as NodeStatus,
    capabilities: (row.capabilities as AgentCapability[] | null) ?? undefined,
    systemMetrics: (row.systemMetrics as SystemMetrics | null) ?? undefined,
    knownPeers: (row.knownPeers as string[] | null) ?? undefined,
    versionInfo: (row.versionInfo as NodeVersionInfo | null) ?? undefined,
    pluginVersions: (row.pluginVersions as Record<string, string> | null) ?? undefined,
    dockerConfig: (row.dockerConfig as DockerNodeConfig | null) ?? undefined,
    maxConcurrent: row.maxConcurrent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const healthColumns = {
  projectId: schema.central.projectHealth.projectId,
  status: schema.central.projectHealth.status,
  activeTaskCount: schema.central.projectHealth.activeTaskCount,
  inFlightAgentCount: schema.central.projectHealth.inFlightAgentCount,
  lastActivityAt: schema.central.projectHealth.lastActivityAt,
  lastErrorAt: schema.central.projectHealth.lastErrorAt,
  lastErrorMessage: schema.central.projectHealth.lastErrorMessage,
  totalTasksCompleted: schema.central.projectHealth.totalTasksCompleted,
  totalTasksFailed: schema.central.projectHealth.totalTasksFailed,
  averageTaskDurationMs: schema.central.projectHealth.averageTaskDurationMs,
  updatedAt: schema.central.projectHealth.updatedAt,
};

interface HealthRow {
  projectId: string;
  status: string;
  activeTaskCount: number | null;
  inFlightAgentCount: number | null;
  lastActivityAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  totalTasksCompleted: number | null;
  totalTasksFailed: number | null;
  averageTaskDurationMs: number | null;
  updatedAt: string;
}

function mapHealthRow(row: HealthRow | undefined): ProjectHealth | undefined {
  if (!row) return undefined;
  return {
    projectId: row.projectId,
    status: row.status as ProjectStatus,
    activeTaskCount: row.activeTaskCount ?? 0,
    inFlightAgentCount: row.inFlightAgentCount ?? 0,
    lastActivityAt: row.lastActivityAt ?? undefined,
    lastErrorAt: row.lastErrorAt ?? undefined,
    lastErrorMessage: row.lastErrorMessage ?? undefined,
    totalTasksCompleted: row.totalTasksCompleted ?? 0,
    totalTasksFailed: row.totalTasksFailed ?? 0,
    averageTaskDurationMs: row.averageTaskDurationMs ?? undefined,
    updatedAt: row.updatedAt,
  };
}

const activityColumns = {
  id: schema.central.centralActivityLog.id,
  timestamp: schema.central.centralActivityLog.timestamp,
  type: schema.central.centralActivityLog.type,
  projectId: schema.central.centralActivityLog.projectId,
  projectName: schema.central.centralActivityLog.projectName,
  taskId: schema.central.centralActivityLog.taskId,
  taskTitle: schema.central.centralActivityLog.taskTitle,
  details: schema.central.centralActivityLog.details,
  metadata: schema.central.centralActivityLog.metadata,
};

interface ActivityRow {
  id: string;
  timestamp: string;
  type: string;
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskTitle: string | null;
  details: string;
  metadata: unknown;
}

function mapActivityRow(row: ActivityRow): CentralActivityLogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    type: row.type as ActivityEventType,
    projectId: row.projectId,
    projectName: row.projectName,
    taskId: row.taskId ?? undefined,
    taskTitle: row.taskTitle ?? undefined,
    details: row.details,
    metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
  };
}

const managedDockerColumns = {
  id: schema.central.managedDockerNodes.id,
  nodeId: schema.central.managedDockerNodes.nodeId,
  name: schema.central.managedDockerNodes.name,
  imageName: schema.central.managedDockerNodes.imageName,
  imageTag: schema.central.managedDockerNodes.imageTag,
  containerId: schema.central.managedDockerNodes.containerId,
  status: schema.central.managedDockerNodes.status,
  hostConfig: schema.central.managedDockerNodes.hostConfig,
  envVars: schema.central.managedDockerNodes.envVars,
  volumeMounts: schema.central.managedDockerNodes.volumeMounts,
  resourceSizing: schema.central.managedDockerNodes.resourceSizing,
  extraClis: schema.central.managedDockerNodes.extraClis,
  persistentStorage: schema.central.managedDockerNodes.persistentStorage,
  reachableUrl: schema.central.managedDockerNodes.reachableUrl,
  apiKey: schema.central.managedDockerNodes.apiKey,
  errorMessage: schema.central.managedDockerNodes.errorMessage,
  createdAt: schema.central.managedDockerNodes.createdAt,
  updatedAt: schema.central.managedDockerNodes.updatedAt,
};

interface ManagedDockerRow {
  id: string;
  nodeId: string | null;
  name: string;
  imageName: string;
  imageTag: string;
  containerId: string | null;
  status: string;
  hostConfig: unknown;
  envVars: unknown;
  volumeMounts: unknown;
  resourceSizing: unknown;
  extraClis: unknown;
  persistentStorage: number;
  reachableUrl: string | null;
  apiKey: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapManagedDockerRow(row: ManagedDockerRow | undefined): ManagedDockerNode | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    nodeId: row.nodeId,
    name: row.name,
    imageName: row.imageName,
    imageTag: row.imageTag,
    containerId: row.containerId,
    status: row.status as DockerNodeStatus,
    hostConfig: (row.hostConfig as DockerHostConfig | null) ?? {},
    envVars: (row.envVars as Record<string, string> | null) ?? {},
    volumeMounts: (row.volumeMounts as ManagedDockerNode["volumeMounts"] | null) ?? [],
    resourceSizing: (row.resourceSizing as ManagedDockerNode["resourceSizing"] | null) ?? {},
    extraClis: (row.extraClis as ManagedDockerNode["extraClis"] | null) ?? [],
    persistentStorage: row.persistentStorage === 1,
    reachableUrl: row.reachableUrl,
    apiKey: row.apiKey,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const peerColumns = {
  id: schema.central.peerNodes.id,
  nodeId: schema.central.peerNodes.nodeId,
  peerNodeId: schema.central.peerNodes.peerNodeId,
  name: schema.central.peerNodes.name,
  url: schema.central.peerNodes.url,
  status: schema.central.peerNodes.status,
  lastSeen: schema.central.peerNodes.lastSeen,
  connectedAt: schema.central.peerNodes.connectedAt,
};

interface PeerRow {
  id: string;
  nodeId: string;
  peerNodeId: string;
  name: string;
  url: string;
  status: string;
  lastSeen: string;
  connectedAt: string;
}

function mapPeerRow(row: PeerRow): PeerNode {
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

const mappingColumns = {
  projectId: schema.central.projectNodePathMappings.projectId,
  nodeId: schema.central.projectNodePathMappings.nodeId,
  path: schema.central.projectNodePathMappings.path,
  createdAt: schema.central.projectNodePathMappings.createdAt,
  updatedAt: schema.central.projectNodePathMappings.updatedAt,
};

interface MappingRow {
  projectId: string;
  nodeId: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

function mapMappingRow(row: MappingRow): ProjectNodePathMapping {
  return {
    projectId: row.projectId,
    nodeId: row.nodeId,
    path: row.path,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const snapshotColumns = {
  nodeId: schema.central.meshSharedSnapshots.nodeId,
  projectId: schema.central.meshSharedSnapshots.projectId,
  scope: schema.central.meshSharedSnapshots.scope,
  payload: schema.central.meshSharedSnapshots.payload,
  snapshotVersion: schema.central.meshSharedSnapshots.snapshotVersion,
  capturedAt: schema.central.meshSharedSnapshots.capturedAt,
  sourceNodeId: schema.central.meshSharedSnapshots.sourceNodeId,
  sourceRunId: schema.central.meshSharedSnapshots.sourceRunId,
  staleAfter: schema.central.meshSharedSnapshots.staleAfter,
  updatedAt: schema.central.meshSharedSnapshots.updatedAt,
};

interface SnapshotRow {
  nodeId: string;
  projectId: string | null;
  scope: string;
  payload: unknown;
  snapshotVersion: string;
  capturedAt: string;
  sourceNodeId: string | null;
  sourceRunId: string | null;
  staleAfter: string | null;
  updatedAt: string;
}

function mapSnapshotRow(row: SnapshotRow | undefined): MeshSnapshotRecord | null {
  if (!row) return null;
  return {
    nodeId: row.nodeId,
    projectId: row.projectId,
    scope: row.scope,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    snapshotVersion: row.snapshotVersion,
    capturedAt: row.capturedAt,
    sourceNodeId: row.sourceNodeId,
    sourceRunId: row.sourceRunId,
    staleAfter: row.staleAfter,
    updatedAt: row.updatedAt,
  };
}

const meshWriteColumns = {
  id: schema.central.meshWriteQueue.id,
  originNodeId: schema.central.meshWriteQueue.originNodeId,
  targetNodeId: schema.central.meshWriteQueue.targetNodeId,
  projectId: schema.central.meshWriteQueue.projectId,
  scope: schema.central.meshWriteQueue.scope,
  entityType: schema.central.meshWriteQueue.entityType,
  entityId: schema.central.meshWriteQueue.entityId,
  operation: schema.central.meshWriteQueue.operation,
  payload: schema.central.meshWriteQueue.payload,
  intentVersion: schema.central.meshWriteQueue.intentVersion,
  status: schema.central.meshWriteQueue.status,
  attemptCount: schema.central.meshWriteQueue.attemptCount,
  lastAttemptAt: schema.central.meshWriteQueue.lastAttemptAt,
  lastError: schema.central.meshWriteQueue.lastError,
  createdAt: schema.central.meshWriteQueue.createdAt,
  updatedAt: schema.central.meshWriteQueue.updatedAt,
  appliedAt: schema.central.meshWriteQueue.appliedAt,
};

interface MeshWriteRow {
  id: string;
  originNodeId: string;
  targetNodeId: string;
  projectId: string | null;
  scope: string;
  entityType: string;
  entityId: string;
  operation: string;
  payload: unknown;
  intentVersion: string;
  status: MeshWriteQueueEntry["status"];
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

function mapMeshWriteRow(row: MeshWriteRow): MeshWriteQueueEntry {
  return {
    ...row,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
  };
}

// ── Init / bootstrap ────────────────────────────────────────────────────────

/**
 * FNXC:CentralCore 2026-06-26-12:05:
 * Backend-mode init: ensure the singleton globalConcurrency row (id=1) and
 * the local node exist. Mirrors the sync CentralCore.init() local-node
 * bootstrap. The PostgreSQL schema baseline already created the tables; this
 * only seeds the runtime singletons. Idempotent.
 */
export async function ensureBackendBootstrap(layer: AsyncDataLayer): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    // Ensure the globalConcurrency singleton row exists (CHECK constraint forces id=1).
    const concurrency = (await tx
      .select()
      .from(schema.central.globalConcurrency)
      .where(eq(schema.central.globalConcurrency.id, 1))
      .limit(1)) as { id: number; globalMaxConcurrent: number | null }[];
    if (concurrency.length === 0) {
      await tx.insert(schema.central.globalConcurrency).values({
        id: 1,
        globalMaxConcurrent: 4,
        currentlyActive: 0,
        queuedCount: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    // Ensure the centralSettings singleton row exists.
    const settings = (await tx
      .select()
      .from(schema.central.centralSettings)
      .where(eq(schema.central.centralSettings.id, 1))
      .limit(1)) as { id: number }[];
    if (settings.length === 0) {
      await tx.insert(schema.central.centralSettings).values({
        id: 1,
        defaultProjectId: null,
        updatedAt: new Date().toISOString(),
      });
    }

    // Ensure a local node exists. Mirror sync: reuse maxConcurrent from the
    // globalConcurrency row (default 2 when unset, matching sync init()).
    const existingLocal = await tx
      .select({ id: schema.central.nodes.id })
      .from(schema.central.nodes)
      .where(eq(schema.central.nodes.type, "local"))
      .limit(1);
    if (existingLocal.length === 0) {
      const maxConcurrent = concurrency[0]?.globalMaxConcurrent ?? 2;
      const now = new Date().toISOString();
      const localId = `node_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await tx.insert(schema.central.nodes).values({
        id: localId,
        name: "local",
        type: "local",
        status: "online",
        maxConcurrent,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
}

// ── Project Registry ────────────────────────────────────────────────────────

export async function getProject(
  handle: QueryHandle,
  id: string,
): Promise<RegisteredProject | undefined> {
  const rows = (await handle
    .select(projectColumns)
    .from(schema.central.projects)
    .where(eq(schema.central.projects.id, id))
    .limit(1)) as ProjectRow[];
  return mapProjectRow(rows[0]);
}

export async function getProjectByPath(
  handle: QueryHandle,
  path: string,
): Promise<RegisteredProject | undefined> {
  const rows = (await handle
    .select(projectColumns)
    .from(schema.central.projects)
    .where(eq(schema.central.projects.path, path))
    .limit(1)) as ProjectRow[];
  return mapProjectRow(rows[0]);
}

export async function listProjects(handle: QueryHandle): Promise<RegisteredProject[]> {
  const rows = (await handle
    .select(projectColumns)
    .from(schema.central.projects)
    .orderBy(asc(schema.central.projects.name))) as ProjectRow[];
  return rows.map((row) => mapProjectRow(row)!).filter(Boolean);
}

/**
 * FNXC:CentralCore 2026-06-26-12:10:
 * Insert a project row + initial projectHealth row + local-node path mapping
 * atomically. Mirrors the sync insertProjectRow() transaction. The local node
 * is resolved inside the transaction (first node of type 'local' by createdAt).
 */
export async function insertProjectRow(
  layer: AsyncDataLayer,
  project: RegisteredProject,
  now: string,
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    await tx.insert(schema.central.projects).values({
      id: project.id,
      name: project.name,
      path: project.path,
      status: project.status,
      isolationMode: project.isolationMode,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastActivityAt: project.lastActivityAt ?? null,
      nodeId: project.nodeId ?? null,
      settings: (project.settings as unknown as Record<string, unknown> | null) ?? null,
    });

    const localNode = (await tx
      .select({ id: schema.central.nodes.id })
      .from(schema.central.nodes)
      .where(eq(schema.central.nodes.type, "local"))
      .orderBy(asc(schema.central.nodes.createdAt))
      .limit(1)) as { id: string }[];

    if (localNode.length > 0) {
      await tx
        .insert(schema.central.projectNodePathMappings)
        .values({
          projectId: project.id,
          nodeId: localNode[0].id,
          path: project.path,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.central.projectNodePathMappings.projectId,
            schema.central.projectNodePathMappings.nodeId,
          ],
          set: {
            path: project.path,
            updatedAt: now,
          },
        });
    }

    await tx.insert(schema.central.projectHealth).values({
      projectId: project.id,
      status: project.status,
      updatedAt: now,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
    });
  });
}

export async function deleteProject(handle: QueryHandle, id: string): Promise<void> {
  await handle.delete(schema.central.projects).where(eq(schema.central.projects.id, id));
}

export async function updateProject(
  layer: AsyncDataLayer,
  id: string,
  project: RegisteredProject,
  previousPath: string,
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    await tx
      .update(schema.central.projects)
      .set({
        name: project.name,
        path: project.path,
        status: project.status,
        isolationMode: project.isolationMode,
        updatedAt: project.updatedAt,
        lastActivityAt: project.lastActivityAt ?? null,
        nodeId: project.nodeId ?? null,
        settings: (project.settings as unknown as Record<string, unknown> | null) ?? null,
      })
      .where(eq(schema.central.projects.id, id));

    if (project.path !== previousPath) {
      const localNode = (await tx
        .select({ id: schema.central.nodes.id })
        .from(schema.central.nodes)
        .where(eq(schema.central.nodes.type, "local"))
        .orderBy(asc(schema.central.nodes.createdAt))
        .limit(1)) as { id: string }[];
      if (localNode.length > 0) {
        await tx
          .insert(schema.central.projectNodePathMappings)
          .values({
            projectId: id,
            nodeId: localNode[0].id,
            path: project.path,
            createdAt: project.updatedAt,
            updatedAt: project.updatedAt,
          })
          .onConflictDoUpdate({
            target: [
              schema.central.projectNodePathMappings.projectId,
              schema.central.projectNodePathMappings.nodeId,
            ],
            set: {
              path: project.path,
              updatedAt: project.updatedAt,
            },
          });
      }
    }
  });
}

/**
 * Reconcile stale projects still in "initializing" to "active". Mirrors the
 * sync reconcileProjectStatuses() transaction: updates both projects and
 * projectHealth atomically.
 */
export async function reconcileStaleProjectStatuses(
  layer: AsyncDataLayer,
): Promise<Array<{ projectId: string; previousStatus: string }>> {
  return layer.transactionImmediate(async (tx) => {
    const stale = (await tx
      .select({ id: schema.central.projects.id, status: schema.central.projects.status })
      .from(schema.central.projects)
      .where(eq(schema.central.projects.status, "initializing"))) as {
      id: string;
      status: string;
    }[];
    if (stale.length === 0) return [];
    const now = new Date().toISOString();
    const reconciled: Array<{ projectId: string; previousStatus: string }> = [];
    for (const project of stale) {
      await tx
        .update(schema.central.projects)
        .set({ status: "active", updatedAt: now })
        .where(eq(schema.central.projects.id, project.id));
      await tx
        .update(schema.central.projectHealth)
        .set({ status: "active", updatedAt: now })
        .where(eq(schema.central.projectHealth.projectId, project.id));
      reconciled.push({ projectId: project.id, previousStatus: project.status });
    }
    return reconciled;
  });
}

export async function assignProjectToNode(
  handle: QueryHandle,
  projectId: string,
  nodeId: string,
  now: string,
): Promise<void> {
  await handle
    .update(schema.central.projects)
    .set({ nodeId, updatedAt: now })
    .where(eq(schema.central.projects.id, projectId));
}

export async function unassignProjectFromNode(
  handle: QueryHandle,
  projectId: string,
  now: string,
): Promise<void> {
  await handle
    .update(schema.central.projects)
    .set({ nodeId: null, updatedAt: now })
    .where(eq(schema.central.projects.id, projectId));
}

// ── Node Registry ───────────────────────────────────────────────────────────

export async function getNode(handle: QueryHandle, id: string): Promise<NodeConfig | undefined> {
  const rows = (await handle
    .select(nodeColumns)
    .from(schema.central.nodes)
    .where(eq(schema.central.nodes.id, id))
    .limit(1)) as NodeRow[];
  return mapNodeRow(rows[0]);
}

export async function getNodeByName(
  handle: QueryHandle,
  name: string,
): Promise<NodeConfig | undefined> {
  const rows = (await handle
    .select(nodeColumns)
    .from(schema.central.nodes)
    .where(eq(schema.central.nodes.name, name))
    .limit(1)) as NodeRow[];
  return mapNodeRow(rows[0]);
}

export async function listNodes(handle: QueryHandle): Promise<NodeConfig[]> {
  const rows = (await handle
    .select(nodeColumns)
    .from(schema.central.nodes)
    .orderBy(asc(schema.central.nodes.name))) as NodeRow[];
  return rows.map((row) => mapNodeRow(row)!).filter(Boolean);
}

export async function getLocalNode(handle: QueryHandle): Promise<NodeConfig | undefined> {
  const rows = (await handle
    .select(nodeColumns)
    .from(schema.central.nodes)
    .where(eq(schema.central.nodes.type, "local"))
    .orderBy(asc(schema.central.nodes.createdAt))
    .limit(1)) as NodeRow[];
  return mapNodeRow(rows[0]);
}

export async function insertNode(handle: QueryHandle, node: NodeConfig): Promise<void> {
  await handle.insert(schema.central.nodes).values({
    id: node.id,
    name: node.name,
    type: node.type,
    url: node.url ?? null,
    apiKey: node.apiKey ?? null,
    status: node.status,
    capabilities: (node.capabilities as unknown[] | null) ?? null,
    dockerConfig: (node.dockerConfig as unknown as Record<string, unknown> | null) ?? null,
    maxConcurrent: node.maxConcurrent,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  });
}

/**
 * Register a gossip peer node. Mirrors sync registerGossipPeer() which does
 * NOT pass systemMetrics/dockerConfig (only capabilities/systemMetrics-style
 * fields via the gossip payload).
 */
export async function insertGossipPeer(handle: QueryHandle, node: NodeConfig): Promise<void> {
  await handle.insert(schema.central.nodes).values({
    id: node.id,
    name: node.name,
    type: node.type,
    url: node.url ?? null,
    status: node.status,
    capabilities: (node.capabilities as unknown[] | null) ?? null,
    systemMetrics: (node.systemMetrics as unknown as Record<string, unknown> | null) ?? null,
    maxConcurrent: node.maxConcurrent,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  });
}

export async function deleteNode(handle: QueryHandle, id: string): Promise<void> {
  await handle.delete(schema.central.nodes).where(eq(schema.central.nodes.id, id));
}

export async function clearProjectNodeAssignments(
  handle: QueryHandle,
  nodeId: string,
  now: string,
): Promise<void> {
  await handle
    .update(schema.central.projects)
    .set({ nodeId: null, updatedAt: now })
    .where(eq(schema.central.projects.nodeId, nodeId));
}

export async function updateNodeColumns(
  handle: QueryHandle,
  id: string,
  values: Partial<{
    name: string;
    type: string;
    url: string | null;
    apiKey: string | null;
    status: string;
    capabilities: unknown;
    systemMetrics: unknown;
    knownPeers: unknown;
    versionInfo: unknown;
    pluginVersions: unknown;
    dockerConfig: unknown;
    maxConcurrent: number;
    updatedAt: string;
  }>,
): Promise<void> {
  await handle
    .update(schema.central.nodes)
    .set(values)
    .where(eq(schema.central.nodes.id, id));
}

// ── Managed Docker Nodes ────────────────────────────────────────────────────

export async function getManagedDockerNode(
  handle: QueryHandle,
  id: string,
): Promise<ManagedDockerNode | undefined> {
  const rows = (await handle
    .select(managedDockerColumns)
    .from(schema.central.managedDockerNodes)
    .where(eq(schema.central.managedDockerNodes.id, id))
    .limit(1)) as ManagedDockerRow[];
  return mapManagedDockerRow(rows[0]);
}

export async function getManagedDockerNodeByName(
  handle: QueryHandle,
  name: string,
): Promise<ManagedDockerNode | undefined> {
  const rows = (await handle
    .select(managedDockerColumns)
    .from(schema.central.managedDockerNodes)
    .where(eq(schema.central.managedDockerNodes.name, name))
    .limit(1)) as ManagedDockerRow[];
  return mapManagedDockerRow(rows[0]);
}

export async function listManagedDockerNodes(handle: QueryHandle): Promise<ManagedDockerNode[]> {
  const rows = (await handle
    .select(managedDockerColumns)
    .from(schema.central.managedDockerNodes)
    .orderBy(asc(schema.central.managedDockerNodes.name))) as ManagedDockerRow[];
  return rows.map((row) => mapManagedDockerRow(row)!).filter(Boolean);
}

export async function insertManagedDockerNode(
  handle: QueryHandle,
  node: ManagedDockerNode,
): Promise<void> {
  await handle.insert(schema.central.managedDockerNodes).values({
    id: node.id,
    nodeId: node.nodeId,
    name: node.name,
    imageName: node.imageName,
    imageTag: node.imageTag,
    containerId: node.containerId,
    status: node.status,
    hostConfig: node.hostConfig ?? {},
    envVars: node.envVars ?? {},
    volumeMounts: node.volumeMounts ?? [],
    resourceSizing: node.resourceSizing ?? {},
    extraClis: node.extraClis ?? [],
    persistentStorage: node.persistentStorage ? 1 : 0,
    reachableUrl: node.reachableUrl,
    apiKey: node.apiKey,
    errorMessage: node.errorMessage,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  });
}

export async function updateManagedDockerNodeRow(
  handle: QueryHandle,
  id: string,
  node: ManagedDockerNode,
): Promise<void> {
  await handle
    .update(schema.central.managedDockerNodes)
    .set({
      nodeId: node.nodeId,
      name: node.name,
      imageName: node.imageName,
      imageTag: node.imageTag,
      containerId: node.containerId,
      status: node.status,
      hostConfig: node.hostConfig ?? {},
      envVars: node.envVars ?? {},
      volumeMounts: node.volumeMounts ?? [],
      resourceSizing: node.resourceSizing ?? {},
      extraClis: node.extraClis ?? [],
      persistentStorage: node.persistentStorage ? 1 : 0,
      reachableUrl: node.reachableUrl,
      apiKey: node.apiKey,
      errorMessage: node.errorMessage,
      updatedAt: node.updatedAt,
    })
    .where(eq(schema.central.managedDockerNodes.id, id));
}

export async function deleteManagedDockerNode(handle: QueryHandle, id: string): Promise<void> {
  await handle
    .delete(schema.central.managedDockerNodes)
    .where(eq(schema.central.managedDockerNodes.id, id));
}

// ── Peer Nodes (mesh) ───────────────────────────────────────────────────────

export async function listPeers(handle: QueryHandle, nodeId: string): Promise<PeerNode[]> {
  const rows = (await handle
    .select(peerColumns)
    .from(schema.central.peerNodes)
    .where(eq(schema.central.peerNodes.nodeId, nodeId))
    .orderBy(asc(schema.central.peerNodes.name))) as PeerRow[];
  return rows.map((row) => mapPeerRow(row));
}

export async function getPeer(
  handle: QueryHandle,
  nodeId: string,
  peerNodeId: string,
): Promise<PeerNode | undefined> {
  const rows = (await handle
    .select(peerColumns)
    .from(schema.central.peerNodes)
    .where(
      and(
        eq(schema.central.peerNodes.nodeId, nodeId),
        eq(schema.central.peerNodes.peerNodeId, peerNodeId),
      ),
    )
    .limit(1)) as PeerRow[];
  return rows[0] ? mapPeerRow(rows[0]) : undefined;
}

/**
 * Upsert a peer node + update the parent node's knownPeers set atomically.
 * Mirrors the sync registerPeerNode() transaction.
 */
export async function upsertPeerNode(
  layer: AsyncDataLayer,
  input: {
    nodeId: string;
    peerNodeId: string;
    name: string;
    url: string;
    now: string;
    existingKnownPeers: string[];
  },
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    const peerId = `peer_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await tx
      .insert(schema.central.peerNodes)
      .values({
        id: peerId,
        nodeId: input.nodeId,
        peerNodeId: input.peerNodeId,
        name: input.name,
        url: input.url,
        status: "offline",
        lastSeen: input.now,
        connectedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [schema.central.peerNodes.nodeId, schema.central.peerNodes.peerNodeId],
        set: {
          name: input.name,
          url: input.url,
          status: "offline",
          lastSeen: input.now,
        },
      });

    const knownPeers = Array.from(new Set([...input.existingKnownPeers, input.peerNodeId]));
    await tx
      .update(schema.central.nodes)
      .set({ knownPeers, updatedAt: input.now })
      .where(eq(schema.central.nodes.id, input.nodeId));
  });
}

export async function deletePeerNode(
  layer: AsyncDataLayer,
  nodeId: string,
  peerNodeId: string,
  existingKnownPeers: string[],
  now: string,
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    await tx
      .delete(schema.central.peerNodes)
      .where(
        and(
          eq(schema.central.peerNodes.nodeId, nodeId),
          eq(schema.central.peerNodes.peerNodeId, peerNodeId),
        ),
      );
    const knownPeers = existingKnownPeers.filter((id) => id !== peerNodeId);
    await tx
      .update(schema.central.nodes)
      .set({ knownPeers, updatedAt: now })
      .where(eq(schema.central.nodes.id, nodeId));
  });
}

// ── Project/Node Path Mappings ──────────────────────────────────────────────

export async function getProjectNodePathMapping(
  handle: QueryHandle,
  projectId: string,
  nodeId: string,
): Promise<ProjectNodePathMapping | undefined> {
  const rows = (await handle
    .select(mappingColumns)
    .from(schema.central.projectNodePathMappings)
    .where(
      and(
        eq(schema.central.projectNodePathMappings.projectId, projectId),
        eq(schema.central.projectNodePathMappings.nodeId, nodeId),
      ),
    )
    .limit(1)) as MappingRow[];
  return rows[0] ? mapMappingRow(rows[0]) : undefined;
}

export async function getProjectNodePath(
  handle: QueryHandle,
  projectId: string,
  nodeId: string,
): Promise<string | undefined> {
  const rows = (await handle
    .select({ path: schema.central.projectNodePathMappings.path })
    .from(schema.central.projectNodePathMappings)
    .where(
      and(
        eq(schema.central.projectNodePathMappings.projectId, projectId),
        eq(schema.central.projectNodePathMappings.nodeId, nodeId),
      ),
    )
    .limit(1)) as { path: string }[];
  return rows[0]?.path;
}

export async function listProjectNodePathMappings(
  handle: QueryHandle,
  filters?: { projectId?: string; nodeId?: string },
): Promise<ProjectNodePathMapping[]> {
  const conditions: SQL[] = [];
  if (filters?.projectId) {
    conditions.push(eq(schema.central.projectNodePathMappings.projectId, filters.projectId));
  }
  if (filters?.nodeId) {
    conditions.push(eq(schema.central.projectNodePathMappings.nodeId, filters.nodeId));
  }
  const query = handle
    .select(mappingColumns)
    .from(schema.central.projectNodePathMappings)
    .orderBy(
      asc(schema.central.projectNodePathMappings.projectId),
      asc(schema.central.projectNodePathMappings.nodeId),
    );
  const rows = (await (conditions.length > 0
    ? query.where(and(...conditions))
    : query)) as MappingRow[];
  return rows.map((row) => mapMappingRow(row));
}

export async function insertProjectNodePathMapping(
  handle: QueryHandle,
  input: { projectId: string; nodeId: string; path: string; now: string },
): Promise<void> {
  await handle.insert(schema.central.projectNodePathMappings).values({
    projectId: input.projectId,
    nodeId: input.nodeId,
    path: input.path,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export async function updateProjectNodePathMappingRow(
  handle: QueryHandle,
  input: { projectId: string; nodeId: string; path: string; now: string },
): Promise<void> {
  await handle
    .update(schema.central.projectNodePathMappings)
    .set({ path: input.path, updatedAt: input.now })
    .where(
      and(
        eq(schema.central.projectNodePathMappings.projectId, input.projectId),
        eq(schema.central.projectNodePathMappings.nodeId, input.nodeId),
      ),
    );
}

export async function deleteProjectNodePathMapping(
  handle: QueryHandle,
  projectId: string,
  nodeId: string,
): Promise<number> {
  const deleted = await handle
    .delete(schema.central.projectNodePathMappings)
    .where(
      and(
        eq(schema.central.projectNodePathMappings.projectId, projectId),
        eq(schema.central.projectNodePathMappings.nodeId, nodeId),
      ),
    )
    .returning({ projectId: schema.central.projectNodePathMappings.projectId });
  return deleted.length;
}

// ── Project Health ──────────────────────────────────────────────────────────

export async function getProjectHealth(
  handle: QueryHandle,
  projectId: string,
): Promise<ProjectHealth | undefined> {
  const rows = (await handle
    .select(healthColumns)
    .from(schema.central.projectHealth)
    .where(eq(schema.central.projectHealth.projectId, projectId))
    .limit(1)) as HealthRow[];
  return mapHealthRow(rows[0]);
}

export async function listAllHealth(handle: QueryHandle): Promise<ProjectHealth[]> {
  const rows = (await handle.select(healthColumns).from(schema.central.projectHealth)) as HealthRow[];
  return rows.map((row) => mapHealthRow(row)!).filter(Boolean);
}

export async function updateProjectHealthRow(
  handle: QueryHandle,
  projectId: string,
  health: ProjectHealth,
): Promise<void> {
  await handle
    .update(schema.central.projectHealth)
    .set({
      status: health.status,
      activeTaskCount: health.activeTaskCount,
      inFlightAgentCount: health.inFlightAgentCount,
      lastActivityAt: health.lastActivityAt ?? null,
      lastErrorAt: health.lastErrorAt ?? null,
      lastErrorMessage: health.lastErrorMessage ?? null,
      totalTasksCompleted: health.totalTasksCompleted,
      totalTasksFailed: health.totalTasksFailed,
      averageTaskDurationMs: health.averageTaskDurationMs ?? null,
      updatedAt: health.updatedAt,
    })
    .where(eq(schema.central.projectHealth.projectId, projectId));
}

export async function recordTaskCompletionRow(
  handle: QueryHandle,
  projectId: string,
  fields: {
    totalTasksCompleted: number;
    totalTasksFailed: number;
    averageTaskDurationMs: number | null;
    lastActivityAt: string;
    updatedAt: string;
  },
): Promise<void> {
  await handle
    .update(schema.central.projectHealth)
    .set({
      totalTasksCompleted: fields.totalTasksCompleted,
      totalTasksFailed: fields.totalTasksFailed,
      averageTaskDurationMs: fields.averageTaskDurationMs,
      lastActivityAt: fields.lastActivityAt,
      updatedAt: fields.updatedAt,
    })
    .where(eq(schema.central.projectHealth.projectId, projectId));
}

// ── Activity Feed ───────────────────────────────────────────────────────────

/**
 * Log an activity + bump the project's lastActivityAt atomically. Mirrors the
 * sync logActivity() transaction.
 */
export async function logActivityRow(
  layer: AsyncDataLayer,
  entry: CentralActivityLogEntry,
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    await tx.insert(schema.central.centralActivityLog).values({
      id: entry.id,
      timestamp: entry.timestamp,
      type: entry.type,
      projectId: entry.projectId,
      projectName: entry.projectName,
      taskId: entry.taskId ?? null,
      taskTitle: entry.taskTitle ?? null,
      details: entry.details,
      metadata: (entry.metadata as Record<string, unknown> | null) ?? null,
    });
    await tx
      .update(schema.central.projects)
      .set({ lastActivityAt: entry.timestamp })
      .where(eq(schema.central.projects.id, entry.projectId));
  });
}

export async function getRecentActivity(
  handle: QueryHandle,
  options?: { limit?: number; projectId?: string; types?: ActivityEventType[] },
): Promise<CentralActivityLogEntry[]> {
  const limit = options?.limit ?? 100;
  const conditions: SQL[] = [];
  if (options?.projectId) {
    conditions.push(eq(schema.central.centralActivityLog.projectId, options.projectId));
  }
  if (options?.types && options.types.length > 0) {
    conditions.push(inArray(schema.central.centralActivityLog.type, options.types));
  }
  const query = handle
    .select(activityColumns)
    .from(schema.central.centralActivityLog)
    .orderBy(desc(schema.central.centralActivityLog.timestamp))
    .limit(limit);
  const rows = (await (conditions.length > 0 ? query.where(and(...conditions)) : query)) as ActivityRow[];
  return rows.map((row) => mapActivityRow(row));
}

export async function getActivityCount(
  handle: QueryHandle,
  projectId?: string,
): Promise<number> {
  const rows = (await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.central.centralActivityLog)
    .where(
      projectId ? eq(schema.central.centralActivityLog.projectId, projectId) : undefined,
    )) as { count: number }[];
  return rows[0]?.count ?? 0;
}

export async function cleanupOldActivity(
  handle: QueryHandle,
  cutoff: string,
): Promise<number> {
  const deleted = await handle
    .delete(schema.central.centralActivityLog)
    .where(sql`${schema.central.centralActivityLog.timestamp} < ${cutoff}`)
    .returning({ id: schema.central.centralActivityLog.id });
  return deleted.length;
}

// ── Central Settings ────────────────────────────────────────────────────────

export async function getDefaultProjectId(handle: QueryHandle): Promise<string | undefined> {
  const rows = (await handle
    .select({ defaultProjectId: schema.central.centralSettings.defaultProjectId })
    .from(schema.central.centralSettings)
    .where(eq(schema.central.centralSettings.id, 1))
    .limit(1)) as { defaultProjectId: string | null }[];
  return rows[0]?.defaultProjectId ?? undefined;
}

export async function setDefaultProjectId(
  handle: QueryHandle,
  projectId: string | null,
  now: string,
): Promise<void> {
  await handle
    .update(schema.central.centralSettings)
    .set({ defaultProjectId: projectId, updatedAt: now })
    .where(eq(schema.central.centralSettings.id, 1));
}

// ── Global Concurrency ──────────────────────────────────────────────────────

export async function getGlobalConcurrencyRow(
  handle: QueryHandle,
): Promise<{ globalMaxConcurrent: number; currentlyActive: number; queuedCount: number }> {
  const rows = (await handle
    .select({
      globalMaxConcurrent: schema.central.globalConcurrency.globalMaxConcurrent,
      currentlyActive: schema.central.globalConcurrency.currentlyActive,
      queuedCount: schema.central.globalConcurrency.queuedCount,
    })
    .from(schema.central.globalConcurrency)
    .where(eq(schema.central.globalConcurrency.id, 1))
    .limit(1)) as {
    globalMaxConcurrent: number | null;
    currentlyActive: number | null;
    queuedCount: number | null;
  }[];
  return {
    globalMaxConcurrent: rows[0]?.globalMaxConcurrent ?? 4,
    currentlyActive: rows[0]?.currentlyActive ?? 0,
    queuedCount: rows[0]?.queuedCount ?? 0,
  };
}

export async function getProjectsActiveCounts(
  handle: QueryHandle,
): Promise<Array<{ projectId: string; inFlightAgentCount: number }>> {
  const rows = (await handle
    .select({
      projectId: schema.central.projectHealth.projectId,
      inFlightAgentCount: schema.central.projectHealth.inFlightAgentCount,
    })
    .from(schema.central.projectHealth)
    .where(sql`${schema.central.projectHealth.inFlightAgentCount} > 0`)) as {
    projectId: string;
    inFlightAgentCount: number | null;
  }[];
  return rows.map((row) => ({
    projectId: row.projectId,
    inFlightAgentCount: row.inFlightAgentCount ?? 0,
  }));
}

export async function getGlobalConcurrencyState(
  handle: QueryHandle,
): Promise<GlobalConcurrencyState> {
  const row = await getGlobalConcurrencyRow(handle);
  const activeCounts = await getProjectsActiveCounts(handle);
  const projectsActive: Record<string, number> = {};
  for (const { projectId, inFlightAgentCount } of activeCounts) {
    projectsActive[projectId] = inFlightAgentCount;
  }
  return {
    globalMaxConcurrent: row.globalMaxConcurrent,
    currentlyActive: row.currentlyActive,
    queuedCount: row.queuedCount,
    projectsActive,
  };
}

export async function updateGlobalConcurrencyRow(
  handle: QueryHandle,
  state: { globalMaxConcurrent: number; currentlyActive: number; queuedCount: number },
  now: string,
): Promise<void> {
  await handle
    .update(schema.central.globalConcurrency)
    .set({
      globalMaxConcurrent: state.globalMaxConcurrent,
      currentlyActive: state.currentlyActive,
      queuedCount: state.queuedCount,
      updatedAt: now,
    })
    .where(eq(schema.central.globalConcurrency.id, 1));
}

/**
 * Atomically acquire a global concurrency slot or queue the request. Mirrors
 * the sync acquireGlobalSlot() transaction: read the singleton row, increment
 * currentlyActive + project inFlightAgentCount if a slot is available,
 * otherwise increment queuedCount.
 */
export async function acquireGlobalSlotAtomic(
  layer: AsyncDataLayer,
  projectId: string,
): Promise<boolean> {
  return layer.transactionImmediate(async (tx) => {
    const row = await getGlobalConcurrencyRow(tx);
    const now = new Date().toISOString();
    if (row.currentlyActive < row.globalMaxConcurrent) {
      await tx
        .update(schema.central.globalConcurrency)
        .set({
          currentlyActive: row.currentlyActive + 1,
          updatedAt: now,
        })
        .where(eq(schema.central.globalConcurrency.id, 1));
      await tx
        .update(schema.central.projectHealth)
        .set({
          inFlightAgentCount: sql`${schema.central.projectHealth.inFlightAgentCount} + 1`,
          updatedAt: now,
        })
        .where(eq(schema.central.projectHealth.projectId, projectId));
      return true;
    }
    await tx
      .update(schema.central.globalConcurrency)
      .set({
        queuedCount: row.queuedCount + 1,
        updatedAt: now,
      })
      .where(eq(schema.central.globalConcurrency.id, 1));
    return false;
  });
}

/**
 * Atomically release a global concurrency slot. Mirrors the sync
 * releaseGlobalSlot() transaction with MAX(0, ...) clamping.
 */
export async function releaseGlobalSlotAtomic(
  layer: AsyncDataLayer,
  projectId: string,
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    const now = new Date().toISOString();
    await tx
      .update(schema.central.globalConcurrency)
      .set({
        currentlyActive: sql`GREATEST(0, ${schema.central.globalConcurrency.currentlyActive} - 1)`,
        updatedAt: now,
      })
      .where(eq(schema.central.globalConcurrency.id, 1));
    await tx
      .update(schema.central.projectHealth)
      .set({
        inFlightAgentCount: sql`GREATEST(0, ${schema.central.projectHealth.inFlightAgentCount} - 1)`,
        updatedAt: now,
      })
      .where(eq(schema.central.projectHealth.projectId, projectId));
  });
}

// ── Mesh Snapshots + Write Queue ────────────────────────────────────────────

export async function recordMeshSnapshotRow(
  handle: QueryHandle,
  input: MeshSnapshotRecordInput,
  now: string,
): Promise<MeshSnapshotRecord> {
  await handle
    .insert(schema.central.meshSharedSnapshots)
    .values({
      nodeId: input.nodeId,
      projectId: input.projectId ?? null,
      scope: input.scope,
      payload: input.payload,
      snapshotVersion: input.snapshotVersion,
      capturedAt: input.capturedAt,
      sourceNodeId: input.sourceNodeId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      staleAfter: input.staleAfter ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.central.meshSharedSnapshots.nodeId,
        schema.central.meshSharedSnapshots.projectId,
        schema.central.meshSharedSnapshots.scope,
      ],
      set: {
        payload: input.payload,
        snapshotVersion: input.snapshotVersion,
        capturedAt: input.capturedAt,
        sourceNodeId: input.sourceNodeId ?? null,
        sourceRunId: input.sourceRunId ?? null,
        staleAfter: input.staleAfter ?? null,
        updatedAt: now,
      },
    });
  return {
    ...input,
    projectId: input.projectId ?? null,
    sourceNodeId: input.sourceNodeId ?? null,
    sourceRunId: input.sourceRunId ?? null,
    staleAfter: input.staleAfter ?? null,
    updatedAt: now,
  };
}

export async function getLatestMeshSnapshotRow(
  handle: QueryHandle,
  query: MeshSnapshotQuery,
): Promise<MeshSnapshotRecord | null> {
  const rows = (await handle
    .select(snapshotColumns)
    .from(schema.central.meshSharedSnapshots)
    .where(
      and(
        eq(schema.central.meshSharedSnapshots.nodeId, query.nodeId),
        query.projectId == null
          ? isNull(schema.central.meshSharedSnapshots.projectId)
          : eq(schema.central.meshSharedSnapshots.projectId, query.projectId),
        eq(schema.central.meshSharedSnapshots.scope, query.scope),
      ),
    )
    .limit(1)) as SnapshotRow[];
  return mapSnapshotRow(rows[0]);
}

export async function enqueueMeshWriteRow(
  handle: QueryHandle,
  id: string,
  input: MeshWriteQueueInput,
  now: string,
): Promise<void> {
  await handle.insert(schema.central.meshWriteQueue).values({
    id,
    originNodeId: input.originNodeId,
    targetNodeId: input.targetNodeId,
    projectId: input.projectId ?? null,
    scope: input.scope,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    payload: input.payload,
    intentVersion: input.intentVersion,
    status: "pending",
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export async function listPendingMeshWritesRow(
  handle: QueryHandle,
  filter: MeshWriteQueueFilter,
): Promise<MeshWriteQueueEntry[]> {
  const conditions: SQL[] = [];
  if (filter.originNodeId) {
    conditions.push(eq(schema.central.meshWriteQueue.originNodeId, filter.originNodeId));
  }
  if (filter.targetNodeId) {
    conditions.push(eq(schema.central.meshWriteQueue.targetNodeId, filter.targetNodeId));
  }
  if (filter.status) {
    conditions.push(eq(schema.central.meshWriteQueue.status, filter.status));
  }
  const query = handle
    .select(meshWriteColumns)
    .from(schema.central.meshWriteQueue)
    .orderBy(
      asc(schema.central.meshWriteQueue.createdAt),
      asc(schema.central.meshWriteQueue.id),
    );
  const rows = (await (conditions.length > 0 ? query.where(and(...conditions)) : query)) as MeshWriteRow[];
  return rows.map((row) => mapMeshWriteRow(row));
}

export async function getMeshWriteQueueEntryById(
  handle: QueryHandle,
  id: string,
): Promise<MeshWriteQueueEntry> {
  const rows = (await handle
    .select(meshWriteColumns)
    .from(schema.central.meshWriteQueue)
    .where(eq(schema.central.meshWriteQueue.id, id))
    .limit(1)) as MeshWriteRow[];
  if (rows.length === 0) {
    throw new Error(`Mesh write queue entry not found: ${id}`);
  }
  return mapMeshWriteRow(rows[0]);
}

export async function markMeshWriteReplayStartedRow(
  handle: QueryHandle,
  id: string,
  now: string,
): Promise<void> {
  await handle
    .update(schema.central.meshWriteQueue)
    .set({
      status: "replaying",
      attemptCount: sql`${schema.central.meshWriteQueue.attemptCount} + 1`,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(schema.central.meshWriteQueue.id, id));
}

export async function markMeshWriteAppliedRow(
  handle: QueryHandle,
  id: string,
  appliedAt: string | null,
  now: string,
): Promise<void> {
  await handle
    .update(schema.central.meshWriteQueue)
    .set({ status: "applied", appliedAt: appliedAt ?? now, updatedAt: now })
    .where(eq(schema.central.meshWriteQueue.id, id));
}

export async function markMeshWriteFailedRow(
  handle: QueryHandle,
  id: string,
  lastError: string,
  now: string,
): Promise<void> {
  await handle
    .update(schema.central.meshWriteQueue)
    .set({ status: "failed", lastError, updatedAt: now })
    .where(eq(schema.central.meshWriteQueue.id, id));
}

export async function getMeshDegradedReadCounts(
  handle: QueryHandle,
): Promise<{ queueDepth: number; pendingWriteCount: number; failedWriteCount: number }> {
  const rows = (await handle
    .select({
      queueDepth: sql<number>`sum(case when ${schema.central.meshWriteQueue.status} in ('pending','replaying','failed') then 1 else 0 end)::int`,
      pendingWriteCount: sql<number>`sum(case when ${schema.central.meshWriteQueue.status} = 'pending' then 1 else 0 end)::int`,
      failedWriteCount: sql<number>`sum(case when ${schema.central.meshWriteQueue.status} = 'failed' then 1 else 0 end)::int`,
    })
    .from(schema.central.meshWriteQueue)) as {
    queueDepth: number | null;
    pendingWriteCount: number | null;
    failedWriteCount: number | null;
  }[];
  return {
    queueDepth: rows[0]?.queueDepth ?? 0,
    pendingWriteCount: rows[0]?.pendingWriteCount ?? 0,
    failedWriteCount: rows[0]?.failedWriteCount ?? 0,
  };
}

// ── Settings Sync State ─────────────────────────────────────────────────────

const settingsSyncColumns = {
  nodeId: schema.central.settingsSyncState.nodeId,
  remoteNodeId: schema.central.settingsSyncState.remoteNodeId,
  lastSyncedAt: schema.central.settingsSyncState.lastSyncedAt,
  localChecksum: schema.central.settingsSyncState.localChecksum,
  remoteChecksum: schema.central.settingsSyncState.remoteChecksum,
  syncCount: schema.central.settingsSyncState.syncCount,
  createdAt: schema.central.settingsSyncState.createdAt,
  updatedAt: schema.central.settingsSyncState.updatedAt,
};

interface SettingsSyncRow {
  nodeId: string;
  remoteNodeId: string;
  lastSyncedAt: string | null;
  localChecksum: string | null;
  remoteChecksum: string | null;
  syncCount: number;
  createdAt: string;
  updatedAt: string;
}

function mapSettingsSyncRow(row: SettingsSyncRow | undefined): SettingsSyncState | null {
  if (!row) return null;
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

export async function getSettingsSyncStateRow(
  handle: QueryHandle,
  nodeId: string,
  remoteNodeId: string,
): Promise<SettingsSyncState | null> {
  const rows = (await handle
    .select(settingsSyncColumns)
    .from(schema.central.settingsSyncState)
    .where(
      and(
        eq(schema.central.settingsSyncState.nodeId, nodeId),
        eq(schema.central.settingsSyncState.remoteNodeId, remoteNodeId),
      ),
    )
    .limit(1)) as SettingsSyncRow[];
  return mapSettingsSyncRow(rows[0]);
}

export async function upsertSettingsSyncStateRow(
  handle: QueryHandle,
  input: {
    nodeId: string;
    remoteNodeId: string;
    lastSyncedAt: string | null;
    localChecksum: string | null;
    remoteChecksum: string | null;
    syncCount: number;
    createdAt: string;
    updatedAt: string;
  },
): Promise<void> {
  await handle
    .insert(schema.central.settingsSyncState)
    .values({
      nodeId: input.nodeId,
      remoteNodeId: input.remoteNodeId,
      lastSyncedAt: input.lastSyncedAt,
      localChecksum: input.localChecksum,
      remoteChecksum: input.remoteChecksum,
      syncCount: input.syncCount,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.central.settingsSyncState.nodeId,
        schema.central.settingsSyncState.remoteNodeId,
      ],
      set: {
        lastSyncedAt: input.lastSyncedAt,
        localChecksum: input.localChecksum,
        remoteChecksum: input.remoteChecksum,
        syncCount: input.syncCount,
        updatedAt: input.updatedAt,
      },
    });
}

// ── Stats ───────────────────────────────────────────────────────────────────

export async function getStats(
  handle: QueryHandle,
): Promise<{ projectCount: number; totalTasksCompleted: number }> {
  const projectRows = (await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.central.projects)) as { count: number }[];
  const totalsRows = (await handle
    .select({ total: sql<number>`coalesce(sum(${schema.central.projectHealth.totalTasksCompleted}), 0)::int` })
    .from(schema.central.projectHealth)) as { total: number }[];
  return {
    projectCount: projectRows[0]?.count ?? 0,
    totalTasksCompleted: totalsRows[0]?.total ?? 0,
  };
}
