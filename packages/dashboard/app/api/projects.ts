/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Multi-project management client API peeled from legacy.ts.
 */
import type {
  NodeConfig,
  NodeStatus,
  MeshClusterSnapshot,
  SystemMetrics,
  DiscoveryConfig,
  DockerNodeConfig,
  ManagedDockerNodeInput,
  DockerHostConfig,
  DockerResourceSizing,
  DockerVolumeMount,
  DockerExtraCli,
  DockerNodeStatus,
  ProjectNodePathMapping,
  ActivityEventType,
  Task,
} from "@fusion/core";
import { api, proxyApi } from "./client.js";
import { withProjectId } from "./health.js";
import { getAuthToken } from "../auth";
import { dedupe } from "./dedupe.js";

// ── Project Management API (Multi-Project Support) ───────────────────────

/** Project information returned by project endpoints */
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  status: "active" | "paused" | "errored" | "initializing";
  isolationMode: "in-process" | "child-process";
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
}

/** Project health metrics */
export interface CodebaseMetrics {
  tokenEstimate: number;
  sourceFileCount: number;
  sourceByteCount: number;
  diskBytes: number;
  diskFileCount: number;
  method: string;
  truncated: boolean;
}

export interface ProjectHealth {
  projectId: string;
  status: "active" | "paused" | "errored" | "initializing";
  activeTaskCount: number;
  inFlightAgentCount: number;
  lastActivityAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  averageTaskDurationMs?: number;
  updatedAt: string;
}

/**
 * Executor state values.
 *
 * FNXC:EngineControls 2026-06-22-00:00:
 * A globally stopped AI engine (`globalPause`) is an operator action, not idleness; the footer must expose it as "Stopped" in error red with the stop-rectangle icon.
 */
export type ExecutorState = "idle" | "running" | "paused" | "stopped";

/** Aggregated executor statistics for the status bar.
 * 
 * Counts (runningTaskCount, blockedTaskCount, queuedTaskCount, inReviewCount, stuckTaskCount)
 * are derived client-side from the same tasks array shared with the board, ensuring
 * the footer counts always match the active work states displayed on screen. Queued covers
 * todo plus planning/triage work; Done is intentionally not exposed unless a footer Done
 * segment is added.
 * The API returns settings-based values (globalPause, enginePaused, maxConcurrent) and
 * lastActivityAt from the activity log.
 * 
 * The executorState is derived from:
 * - "stopped": globalPause is true
 * - "idle": (enginePaused is true AND runningTaskCount is 0) OR not paused with nothing running
 * - "paused": enginePaused is true AND runningTaskCount > 0
 * - "running": globalPause is false AND enginePaused is false AND runningTaskCount > 0
 */
export interface ExecutorStats {
  /** Number of tasks currently in "in-progress" column */
  runningTaskCount: number;
  /** Number of tasks with blockedBy field set (waiting on file overlap) */
  blockedTaskCount: number;
  /** Number of "in-progress" tasks with no activity for > 10 minutes */
  stuckTaskCount: number;
  /** Number of tasks in "todo" plus planning/triage work states */
  queuedTaskCount: number;
  /** Number of tasks in "in-review" column */
  inReviewCount: number;
  /** Derived executor state: "idle", "running", "paused", or "stopped" */
  executorState: ExecutorState;
  /** Maximum concurrent tasks allowed from settings */
  maxConcurrent: number;
  /** ISO timestamp of most recent task event from activity log */
  lastActivityAt?: string;
}

/** Unified activity feed entry */
export interface ActivityFeedEntry {
  id: string;
  timestamp: string;
  type: ActivityEventType;
  projectId: string;
  projectName: string;
  taskId?: string;
  taskTitle?: string;
  details: string;
  metadata?: Record<string, unknown>;
}

/** Input for creating a new project */
export interface ProjectCreateInput {
  name: string;
  path: string;
  isolationMode?: "in-process" | "child-process";
  nodeId?: string;
  gitSetupMode?: "existing" | "init" | "clone";
  cloneUrl?: string;
  workspaceMode?: boolean;
  taskPrefix?: string;
  /** Confirmed "create anyway without a git repo" when git is missing on the host (never valid for clone mode). */
  skipGitInit?: boolean;
}

export type DockerNodeConfigInfo = DockerNodeConfig;
export type { DockerNodeConfig };

/** Node information returned by node endpoints */
export interface NodeInfo {
  id: NodeConfig["id"];
  name: NodeConfig["name"];
  type: NodeConfig["type"];
  url?: NodeConfig["url"];
  apiKey?: NodeConfig["apiKey"];
  status: NodeStatus;
  capabilities?: NodeConfig["capabilities"];
  maxConcurrent: NodeConfig["maxConcurrent"];
  createdAt: NodeConfig["createdAt"];
  updatedAt: NodeConfig["updatedAt"];
  dockerConfig?: DockerNodeConfigInfo;
}

/** Managed Docker node information returned by docker node endpoints */
export interface DockerNodeInfo {
  id: string;
  nodeId: string | null;
  name: string;
  nodeType: "docker-managed";
  imageName: string;
  imageTag: string;
  containerId: string | null;
  status: DockerNodeStatus;
  hostConfig: DockerHostConfig;
  envVars: Record<string, string>;
  volumeMounts: DockerVolumeMount[];
  resourceSizing: DockerResourceSizing;
  extraClis: DockerExtraCli[];
  persistentStorage: boolean;
  reachableUrl: string | null;
  apiKey: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedDockerNodeInfo {
  id: string;
  nodeId?: string;
  name: string;
  containerId?: string;
  status: string;
  hostConfig: {
    type: "local" | "remote";
    host?: string;
    context?: string;
    tlsOptions?: Record<string, unknown>;
  };
  envVars: Record<string, string>;
  reachableUrl?: string;
  imageName: string;
  imageTag: string;
  volumeMounts: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
  persistentStorage: boolean;
  resourceSizing?: { cpuLimit?: string; memoryLimit?: string };
  errorMessage?: string;
  linkedNode?: NodeInfo;
  createdAt: string;
  updatedAt: string;
}

export interface ContainerStatusInfo {
  running: boolean;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  ports?: Record<string, string>;
}

/** Node discovered over local network mDNS/DNS-SD */
export interface DiscoveredNodeInfo {
  name: string;
  host: string;
  port: number;
  nodeType: "local" | "remote";
  nodeId?: string;
  discoveredAt: string;
  lastSeenAt: string;
}

/** Input for creating a new node */
export interface NodeCreateInput {
  name: string;
  type: "local" | "remote";
  url?: string;
  apiKey?: string;
  maxConcurrent?: number;
  dockerConfig?: DockerNodeConfigInfo;
}

/** Input for assigning a project path for a specific node during onboarding. */
export interface NodeProjectMappingInput {
  projectId: string;
  path: string;
}

export interface RemoteNodeDiscoveredProject {
  id: string;
  name: string;
  path: string;
  status: "active" | "paused" | "errored" | "initializing";
  isolationMode: "in-process" | "child-process";
}

export interface RemoteNodeProjectDiscoveryResult {
  projects: RemoteNodeDiscoveredProject[];
}

/**
 * Node onboarding payload used by dashboard UI.
 *
 * `projectMappings` is intentionally separate from `ProjectInfo.path` and `projects.nodeId`.
 * It captures node-specific filesystem paths for selected existing projects.
 */
export interface NodeOnboardingInput extends NodeCreateInput {
  projectMappings: NodeProjectMappingInput[];
}

/** Input for updating an existing node */
export type NodeUpdateInput = Partial<Pick<NodeCreateInput, "name" | "type" | "url" | "apiKey" | "maxConcurrent" | "dockerConfig">> & {
  status?: NodeStatus;
  capabilities?: string[];
};

/** Result from a node health check */
export interface NodeHealthCheckResult {
  nodeId: string;
  status: NodeStatus;
  responseTimeMs?: number;
  error?: string;
  checkedAt: string;
}

/** Runtime metrics for a node */
export interface NodeMetrics {
  nodeId: string;
  activeTaskCount: number;
  inFlightAgentCount: number;
  uptimeMs: number;
  lastActivityAt?: string;
}

/** Options for fetching activity feed */
export interface FeedOptions {
  limit?: number;
  since?: string;
  projectId?: string;
  type?: ActivityFeedEntry["type"];
}

/** Global concurrency state across all projects */
export interface GlobalConcurrencyState {
  globalMaxConcurrent: number;
  currentlyActive: number;
  queuedCount: number;
  projectsActive: Record<string, number>;
}

/** First run status response */
export interface FirstRunStatus {
  hasProjects: boolean;
  singleProjectPath: string | null;
}

/** Setup state for first-run wizard */
export interface SetupState {
  /** The first-run state: fresh-install, setup-wizard, normal-operation */
  state: "fresh-install" | "setup-wizard" | "normal-operation";
  /** Projects detected on the filesystem (not yet registered) */
  detectedProjects: Array<{
    path: string;
    name: string;
    hasDb: boolean;
  }>;
  /** Whether the central database exists */
  hasCentralDb: boolean;
  /** Projects already registered in the central database */
  registeredProjects: Array<{
    id: string;
    name: string;
    path: string;
  }>;
}

/** Input for completing setup */
export interface CompleteSetupInput {
  projects: Array<{
    path: string;
    name: string;
    isolationMode?: "in-process" | "child-process";
  }>;
}

/** Result of completing setup */
export interface CompleteSetupResult {
  success: boolean;
  projectsRegistered: string[];
  errors: string[];
}

/** Fetch all registered projects */
export function fetchProjects(): Promise<ProjectInfo[]> {
  return api<ProjectInfo[]>("/projects");
}

/** Dashboard-facing mapping contract for project availability on nodes. */
export interface ProjectNodeAvailability {
  nodeId: string;
  nodeName?: string;
  path: string;
  available: boolean;
}

/** Project info with source node metadata (added by server for remote projects). */
export interface ProjectInfoWithSource extends ProjectInfo {
  /** Name of the source node (added by server for remote projects). */
  _sourceNodeName?: string;
  /** Normalized per-node project mappings for dashboard UI. */
  nodeMappings?: ProjectNodeAvailability[];
  /** Compatibility fields accepted from in-flight server rollouts. */
  projectNodeMappings?: ProjectNodeAvailability[];
  pathMappings?: ProjectNodeAvailability[];
}

export function hasNodeMappingsSupport(project: ProjectInfoWithSource): boolean {
  return Array.isArray(project.nodeMappings)
    || Array.isArray(project.projectNodeMappings)
    || Array.isArray(project.pathMappings);
}

/** Fetch all registered projects from all nodes (local + remote) */
export function fetchProjectsAcrossNodes(): Promise<ProjectInfoWithSource[]> {
  return dedupe("/projects/across-nodes", () => api<ProjectInfoWithSource[]>("/projects/across-nodes"));
}

/** Fetch all registered nodes */
export function fetchNodes(): Promise<NodeInfo[]> {
  return dedupe("/nodes", () => api<NodeInfo[]>("/nodes"));
}

/** Fetch discovery runtime status and active config. */
export function fetchDiscoveryStatus(): Promise<{ active: boolean; config: DiscoveryConfig | null }> {
  return api<{ active: boolean; config: DiscoveryConfig | null }>("/discovery/status");
}

/** Fetch all managed Docker nodes */
export function listManagedDockerNodes(): Promise<DockerNodeInfo[]> {
  return api<DockerNodeInfo[]>("/docker-nodes");
}

export function fetchManagedDockerNodes(): Promise<ManagedDockerNodeInfo[]> {
  return api<ManagedDockerNodeInfo[]>("/docker/nodes");
}

export function fetchManagedDockerNode(id: string): Promise<ManagedDockerNodeInfo> {
  return api<ManagedDockerNodeInfo>(`/docker/nodes/${encodeURIComponent(id)}`);
}

export function fetchManagedDockerNodeContainerStatus(id: string): Promise<ContainerStatusInfo> {
  return api<ContainerStatusInfo>(`/docker/nodes/${encodeURIComponent(id)}/container-status`);
}

export function fetchDockerNodeLogs(id: string, options?: { tail?: number }): Promise<{ logs: string }> {
  const params = new URLSearchParams();
  if (typeof options?.tail === "number") {
    params.set("tail", String(options.tail));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<{ logs: string }>(`/docker/nodes/${encodeURIComponent(id)}/logs${suffix}`);
}

/** Create a managed Docker node */
export function createManagedDockerNode(input: ManagedDockerNodeInput): Promise<DockerNodeInfo> {
  return api<DockerNodeInfo>("/docker-nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Start local-network discovery service. */
export function startDiscovery(input?: {
  broadcast?: boolean;
  listen?: boolean;
  port?: number;
}): Promise<{ success: boolean; config: DiscoveryConfig }> {
  return api<{ success: boolean; config: DiscoveryConfig }>("/discovery/start", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

/** Stop local-network discovery service. */
export function stopDiscovery(): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/discovery/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Fetch currently discovered nodes from mDNS/DNS-SD. */
export function fetchDiscoveredNodes(): Promise<DiscoveredNodeInfo[]> {
  return api<DiscoveredNodeInfo[]>("/discovery/nodes");
}

/** Register a discovered node into the central node registry. */
export function connectDiscoveredNode(input: {
  name: string;
  host: string;
  port: number;
  apiKey?: string;
}): Promise<NodeInfo> {
  return api<NodeInfo>("/discovery/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Register a new node */
export function registerNode(input: NodeCreateInput): Promise<NodeInfo> {
  return api<NodeInfo>("/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Discover projects from a remote node before registering it. */
export function discoverRemoteNodeProjects(input: { url: string; apiKey?: string }): Promise<RemoteNodeProjectDiscoveryResult> {
  return api<RemoteNodeProjectDiscoveryResult>("/nodes/discover-projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch a single node by ID */
export function fetchNode(id: string): Promise<NodeInfo> {
  return api<NodeInfo>(`/nodes/${encodeURIComponent(id)}`);
}

/** Fetch all project path mappings for a node */
export function fetchNodePathMappings(nodeId: string): Promise<ProjectNodePathMapping[]> {
  return api<ProjectNodePathMapping[]>(`/nodes/${encodeURIComponent(nodeId)}/path-mappings`);
}

/** Update an existing node */
export function updateNode(id: string, updates: NodeUpdateInput): Promise<NodeInfo> {
  return api<NodeInfo>(`/nodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Fetch sanitized docker config for a node */
export function fetchDockerNodeConfig(nodeId: string): Promise<DockerNodeConfigInfo | null> {
  return api<DockerNodeConfigInfo | null>(`/nodes/${encodeURIComponent(nodeId)}/docker-config`);
}

/** Replace full docker config for a node */
export function replaceDockerNodeConfig(nodeId: string, config: DockerNodeConfig): Promise<DockerNodeConfigInfo> {
  return api<DockerNodeConfigInfo>(`/nodes/${encodeURIComponent(nodeId)}/docker-config`, {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

/** Patch docker config for a node */
export function updateDockerNodeConfig(nodeId: string, config: Partial<DockerNodeConfig>): Promise<DockerNodeConfigInfo> {
  return api<DockerNodeConfigInfo>(`/nodes/${encodeURIComponent(nodeId)}/docker-config`, {
    method: "PATCH",
    body: JSON.stringify(config),
  });
}

/** Fetch docker config diff status for a node */
export function fetchDockerConfigDiff(nodeId: string): Promise<{
  persistedVersion: number;
  deployedVersion: number | null;
  needsRecreate: boolean;
}> {
  return api<{ persistedVersion: number; deployedVersion: number | null; needsRecreate: boolean }>(
    `/nodes/${encodeURIComponent(nodeId)}/docker-config/diff`,
  );
}

/** Unregister a node */
export function unregisterNode(id: string): Promise<void> {
  return api<void>(`/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Trigger a node health check */
export async function checkNodeHealth(id: string): Promise<NodeHealthCheckResult> {
  const result = await api<Partial<NodeHealthCheckResult> & { status: NodeStatus }>(`/nodes/${encodeURIComponent(id)}/health-check`, {
    method: "POST",
  });

  return {
    nodeId: result.nodeId ?? id,
    status: result.status,
    responseTimeMs: result.responseTimeMs,
    error: result.error,
    checkedAt: result.checkedAt ?? new Date().toISOString(),
  };
}

/** Fetch runtime metrics for a node */
export async function fetchNodeMetrics(id: string): Promise<SystemMetrics | null> {
  return api<SystemMetrics | null>(`/nodes/${encodeURIComponent(id)}/metrics`);
}

/** Fetch full mesh topology state (all nodes with their metrics and known peers) */
export async function fetchMeshState(): Promise<MeshClusterSnapshot> {
  return api<MeshClusterSnapshot>("/mesh/state");
}

/*
 * FNXC:MeshSharedPg 2026-06-25-00:00:
 * With the mesh on shared PostgreSQL, the dashboard needs to surface which
 * engines are actively connected to the shared DB, their in-flight tasks, and
 * heartbeat status. GET /api/mesh/engines joins the local engineManager with
 * the central node registry and per-project health. The shape matches the
 * MeshTopology `engines` prop (MeshEngineStatus) so the dashboard can render it
 * without transformation.
 */
export interface MeshEnginesResponse {
  collectedAt: string;
  backend: string;
  engines: MeshEngineStatusApi[];
}

/** Per-engine status entry returned by GET /api/mesh/engines. Mirrors MeshEngineStatus. */
export interface MeshEngineStatusApi {
  projectId: string;
  projectName?: string;
  projectPath?: string;
  workingDirectory?: string;
  runtimeStatus: string;
  inFlightTasks: number;
  activeAgents: number;
  lastActivityAt?: string;
  memoryBytes?: number;
  nodeId?: string;
}

/** Fetch active engine connections reading from shared PG (GET /api/mesh/engines). */
export async function fetchMeshEngines(): Promise<MeshEnginesResponse> {
  return api<MeshEnginesResponse>("/mesh/engines");
}

/** Browse directory entries for the directory picker */
export interface BrowseDirectoryResult {
  currentPath: string;
  parentPath: string | null;
  entries: Array<{ name: string; path: string; hasChildren: boolean }>;
}

export function browseDirectory(
  path?: string,
  showHidden?: boolean,
  nodeId?: string,
  localNodeId?: string,
): Promise<BrowseDirectoryResult> {
  const effectiveNodeId = nodeId && nodeId !== localNodeId ? nodeId : undefined;
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (showHidden) params.set("showHidden", "true");
  if (effectiveNodeId) params.set("nodeId", effectiveNodeId);
  const token = getAuthToken();
  if (token) {
    params.set("fn_token", token);
  }
  const qs = params.toString();
  const fullPath = `/browse-directory${qs ? `?${qs}` : ""}`;
  return api<BrowseDirectoryResult>(fullPath);
}

/** Create a new directory */
export function createDirectory(path: string): Promise<{ success: true; path: string }> {
  return api<{ success: true; path: string }>("/create-directory", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Register a new project */
export function registerProject(input: ProjectCreateInput): Promise<ProjectInfo> {
  return api<ProjectInfo>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
/** Detect git sub-repos in a directory (workspace mode detection) */
export function detectWorkspace(path: string): Promise<{ repos: string[]; isWorkspace: boolean }> {
  return api<{ repos: string[]; isWorkspace: boolean }>("/projects/detect-workspace", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Unregister a project */
export function unregisterProject(id: string): Promise<void> {
  return api<void>(`/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Fetch all per-node path mappings for a project */
export function fetchProjectPathMappings(projectId: string): Promise<ProjectNodePathMapping[]> {
  return api<ProjectNodePathMapping[]>(`/projects/${encodeURIComponent(projectId)}/path-mappings`);
}

/** Fetch a single project-node path mapping */
export function fetchProjectPathMapping(projectId: string, nodeId: string): Promise<ProjectNodePathMapping> {
  return api<ProjectNodePathMapping>(
    `/projects/${encodeURIComponent(projectId)}/path-mappings/${encodeURIComponent(nodeId)}`,
  );
}

/** Create or update a project-node path mapping */
export function upsertProjectPathMapping(
  projectId: string,
  nodeId: string,
  path: string,
): Promise<ProjectNodePathMapping> {
  return api<ProjectNodePathMapping>(
    `/projects/${encodeURIComponent(projectId)}/path-mappings/${encodeURIComponent(nodeId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ path }),
    },
  );
}

/** Remove a project-node path mapping */
export function removeProjectPathMapping(projectId: string, nodeId: string): Promise<void> {
  return api<void>(
    `/projects/${encodeURIComponent(projectId)}/path-mappings/${encodeURIComponent(nodeId)}`,
    {
      method: "DELETE",
    },
  );
}

/** Fetch health metrics for a specific project */
export function fetchProjectHealth(id: string): Promise<ProjectHealth> {
  return api<ProjectHealth>(`/projects/${encodeURIComponent(id)}/health`);
}

export function fetchCodebaseMetrics(id: string): Promise<CodebaseMetrics> {
  return api<CodebaseMetrics>(`/projects/${encodeURIComponent(id)}/codebase-metrics`);
}

/** Fetch executor statistics for the status bar.
 * 
 * Returns settings-based values and lastActivityAt.
 * Counts are derived client-side from the tasks array.
 */
export function fetchExecutorStats(projectId?: string): Promise<{
  globalPause: boolean;
  enginePaused: boolean;
  maxConcurrent: number;
  lastActivityAt?: string;
}> {
  const path = withProjectId("/executor/stats", projectId);
  return dedupe(path, () => api<{
    globalPause: boolean;
    enginePaused: boolean;
    maxConcurrent: number;
    lastActivityAt?: string;
  }>(path));
}

export interface SystemStatsSnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
  external: number;
  arrayBuffers: number;
  // Null until at least two samples are available to compute process CPU delta.
  cpuPercent: number | null;
  loadAvg: [number, number, number];
  cpuCount: number;
  systemTotalMem: number;
  systemFreeMem: number;
  pid: number;
  nodeVersion: string;
  platform: string;
}

export interface TaskStatsSnapshot {
  total: number;
  byColumn: Record<string, number>;
  active: number;
  agents: {
    idle: number;
    active: number;
    running: number;
    error: number;
  };
}

export interface SystemStatsResponse {
  systemStats: SystemStatsSnapshot;
  taskStats: TaskStatsSnapshot;
  vitestProcessCount?: number;
  vitestLastAutoKillAt?: string | null;
}

export interface KillVitestResponse {
  killed: number;
  pids: number[];
}

export interface GithubSourceIssueClosedAtBackfillResult {
  scanned: number;
  filled: number;
  skipped: number;
  errors: number;
  hasMore: boolean;
}

/*
FNXC:CommandCenter 2026-06-21-00:00:
The Command Center System area keeps the direct local /system-stats client and uses the explicit /nodes/:id/system-stats route for selected remote nodes so authenticated node proxying stays server-side and local project scoping is not forwarded across nodes.
*/
export function fetchSystemStats(projectId?: string): Promise<SystemStatsResponse> {
  return api<SystemStatsResponse>(withProjectId("/system-stats", projectId));
}

export function fetchNodeSystemStats(nodeId: string, projectId?: string): Promise<SystemStatsResponse> {
  return api<SystemStatsResponse>(withProjectId(`/nodes/${encodeURIComponent(nodeId)}/system-stats`, projectId));
}

export function killVitestProcesses(projectId?: string, nodeId?: string, localNodeId?: string): Promise<KillVitestResponse> {
  return proxyApi<KillVitestResponse>(withProjectId("/kill-vitest", projectId), {
    method: "POST",
    nodeId,
    localNodeId,
  });
}

/**
 * FNXC:GithubSourceIssueBackfill 2026-06-18-19:20:
 * Thin client for the FN-6674 manual source-issue closed-at backfill endpoint. Callers own bounded pagination until `hasMore === false`; this helper keeps the GitHub lookup in the explicit operator action path and out of analytics/render-time data loading.
 */
export function apiBackfillGithubSourceIssueClosedAt(
  options: { offset?: number; limit?: number } = {},
  projectId?: string,
): Promise<GithubSourceIssueClosedAtBackfillResult> {
  return api<GithubSourceIssueClosedAtBackfillResult>(
    withProjectId("/git/github/backfill-source-issue-closed-at", projectId),
    {
      method: "POST",
      body: JSON.stringify({ offset: options.offset, limit: options.limit }),
    },
  );
}

/** Fetch unified activity feed */
export function fetchActivityFeed(options?: FeedOptions): Promise<ActivityFeedEntry[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.since) params.set("since", options.since);
  if (options?.projectId) params.set("projectId", options.projectId);
  if (options?.type) params.set("type", options.type);
  
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return api<ActivityFeedEntry[]>(`/activity-feed${query}`);
}

/** Pause a project */
export function pauseProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}/pause`, {
    method: "POST",
  });
}

/** Resume a paused project */
export function resumeProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}/resume`, {
    method: "POST",
  });
}

/** Fetch first run status to detect if user needs setup wizard */
export function fetchFirstRunStatus(): Promise<FirstRunStatus> {
  return api<FirstRunStatus>("/first-run-status");
}

/** Fetch detailed setup state including detected projects */
export function fetchSetupState(): Promise<SetupState> {
  return api<SetupState>("/setup-state");
}

/** Complete first-run setup by registering projects */
export function completeSetup(input: CompleteSetupInput): Promise<CompleteSetupResult> {
  return api<CompleteSetupResult>("/complete-setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Fetch global concurrency state */
export function fetchGlobalConcurrency(): Promise<GlobalConcurrencyState> {
  return api<GlobalConcurrencyState>("/global-concurrency");
}

/** Update the system-wide concurrency limit shared across all projects. */
export function updateGlobalConcurrency(input: {
  globalMaxConcurrent: number;
}): Promise<GlobalConcurrencyState> {
  return api<GlobalConcurrencyState>("/global-concurrency", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Fetch tasks for a specific project */
export function fetchProjectTasks(projectId: string, limit?: number, offset?: number): Promise<Task[]> {
  const params = new URLSearchParams();
  params.set("projectId", projectId);
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  return api<Task[]>(`/tasks?${params.toString()}`);
}

/** Fetch project-specific config */
export function fetchProjectConfig(projectId: string): Promise<{ maxConcurrent: number; rootDir: string }> {
  return api<{ maxConcurrent: number; rootDir: string }>(`/projects/${encodeURIComponent(projectId)}/config`);
}

/** Detected project information */
export interface DetectedProject {
  path: string;
  suggestedName: string;
  existing: boolean;
}

/** Detect projects in a base path */
export function detectProjects(basePath?: string): Promise<{ projects: DetectedProject[] }> {
  return api<{ projects: DetectedProject[] }>("/projects/detect", {
    method: "POST",
    body: JSON.stringify({ basePath }),
  });
}

/** Fetch a single project by ID */
export function fetchProject(id: string): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}`);
}

/** Update an existing project */
export function updateProject(id: string, updates: Partial<ProjectInfo>): Promise<ProjectInfo> {
  return api<ProjectInfo>(`/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

