import { describe, expect, it, vi } from "vitest";
import { persistMissionFeatureReconciliation, projectMissionFeatureAlignment, publishPersistedMissionFeatureAlignment, reconcileMissionFeatureState, resolveMissionFeatureAlignment } from "../missions/mission-feature-sync.js";

describe("reconcileMissionFeatureState", () => {
  it("projects persisted drift separately from delivery status", async () => {
    expect(projectMissionFeatureAlignment({ alignment: "diverged-needs-review" })).toBe("diverged-needs-review");
    expect(projectMissionFeatureAlignment(undefined)).toBe("unavailable");
    await expect(resolveMissionFeatureAlignment({ getLatestSpecDriftReport: async () => ({ alignment: "diverged-relocked-approved" }) } as never, "FN-1"))
      .resolves.toBe("diverged-relocked-approved");
    await expect(resolveMissionFeatureAlignment({ getLatestSpecDriftReport: async () => { throw new Error("read failed"); } } as never, "FN-1"))
      .resolves.toBe("unavailable");
  });

  it("publishes a persisted report without changing feature delivery status", async () => {
    const updateFeature = vi.fn();
    const getFeatureByTaskId = vi.fn().mockResolvedValue({ id: "F-1", status: "in-progress", specAlignment: "on-plan" });
    const updated = await publishPersistedMissionFeatureAlignment(
      { getMissionStore: () => ({ getFeatureByTaskId, updateFeature }) } as never,
      "FN-1",
      { alignment: "diverged-needs-review" },
    );

    expect(updated).toBe(true);
    expect(updateFeature).toHaveBeenCalledWith("F-1", { specAlignment: "diverged-needs-review" });
  });

  it("persists alignment when delivery status is unchanged", async () => {
    const updateFeature = vi.fn();
    await expect(persistMissionFeatureReconciliation(
      { updateFeature },
      { id: "F-1", specAlignment: "on-plan" },
      { kind: "noop", alignment: "diverged-needs-review" },
    )).resolves.toBe(true);
    expect(updateFeature).toHaveBeenCalledWith("F-1", { specAlignment: "diverged-needs-review" });

    await expect(persistMissionFeatureReconciliation(
      { updateFeature },
      { id: "F-1", specAlignment: "diverged-needs-review" },
      { kind: "update", status: "done", reason: "task completed", alignment: "diverged-relocked-approved" },
    )).resolves.toBe(true);
    expect(updateFeature).toHaveBeenLastCalledWith("F-1", {
      status: "done",
      specAlignment: "diverged-relocked-approved",
    });
  });

  it("keeps assertion validation as the completion gate for research-derived features", async () => {
    const decision = await reconcileMissionFeatureState(
      { getTask: async () => undefined } as never,
      { id: "FN-1", column: "done", status: "completed" } as never,
      { id: "F-1", status: "in-progress", lastValidatorStatus: "failed" } as never,
      { hasLinkedAssertions: true },
    );
    expect(decision).toEqual(expect.objectContaining({ kind: "noop", alignment: "unavailable" }));
  });

  it("reconciles return and active board states without fabricating completion", async () => {
    const taskStore = { getTask: async () => undefined } as never;
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "todo", status: "pending" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toMatchObject({ kind: "update", status: "triaged" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "triage" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toMatchObject({ kind: "update", status: "triaged" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "in-review", status: "in-progress" } as never, { id: "F-1", status: "triaged" } as never)).resolves.toMatchObject({ kind: "update", status: "in-progress" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "in-progress" } as never, { id: "F-1", status: "defined" } as never)).resolves.toMatchObject({ kind: "update", status: "in-progress" });
  });

  it("keeps unclassified and failed task outcomes as idempotent non-completion", async () => {
    const taskStore = { getTask: async () => undefined } as never;
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "unexpected" } as never, { id: "F-1", status: "in-progress" } as never)).resolves.toEqual({ kind: "noop", alignment: "unavailable" });
    await expect(reconcileMissionFeatureState(taskStore, { id: "FN-1", column: "todo", status: "failed", error: "BLOCKED" } as never, { id: "F-1", status: "triaged" } as never)).resolves.toMatchObject({ kind: "failure" });
  });
});
