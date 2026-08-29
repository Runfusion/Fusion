import type { MeshWriteQueueEntry, NodeMeshState, PeerSyncRequest, PeerSyncResponse, SettingsSyncPayload } from "../types.js";

export const SHARED_MESH_PROTOCOL_ID = "fusion.shared-mesh" as const;
export const SHARED_MESH_PROTOCOL_VERSION = "1.0" as const;

export const MESH_WRITE_CLASSES = ["strong", "append-only", "queued", "local"] as const;
export type MeshWriteClass = (typeof MESH_WRITE_CLASSES)[number];

export const MESH_INTENT_STATES = ["intent", "committed", "rejected", "queued", "reconciled"] as const;
export type MeshIntentState = (typeof MESH_INTENT_STATES)[number];

export const MESH_RECONCILIATION_OUTCOMES = [
  "applied",
  "noop_already_applied",
  "superseded",
  "conflict_requires_merge",
  "rejected_fenced",
] as const;
export type MeshReconciliationOutcome = (typeof MESH_RECONCILIATION_OUTCOMES)[number];

export type SharedMeshEntityType =
  | "task"
  | "task-metadata"
  | "mission"
  | "agent-config"
  | "agent-runtime"
  | "project-settings"
  | "auth-material"
  | "execution-run"
  | "audit-event"
  | "filesystem-blob";

export type SharedMeshCoordinationMode = "strongly-coordinated" | "append-only-replicated" | "queued-for-later" | "node-local-only";

export interface SharedMeshProtocolRef {
  protocol: typeof SHARED_MESH_PROTOCOL_ID;
  version: typeof SHARED_MESH_PROTOCOL_VERSION;
}

export interface SharedMeshLeaseRef {
  leaseEpoch: number;
  fenceToken: string;
  coordinatorNodeId: string;
}

export interface SharedMeshWritePrecondition {
  expectedBaseRevision?: string;
  expectedLeaseEpoch?: number;
}

export interface SharedMeshReplicationEnvelope<TPayload = unknown> extends SharedMeshProtocolRef, SharedMeshLeaseRef {
  recordId: string;
  intentId: string;
  entityType: SharedMeshEntityType;
  entityId: string;
  originNodeId: string;
  originSeq: number;
  writeClass: MeshWriteClass;
  state: MeshIntentState;
  createdAt: string;
  committedAt?: string;
  precondition?: SharedMeshWritePrecondition;
  payload: TPayload;
}

export interface SharedMeshQueueEntryMeta {
  firstAttemptAt: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  retryCount: number;
}

export interface SharedMeshReconciliationResult {
  intentId: string;
  outcome: MeshReconciliationOutcome;
  detail?: string;
}

export interface SharedMeshReadStaleness {
  source: "local-committed" | "local-queued" | "replica";
  lastGlobalCommitAt?: string;
  replicationLagMs?: number;
  queueDepth: number;
  isStale: boolean;
}

export interface SharedMeshQuorumRequirement {
  eligibleVoters: number;
  requiredAcks: number;
}

export type SharedMeshSyncRequestEnvelope<TPayload = unknown> = PeerSyncRequest & {
  replication?: SharedMeshReplicationEnvelope<TPayload>[];
};

export type SharedMeshSyncResponseEnvelope<TPayload = unknown> = PeerSyncResponse & {
  replication?: SharedMeshReplicationEnvelope<TPayload>[];
};

export interface SharedMeshSettingsRecord {
  settings: SettingsSyncPayload;
}

export interface SharedMeshSnapshot {
  mesh: NodeMeshState;
  staleness: SharedMeshReadStaleness;
}

const COORDINATION_BY_ENTITY: Record<SharedMeshEntityType, SharedMeshCoordinationMode> = {
  task: "strongly-coordinated",
  "task-metadata": "strongly-coordinated",
  mission: "strongly-coordinated",
  "agent-config": "strongly-coordinated",
  "agent-runtime": "node-local-only",
  "project-settings": "strongly-coordinated",
  "auth-material": "queued-for-later",
  "execution-run": "queued-for-later",
  "audit-event": "append-only-replicated",
  "filesystem-blob": "queued-for-later",
};

export function isMeshWriteClass(value: string): value is MeshWriteClass {
  return MESH_WRITE_CLASSES.includes(value as MeshWriteClass);
}

export function isMeshIntentState(value: string): value is MeshIntentState {
  return MESH_INTENT_STATES.includes(value as MeshIntentState);
}

export function getCoordinationModeForEntity(entityType: SharedMeshEntityType): SharedMeshCoordinationMode {
  return COORDINATION_BY_ENTITY[entityType];
}

export function getDefaultWriteClassForEntity(entityType: SharedMeshEntityType): MeshWriteClass {
  const mode = getCoordinationModeForEntity(entityType);
  if (mode === "append-only-replicated") return "append-only";
  if (mode === "queued-for-later") return "queued";
  if (mode === "node-local-only") return "local";
  return "strong";
}

export function getQuorumRequirement(eligibleVoters: number): SharedMeshQuorumRequirement {
  const normalized = Math.max(1, Math.floor(eligibleVoters));
  return {
    eligibleVoters: normalized,
    requiredAcks: Math.floor(normalized / 2) + 1,
  };
}

export function isQuorumSatisfied(eligibleVoters: number, ackCount: number): boolean {
  return ackCount >= getQuorumRequirement(eligibleVoters).requiredAcks;
}

export function createFenceToken(leaseEpoch: number, coordinatorNodeId: string, originSeq: number): string {
  return `${leaseEpoch}:${coordinatorNodeId}:${originSeq}`;
}

export function isProtocolRef(value: { protocol?: string; version?: string } | null | undefined): value is SharedMeshProtocolRef {
  return value?.protocol === SHARED_MESH_PROTOCOL_ID && value.version === SHARED_MESH_PROTOCOL_VERSION;
}

const RETRYABLE_NODE_ERROR_CODES = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"] as const;

export function isRetryableMeshWriteFailure(statusCode?: number, errorMessage?: string): boolean {
  if (statusCode !== undefined) {
    return statusCode === 502 || statusCode === 503 || statusCode === 504;
  }
  const message = (errorMessage ?? "").toLowerCase();
  if (message.includes("timeout") || message.includes("abort")) return true;
  if (message.includes("typeerror") || message.includes("network")) return true;
  return RETRYABLE_NODE_ERROR_CODES.some((code) => message.includes(code.toLowerCase()));
}

export function compareMeshWriteReplayOrder(a: Pick<MeshWriteQueueEntry, "createdAt" | "id">, b: Pick<MeshWriteQueueEntry, "createdAt" | "id">): number {
  if (a.createdAt === b.createdAt) {
    return a.id.localeCompare(b.id);
  }
  return a.createdAt.localeCompare(b.createdAt);
}

export function classifyReadStaleness(params: {
  queueDepth: number;
  lastGlobalCommitAt?: string;
  observedAt?: string;
}): SharedMeshReadStaleness {
  const observedAt = params.observedAt ? Date.parse(params.observedAt) : Date.now();
  const lastGlobal = params.lastGlobalCommitAt ? Date.parse(params.lastGlobalCommitAt) : undefined;
  const lag = lastGlobal !== undefined && Number.isFinite(lastGlobal) ? Math.max(0, observedAt - lastGlobal) : undefined;
  const queueDepth = Math.max(0, params.queueDepth);

  return {
    source: queueDepth > 0 ? "local-queued" : "local-committed",
    lastGlobalCommitAt: params.lastGlobalCommitAt,
    replicationLagMs: lag,
    queueDepth,
    isStale: queueDepth > 0 || (lag ?? 0) > 0,
  };
}
