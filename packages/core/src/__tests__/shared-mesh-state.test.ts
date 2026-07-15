import { describe, expect, it } from "vitest";
import {
  SHARED_STATE_SNAPSHOT_VERSION,
  computeSnapshotChecksum,
  createAuthMaterialSnapshot,
  createProjectSettingsSnapshot,
  validateSnapshotEnvelope,
} from "../shared-mesh-state.js";

/*
FNXC:PostgresCutover 2026-07-12:
FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
Task/state mesh replication is REMOVED. Live mesh routes exchange authMaterial
only; projectSettings helpers remain for legacy envelope tests/checksum plumbing.
*/
describe("shared-mesh-state", () => {
  const exportedAt = "2026-05-04T00:00:00.000Z";

  it("computes stable checksums", () => {
    const snapshot = createProjectSettingsSnapshot({ global: {} }, exportedAt);
    const checksum = computeSnapshotChecksum({
      version: snapshot.version,
      exportedAt: snapshot.exportedAt,
      payload: snapshot.payload,
    });
    expect(checksum).toBe(snapshot.checksum);
  });

  it("rejects version mismatch", () => {
    const snapshot = createProjectSettingsSnapshot({ global: {} }, exportedAt);
    expect(() => validateSnapshotEnvelope({ ...snapshot, version: 999 }, SHARED_STATE_SNAPSHOT_VERSION)).toThrow(
      "Unsupported shared-state snapshot version",
    );
  });

  it("rejects checksum mismatch", () => {
    const snapshot = createProjectSettingsSnapshot({ global: {} }, exportedAt);
    expect(() => validateSnapshotEnvelope({ ...snapshot, checksum: "bad" })).toThrow("checksum mismatch");
  });

  it("supports happy-path round trips for the surviving payload kinds", () => {
    const settingsSnapshot = createProjectSettingsSnapshot({ global: {} }, exportedAt);
    const authSnapshot = createAuthMaterialSnapshot({
      anthropic: { type: "api_key", key: "sk-ant" },
      "openai-codex": {
        type: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expires: 1_900_000_000_000,
        accountId: "acct-1",
      },
    }, exportedAt);

    for (const snapshot of [settingsSnapshot, authSnapshot]) {
      validateSnapshotEnvelope(snapshot);
      const roundTrip = JSON.parse(JSON.stringify(snapshot));
      expect(roundTrip).toEqual(snapshot);
      validateSnapshotEnvelope(roundTrip);
    }
  });
});
