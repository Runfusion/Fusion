import { createHash } from "node:crypto";
export { SHARED_STATE_SNAPSHOT_VERSION } from "./types.js";
import { SHARED_STATE_SNAPSHOT_VERSION } from "./types.js";
import type {
  ActivityLogEntry,
  Agent,
  AgentHeartbeatRun,
  BlockedStateSnapshot,
  GlobalSettings,
  ProjectSettings,
  ProviderAuthEntry,
  RunAuditEvent,
  Task,
} from "./types.js";
import type {
  FeatureAssertionLink,
  Milestone,
  Mission,
  MissionContractAssertion,
  MissionEvent,
  MissionFeature,
  Slice,
} from "./mission-types.js";

export interface SharedSnapshotEnvelope<TPayload> {
  version: number;
  exportedAt: string;
  checksum: string;
  payload: TPayload;
}

/** Excludes file/blob/runtime state: no PROMPT.md body, task documents, attachment bytes, or worktree/runtime handles. */
export type TaskMetadataRecord = Omit<Task, "worktree" | "executionStartBranch" | "sessionFile">;
export type TaskMetadataSnapshot = SharedSnapshotEnvelope<{ tasks: TaskMetadataRecord[] }>;

/** Excludes instruction-bundle file contents and other node-local runtime handles. */
export interface AgentBlockedStateRecord {
  agentId: string;
  state: BlockedStateSnapshot;
}
export type AgentSnapshot = SharedSnapshotEnvelope<{ agents: Agent[]; blockedStates: AgentBlockedStateRecord[] }>;

/** Excludes agent.log/run-log JSONL content; structured run rows only. */
export type AgentRunSnapshot = SharedSnapshotEnvelope<{ runs: AgentHeartbeatRun[] }>;

export type ActivityLogSnapshot = SharedSnapshotEnvelope<{ entries: ActivityLogEntry[] }>;
export type RunAuditSnapshot = SharedSnapshotEnvelope<{ entries: RunAuditEvent[] }>;

export type MissionHierarchySnapshot = SharedSnapshotEnvelope<{
  missions: Mission[];
  milestones: Milestone[];
  slices: Slice[];
  features: MissionFeature[];
  missionEvents: MissionEvent[];
  assertions: MissionContractAssertion[];
  featureAssertionLinks: FeatureAssertionLink[];
}>;

export type ProjectSettingsSnapshot = SharedSnapshotEnvelope<{
  global: GlobalSettings;
  projects?: Record<string, ProjectSettings>;
}>;

export type AuthMaterialSnapshot = SharedSnapshotEnvelope<{
  providerAuth?: Record<string, ProviderAuthEntry>;
}>;

export type SharedMeshStateSnapshot =
  | TaskMetadataSnapshot
  | MissionHierarchySnapshot
  | AgentSnapshot
  | AgentRunSnapshot
  | ActivityLogSnapshot
  | RunAuditSnapshot
  | ProjectSettingsSnapshot
  | AuthMaterialSnapshot;

function withChecksum<TPayload>(payload: TPayload, exportedAt?: string): SharedSnapshotEnvelope<TPayload> {
  const withoutChecksum = {
    version: SHARED_STATE_SNAPSHOT_VERSION,
    exportedAt: exportedAt ?? new Date().toISOString(),
    payload,
  };
  return {
    ...withoutChecksum,
    checksum: createHash("sha256").update(JSON.stringify(withoutChecksum)).digest("hex"),
  };
}

export function computeSnapshotChecksum(snapshotWithoutChecksum: Omit<SharedSnapshotEnvelope<unknown>, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(snapshotWithoutChecksum)).digest("hex");
}

export function validateSnapshotEnvelope(snapshot: SharedSnapshotEnvelope<unknown>, expectedVersion = SHARED_STATE_SNAPSHOT_VERSION): void {
  if (snapshot.version !== expectedVersion) {
    throw new Error(`Unsupported shared-state snapshot version: ${snapshot.version}`);
  }
  const expected = computeSnapshotChecksum({
    version: snapshot.version,
    exportedAt: snapshot.exportedAt,
    payload: snapshot.payload,
  });
  if (snapshot.checksum !== expected) {
    throw new Error("Shared-state snapshot checksum mismatch");
  }
}

export function toTaskMetadataRecord(task: Task): TaskMetadataRecord {
  const { worktree: _worktree, executionStartBranch: _executionStartBranch, sessionFile: _sessionFile, ...rest } = task;
  return rest;
}

export function createTaskMetadataSnapshot(tasks: Task[], exportedAt?: string): TaskMetadataSnapshot {
  return withChecksum({ tasks: tasks.map((task) => toTaskMetadataRecord(task)) }, exportedAt);
}

export function createMissionHierarchySnapshot(payload: MissionHierarchySnapshot["payload"], exportedAt?: string): MissionHierarchySnapshot {
  return withChecksum(payload, exportedAt);
}

export function createAgentSnapshot(payload: AgentSnapshot["payload"], exportedAt?: string): AgentSnapshot {
  return withChecksum(payload, exportedAt);
}

export function createAgentRunSnapshot(runs: AgentHeartbeatRun[], exportedAt?: string): AgentRunSnapshot {
  return withChecksum({ runs }, exportedAt);
}

export function createActivityLogSnapshot(entries: ActivityLogEntry[], exportedAt?: string): ActivityLogSnapshot {
  return withChecksum({ entries }, exportedAt);
}

export function createRunAuditSnapshot(entries: RunAuditEvent[], exportedAt?: string): RunAuditSnapshot {
  return withChecksum({ entries }, exportedAt);
}

export function createProjectSettingsSnapshot(payload: ProjectSettingsSnapshot["payload"], exportedAt?: string): ProjectSettingsSnapshot {
  return withChecksum(payload, exportedAt);
}

export function createAuthMaterialSnapshot(providerAuth: Record<string, ProviderAuthEntry> | undefined, exportedAt?: string): AuthMaterialSnapshot {
  return withChecksum({ providerAuth }, exportedAt);
}
