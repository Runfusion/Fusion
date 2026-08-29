import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/client/client.js";
import { parseMissionResumeConflict } from "../../api/missions/missions.js";

const descriptor = { schemaVersion: 1, kind: "mission-resume-conflict", rootFeatureId: "F-root", reason: "budget-exhausted", source: "feature-row" } as const;
const retiredMirrorKey = ["legacy", "Blockers"].join("");

describe("MissionManager resume-conflict presentation input", () => {
  it("keeps v1 root ids and reasons for the operator toast", () => {
    const parsed = parseMissionResumeConflict(new ApiRequestError("conflict", 409, { code: "MISSION_RESUME_CONFLICT", blockerSchemaVersion: 1, blockers: [descriptor, { ...descriptor, rootFeatureId: "F-second", reason: "legacy-unknown-stop" }] }));
    expect(parsed?.blockers.map((blocker) => `${blocker.rootFeatureId} — ${blocker.reason}`)).toEqual([
      "F-root — budget-exhausted",
      "F-second — legacy-unknown-stop",
    ]);
  });

  it("fails closed for legacy-only and unversioned conflict payloads", () => {
    const legacyOnly = parseMissionResumeConflict(new ApiRequestError("conflict", 409, { code: "MISSION_RESUME_CONFLICT", [retiredMirrorKey]: [{ id: "F-root", reason: "budget-exhausted" }] }));
    const unversioned = parseMissionResumeConflict(new ApiRequestError("conflict", 409, { code: "MISSION_RESUME_CONFLICT", blockers: [descriptor] }));
    expect(legacyOnly).toEqual({ blockers: [] });
    expect(unversioned).toEqual({ blockers: [] });
  });

  it("leaves generic resume failures for the existing fallback toast", () => {
    expect(parseMissionResumeConflict(new Error("resume failed"))).toBeUndefined();
  });
});
