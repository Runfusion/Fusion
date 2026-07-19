import { describe, expect, it, vi } from "vitest";
import { createMissionTools } from "../agent-tools.js";

/*
FNXC:MissionToolParity 2026-07-29-12:00:
FN-8294 proves the engine surface delegates feature linking to the one MissionStore operation,
which owns live project-scoped task validation and bidirectional task linkage.
*/
describe("createMissionTools", () => {
  it("exposes the complete hierarchy surface with read and mutation names", () => {
    const store = { getMissionStore: vi.fn() } as never;
    expect(createMissionTools(store).map((tool) => tool.name)).toEqual([
      "fn_mission_list", "fn_mission_show", "fn_mission_create", "fn_mission_update", "fn_mission_delete",
      "fn_milestone_add", "fn_milestone_update", "fn_milestone_delete", "fn_slice_add", "fn_slice_activate",
      "fn_slice_delete", "fn_feature_add", "fn_feature_update", "fn_feature_delete", "fn_feature_link_task", "fn_research_promote_finding",
    ]);
  });

  it("delegates feature linkage to MissionStore without a second task update", async () => {
    const linkFeatureToTask = vi.fn().mockResolvedValue({ id: "F-1", taskId: "FN-1", status: "triaged" });
    const store = { getMissionStore: () => ({ linkFeatureToTask }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_feature_link_task")!;
    const result = await tool.execute("call", { featureId: "F-1", taskId: "FN-1" });
    expect(linkFeatureToTask).toHaveBeenCalledWith("F-1", "FN-1");
    expect(result.details).toMatchObject({ feature: { taskId: "FN-1", status: "triaged" } });
  });

  it("promotes completed findings through the idempotent mission-store facade", async () => {
    const addResearchFeature = vi.fn().mockResolvedValue({ reused: false, feature: { id: "F-1", status: "defined" } });
    const store = {
      getResearchStore: () => ({ getRun: vi.fn().mockResolvedValue({ id: "R-1", status: "completed", results: { findings: [{ heading: "Finding", content: "Evidence", sources: ["https://source.example"] }] } }) }),
      getMissionStore: () => ({ addResearchFeature }),
    } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_research_promote_finding")!;
    const result = await tool.execute("call", { runId: "R-1", findingId: "finding-b481c893", sliceId: "SL-1" });
    expect(addResearchFeature).toHaveBeenCalledWith("SL-1", expect.objectContaining({ researchProvenance: expect.objectContaining({ researchRunId: "R-1" }) }));
    expect(result.details).toMatchObject({ feature: { id: "F-1" }, reused: false });
  });

  it("returns a structured error for missing hierarchy records", async () => {
    const store = { getMissionStore: () => ({ getMissionWithHierarchy: vi.fn().mockResolvedValue(undefined) }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_mission_show")!;
    const result = await tool.execute("call", { id: "M-missing" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: "MISSION_NOT_FOUND" });
  });

  it("preserves supplied empty updates so descriptions can be cleared", async () => {
    const updateMission = vi.fn().mockResolvedValue({ id: "M-1", title: "Mission" });
    const store = { getMissionStore: () => ({ updateMission }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_mission_update")!;
    await tool.execute("call", { id: "M-1", description: "   " });
    expect(updateMission).toHaveBeenCalledWith("M-1", { description: "" });
  });
});
