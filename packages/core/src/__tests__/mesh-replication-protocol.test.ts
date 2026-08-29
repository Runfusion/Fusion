import { describe, expect, it } from "vitest";
import {
  SHARED_MESH_PROTOCOL_ID,
  SHARED_MESH_PROTOCOL_VERSION,
  classifyReadStaleness,
  compareMeshWriteReplayOrder,
  createFenceToken,
  getCoordinationModeForEntity,
  getDefaultWriteClassForEntity,
  getQuorumRequirement,
  isMeshIntentState,
  isMeshWriteClass,
  isProtocolRef,
  isQuorumSatisfied,
  isRetryableMeshWriteFailure,
} from "../mesh/mesh-replication-protocol.js";

describe("mesh-replication-protocol", () => {
  it("exposes protocol identity", () => {
    expect(SHARED_MESH_PROTOCOL_ID).toBe("fusion.shared-mesh");
    expect(SHARED_MESH_PROTOCOL_VERSION).toBe("1.0");
  });

  it("classifies entity coordination modes", () => {
    expect(getCoordinationModeForEntity("task")).toBe("strongly-coordinated");
    expect(getCoordinationModeForEntity("audit-event")).toBe("append-only-replicated");
    expect(getCoordinationModeForEntity("filesystem-blob")).toBe("queued-for-later");
    expect(getCoordinationModeForEntity("agent-runtime")).toBe("node-local-only");
  });

  it("maps entity coordination mode to default write class", () => {
    expect(getDefaultWriteClassForEntity("task")).toBe("strong");
    expect(getDefaultWriteClassForEntity("audit-event")).toBe("append-only");
    expect(getDefaultWriteClassForEntity("filesystem-blob")).toBe("queued");
    expect(getDefaultWriteClassForEntity("agent-runtime")).toBe("local");
  });

  it("computes quorum requirements and satisfies majority rule", () => {
    expect(getQuorumRequirement(1)).toEqual({ eligibleVoters: 1, requiredAcks: 1 });
    expect(getQuorumRequirement(2)).toEqual({ eligibleVoters: 2, requiredAcks: 2 });
    expect(getQuorumRequirement(3)).toEqual({ eligibleVoters: 3, requiredAcks: 2 });
    expect(isQuorumSatisfied(5, 2)).toBe(false);
    expect(isQuorumSatisfied(5, 3)).toBe(true);
  });

  it("validates write class and intent state discriminators", () => {
    expect(isMeshWriteClass("strong")).toBe(true);
    expect(isMeshWriteClass("invalid")).toBe(false);
    expect(isMeshIntentState("committed")).toBe(true);
    expect(isMeshIntentState("waiting")).toBe(false);
  });

  it("creates deterministic fence tokens", () => {
    expect(createFenceToken(7, "node_a", 99)).toBe("7:node_a:99");
  });

  it("validates protocol refs", () => {
    expect(isProtocolRef({ protocol: "fusion.shared-mesh", version: "1.0" })).toBe(true);
    expect(isProtocolRef({ protocol: "fusion.shared-mesh", version: "2.0" })).toBe(false);
  });

  it("orders replay rows by createdAt then id", () => {
    const a = { createdAt: "2026-05-10T00:00:00.000Z", id: "b" };
    const b = { createdAt: "2026-05-10T00:00:00.000Z", id: "a" };
    const c = { createdAt: "2026-05-10T00:00:01.000Z", id: "a" };

    expect(compareMeshWriteReplayOrder(a, b)).toBeGreaterThan(0);
    expect(compareMeshWriteReplayOrder(b, a)).toBeLessThan(0);
    expect(compareMeshWriteReplayOrder(a, c)).toBeLessThan(0);
  });

  it("classifies retryable mesh failures", () => {
    expect(isRetryableMeshWriteFailure(503)).toBe(true);
    expect(isRetryableMeshWriteFailure(409)).toBe(false);
    expect(isRetryableMeshWriteFailure(undefined, "TypeError: fetch failed ECONNREFUSED")).toBe(true);
    expect(isRetryableMeshWriteFailure(undefined, "validation error 422")).toBe(false);
  });

  it("classifies read staleness from queue depth and lag", () => {
    const fresh = classifyReadStaleness({ queueDepth: 0, observedAt: "2026-05-05T00:00:10.000Z", lastGlobalCommitAt: "2026-05-05T00:00:10.000Z" });
    expect(fresh.isStale).toBe(false);
    expect(fresh.source).toBe("local-committed");

    const queued = classifyReadStaleness({ queueDepth: 2, observedAt: "2026-05-05T00:00:10.000Z", lastGlobalCommitAt: "2026-05-05T00:00:09.000Z" });
    expect(queued.isStale).toBe(true);
    expect(queued.source).toBe("local-queued");
    expect(queued.replicationLagMs).toBe(1000);
  });
});
