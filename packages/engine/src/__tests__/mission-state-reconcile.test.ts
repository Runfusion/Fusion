import { describe, expect, it, vi } from "vitest";
import { reconcileMissionState } from "../missions/mission-state-reconcile.js";

describe("reconcileMissionState", () => {
  it("keeps a source feature active while an approved Decision-A follow-up is live", async () => {
    const parent = {
      id: "FN-1", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const followUp = {
      id: "FN-2", title: "Follow-up", column: "todo", status: "queued",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: parent.id, status: "done",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "complete" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([parent, followUp]),
      getTask: vi.fn().mockResolvedValue(parent),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).toHaveBeenCalledWith(
      feature.id,
      "in-progress",
      { actor: { type: "system", id: "mission-reconcile", source: "mission-reconcile:self-healing" } },
    );
  });

  it("does not retain a historical source after a same-slice follow-up rehome", async () => {
    const parent = {
      id: "FN-1", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const followUp = {
      id: "FN-2", title: "Rehomed", column: "todo", status: "queued",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const sourceFeature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: parent.id, status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const currentFeature = {
      id: "F-2", title: "Rehomed", sliceId: "SL-1", taskId: followUp.id, status: "triaged",
      createdAt: "2026-08-11T00:01:00.000Z", updatedAt: "2026-08-11T00:01:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [sourceFeature, currentFeature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
    };
    const tasks = new Map([[parent.id, parent], [followUp.id, followUp]]);
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([parent, followUp]),
      getTask: vi.fn((taskId: string) => Promise.resolve(tasks.get(taskId))),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).toHaveBeenCalledWith(
      sourceFeature.id,
      "done",
      { actor: { type: "system", id: "mission-reconcile", source: "mission-reconcile:self-healing" } },
    );
    expect(updateFeatureStatus).not.toHaveBeenCalledWith(
      sourceFeature.id,
      "in-progress",
      expect.anything(),
    );
  });

  it("allows a source feature to complete after every Decision-A follow-up reaches a custom terminal lane", async () => {
    const parent = {
      id: "FN-1", title: "Delivery", column: "shipped", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const followUp = {
      id: "FN-2", title: "Follow-up", column: "shipped", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: parent.id, status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([parent, followUp]),
      getTask: vi.fn((taskId: string) => Promise.resolve(taskId === parent.id ? parent : followUp)),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
      getTaskWorkflowSelectionsAsync: vi.fn().mockResolvedValue(new Map([
        [parent.id, { workflowId: "custom:delivery", stepIds: [] }],
        [followUp.id, { workflowId: "custom:delivery", stepIds: [] }],
      ])),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "custom:delivery", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({
        ir: {
          version: "v2", id: "custom:delivery", nodes: [], edges: [],
          columns: [
            { id: "todo", label: "Todo", traits: [{ trait: "hold" }] },
            { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
          ],
        },
      }),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).toHaveBeenCalledWith(
      feature.id,
      "done",
      { actor: { type: "system", id: "mission-reconcile", source: "mission-reconcile:self-healing" } },
    );
    expect(taskStore.getTaskWorkflowSelectionsAsync).toHaveBeenCalledOnce();
    expect(taskStore.getTaskWorkflowSelectionAsync).not.toHaveBeenCalledWith(followUp.id);
  });

  it("retains the orthogonal alignment projection when lifecycle status is already current", async () => {
    const task = {
      id: "FN-1", title: "Delivery", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: "FN-1", status: "in-progress",
      specAlignment: "on-plan", createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeature = vi.fn().mockResolvedValue(feature);
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus: vi.fn(),
      updateFeature,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([task]),
      getTask: vi.fn().mockResolvedValue(task),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue({ alignment: "diverged-needs-review" }),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(missionStore.updateFeatureStatus).not.toHaveBeenCalled();
    expect(updateFeature).toHaveBeenCalledWith(
      "F-1",
      { specAlignment: "diverged-needs-review" },
      { actor: { type: "system", id: "mission-reconcile", source: "mission-reconcile:self-healing" } },
    );

    updateFeature.mockClear();
    const dryRun = await reconcileMissionState(
      { taskStore: taskStore as never, missionStore },
      { source: "self-healing", dryRun: true },
    );
    expect(dryRun.planned).toEqual([{ featureId: "F-1", action: "spec-alignment" }]);
    expect(updateFeature).not.toHaveBeenCalled();
  });

  it("does not preview spec alignment when the store cannot apply that mutation", async () => {
    const task = {
      id: "FN-1", title: "Delivery", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: "FN-1", status: "in-progress",
      specAlignment: "on-plan", createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus: vi.fn(),
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([task]),
      getTask: vi.fn().mockResolvedValue(task),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue({ alignment: "diverged-needs-review" }),
    };

    const result = await reconcileMissionState(
      { taskStore: taskStore as never, missionStore },
      { source: "self-healing", dryRun: true },
    );

    expect(result.planned).toEqual([]);
    expect(result).toMatchObject({ missionsScanned: 1, featuresScanned: 1, failures: 0 });
    expect(taskStore.getLatestSpecDriftReport).toHaveBeenCalled();
  });

  it("preserves the TaskStore receiver while listing reconciliation candidates", async () => {
    const taskStore = {
      async listTasks(this: unknown, options: unknown) {
        expect(this).toBe(taskStore);
        expect(options).toEqual({ slim: true, includeArchived: false });
        return [];
      },
    };
    const missionStore = { listMissions: vi.fn().mockResolvedValue([]) };

    await expect(reconcileMissionState(
      { taskStore: taskStore as never, missionStore },
      { source: "startup" },
    )).resolves.toMatchObject({ missionsScanned: 0, failures: 0 });
  });

  it("previews unique title repair as a link without mutating the feature", async () => {
    const task = {
      id: "FN-1", title: "Delivery", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", status: "defined",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const linkFeatureToTask = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      linkFeatureToTask,
      updateFeatureStatus: vi.fn(),
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([task]),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reconcileMissionState(
      { taskStore: taskStore as never, missionStore },
      { source: "task-move", dryRun: true },
    );

    expect(result.planned).toContainEqual({ featureId: "F-1", action: "link" });
    expect(linkFeatureToTask).not.toHaveBeenCalled();
  });

  it("does not title-link a task when duplicate features make ownership ambiguous", async () => {
    const task = {
      id: "FN-1", title: "Delivery", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const features = ["F-1", "F-2"].map((id) => ({
      id, title: "Delivery", sliceId: "SL-1", status: "defined",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    }));
    const linkFeatureToTask = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features }] }],
      }),
      linkFeatureToTask,
      updateFeatureStatus: vi.fn(),
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([task]),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "task-move" });

    expect(linkFeatureToTask).not.toHaveBeenCalled();
  });

  it("reverts a feature to in-progress when its only link is a live non-satisfying task (forward model preserved)", async () => {
    const forward = {
      id: "T-LIVE", title: "Vision", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "triaged",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const linkFeatureToTask = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
      linkFeatureToTask,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward]),
      getTask: vi.fn().mockResolvedValue(forward),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).toHaveBeenCalledWith("F-1", "in-progress", expect.anything());
    expect(updateFeatureStatus).not.toHaveBeenCalledWith("F-1", "done", expect.anything());
    expect(linkFeatureToTask).not.toHaveBeenCalled();
    expect(feature.taskId).toBe(forward.id);
  });

  it("reconciles a feature to done via a done reverse-lineage task, leaving the forward link untouched", async () => {
    const forward = {
      id: "RUFU-101", title: "Vision", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const delivery = {
      id: "RUFU-108", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const linkFeatureToTask = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
      linkFeatureToTask,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward, delivery]),
      getTask: vi.fn((taskId: string) => Promise.resolve(taskId === forward.id ? forward : delivery)),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
      getTaskWorkflowSelectionsAsync: vi.fn().mockResolvedValue(new Map([
        [forward.id, { workflowId: "custom:delivery", stepIds: [] }],
        [delivery.id, { workflowId: "custom:delivery", stepIds: [] }],
      ])),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "custom:delivery", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({
        ir: {
          version: "v2", id: "custom:delivery", nodes: [], edges: [],
          columns: [
            { id: "in-progress", label: "In Progress", traits: [{ trait: "wip" }] },
            { id: "todo", label: "Todo", traits: [{ trait: "hold" }] },
            { id: "done", label: "Done", traits: [{ trait: "complete" }] },
          ],
        },
      }),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).toHaveBeenCalledWith(
      "F-1",
      "done",
      { actor: { type: "system", id: "mission-reconcile", source: "mission-reconcile:self-healing" } },
    );
    expect(feature.taskId).toBe(forward.id);
    expect(linkFeatureToTask).not.toHaveBeenCalled();
  });

  it("keeps a feature active when a live lineage follow-up exists even with a done delivery", async () => {
    const forward = {
      id: "RUFU-101", title: "Vision", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const followUp = {
      id: "FN-2", title: "Follow-up", column: "todo", status: "queued",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:30.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const delivery = {
      id: "RUFU-108", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "done",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward, followUp, delivery]),
      getTask: vi.fn((taskId: string) => Promise.resolve(
        taskId === forward.id ? forward : taskId === followUp.id ? followUp : delivery,
      )),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).not.toHaveBeenCalledWith("F-1", "done", expect.anything());
    expect(updateFeatureStatus).toHaveBeenCalledWith("F-1", "in-progress", expect.anything());
  });

  it("holds an already-done feature idempotently without a second write when a done lineage delivery exists", async () => {
    const forward = {
      id: "RUFU-101", title: "Vision", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const delivery = {
      id: "RUFU-108", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "done",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward, delivery]),
      getTask: vi.fn((taskId: string) => Promise.resolve(taskId === forward.id ? forward : delivery)),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).not.toHaveBeenCalled();
  });

  it("does not credit a done-candidate lineage task that failed or errored", async () => {
    const forward = {
      id: "RUFU-101", title: "Vision", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const failed = {
      id: "RUFU-108", title: "Failed delivery", column: "done", status: "failed", error: "boom",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    /*
    FNXC:MissionReconcileFailedLineage 2026-08-19-21:44 (RUFU-134 / PR #3491):
    The feature starts in-progress (not done) so the reverse-credit branch is actually REACHABLE
    for this fixture: if a failed/errored terminal lineage task were (wrongly) treated as a
    satisfying done delivery, the branch would credit it to done and the assertion below would
    catch it. With the fixture at status "done" the branch gate (feature.status !== "done")
    short-circuited and the test passed for the wrong reason.
    */
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward, failed]),
      getTask: vi.fn((taskId: string) => Promise.resolve(taskId === forward.id ? forward : failed)),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).not.toHaveBeenCalledWith("F-1", "done", expect.anything());
    expect(feature.status).toBe("in-progress");
  });

  /*
  FNXC:MissionReverseLineageSpecAlignment 2026-08-19-21:44 (RUFU-134 / PR #3491):
  A reverse-lineage-credited feature must get the same spec-alignment projection the live path
  always applies — computed against the SATISFYING delivery task, not the unrelated forward
  link — and a dry-run pass must preview the write instead of applying it.
  */
  it("projects spec alignment from the satisfying delivery task when reverse-crediting a feature", async () => {
    const forward = {
      id: "RUFU-101", title: "Vision", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const delivery = {
      id: "RUFU-108", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "in-progress",
      specAlignment: "on-plan",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const updateFeature = vi.fn().mockResolvedValue(undefined);
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
      updateFeature,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward, delivery]),
      getTask: vi.fn((taskId: string) => Promise.resolve(taskId === forward.id ? forward : delivery)),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue({ alignment: "diverged-needs-review" }),
      getTaskWorkflowSelectionsAsync: vi.fn().mockResolvedValue(new Map([
        [forward.id, { workflowId: "custom:delivery", stepIds: [] }],
        [delivery.id, { workflowId: "custom:delivery", stepIds: [] }],
      ])),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "custom:delivery", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({
        ir: {
          version: "v2", id: "custom:delivery", nodes: [], edges: [],
          columns: [
            { id: "in-progress", label: "In Progress", traits: [{ trait: "wip" }] },
            { id: "todo", label: "Todo", traits: [{ trait: "hold" }] },
            { id: "done", label: "Done", traits: [{ trait: "complete" }] },
          ],
        },
      }),
    };

    await reconcileMissionState({ taskStore: taskStore as never, missionStore }, { source: "self-healing" });

    expect(updateFeatureStatus).toHaveBeenCalledWith(
      "F-1", "done",
      { actor: { type: "system", id: "mission-reconcile", source: "mission-reconcile:self-healing" } },
    );
    // The alignment is projected from the delivery task's drift report, not the forward link's.
    expect(taskStore.getLatestSpecDriftReport).toHaveBeenCalledWith(delivery.id);
    expect(updateFeature).toHaveBeenCalledWith(
      "F-1", { specAlignment: "diverged-needs-review" },
      { actor: { type: "system", id: "mission-reconcile", source: "mission-reconcile:self-healing" } },
    );
  });

  it("previews the reverse-lineage spec-alignment write in a dry run without mutating", async () => {
    const forward = {
      id: "RUFU-101", title: "Vision", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const delivery = {
      id: "RUFU-108", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "in-progress",
      specAlignment: "on-plan",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const updateFeature = vi.fn().mockResolvedValue(undefined);
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
      updateFeature,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward, delivery]),
      getTask: vi.fn((taskId: string) => Promise.resolve(taskId === forward.id ? forward : delivery)),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue({ alignment: "diverged-needs-review" }),
      getTaskWorkflowSelectionsAsync: vi.fn().mockResolvedValue(new Map([
        [forward.id, { workflowId: "custom:delivery", stepIds: [] }],
        [delivery.id, { workflowId: "custom:delivery", stepIds: [] }],
      ])),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "custom:delivery", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({
        ir: {
          version: "v2", id: "custom:delivery", nodes: [], edges: [],
          columns: [
            { id: "in-progress", label: "In Progress", traits: [{ trait: "wip" }] },
            { id: "todo", label: "Todo", traits: [{ trait: "hold" }] },
            { id: "done", label: "Done", traits: [{ trait: "complete" }] },
          ],
        },
      }),
    };

    const result = await reconcileMissionState(
      { taskStore: taskStore as never, missionStore },
      { source: "self-healing", dryRun: true },
    );

    expect(result.planned).toContainEqual({ featureId: "F-1", action: "status" });
    expect(result.planned).toContainEqual({ featureId: "F-1", action: "spec-alignment" });
    expect(updateFeature).not.toHaveBeenCalled();
    expect(updateFeatureStatus).not.toHaveBeenCalled();
  });

  it("previews a reverse-lineage done credit as a planned status update without mutating", async () => {
    const forward = {
      id: "RUFU-101", title: "Vision", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const delivery = {
      id: "RUFU-108", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn();
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward, delivery]),
      getTask: vi.fn((taskId: string) => Promise.resolve(taskId === forward.id ? forward : delivery)),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reconcileMissionState(
      { taskStore: taskStore as never, missionStore },
      { source: "self-healing", dryRun: true },
    );

    expect(result.planned).toContainEqual({ featureId: "F-1", action: "status" });
    expect(updateFeatureStatus).not.toHaveBeenCalled();
  });

  it("holds a reverse-lineage feature at done across two reconcile passes (reversion loop broken)", async () => {
    // Mirrors the live mission M-MSL4E01A-0001-Y9QC / F-MSL72J08-000L-ZGFL shape:
    // the single-valued forward link is pinned to RUFU-101 (the shared vision doc, which does
    // not satisfy the AC) while the done delivery RUFU-108 carries the correct reverse lineage.
    const forward = {
      id: "RUFU-101", title: "Vision", column: "in-progress", status: "in-progress",
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const delivery = {
      id: "RUFU-108", title: "Delivery", column: "done", status: undefined,
      missionId: "M-1", sliceId: "SL-1", updatedAt: "2026-08-11T00:01:00.000Z",
      sourceMetadata: { missionLineage: { missionId: "M-1", sliceId: "SL-1", featureId: "F-1" } },
    };
    const feature = {
      id: "F-1", title: "Delivery", sliceId: "SL-1", taskId: forward.id, status: "in-progress",
      createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const updateFeatureStatus = vi.fn().mockImplementation((_id: string, status: string) => {
      // The real store persists the status; mirror that so pass 2 observes the feature already done.
      feature.status = status;
      return Promise.resolve(feature);
    });
    const missionStore = {
      listMissions: vi.fn().mockResolvedValue([{ id: "M-1", status: "active" }]),
      getMissionWithHierarchy: vi.fn().mockResolvedValue({
        id: "M-1", milestones: [{ slices: [{ id: "SL-1", features: [feature] }] }],
      }),
      listAssertionsForFeature: vi.fn().mockResolvedValue([]),
      updateFeatureStatus,
    };
    const taskStore = {
      listTasks: vi.fn().mockResolvedValue([forward, delivery]),
      getTask: vi.fn((taskId: string) => Promise.resolve(taskId === forward.id ? forward : delivery)),
      getLatestSpecDriftReport: vi.fn().mockResolvedValue(undefined),
    };
    const deps = { taskStore: taskStore as never, missionStore };

    const pass1 = await reconcileMissionState(deps, { source: "self-healing" });
    expect(updateFeatureStatus).toHaveBeenCalledWith("F-1", "done", expect.anything());
    expect(feature.status).toBe("done");
    expect(pass1.statusUpdates).toBeGreaterThan(0);

    updateFeatureStatus.mockClear();
    const pass2 = await reconcileMissionState(deps, { source: "self-healing" });
    // Feature is already `done` and the done delivery persists, so the second pass performs NO
    // status write and the feature holds `done` — the reversion loop is broken.
    expect(updateFeatureStatus).not.toHaveBeenCalled();
    expect(feature.status).toBe("done");
    expect(pass2.statusUpdates).toBe(0);
  });
});
