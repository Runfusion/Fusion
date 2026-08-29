import { describe, expect, it } from "vitest";
import {
  MISSION_BLOCKER_DESCRIPTOR_SCHEMA_VERSION,
  createMissionBlockerDescriptor,
  dedupeMissionBlockerDescriptors,
  isMissionBlockerDescriptor,
  normalizeMissionBlockerReason,
  sortMissionBlockerDescriptors,
} from "../index.js";

describe("mission blocker descriptors", () => {
  it("normalizes known and unknown persisted stop reasons fail-closed", () => {
    for (const reason of ["budget-exhausted", "operator-intervention", "legacy-unknown-stop"] as const) expect(normalizeMissionBlockerReason(reason)).toEqual({ reason });
    expect(normalizeMissionBlockerReason(undefined)).toEqual({ reason: "legacy-unknown-stop" });
    expect(normalizeMissionBlockerReason(null)).toEqual({ reason: "legacy-unknown-stop" });
    expect(normalizeMissionBlockerReason("")).toEqual({ reason: "legacy-unknown-stop" });
    expect(normalizeMissionBlockerReason("garbage-from-a-plugin")).toEqual({ reason: "legacy-unknown-stop", rawReason: "garbage-from-a-plugin" });
  });

  it("gates descriptors by their versioned shape", () => {
    const descriptor = createMissionBlockerDescriptor({ rootFeatureId: "F-1", rawReason: "budget-exhausted", source: "feature-row" });
    expect(isMissionBlockerDescriptor(descriptor)).toBe(true);
    expect(isMissionBlockerDescriptor({ id: "F-1", reason: "budget-exhausted" })).toBe(false);
    expect(isMissionBlockerDescriptor({ ...descriptor, schemaVersion: 2 })).toBe(false);
    expect(isMissionBlockerDescriptor(null)).toBe(false);
    expect(descriptor.schemaVersion).toBe(MISSION_BLOCKER_DESCRIPTOR_SCHEMA_VERSION);
  });

  it("preserves unknown persisted reasons in canonical descriptors", () => {
    const unknown = createMissionBlockerDescriptor({ rootFeatureId: "F-2", rawReason: "old-plugin-stop", source: "lineage-stop" });
    expect(unknown).toMatchObject({ reason: "legacy-unknown-stop", rawReason: "old-plugin-stop" });
  });

  it("sorts same-root sources deterministically without mutating input", () => {
    const lineage = createMissionBlockerDescriptor({ rootFeatureId: "F-1", rawReason: "budget-exhausted", source: "lineage-stop" });
    const feature = createMissionBlockerDescriptor({ rootFeatureId: "F-1", rawReason: "legacy-unknown-stop", source: "feature-row" });
    const original = [lineage, feature];
    expect(sortMissionBlockerDescriptors(original)).toEqual([feature, lineage]);
    expect(original).toEqual([lineage, feature]);
  });

  it("deduplicates sorted descriptors without losing cross-source provenance or mutating input", () => {
    const feature = createMissionBlockerDescriptor({ rootFeatureId: "F-1", rawReason: "budget-exhausted", source: "feature-row", stoppedAt: "first" });
    const duplicateLineage = createMissionBlockerDescriptor({ rootFeatureId: "F-1", rawReason: "budget-exhausted", source: "lineage-stop", stoppedAt: "first" });
    const lineage = createMissionBlockerDescriptor({ rootFeatureId: "F-1", rawReason: "budget-exhausted", source: "lineage-stop", stoppedAt: "second" });
    const original = [feature, duplicateLineage, lineage];

    expect(dedupeMissionBlockerDescriptors(original)).toEqual([feature, duplicateLineage]);
    expect(original).toEqual([feature, duplicateLineage, lineage]);
  });
});
