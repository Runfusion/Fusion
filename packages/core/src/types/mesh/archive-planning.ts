/**
 * FNXC:CodeOrganization 2026-07-22-12:00:
 * Archive log entries and planning-mode session types peeled from types.ts.
 */

import type { Column, TaskPriority, ThinkingLevel } from "../board/board.js";
import type { ExecutionMode, PlannerOversightLevel } from "../ui/execution-and-ui.js";
import type { IssueInfo, PrInfo, TaskGitLabTracking, TaskGithubTracking, TaskSourceIssue } from "../task/task-tracking.js";
import type { AgentCapability } from "../agents/agents.js";
import type { TaskReview, TaskReviewState } from "../task/task-review.js";
import type { GlobalSettings, ProjectSettings } from "../settings/settings-scope.js";
import type {
  ActivityEventType,
  AgentLogEntry,
  ArchiveAgentLogMode,
  MergeDetails,
  TaskAttachment,
  TaskBranchContext,
  TaskComment,
  TaskLogEntry,
  TaskStep,
  TaskTokenUsage,
} from "../../types.js";
// ── Planning Mode Types ────────────────────────────────────────────────────

/** Entry in the archive log (archive.jsonl) representing a compact, 
 *  restorable snapshot of an archived task without agent log content.
 */
export interface ArchivedTaskEntry {
  id: string;
  /** Immutable lineage identity preserved across archive/restore. */
  lineageId: string;
  title?: string;
  description: string;
  /**
   * Task importance level at archive time. Missing legacy values should be
   * interpreted as `normal` during restore/read flows.
   */
  priority?: TaskPriority;
  column: "archived"; // Always archived when in the log
  /** Source column captured at archive time; absent on legacy archive entries. */
  preArchiveColumn?: Column;
  dependencies: string[];
  steps: TaskStep[];
  currentStep: number;
  /** Workflow-defined custom task field values (KTD-13) frozen at archive time. */
  customFields?: Record<string, unknown>;
  size?: "S" | "M" | "L";
  reviewLevel?: number;
  /** Execution mode for task implementation at time of archival.
   *  - "standard": Full execution with complete review workflow (default)
   *  - "fast": Expedited execution with minimal overhead for simple tasks */
  executionMode?: ExecutionMode;
  /** Per-task override of the workflow-native planner oversight level at time of archival. */
  plannerOversightLevel?: PlannerOversightLevel;
  /** Per-task session advisor override at time of archival. */
  sessionAdvisorEnabled?: boolean;
  prInfo?: PrInfo;
  prInfos?: PrInfo[];
  issueInfo?: IssueInfo;
  githubTracking?: TaskGithubTracking;
  /** Linked GitLab tracking metadata for GitLab.com and self-managed GitLab items. */
  gitlabTracking?: TaskGitLabTracking;
  /** Durable source provenance for the originating external issue. */
  sourceIssue?: TaskSourceIssue;
  /** Attachment metadata (filenames, mime types, etc.) without file content */
  attachments?: TaskAttachment[];
  /** User and agent comments remain searchable in the archive DB. */
  comments?: TaskComment[];
  /** Structured review metadata shown in the Review tab (legacy contract). */
  review?: TaskReview;
  /** Structured review metadata shown in the Review tab (canonical contract). */
  reviewState?: TaskReviewState;
  /** Reconstructed prompt content at archive time, without attachment blobs. */
  prompt?: string;
  /** Agent log retention mode used when this archive entry was written. */
  agentLogMode?: ArchiveAgentLogMode;
  /** Deterministic compact summary of the historical agent log. */
  agentLogSummary?: string;
  /** Bounded recent agent log entries retained in compact mode. */
  agentLogSnapshot?: AgentLogEntry[];
  /** Full historical agent log. Only present when archiveAgentLogMode is "full". */
  agentLogFull?: AgentLogEntry[];
  log: TaskLogEntry[];
  createdAt: string;
  updatedAt: string;
  columnMovedAt?: string;
  /** Immutable first-ever dispatch timestamp into `in-progress`. */
  firstExecutionAt?: string;
  /** Accumulated active runtime spent in `in-progress` across attempts. */
  cumulativeActiveMs?: number;
  /** Accumulated active AI planning duration carried through archive/restore. */
  cumulativePlanningMs?: number;
  /** Open planning AI segment carried through archive/restore. */
  planningStartedAt?: string;
  /** FNXC:TaskTiming 2026-06-26-10:14: per-column cumulative dwell (ms) carried through
   *  archive/restore so per-stage wall-clock survives archival. See Task.columnDwellMs. */
  columnDwellMs?: Record<string, number>;
  /** Current-attempt execution anchor; may be cleared on reopen. */
  executionStartedAt?: string;
  /** First-time completion anchor; may be cleared on reopen. */
  executionCompletedAt?: string;
  /** ISO timestamp set when the task is soft-deleted from active views. */
  deletedAt?: string;
  /** Timestamp when the task was archived to the log */
  archivedAt: string;
  /** Optional: model preset and override fields for executor and validator */
  modelPresetId?: string;
  modelProvider?: string;
  modelId?: string;
  validatorModelProvider?: string;
  validatorModelId?: string;
  /** Optional: planning model override for triage agent */
  planningModelProvider?: string;
  planningModelId?: string;
  mergerModelProvider?: string;
  mergerModelId?: string;
  mergerThinkingLevel?: ThinkingLevel;
  /** Per-task token/cost accounting (input/output/cache) preserved across archival. */
  tokenUsage?: TaskTokenUsage;
  /** Optional: other metadata to preserve */
  breakIntoSubtasks?: boolean;
  noCommitsExpected?: boolean;
  paused?: boolean;
  baseBranch?: string;
  /** Actual git branch name used for this task's worktree */
  branch?: string;
  /** Optional planning/mission branch-group metadata carried across related tasks. */
  branchContext?: TaskBranchContext;
  /** Optional per-task auto-merge override. Undefined means no task-level override. */
  autoMerge?: boolean;
  /** Base commit SHA for the task's worktree */
  baseCommitSha?: string;
  /** List of files modified by this task */
  modifiedFiles?: string[];
  declaredSymbols?: string[];
  /** Mission ID this task is linked to */
  missionId?: string;
  /** Slice ID this task is linked to */
  sliceId?: string;
  mergeRetries?: number;
  recoveryRetryCount?: number;
  nextRecoveryAt?: string;
  error?: string;
  /** User assigned to review this task (used during review handoff) */
  assigneeUserId?: string;
  /**
   * FNXC:BranchGroupCompletion 2026-07-04-00:00:
   * FN-7534: frozen merge-confirmation snapshot, captured at archive time. Previously
   * dropped entirely on archival, which meant a branch-group member that had already
   * landed before being archived could never be told apart from one that never landed —
   * both looked identical (mergeDetails undefined) to isBranchGroupMemberLanded once
   * archived. Persisting it here lets an archived-but-already-landed member keep
   * counting as landed for branch-group completion instead of regressing to "pending"
   * and permanently deadlocking an otherwise-complete group.
   */
  mergeDetails?: MergeDetails;
}

/** Type of planning question presented to the user */
export type PlanningQuestionType = "text" | "single_select" | "multi_select" | "confirm";

/** Isolation mode for project execution */
export type IsolationMode = "in-process" | "child-process";

/** Project status in the central registry */
export type ProjectStatus = "active" | "paused" | "errored" | "initializing";

/** Node connectivity/health status in the central registry */
export type NodeStatus = "online" | "offline" | "connecting" | "error";

/** A node discovered on the local network via mDNS/DNS-SD */
export interface DiscoveredNode {
  /** Node name from the mDNS service instance name */
  name: string;
  /** Host address (IP address) */
  host: string;
  /** Port the Fusion dashboard is running on */
  port: number;
  /** Node type from TXT record */
  nodeType: "local" | "remote";
  /** Node ID from TXT record (if the node has registered itself) */
  nodeId?: string;
  /** When this node was first discovered */
  discoveredAt: string;
  /** When this node was last seen (updated on each mDNS response) */
  lastSeenAt: string;
}

/** Configuration for network node discovery */
export interface DiscoveryConfig {
  /** Whether to broadcast this node's presence on the network */
  broadcast: boolean;
  /** Whether to listen for other nodes on the network */
  listen: boolean;
  /** mDNS service type name (default: "_fusion._tcp") */
  serviceType: string;
  /** Port to advertise (defaults to the dashboard port) */
  port: number;
  /**
   * How long (ms) to remember a discovered node after last seeing it.
   * Default: 300000 (5 minutes).
   */
  staleTimeoutMs: number;
}

export type NodeDiscoveryEvent =
  | { type: "node:discovered"; node: DiscoveredNode }
  | { type: "node:updated"; node: DiscoveredNode }
  | { type: "node:lost"; name: string }
  | { type: "discovery:started" }
  | { type: "discovery:stopped" };

/** Host-level resource and uptime metrics reported by a node. */
export interface SystemMetrics {
  /** CPU utilization percentage (0-100). */
  cpuUsage: number;
  /** Used system memory in bytes. */
  memoryUsed: number;
  /** Total system memory in bytes. */
  memoryTotal: number;
  /** Used storage space in bytes. */
  storageUsed: number;
  /** Total storage space in bytes. */
  storageTotal: number;
  /** Node uptime in milliseconds. */
  uptime: number;
  /** ISO timestamp for when the metrics snapshot was captured. */
  reportedAt: string;
}

/** A peer node known by a local node in the mesh graph. */
export interface PeerNode {
  /** Unique id for this node-peer relationship. */
  id: string;
  /** Local node id that owns this peer entry. */
  nodeId: string;
  /** Remote node identifier for this peer relationship. */
  peerNodeId: string;
  /** Remote peer display name. */
  name: string;
  /** Remote peer base URL. */
  url: string;
  /** Last known peer connectivity status. */
  status: NodeStatus;
  /** ISO timestamp when the peer was last observed. */
  lastSeen: string;
  /** ISO timestamp when the peer relationship was created. */
  connectedAt: string;
}

/** Full mesh status snapshot for a node. */
export interface NodeMeshState {
  /** Node id for this snapshot. */
  nodeId: string;
  /** Display name of the reporting node. */
  nodeName: string;
  /** Optional base URL (undefined for local nodes). */
  nodeUrl: string | undefined;
  /** Runtime node type for this snapshot. */
  nodeType: NodeConfig["type"];
  /** Current node status. */
  status: NodeStatus;
  /** Latest metrics payload for the node. */
  metrics: SystemMetrics | null;
  /** ISO timestamp when the node was last seen. */
  lastSeen: string;
  /** ISO timestamp when this node was connected/registered. */
  connectedAt: string;
  /** Expanded peer list for the node. */
  knownPeers: PeerNode[];
}

/** Cluster-wide mesh topology snapshot merged from local and remote mesh reads. */
export interface MeshClusterSnapshot {
  /** ISO timestamp when this aggregate snapshot was assembled. */
  collectedAt: string;
  /** Node ID that assembled and served the snapshot. */
  sourceNodeId: string;
  /** Deduplicated per-node mesh snapshots keyed by nodeId semantically. */
  nodes: NodeMeshState[];
}

/** Lightweight mesh discovery record for propagating peer awareness. */
export interface MeshDiscovery {
  /** Node id that generated this discovery payload. */
  nodeId: string;
  /** Known peer node ids for the reporting node. */
  knownPeers: string[];
  /** ISO timestamp for latest discovery refresh. */
  lastDiscoveryAt: string;
  /** Monotonic version for discovery state updates. */
  discoveryVersion: number;
}

/** Lightweight snapshot of a known node suitable for gossip transmission. */
export interface PeerInfo {
  /** Unique node identifier. */
  nodeId: string;
  /** Display name of the node. */
  nodeName: string;
  /** Base URL of the node (empty string for local nodes). */
  nodeUrl: string;
  /** Current node status. */
  status: NodeStatus;
  /** Latest system metrics snapshot, if available. */
  metrics: SystemMetrics | null;
  /** ISO timestamp of when this info was last updated. */
  lastSeen: string;
  /** Optional capabilities available on this node. */
  capabilities?: AgentCapability[];
  /** Maximum concurrent tasks/runtimes this node can host. */
  maxConcurrent: number;
}

/** Request payload sent when a node initiates a peer sync. */
export interface SnapshotBase {
  version: number;
  exportedAt: string;
  checksum: string;
}

export type MeshWriteQueueStatus = "pending" | "replaying" | "applied" | "failed";

export interface MeshSnapshotQuery {
  nodeId: string;
  projectId?: string | null;
  scope: string;
}

export interface MeshSnapshotRecordInput {
  nodeId: string;
  projectId?: string | null;
  scope: string;
  payload: Record<string, unknown>;
  snapshotVersion: string;
  capturedAt: string;
  sourceNodeId?: string | null;
  sourceRunId?: string | null;
  staleAfter?: string | null;
}

export interface MeshSnapshotRecord extends MeshSnapshotRecordInput {
  updatedAt: string;
}

export interface MeshWriteQueueInput {
  originNodeId: string;
  targetNodeId: string;
  projectId?: string | null;
  scope: string;
  entityType: string;
  entityId: string;
  operation: string;
  payload: Record<string, unknown>;
  intentVersion: string;
}

export interface MeshWriteQueueFilter {
  originNodeId?: string;
  targetNodeId?: string;
  status?: MeshWriteQueueStatus;
}

export interface MeshWriteQueueEntry extends MeshWriteQueueInput {
  id: string;
  status: MeshWriteQueueStatus;
  attemptCount: number;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string | null;
}

export interface MeshWriteApplyResult {
  appliedAt?: string;
}

export interface MeshWriteFailureResult {
  lastError: string;
}

export interface MeshWriteReplaySummary {
  replayed: number;
  applied: number;
  failed: number;
  queuedWriteIds: string[];
}

export interface MeshDegradedReadState {
  mode: "fresh" | "degraded";
  asOf: string;
  sourceNodeId: string | null;
  snapshotVersion: string | null;
  stalenessMs: number;
  queueDepth: number;
  pendingWriteCount: number;
  failedWriteCount: number;
}

export interface SharedMeshStatePayload {
  /*
  FNXC:PostgresCutover 2026-07-12:
  FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
  Task/state mesh replication is REMOVED — shared PostgreSQL is the SoT.
  projectSettings is deprecated on the wire (ignored by receivers; settings
  live in the shared DB). authMaterial remains (per-machine auth.json).
  Receivers ignore any other domain a legacy peer may still send.
  */
  /** @deprecated Ignored under shared Postgres; kept for wire compatibility with old peers. */
  projectSettings?: SnapshotBase & { payload: { global: GlobalSettings; projects?: Record<string, ProjectSettings> } };
  authMaterial?: SnapshotBase & { payload: { providerAuth?: Record<string, ProviderAuthEntry> } };
}

export interface PeerSyncRequest {
  /** Node ID of the sender. */
  senderNodeId: string;
  /** Base URL of the sender node. */
  senderNodeUrl: string;
  /** List of peers known by the sender. */
  knownPeers: PeerInfo[];
  /** ISO timestamp of when this sync request was generated. */
  timestamp: string;
  /** Optional settings sync payload included in the request. */
  settings?: SettingsSyncPayload;
  /** Optional shared-state payload included in the request. */
  sharedState?: SharedMeshStatePayload;
}

/** Response payload returned after a peer sync exchange. */
export interface PeerSyncResponse {
  /** Node ID of the responding node (local node). */
  senderNodeId: string;
  /** Base URL of the responding node. */
  senderNodeUrl: string;
  /** Full list of peers known by the responding node. */
  knownPeers: PeerInfo[];
  /** Peers in the local list that the sender didn't know about. */
  newPeers: PeerInfo[];
  /** ISO timestamp of when this response was generated. */
  timestamp: string;
  /** Optional settings sync payload included in the response. */
  settings?: SettingsSyncPayload;
  /** Optional shared-state payload included in the response. */
  sharedState?: SharedMeshStatePayload;
}

/** A single provider's authentication credential for sync transport. */
export interface ProviderAuthEntry {
  /** Credential type: "api_key" or "oauth". */
  type: "api_key" | "oauth";
  /** The API key value (for "api_key" type). Omitted for OAuth providers. */
  key?: string;
  /** OAuth access token (for "oauth" type). Omitted for API key providers. */
  accessToken?: string;
  /** OAuth refresh token (for "oauth" type). */
  refreshToken?: string;
  /** OAuth credential expiry epoch milliseconds. */
  expires?: number;
  /** Optional OAuth account identifier. */
  accountId?: string;
  /** Whether this credential has been validated. */
  authenticated?: boolean;
}

/** Payload for synchronizing settings and model auth between nodes. */
export interface SettingsSyncPayload {
  /** Global settings (user-level preferences, model defaults). */
  global?: GlobalSettings;
  /** Map of project name → project settings for projects on this node.
   *  Keyed by project name (not ID or path) since node paths differ. */
  projects?: Record<string, ProjectSettings>;
  /** Model provider auth credentials. Keys are provider IDs (e.g., "anthropic", "openai").
   *  Values contain the credential type and key. Only transmitted over authenticated
   *  node connections. */
  providerAuth?: Record<string, ProviderAuthEntry>;
  /** Per-project workflow setting values keyed `workflowId → { settingKey: value }`. */
  workflowSettings?: Record<string, Record<string, unknown>>;
  /** ISO timestamp when this snapshot was generated. */
  exportedAt: string;
  /** Checksum of the settings data for change detection (SHA-256 hex of JSON). */
  checksum: string;
  /** Version of the sync payload format. */
  version: 1;
}

/** Tracks settings sync state between the local node and a remote node. */
export interface SettingsSyncState {
  /** Local node ID. */
  nodeId: string;
  /** Remote node ID. */
  remoteNodeId: string;
  /** ISO timestamp of the last successful settings sync. */
  lastSyncedAt: string | null;
  /** Checksum of local settings at last sync (for change detection). */
  localChecksum: string | null;
  /** Checksum of remote settings at last sync. */
  remoteChecksum: string | null;
  /** Number of settings syncs performed. */
  syncCount: number;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** Result of a settings sync exchange. */
export interface SettingsSyncResult {
  /** Number of global settings applied. */
  globalCount: number;
  /** Number of project settings applied. */
  projectCount: number;
  /** Number of provider auth entries synced. */
  authCount: number;
  /** Number of workflow setting values applied by the caller. */
  workflowSettingsCount: number;
  /** Whether the sync was successful. */
  success: boolean;
  /** Error message if sync failed. */
  error?: string;
}


import type {
  DockerNodeConfig,
  DockerNodeVolumeMount,
  DockerNodeContainerResourceConfig,
  DockerNodeHostConfig,
  DockerNodePersistenceConfig,
  NodeVersionInfo,
  NodeVersionInfoInput,
  DockerNodeStatus,
  DockerHostConfig,
  DockerResourceSizing,
  DockerVolumeMount,
  DockerExtraCli,
  ManagedDockerNode,
  ManagedDockerNodeInput,
  ManagedDockerNodeUpdate,
  MeshConfigGeneratorInput,
  FullProvisioningInput,
  MeshConnectionConfig,
  DockerContextInfo,
  DockerConnectivityResult,
  DockerContainerInspectResult,
  DockerNodeImageConfig,
  DockerNodeResourceConfig,
  DockerProvisionInput,
  DockerProvisionResult,
} from "./docker-nodes.js";
export type {
  DockerNodeConfig,
  DockerNodeVolumeMount,
  DockerNodeContainerResourceConfig,
  DockerNodeHostConfig,
  DockerNodePersistenceConfig,
  NodeVersionInfo,
  NodeVersionInfoInput,
  DockerNodeStatus,
  DockerHostConfig,
  DockerResourceSizing,
  DockerVolumeMount,
  DockerExtraCli,
  ManagedDockerNode,
  ManagedDockerNodeInput,
  ManagedDockerNodeUpdate,
  MeshConfigGeneratorInput,
  FullProvisioningInput,
  MeshConnectionConfig,
  DockerContextInfo,
  DockerConnectivityResult,
  DockerContainerInspectResult,
  DockerNodeImageConfig,
  DockerNodeResourceConfig,
  DockerProvisionInput,
  DockerProvisionResult,
};
import {
  validateDockerNodeConfig,
  sanitizeDockerNodeConfigForResponse
} from "./docker-nodes.js";
export {
  validateDockerNodeConfig,
  sanitizeDockerNodeConfigForResponse,
};

/** A runtime node that can host project execution (local machine or remote host) */
export interface NodeConfig {
  /** Unique node ID (e.g., "node_abc123") */
  id: string;
  /** Display name (unique across all nodes) */
  name: string;
  /** Node type */
  type: "local" | "remote";
  /** Base URL for remote nodes. Undefined for local nodes. */
  url?: string;
  /** API key used for authenticating requests to remote nodes. */
  apiKey?: string;
  /** Current node status */
  status: NodeStatus;
  /** Optional capabilities available on this node */
  capabilities?: AgentCapability[];
  /** Optional latest host metrics for this node. */
  systemMetrics?: SystemMetrics;
  /** Optional list of known peer node IDs. */
  knownPeers?: string[];
  /** Version tracking info (app version, plugin versions, last sync) */
  versionInfo?: NodeVersionInfo;
  /** Snapshot of plugin ID → version mapping */
  pluginVersions?: Record<string, string>;
  /** Persisted Docker-managed container configuration, when present. */
  dockerConfig?: DockerNodeConfig;
  /** Maximum concurrent tasks/runtimes this node can host */
  maxConcurrent: number;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}




/** Result of applying mesh config to a provisioned node. */
export interface MeshConfigResult {
  /** The generated/applied connection config. */
  config: MeshConnectionConfig;
  /** The registered NodeConfig in the mesh. */
  node: NodeConfig;
  /** Whether the node health check passed after registration. */
  isHealthy: boolean;
  /** Latency of the health check in ms, if successful. */
  healthCheckLatencyMs?: number;
  /** Error if health check or registration failed. */
  error?: string;
}

export interface PluginVersionEntry {
  /** Plugin ID (matches PluginManifest.id) */
  pluginId: string;
  /** Version on the source/local node (undefined if not installed) */
  localVersion?: string;
  /** Version on the target/remote node (undefined if not installed) */
  remoteVersion?: string;
}

/** Suggested action for a plugin during node synchronization */
export type PluginSyncAction = "install" | "update" | "remove" | "no-action";

/** A single plugin sync recommendation */
export interface PluginSyncEntry {
  /** Plugin ID */
  pluginId: string;
  /** Suggested action */
  action: PluginSyncAction;
  /** Version to install/update to (undefined for "remove" and "no-action") */
  targetVersion?: string;
  /** Current version on the local node (undefined if not installed) */
  localVersion?: string;
  /** Current version on the remote node (undefined if not installed) */
  remoteVersion?: string;
  /** Reason for the suggested action */
  reason: string;
}

/** Result of comparing plugin versions between two nodes */
export interface PluginSyncResult {
  /** The local node ID */
  localNodeId: string;
  /** The remote node ID being compared against */
  remoteNodeId: string;
  /** List of plugin sync recommendations */
  plugins: PluginSyncEntry[];
  /** ISO-8601 timestamp of when this comparison was made */
  comparedAt: string;
  /** Whether the two nodes are considered compatible (no install/update/remove needed) */
  isCompatible: boolean;
  /** Summary message */
  summary: string;
}

/** Compatibility status between two version strings */
export type VersionCompatibilityStatus = "compatible" | "minor-difference" | "major-difference" | "incompatible";

/** Result of checking version compatibility between two versions */
export interface VersionCompatibilityResult {
  /** The local version */
  localVersion: string;
  /** The remote version */
  remoteVersion: string;
  /** Overall compatibility status */
  status: VersionCompatibilityStatus;
  /** Human-readable explanation */
  message: string;
}

/** A project registered in the central database */
export interface RegisteredProject {
  /** Unique project ID (e.g., "proj_abc123") */
  id: string;
  /** Display name */
  name: string;
  /** Absolute path to project directory */
  path: string;
  /** Current project status */
  status: ProjectStatus;
  /** Execution isolation mode */
  isolationMode: IsolationMode;
  /** Optional runtime node assignment */
  nodeId?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
  /** ISO-8601 timestamp of last activity */
  lastActivityAt?: string;
  /** Cached project settings snapshot */
  settings?: ProjectSettings;
}

/** @deprecated Use RegisteredProject instead */
export type ProjectInfo = RegisteredProject;

/** A persisted per-project, per-node working directory path mapping. */
export interface ProjectNodePathMapping {
  /** Project ID reference */
  projectId: string;
  /** Node ID reference */
  nodeId: string;
  /** Absolute working-directory path for this project on this node */
  path: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Input payload for creating/updating a project-node path mapping. */
export interface ProjectNodePathMappingUpsertInput {
  projectId: string;
  nodeId: string;
  path: string;
}

/** Input payload for deleting a project-node path mapping. */
export interface ProjectNodePathMappingDeleteInput {
  projectId: string;
  nodeId: string;
}

/** Health metrics for a registered project */
export interface ProjectHealth {
  /** Project ID reference */
  projectId: string;
  /** Current status */
  status: ProjectStatus;
  /** Number of tasks currently active */
  activeTaskCount: number;
  /**
   * FNXC:Concurrency 2026-06-26-23:46:
   * Persisted project-health bookkeeping refreshed only by health polling / slot accounting paths; it is not a live read-layer running-agent count.
   * Consumers that need current running agents must derive from the shared top-level slot predicate: in-progress executors, active triage planners (`column === "triage" && status === "planning" && !paused`), and active in-review reviewer/merger/fix agents including PR/fix merge substates, leaving this stored value untouched.
   */
  inFlightAgentCount: number;
  /** ISO-8601 timestamp of last activity */
  lastActivityAt?: string;
  /** ISO-8601 timestamp of last error */
  lastErrorAt?: string;
  /** Last error message */
  lastErrorMessage?: string;
  /** Total completed tasks (cumulative) */
  totalTasksCompleted: number;
  /** Total failed tasks (cumulative) */
  totalTasksFailed: number;
  /** Rolling average task duration in milliseconds */
  averageTaskDurationMs?: number;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/** Activity log entry in the central unified feed */
export interface CentralActivityLogEntry {
  /** Unique entry ID */
  id: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Event type */
  type: ActivityEventType;
  /** Project ID this event belongs to */
  projectId: string;
  /** Project name (denormalized for display) */
  projectName: string;
  /** Task ID (optional) */
  taskId?: string;
  /** Task title (optional) */
  taskTitle?: string;
  /** Event details */
  details: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Global concurrency state across all projects */
export interface GlobalConcurrencyState {
  /** System-wide concurrent agent limit (default: 4) */
  globalMaxConcurrent: number;
  /**
   * FNXC:Concurrency 2026-06-26-18:34:
   * Persisted global slot bookkeeping maintained by acquire/release flows; it is not a live aggregate of project task stores.
   * Read surfaces that need current running-agent totals should aggregate live `column === "in-progress"` task counts while preserving slot limiter semantics and DB column names.
   */
  currentlyActive: number;
  /** Tasks waiting for concurrency slots */
  queuedCount: number;
  /** Per-project active agent counts */
  projectsActive: Record<string, number>;
}

/** A single question in the planning conversation flow */
export interface PlanningQuestion {
  id: string;
  type: PlanningQuestionType;
  question: string;
  description?: string;
  options?: Array<{ id: string; label: string; description?: string; pros?: string[]; cons?: string[]; isOther?: boolean; customText?: string }>;
  /*
  FNXC:PlanningMode 2026-07-20-00:00:
  FN-8434 carries the evolving plan beside the next interview question. This field is additive:
  it must never be interpreted as model authority to complete a user-controlled Planning Mode session.
  */
  runningPlan?: PlanningSummary;
}

/** The final summary generated after planning conversation completes */
export interface PlanningSummary {
  title: string;
  description: string;
  /** Concrete product, code, or configuration changes proposed by the model. */
  proposedChanges?: string[];
  /** Observable pass/fail conditions for the implementation. */
  acceptanceCriteria?: string[];
  suggestedSize: "S" | "M" | "L";
  priority?: TaskPriority;
  suggestedDependencies: string[];
  keyDeliverables: string[];
  /** Model-suggested areas the operator can choose for the next refinement question. */
  suggestedRefinements?: string[];
}

/*
FNXC:PlanningMode 2026-07-20-17:15:
This pure formatter lives on the dashboard's browser-safe core surface so plan review
and server persistence share one canonical Markdown representation without widening
the client bundle to Node-only core modules.
*/
export function formatPlanningPlanMd(summary: PlanningSummary): string {
  const normalizeListItem = (item: string) => item.replace(/\s+/g, " ").trim();
  const list = (items: string[] | undefined) => items && items.length > 0
    ? items.map((item) => `- ${normalizeListItem(item)}`).join("\n")
    : "_None_";
  const proposedChanges = list(summary.proposedChanges);
  const acceptanceCriteria = list(summary.acceptanceCriteria);
  const dependencies = list(summary.suggestedDependencies);
  const deliverables = list(summary.keyDeliverables);

  return `# ${summary.title}\n\n${summary.description}\n\n## What to change\n${proposedChanges}\n\n## Acceptance criteria\n${acceptanceCriteria}\n\n## Size\n${summary.suggestedSize}\n\n## Suggested dependencies\n${dependencies}\n\n## Key deliverables\n${deliverables}\n`;
}

/** Response from planning endpoints - either a question or the final summary */
export type PlanningResponse =
  | { type: "question"; data: PlanningQuestion }
  | { type: "complete"; data: PlanningSummary };

/** Planning session state stored in memory */
export interface PlanningSession {
  id: string;
  ip: string;
  initialPlan: string;
  history: Array<{ question: PlanningQuestion; response: unknown }>;
  currentQuestion?: PlanningQuestion;
  summary?: PlanningSummary;
  /** User explicitly validated the continuously maintained running plan. */
  validated?: boolean;
  /** FNXC:PlanningMode 2026-07-20-15:45: Durable planning-to-task handoff cache; proposalClaimId is the crash-safe authority. */
  createdTaskId?: string;
  createClaimStatus?: "none" | "creating" | "created";
  claimOwnerToken?: string;
  claimStartedAt?: string;
  /**
   * Optional per-session auto-merge override for tasks planned in this session.
   * Not separately persisted; durable form is a branch_groups row keyed by session id.
   */
  autoMerge?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

