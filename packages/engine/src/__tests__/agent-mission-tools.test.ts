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

  it("renders populated hierarchy IDs, statuses, task links, and bounded gate text", async () => {
    const longAcceptanceCriteria = "a".repeat(241);
    const mission = {
      id: "M-1", title: "Mission", status: "active", description: "Mission description", baseBranch: "main",
      createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z", eventCount: 4,
      linkedGoals: [{ id: "G-1", title: "Goal", status: "active" }],
      milestones: [
        {
          id: "MS-1", title: "Repeated", status: "active", acceptanceCriteria: longAcceptanceCriteria,
          slices: [
            {
              id: "SL-1", title: "Repeated", status: "active", activatedAt: "2026-07-23T02:00:00.000Z", verification: "Run focused test",
              features: [
                { id: "F-1", title: "Repeated", status: "triaged", taskId: "FN-1", acceptanceCriteria: longAcceptanceCriteria },
                { id: "F-2", title: "Repeated", status: "done" },
              ],
            },
          ],
        },
        { id: "MS-2", title: "Second", status: "pending", slices: [] },
      ],
    };
    const getMissionWithHierarchy = vi.fn().mockResolvedValue(mission);
    const store = { getMissionStore: () => ({ getMissionWithHierarchy }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_mission_show")!;
    const result = await tool.execute("call", { id: mission.id });
    const text = result.content[0].text;

    expect(getMissionWithHierarchy).toHaveBeenCalledWith(mission.id);
    expect(result.details).toEqual({ mission });
    expect(text).toContain("Status: active");
    expect(text).toContain("MS-1: Repeated (active)");
    expect(text).toContain("SL-1: Repeated (active)");
    expect(text).toContain("F-1: Repeated (triaged) → FN-1");
    expect(text).toContain("F-2: Repeated (done)");
    expect(text).toContain("MS-2: Second (pending)");
    expect(text).toContain("No slices.");
    expect(text).toContain("… (truncated, 241 chars)");
    expect(text).toContain("F-1: Repeated (triaged) → FN-1");
    expect(text.indexOf("MS-1:")).toBeLessThan(text.indexOf("SL-1:"));
    expect(text.indexOf("SL-1:")).toBeLessThan(text.indexOf("F-1:"));
    expect(text).not.toBe(`${mission.id}: ${mission.title}`);
  });

  it("renders explicit empty hierarchy states without optional metadata", async () => {
    const missionWithoutMilestones = {
      id: "M-empty", title: "Empty", status: "planning", createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z", milestones: [],
    };
    const missionWithEmptyChildren = {
      id: "M-children", title: "Children", status: "planning", createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z",
      milestones: [{ id: "MS-empty", title: "Empty", status: "pending", slices: [{ id: "SL-empty", title: "Empty", status: "pending", features: [] }] }],
    };
    const getMissionWithHierarchy = vi.fn()
      .mockResolvedValueOnce(missionWithoutMilestones)
      .mockResolvedValueOnce(missionWithEmptyChildren);
    const store = { getMissionStore: () => ({ getMissionWithHierarchy }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_mission_show")!;

    const emptyResult = await tool.execute("call", { id: missionWithoutMilestones.id });
    const childrenResult = await tool.execute("call", { id: missionWithEmptyChildren.id });

    expect(emptyResult.content[0].text).toContain("No linked goals.");
    expect(emptyResult.content[0].text).toContain("No milestones yet.");
    expect(childrenResult.content[0].text).toContain("MS-empty: Empty (pending)");
    expect(childrenResult.content[0].text).toContain("SL-empty: Empty (pending)");
    expect(childrenResult.content[0].text).toContain("No features.");
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
    expect(updateMission).toHaveBeenCalledWith("M-1", { description: "" }, {
      actor: { type: "system", id: "engine-mission-tools", displayName: "Engine mission tools", source: "engine-agent-tool" },
    });
  });

  it("forwards the runtime agent identity into mission mutations", async () => {
    const updateMission = vi.fn().mockResolvedValue({ id: "M-1", title: "Mission" });
    const store = { getMissionStore: () => ({ updateMission }) } as never;
    const tool = createMissionTools(store, { agentId: "agent-7", agentName: "Planner" })
      .find((candidate) => candidate.name === "fn_mission_update")!;

    await tool.execute("call", { id: "M-1", title: "Updated mission" });

    expect(updateMission).toHaveBeenCalledWith("M-1", { title: "Updated mission" }, {
      actor: { type: "agent", id: "agent-7", displayName: "Planner", source: "engine-agent-tool" },
    });
  });
});
