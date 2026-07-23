/*
FNXC:PostgresCutover 2026-07-12:
The three replicated-create tests (buildMeshReplicatedTaskCreatePayload,
toReplicatedCreateInput, taskMatchesReplicatedCreate) were deleted because
mesh task replication moved to the PostgreSQL level (nodes share the
database) and those functions were removed from mesh-task-replication.ts.
Only buildBootstrapPrompt survives (task/comment PROMPT.md stub builder).
*/
import { describe, expect, it } from "vitest";
import { buildBootstrapPrompt, isUnplannedSeedPrompt } from "../mesh/mesh-task-replication.js";
import { applyOriginalDescription } from "../tasks/original-description-policy.js";

describe("mesh-task-replication", () => {
  it("buildBootstrapPrompt matches task bootstrap format", () => {
    expect(buildBootstrapPrompt("FN-1", undefined, "desc")).toBe("# FN-1\n\ndesc\n");
    expect(buildBootstrapPrompt("FN-1", "Title", "desc")).toBe("# FN-1: Title\n\ndesc\n");
  });

  /*
  FNXC:OriginalDescriptionInPrompt 2026-07-14-23:35:
  Planned-spec Original Description injection must not change bootstrap equality
  used by isUnplannedSeedPrompt / hold-release unplanned detection.
  */
  it("keeps bootstrap seed equality after original-description policy exists", () => {
    const bootstrap = buildBootstrapPrompt("FN-1", "Title", "desc");
    expect(isUnplannedSeedPrompt(bootstrap, "FN-1", "Title", "desc")).toBe(true);
    // Applying original description to a *real* spec does not affect bootstrap detection.
    const planned = applyOriginalDescription(
      "# FN-1: Title\n\n**Created:** 2026-07-14\n\n## Mission\n\nPlanned work.\n",
      "desc",
    );
    expect(isUnplannedSeedPrompt(planned, "FN-1", "Title", "desc")).toBe(false);
    expect(planned).toContain("## Original Description");
  });
});
