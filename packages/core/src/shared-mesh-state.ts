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
FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
Task/state mesh replication is REMOVED — shared PostgreSQL is the SoT.
createProjectSettingsSnapshot remains for legacy helpers/tests only; live mesh
routes no longer apply or emit projectSettings. authMaterial stays on the wire
because auth.json is per-machine file state, plus the shared envelope/checksum
plumbing.
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
