/*
FNXC:PostgresCutover 2026-07-12:
The three replicated-create tests (buildMeshReplicatedTaskCreatePayload,
toReplicatedCreateInput, taskMatchesReplicatedCreate) were deleted because
mesh task replication moved to the PostgreSQL level (nodes share the
database) and those functions were removed from mesh-task-replication.ts.
Only buildBootstrapPrompt survives (task/comment PROMPT.md stub builder).
*/
import { describe, expect, it } from "vitest";
import { buildBootstrapPrompt } from "../mesh-task-replication.js";

describe("mesh-task-replication", () => {
  it("buildBootstrapPrompt matches task bootstrap format", () => {
    expect(buildBootstrapPrompt("FN-1", undefined, "desc")).toBe("# FN-1\n\ndesc\n");
    expect(buildBootstrapPrompt("FN-1", "Title", "desc")).toBe("# FN-1: Title\n\ndesc\n");
  });
});
