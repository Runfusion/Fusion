/*
FNXC:MissionAutoMerge 2026-07-18-12:00:
The legacy synchronous MissionStore remains a supported fallback even though PostgreSQL
is the production backend. Keep its create-only triage contract aligned with AsyncMissionStore:
only an explicit false mission override is forwarded to TaskStore.createTask with mission policy provenance.
*/

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("MissionStore synchronous triage auto-merge contract", () => {
  it("stamps only false on the synchronous create branch after the duplicate guard", async () => {
    const source = await readFile(fileURLToPath(new URL("../missions/mission-store.ts", import.meta.url)), "utf8");
    const triageFeature = source.slice(source.indexOf("async triageFeature("), source.indexOf("async triageSlice("));

    expect(triageFeature).toContain('if (guard.action === "duplicate" && guard.existing)');
    const missionPolicyCreate = '...(mission?.autoMerge === false ? { autoMerge: false, autoMergeProvenance: "mission" as const } : {}),';
    expect(triageFeature).toContain(missionPolicyCreate);
    expect(triageFeature.indexOf('if (guard.action === "duplicate" && guard.existing)'))
      .toBeLessThan(triageFeature.indexOf(missionPolicyCreate));
    expect(triageFeature).toContain('usesProjectDefaultStrategy ? `mission/${missionId}`');
    expect(triageFeature).toContain('ensureBranchGroupForSource("mission", missionId');
  });
});
