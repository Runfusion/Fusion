import { createHash } from "node:crypto";
export { SHARED_STATE_SNAPSHOT_VERSION } from "./types.js";
import { SHARED_STATE_SNAPSHOT_VERSION } from "./types.js";
import type {
  GlobalSettings,
  ProjectSettings,
  ProviderAuthEntry,
} from "./types.js";

/*
FNXC:PostgresCutover 2026-07-12:
Task/state mesh replication is REMOVED — all replication is handled at the
PostgreSQL level (nodes share the database). The task-metadata, agent,
agent-run, activity-log, run-audit, and mission-hierarchy snapshot types and
creators that used to live here are gone with it. What remains is the
settings-adjacent pair still exchanged over the mesh: projectSettings (legacy
sqlite topology settings sync) and authMaterial (auth.json is per-machine
file state — the one domain that does not live in the database), plus the
shared envelope/checksum plumbing they ride on.
*/

export const SHARED_STATE_DEFAULT_LIMIT = 10_000;

export interface SharedSnapshotEnvelope<TPayload> {
  version: number;
  exportedAt: string;
  checksum: string;
  payload: TPayload;
}

export type ProjectSettingsSnapshot = SharedSnapshotEnvelope<{
  global: GlobalSettings;
  projects?: Record<string, ProjectSettings>;
}>;

export type AuthMaterialSnapshot = SharedSnapshotEnvelope<{
  providerAuth?: Record<string, ProviderAuthEntry>;
}>;

function withChecksum<TPayload>(payload: TPayload, exportedAt?: string): SharedSnapshotEnvelope<TPayload> {
  const envelope = {
    version: SHARED_STATE_SNAPSHOT_VERSION,
    exportedAt: exportedAt ?? new Date().toISOString(),
    payload,
  };
  return { ...envelope, checksum: computeSnapshotChecksum(envelope) };
}

export function computeSnapshotChecksum(snapshotWithoutChecksum: Omit<SharedSnapshotEnvelope<unknown>, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(snapshotWithoutChecksum)).digest("hex");
}

export function validateSnapshotEnvelope(snapshot: SharedSnapshotEnvelope<unknown>, expectedVersion = SHARED_STATE_SNAPSHOT_VERSION): void {
  if (snapshot.version !== expectedVersion) {
    throw new Error(`Unsupported shared-state snapshot version ${snapshot.version} (expected ${expectedVersion})`);
  }
  const expectedChecksum = computeSnapshotChecksum({
    version: snapshot.version,
    exportedAt: snapshot.exportedAt,
    payload: snapshot.payload,
  });
  if (snapshot.checksum !== expectedChecksum) {
    throw new Error("Shared-state snapshot checksum mismatch");
  }
}

export function createProjectSettingsSnapshot(payload: ProjectSettingsSnapshot["payload"], exportedAt?: string): ProjectSettingsSnapshot {
  return withChecksum(payload, exportedAt);
}

export function createAuthMaterialSnapshot(providerAuth: Record<string, ProviderAuthEntry> | undefined, exportedAt?: string): AuthMaterialSnapshot {
  return withChecksum({ providerAuth }, exportedAt);
}
