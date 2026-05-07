import { describe, expect, it } from "vitest";
import {
  SHARED_STATE_SNAPSHOT_VERSION,
  computeSnapshotChecksum,
  createActivityLogSnapshot,
  createAgentRunSnapshot,
  createAgentSnapshot,
  createAuthMaterialSnapshot,
  createMissionHierarchySnapshot,
  createProjectSettingsSnapshot,
  createRunAuditSnapshot,
  createTaskMetadataSnapshot,
  validateSnapshotEnvelope,
  type AgentSnapshot,
  type MissionHierarchySnapshot,
  type TaskMetadataRecord,
} from "../shared-mesh-state.js";

describe("shared-mesh-state", () => {
  const exportedAt = "2026-05-04T00:00:00.000Z";

  it("computes stable checksums", () => {
    const snapshot = createActivityLogSnapshot([{ id: "a1", timestamp: exportedAt, type: "task:created", details: "x" }], exportedAt);
    const checksum = computeSnapshotChecksum({
      version: snapshot.version,
      exportedAt: snapshot.exportedAt,
      payload: snapshot.payload,
    });
    expect(checksum).toBe(snapshot.checksum);
  });

  it("rejects version mismatch", () => {
    const snapshot = createRunAuditSnapshot([], exportedAt);
    expect(() => validateSnapshotEnvelope({ ...snapshot, version: 999 }, SHARED_STATE_SNAPSHOT_VERSION)).toThrow(
      "Unsupported shared-state snapshot version",
    );
  });

  it("rejects checksum mismatch", () => {
    const snapshot = createRunAuditSnapshot([], exportedAt);
    expect(() => validateSnapshotEnvelope({ ...snapshot, checksum: "bad" })).toThrow("checksum mismatch");
  });

  it("supports happy-path round trips for all payload kinds", () => {
    const task = { id: "FN-1", description: "d", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: exportedAt, updatedAt: exportedAt, worktree: "/tmp/x", sessionFile: "/tmp/y" } as unknown as TaskMetadataRecord;
    const taskSnapshot = createTaskMetadataSnapshot([task as any], exportedAt);
    expect((taskSnapshot.payload.tasks[0] as any).worktree).toBeUndefined();

    const missionSnapshot: MissionHierarchySnapshot = createMissionHierarchySnapshot(
      { missions: [], milestones: [], slices: [], features: [], missionEvents: [], assertions: [], featureAssertionLinks: [] },
      exportedAt,
    );

    const agentSnapshot: AgentSnapshot = createAgentSnapshot({ agents: [], blockedStates: [] }, exportedAt);
    const runSnapshot = createAgentRunSnapshot([], exportedAt);
    const activitySnapshot = createActivityLogSnapshot([], exportedAt);
    const auditSnapshot = createRunAuditSnapshot([], exportedAt);
    const settingsSnapshot = createProjectSettingsSnapshot({ global: {} }, exportedAt);
    const authSnapshot = createAuthMaterialSnapshot({}, exportedAt);

    for (const snapshot of [
      taskSnapshot,
      missionSnapshot,
      agentSnapshot,
      runSnapshot,
      activitySnapshot,
      auditSnapshot,
      settingsSnapshot,
      authSnapshot,
    ]) {
      validateSnapshotEnvelope(snapshot);
      const roundTrip = JSON.parse(JSON.stringify(snapshot));
      expect(roundTrip).toEqual(snapshot);
      validateSnapshotEnvelope(roundTrip);
    }
  });
});
