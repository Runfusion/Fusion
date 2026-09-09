import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fusionCore from "@fusion/core";
import { RepairGroundTruthStaleError, listRecall, type RecallCaptureWriterWithTestDrain, type TaskStore } from "@fusion/core";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createMissionTools } from "../agent-tools.js";

/*
FNXC:MissionToolParity 2026-07-29-12:00:
FN-8294 proves the engine surface delegates feature linking to the one MissionStore operation,
which owns live project-scoped task validation and bidirectional task linkage.
*/
describe("createMissionTools", () => {
  it("exposes the complete hierarchy surface with read and mutation names", () => {
    const store = { getMissionStore: vi.fn() } as never;
    const toolNames = createMissionTools(store).map((tool) => tool.name);
    // FNXC:MissionBlockedRepair 2026-08-11-03:58: Operator-only repair stays out of executor, triage, heartbeat, and chat.
    expect(toolNames).not.toContain("fn_mission_clear_blocked");
    expect(toolNames).toEqual([
      "fn_mission_list", "fn_mission_show", "fn_mission_create", "fn_mission_update", "fn_mission_set_status", "fn_mission_delete", "fn_mission_reconcile",
      "fn_milestone_add", "fn_milestone_update", "fn_milestone_delete", "fn_slice_add", "fn_slice_activate",
      "fn_slice_delete", "fn_feature_add", "fn_feature_update", "fn_feature_repair_validation", "fn_feature_set_status", "fn_feature_delete", "fn_feature_link_task", "fn_feature_repoint_task", "fn_feature_unlink_task", "fn_research_promote_finding",
    ]);
  });

  it("repairs an eligible validation badge through the attributed store primitive", async () => {
    const repairFeatureValidationState = vi.fn().mockResolvedValue({ feature: { id: "F-1", status: "in-progress", loopState: "validating" }, run: { id: "VR-1" } });
    const store = { getMissionStore: () => ({
      getFeature: vi.fn().mockResolvedValue({ id: "F-1", status: "in-progress", loopState: "blocked" }),
      repairFeatureValidationState,
    }) } as never;
    const tool = createMissionTools(store, { agentId: "agent-1" }).find((candidate) => candidate.name === "fn_feature_repair_validation")!;
    const result = await tool.execute("call", { id: "F-1", action: "re_run", reason: "resolved" });
    expect(result.isError).toBeUndefined();
    expect(repairFeatureValidationState).toHaveBeenCalledWith("F-1", expect.objectContaining({ action: "re_run", reason: "resolved", actor: expect.objectContaining({ type: "agent", id: "agent-1" }) }));
  });

  it("derives an unfenced caller input into a fenced clear and refuses an ineligible rerun", async () => {
    const repairFeatureValidationState = vi.fn().mockResolvedValue({ feature: { id: "F-1", status: "defined", loopState: "idle" } });
    const missionStore = { getFeature: vi.fn().mockResolvedValue({ id: "F-1", status: "blocked", loopState: "blocked" }), repairFeatureValidationState };
    const store = { getMissionStore: () => missionStore } as never;
    const tool = createMissionTools(store, { agentId: "agent-1" }).find((candidate) => candidate.name === "fn_feature_repair_validation")!;
    await expect(tool.execute("call", { id: "F-1", action: "clear", reason: "resolved" })).resolves.toMatchObject({ content: [{ text: "Cleared validation state for F-1" }] });
    expect(repairFeatureValidationState).toHaveBeenCalledWith("F-1", expect.objectContaining({
      action: "clear", resolvedStatus: "defined", resolvedLoopState: "idle",
      groundTruth: expect.objectContaining({ featureId: "F-1", taskId: null, taskLiveness: "absent" }),
      actor: expect.objectContaining({ type: "agent", id: "agent-1" }),
    }));

    missionStore.getFeature.mockResolvedValue({ id: "F-1", status: "blocked", loopState: "passed" });
    const rejected = await tool.execute("call", { id: "F-1", action: "re_run" });
    expect(rejected.isError).toBe(true);
    expect(repairFeatureValidationState).toHaveBeenCalledTimes(1);
  });

  it("re-resolves a stale clear fence exactly once before succeeding", async () => {
    const repairFeatureValidationState = vi.fn()
      .mockRejectedValueOnce(new RepairGroundTruthStaleError("F-1"))
      .mockResolvedValueOnce({ feature: { id: "F-1", status: "defined", loopState: "idle" } });
    const getFeature = vi.fn().mockResolvedValue({ id: "F-1", status: "blocked", loopState: "blocked" });
    const store = { getMissionStore: () => ({ getFeature, repairFeatureValidationState }) } as never;
    const tool = createMissionTools(store, { agentId: "agent-1" }).find((candidate) => candidate.name === "fn_feature_repair_validation")!;
    await expect(tool.execute("call", { id: "F-1", action: "clear" })).resolves.toMatchObject({ details: { feature: { id: "F-1", status: "defined" } } });
    expect(getFeature).toHaveBeenCalledTimes(3);
    expect(repairFeatureValidationState).toHaveBeenCalledTimes(2);
  });

  it("sets a linked feature status with attributed raw reason", async () => {
    const updateFeatureStatus = vi.fn().mockResolvedValue({ id: "F-1", status: "done", taskId: "FN-1" });
    const store = { getMissionStore: () => ({ getFeature: vi.fn().mockResolvedValue({ id: "F-1", taskId: "FN-1", status: "defined" }), updateFeatureStatus }) } as never;
    const tool = createMissionTools(store, { agentId: "agent-1" }).find((candidate) => candidate.name === "fn_feature_set_status")!;
    await tool.execute("call", { id: "F-1", status: "done", reason: "raw reason" });
    expect(updateFeatureStatus).toHaveBeenCalledWith("F-1", "done", expect.objectContaining({ reason: "raw reason", actor: expect.objectContaining({ type: "agent", id: "agent-1" }) }));
  });

  it("rejects an unlinked feature execution status", async () => {
    const updateFeatureStatus = vi.fn();
    const store = { getMissionStore: () => ({ getFeature: vi.fn().mockResolvedValue({ id: "F-1", status: "defined" }), updateFeatureStatus }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_feature_set_status")!;
    const result = await tool.execute("call", { id: "F-1", status: "done" });
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain("linked task"); expect(updateFeatureStatus).not.toHaveBeenCalled();
  });

  it("rejects invalid feature and mission statuses before reaching the store", async () => {
    const updateFeatureStatus = vi.fn();
    const updateMission = vi.fn();
    const store = { getMissionStore: () => ({ getFeature: vi.fn(), updateFeatureStatus, updateMission }) } as never;
    const featureTool = createMissionTools(store).find((candidate) => candidate.name === "fn_feature_set_status")!;
    const missionTool = createMissionTools(store).find((candidate) => candidate.name === "fn_mission_set_status")!;
    await expect(featureTool.execute("call", { id: "F-1", status: "invalid" })).resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Invalid status. Must be one of:") }] });
    await expect(missionTool.execute("call", { id: "M-1", status: "invalid" })).resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Invalid status. Must be one of:") }] });
    expect(updateFeatureStatus).not.toHaveBeenCalled();
    expect(updateMission).not.toHaveBeenCalled();
  });

  it("delegates mission status through updateMission with the attributed raw reason", async () => {
    const updateMission = vi.fn().mockResolvedValue({ id: "M-1", status: "blocked" });
    const store = { getMissionStore: () => ({ updateMission }) } as never;
    const tool = createMissionTools(store, { agentId: "agent-1" }).find((candidate) => candidate.name === "fn_mission_set_status")!;
    await tool.execute("call", { id: "M-1", status: "blocked", reason: "raw reason" });
    expect(updateMission).toHaveBeenCalledWith("M-1", { status: "blocked" }, expect.objectContaining({
      reason: "raw reason", actor: expect.objectContaining({ type: "agent", id: "agent-1" }),
    }));
  });

  it("delegates feature linkage to MissionStore without a second task update", async () => {
    const linkFeatureToTask = vi.fn().mockResolvedValue({ id: "F-1", taskId: "FN-1", status: "triaged" });
    const store = { getMissionStore: () => ({ linkFeatureToTask }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_feature_link_task")!;
    const result = await tool.execute("call", { featureId: "F-1", taskId: "FN-1" });
    expect(linkFeatureToTask).toHaveBeenCalledWith("F-1", "FN-1");
    expect(result.details).toMatchObject({ feature: { taskId: "FN-1", status: "triaged" } });
  });

  it("delegates feature unlink to MissionStore unlinkFeatureFromTask", async () => {
    const unlinkFeatureFromTask = vi.fn().mockResolvedValue({ id: "F-1", taskId: undefined, status: "defined" });
    const store = { getMissionStore: () => ({ unlinkFeatureFromTask }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_feature_unlink_task")!;
    const result = await tool.execute("call", { featureId: "F-1" });
    expect(unlinkFeatureFromTask).toHaveBeenCalledWith("F-1");
    expect(unlinkFeatureFromTask).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ feature: { taskId: undefined, status: "defined" } });
  });

  it("delegates feature re-point to MissionStore repointFeatureToTask exactly once", async () => {
    const repointFeatureToTask = vi.fn().mockResolvedValue({ id: "F-1", taskId: "FN-2", status: "triaged" });
    const store = { getMissionStore: () => ({ repointFeatureToTask }) } as never;
    const tool = createMissionTools(store).find((candidate) => candidate.name === "fn_feature_repoint_task")!;
    const result = await tool.execute("call", { featureId: "F-1", taskId: "FN-2" });
    expect(repointFeatureToTask).toHaveBeenCalledWith("F-1", "FN-2");
    expect(repointFeatureToTask).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ feature: { taskId: "FN-2", status: "triaged" } });
  });

  it("promotes completed findings through the idempotent mission-store facade", async () => {
    const addResearchFeature = vi.fn().mockResolvedValue({ reused: false, feature: { id: "F-1", status: "defined" } });
    const store = {
      getResearchStore: () => ({ getRun: vi.fn().mockResolvedValue({ id: "R-1", status: "completed", tags: [], results: { findings: [{ id: "finding-b481c893", heading: "Finding", content: "Evidence", sources: ["https://source.example"] }] } }) }),
      getMissionStore: () => ({ addResearchFeature }),
      getAsyncLayer: () => undefined,
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

/*
FNXC:MissionValidationRepair 2026-08-11-01:46:
These use the real PostgreSQL MissionStore behind the production tool adapter. A forwarding mock
cannot prove that a stale fence retries once or that a soft-deleted linked task remains repairable.
*/
pgDescribe("mission validation repair agent tool", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_validation_repair",
    projectId: "agent-validation-repair-test",
  });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function blockedFeature(taskId?: string) {
    const missionStore = h.store().getMissionStore();
    const mission = await missionStore.createMission({ title: "Tool repair" });
    const milestone = await missionStore.addMilestone(mission.id, { title: "Milestone" });
    const slice = await missionStore.addSlice(milestone.id, { title: "Slice" });
    const feature = await missionStore.addFeature(slice.id, { title: "Feature" });
    return missionStore.updateFeature(feature.id, { taskId, status: "blocked", loopState: "blocked" });
  }

  it("clears a soft-deleted linked task through the real tool and persists its audit event", async () => {
    const task = await h.store().createTask({ description: "Deleted delivery", column: "done" });
    await h.store().deleteTask(task.id);
    const feature = await blockedFeature(task.id);
    const tool = createMissionTools(h.store(), { agentId: "agent-repair" })
      .find((candidate) => candidate.name === "fn_feature_repair_validation")!;

    const result = await tool.execute("repair", { id: feature.id, action: "clear" });
    expect(result.isError).not.toBe(true);
    expect(await h.store().getMissionStore().getFeature(feature.id))
      .toMatchObject({ status: "defined", loopState: "idle" });
  });

  /*
  FNXC:MemoryRecallCapture 2026-08-11-12:17:
  The agent tool is a named production composition root for research-promotion capture. Retain the
  real writer's test-only drain so this verifies both factory composition and the actual recall row,
  rather than proving only that promoteResearchFinding accepts a hand-injected callback.
  */
  it("captures a promoted finding through the agent-tool composition root", async () => {
    const store = h.store();
    const researchStore = store.getResearchStore();
    const run = await researchStore.createRun({ query: "Capture through agent tools", tags: ["agent-tool"] });
    await researchStore.updateRun(run.id, { status: "running" });
    await researchStore.updateRun(run.id, {
      status: "completed",
      results: {
        summary: "Agent-tool research result",
        findings: [{ id: "finding-agent-capture", heading: "Capture finding", content: "Persist recall through the live writer.", sources: [] }],
      },
    });
    const missionStore = store.getMissionStore();
    const mission = await missionStore.createMission({ title: "Promotion capture" });
    const milestone = await missionStore.addMilestone(mission.id, { title: "Milestone" });
    const slice = await missionStore.addSlice(milestone.id, { title: "Slice" });
    const realCreateRecallCaptureWriter = fusionCore.createRecallCaptureWriter;
    const writerFactory = vi.spyOn(fusionCore, "createRecallCaptureWriter");
    let writer: RecallCaptureWriterWithTestDrain | undefined;
    writerFactory.mockImplementation((deps) => {
      writer = realCreateRecallCaptureWriter(deps);
      return writer;
    });

    try {
      const tool = createMissionTools(store, { agentId: "agent-capture" })
        .find((candidate) => candidate.name === "fn_research_promote_finding")!;
      const result = await tool.execute("capture", {
        runId: run.id,
        findingId: "finding-agent-capture",
        sliceId: slice.id,
      });
      expect(result.isError).not.toBe(true);
      expect(writerFactory).toHaveBeenCalledWith(expect.objectContaining({ layer: store.getAsyncLayer() }));
      // The spy wraps the real factory, so its returned drain observes the actual detached insert.
      await writer!.flushPendingCaptures();
      expect(await listRecall(store.getAsyncLayer()!, { limit: 10 })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "solution",
          source: expect.objectContaining({ origin: "deep-research" }),
          tags: expect.arrayContaining([`research-run:${run.id}`]),
        }),
      ]));
    } finally {
      writerFactory.mockRestore();
    }
  });

  it("re-resolves a real stale fence exactly once before clearing", async () => {
    const task = await h.store().createTask({ description: "Planner delivery", column: "todo" });
    const feature = await blockedFeature(task.id);
    const realStore = h.store();
    const getTask = realStore.getTask.bind(realStore);
    let reads = 0;
    const facade = new Proxy(realStore, {
      get(target, property) {
        if (property === "getTask") {
          return async (id: string) => {
            const snapshot = await getTask(id);
            reads += 1;
            if (reads === 1 && snapshot) await realStore.moveTask(id, "in-progress");
            return snapshot;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TaskStore;
    const repair = vi.spyOn(realStore.getMissionStore(), "repairFeatureValidationState");
    const tool = createMissionTools(facade, { agentId: "agent-repair" })
      .find((candidate) => candidate.name === "fn_feature_repair_validation")!;

    const result = await tool.execute("repair-stale", { id: feature.id, action: "clear" });
    expect(result.isError).not.toBe(true);
    expect(repair).toHaveBeenCalledTimes(2);
    // One helper read per bounded attempt proves the first real fence lost its race and the second re-resolved.
    expect(reads).toBe(2);
    expect(await realStore.getMissionStore().getFeature(feature.id))
      .toMatchObject({ status: "in-progress", loopState: "implementing" });
  });
});
