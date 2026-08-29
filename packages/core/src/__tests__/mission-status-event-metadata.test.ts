import { describe, expect, it } from "vitest";
import {
  FEATURE_LOOP_REPAIR_TRANSITIONS,
  FEATURE_LOOP_TRANSITIONS,
  MISSION_EVENT_METADATA_MAX_BYTES,
  boundMissionEventReason,
  featureValidationRepairEligibility,
  buildMissionStatusEventMetadata,
  normalizeMissionTransitionActorForEvent,
} from "../missions/mission-types.js";

describe("mission status event metadata", () => {
  it("keeps execution transitions terminal while exposing only explicit repair edges", () => {
    expect(FEATURE_LOOP_TRANSITIONS.blocked).toEqual([]);
    expect(FEATURE_LOOP_TRANSITIONS.passed).toEqual([]);
    expect(FEATURE_LOOP_REPAIR_TRANSITIONS.blocked).toEqual(["idle", "implementing"]);
    expect(FEATURE_LOOP_REPAIR_TRANSITIONS.needs_fix).toEqual(["idle", "implementing"]);
    expect(FEATURE_LOOP_REPAIR_TRANSITIONS.passed).toEqual([]);
    expect(Object.values(FEATURE_LOOP_REPAIR_TRANSITIONS).flat()).not.toContain("validating");
  });

  it("uses one eligibility rule for stale badges without preempting live validation", () => {
    for (const status of ["defined", "triaged", "in-progress", "done"] as const) {
      expect(featureValidationRepairEligibility({ status, loopState: "blocked" })).toEqual({ clear: true, reRun: true });
      expect(featureValidationRepairEligibility({ status, loopState: "needs_fix" })).toEqual({ clear: true, reRun: true });
    }
    expect(featureValidationRepairEligibility({ status: "blocked", loopState: "idle" })).toEqual({ clear: true, reRun: true });
    for (const loopState of ["implementing", "validating", "passed"] as const) {
      expect(featureValidationRepairEligibility({ status: "blocked", loopState })).toEqual({ clear: true, reRun: false });
    }
    expect(featureValidationRepairEligibility({ status: "in-progress", loopState: "validating" })).toEqual({ clear: false, reRun: false });
  });
  it("redacts, bounds, and rejects semantically empty untrusted reasons", () => {
    expect(boundMissionEventReason("Authorization: Bearer sk-live-ABCDEFG1234567890abcdef").value).toContain("[REDACTED]");
    expect(boundMissionEventReason("/private/secret/worktree/file.ts").value).toContain("[external path omitted]");
    expect(boundMissionEventReason(" ".repeat(600))).toEqual({});
    const bounded = boundMissionEventReason("ordinary prose ".repeat(100));
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.value!, "utf8")).toBeLessThanOrEqual(512);
  });

  it("persists only normalized actor identity", () => {
    const actor = normalizeMissionTransitionActorForEvent({
      type: "not-a-real-actor",
      id: 42,
      source: "s".repeat(500),
      displayName: "must not persist",
      extra: "must not persist",
    });
    expect(actor).toMatchObject({ type: "system", id: "mission-store" });
    expect(actor).not.toHaveProperty("displayName");
    expect(Buffer.byteLength(actor.source, "utf8")).toBeLessThanOrEqual(200);
  });

  it("is total and produces bounded JSON for hostile metadata", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const hostile = Object.defineProperty({}, "id", { get: () => { throw new Error("getter"); } });
    expect(() => buildMissionStatusEventMetadata({
      entity: "feature", field: "status", from: "defined", to: "done",
      ids: { featureId: "F-1", missing: undefined }, actor: hostile,
      reason: circular,
    })).not.toThrow();
    const metadata = buildMissionStatusEventMetadata({
      entity: "mission", field: "autopilotEnabled", from: false, to: true,
      ids: {}, actor: { type: "agent", id: "agent-1", source: "tool", displayName: "Ignored" },
      reason: "r".repeat(900),
    });
    expect(metadata).toMatchObject({ source: "tool", from: false, to: true });
    expect(metadata.actor).toEqual({ type: "agent", id: "agent-1", source: "tool" });
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeLessThanOrEqual(MISSION_EVENT_METADATA_MAX_BYTES);
  });
});
