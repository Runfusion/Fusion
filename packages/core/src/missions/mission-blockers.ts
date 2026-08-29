/*
FNXC:MissionBlockedRepair 2026-08-11-08:07:
FN-8979 retired the v0 { id, reason } mirror after auditing supported consumers. Resume and
blocked diagnostics share one canonical descriptor vocabulary; future consumers must not re-add
an id/reason shape.
*/
import {
  MISSION_BLOCKER_DESCRIPTOR_SCHEMA_VERSION,
  type MissionBlockerDescriptor,
  type MissionBlockerReason,
  type MissionBlockerSource,
} from "./mission-types.js";

const KNOWN_REASONS = new Set<MissionBlockerReason>(["budget-exhausted", "operator-intervention", "legacy-unknown-stop"]);

export function normalizeMissionBlockerReason(raw: string | null | undefined): { reason: MissionBlockerReason; rawReason?: string } {
  if (raw && KNOWN_REASONS.has(raw as MissionBlockerReason)) return { reason: raw as MissionBlockerReason };
  return raw ? { reason: "legacy-unknown-stop", rawReason: raw } : { reason: "legacy-unknown-stop" };
}

export function createMissionBlockerDescriptor(input: { rootFeatureId: string; source: MissionBlockerSource; rawReason: string | null | undefined; missionId?: string; stoppedAt?: string; origin?: string }): MissionBlockerDescriptor {
  const normalized = normalizeMissionBlockerReason(input.rawReason);
  return { schemaVersion: MISSION_BLOCKER_DESCRIPTOR_SCHEMA_VERSION, kind: "mission-resume-conflict", rootFeatureId: input.rootFeatureId, reason: normalized.reason, source: input.source, ...(input.missionId ? { missionId: input.missionId } : {}), ...(input.stoppedAt ? { stoppedAt: input.stoppedAt } : {}), ...(input.origin ? { origin: input.origin } : {}), ...(normalized.rawReason ? { rawReason: normalized.rawReason } : {}) };
}

export function isMissionBlockerDescriptor(value: unknown): value is MissionBlockerDescriptor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === MISSION_BLOCKER_DESCRIPTOR_SCHEMA_VERSION && candidate.kind === "mission-resume-conflict" && typeof candidate.rootFeatureId === "string" && candidate.rootFeatureId.length > 0 && typeof candidate.reason === "string" && KNOWN_REASONS.has(candidate.reason as MissionBlockerReason) && (candidate.source === "feature-row" || candidate.source === "lineage-stop");
}

export function sortMissionBlockerDescriptors(list: readonly MissionBlockerDescriptor[]): MissionBlockerDescriptor[] {
  return [...list].sort((a, b) => a.rootFeatureId.localeCompare(b.rootFeatureId) || (a.source === b.source ? 0 : a.source === "feature-row" ? -1 : 1) || a.reason.localeCompare(b.reason));
}

/*
FNXC:MissionBlockedRepair 2026-08-11-08:07:
Canonical blockers deduplicate on (rootFeatureId, source, reason), exactly matching the Mission
Manager Why blocked render key. Persisted rows cannot currently collide because lineage stops are
keyed by (project_id, root_feature_id), so this enforces the exported classifier contract for all
callers. Cross-source entries preserve provenance; first-after-sort retains stoppedAt, origin, and rawReason.
*/
export function dedupeMissionBlockerDescriptors(list: readonly MissionBlockerDescriptor[]): MissionBlockerDescriptor[] {
  const seen = new Set<string>();
  return list.filter((descriptor) => {
    const key = `${descriptor.rootFeatureId}\u0000${descriptor.source}\u0000${descriptor.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
