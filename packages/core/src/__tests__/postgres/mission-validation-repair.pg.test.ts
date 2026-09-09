import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { AsyncMissionStore } from "../../async-stores/async-mission-store.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/*
FNXC:MissionValidationRepair 2026-08-11-01:20:
This production-store regression reproduces the reported terminal badge: ordinary loop execution
must still fail, while the explicit, fenced repair commits a resumable feature and its audit event.
*/
pgTest("mission validation repair", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_mission_validation_repair",
    projectId: "mission-validation-repair-test",
  });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);
  const missions = (): AsyncMissionStore => h.store().getMissionStore() as AsyncMissionStore;

  async function blockedFeature() {
    const store = missions();
    const mission = await store.createMission({ title: "Repairable validation" });
    const milestone = await store.addMilestone(mission.id, { title: "Milestone" });
    const slice = await store.addSlice(milestone.id, { title: "Slice" });
    const feature = await store.addFeature(slice.id, { title: "Feature" });
    return { store, mission, milestone, feature: await store.updateFeature(feature.id, {
      status: "blocked", loopState: "blocked", implementationAttemptCount: 3, lastValidatorStatus: "blocked",
    }) };
  }

  it("keeps ordinary blocked transitions terminal but clears the reported badge with a fenced audit event", async () => {
    const { store, mission, feature } = await blockedFeature();
    await expect(store.transitionLoopState(feature.id, "implementing")).rejects.toThrow("Invalid loop state transition");

    const repaired = await store.repairFeatureValidationState(feature.id, {
      action: "clear", actor: { type: "agent", id: "agent-repair", source: "test" }, resolvedStatus: "defined",
      groundTruth: { featureId: feature.id, taskId: null, taskLiveness: "absent", taskColumn: null, taskUpdatedAt: null, laneRole: "none", resolvedAt: new Date().toISOString() },
    });
    expect(repaired.feature).toMatchObject({ status: "defined", loopState: "idle", implementationAttemptCount: 0 });
    const events = (await store.getMissionEvents(mission.id, { limit: 20 })).events;
    expect(events.find((event) => event.eventType === "feature_validation_repaired")?.metadata).toMatchObject({
      featureId: feature.id, action: "clear", groundTruthTaskVerified: true,
      actor: { type: "agent", id: "agent-repair" },
    });
  });

  it("clears an unvalidated generated-fix marker only under an absent task fence", async () => {
    const { store, mission, feature } = await blockedFeature();
    await store.updateFeature(feature.id, { status: "defined", loopState: "idle", implementationAttemptCount: 0, lastValidatorStatus: undefined });
    const failedRun = await store.startValidatorRun(feature.id, "scheduled");
    await store.completeValidatorRun(failedRun.id, "failed", "needs fix");
    const fix = await store.createGeneratedFixFeature(feature.id, failedRun.id, [], "repair");
    const fabricated = await store.updateFeature(fix.id, { status: "done", loopState: "passed", lastValidatorStatus: "passed", lastValidatorRunId: undefined, taskId: undefined });
    const fence = { featureId: fabricated.id, taskId: null, taskLiveness: "absent" as const, taskColumn: null, taskUpdatedAt: null, laneRole: "none" as const, resolvedAt: new Date().toISOString() };
    await expect(store.repairFeatureValidationState(fabricated.id, { action: "clear", actor: { type: "operator", id: "operator", source: "test" }, groundTruth: fence }))
      .resolves.toMatchObject({ feature: { status: "defined", loopState: "idle", lastValidatorStatus: undefined } });
    expect((await store.getMissionEvents(mission.id, { limit: 20 })).events.some((event) => event.eventType === "feature_validation_repaired")).toBe(true);

    const justified = await store.updateFeature(fabricated.id, { status: "done", loopState: "passed", lastValidatorStatus: "passed", lastValidatorRunId: "MVR-real" });
    await expect(store.repairFeatureValidationState(justified.id, { action: "clear", actor: { type: "operator", id: "operator", source: "test" }, groundTruth: fence })).rejects.toThrow();

    const ordinary = await store.updateFeature(feature.id, { status: "done", loopState: "passed", lastValidatorStatus: "passed", lastValidatorRunId: undefined, taskId: undefined });
    await expect(store.repairFeatureValidationState(ordinary.id, { action: "clear", actor: { type: "operator", id: "operator", source: "test" } }))
      .resolves.toMatchObject({ feature: { status: "done", loopState: "passed", lastValidatorStatus: undefined } });
  });

  it("serves loop-only and status-only clear shapes without laundering ordinary transitions", async () => {
    const { store, feature } = await blockedFeature();
    const loopOnly = await store.updateFeature(feature.id, { status: "in-progress", loopState: "blocked" });
    const clearedLoop = await store.repairFeatureValidationState(loopOnly.id, {
      action: "clear", actor: { type: "operator", id: "operator", source: "test" },
      // The caller may always provide helper targets; loop-only repair must ignore this status.
      resolvedStatus: "defined",
    });
    expect(clearedLoop.feature).toMatchObject({ status: "in-progress", loopState: "idle" });

    const statusOnly = await store.updateFeature(feature.id, { status: "blocked", loopState: "passed" });
    await expect(store.repairFeatureValidationState(statusOnly.id, {
      action: "clear", actor: { type: "operator", id: "operator", source: "test" }, resolvedStatus: "defined",
    })).rejects.toThrow();
    const clearedStatus = await store.repairFeatureValidationState(statusOnly.id, {
      action: "clear", actor: { type: "operator", id: "operator", source: "test" }, resolvedStatus: "defined",
      // Status-only repair ignores this invalid-for-passed loop target instead of rejecting it.
      resolvedLoopState: "implementing",
      groundTruth: { featureId: statusOnly.id, taskId: null, taskLiveness: "absent", taskColumn: null, taskUpdatedAt: null, laneRole: "none", resolvedAt: new Date().toISOString() },
    });
    expect(clearedStatus.feature).toMatchObject({ status: "defined", loopState: "passed" });
    await expect(store.transitionLoopState(feature.id, "implementing")).rejects.toThrow("Invalid loop state transition");
  });

  it("rejects an unfenced status-changing clear without mutation or audit event", async () => {
    const { store, mission, feature } = await blockedFeature();
    await expect(store.repairFeatureValidationState(feature.id, {
      action: "clear", actor: { type: "agent", id: "agent", source: "test" }, resolvedStatus: "defined",
    })).rejects.toThrow();
    expect(await store.getFeature(feature.id)).toMatchObject({ status: "blocked", loopState: "blocked" });
    expect((await store.getMissionEvents(mission.id, { limit: 20 })).events.find((event) => event.eventType === "feature_validation_repaired")).toBeUndefined();
  });

  it("clears soft-deleted linked tasks as absent ground truth", async () => {
    const { store, feature } = await blockedFeature();
    const deleted = await h.store().createTask({ description: "deleted repair target", column: "done" });
    await h.store().deleteTask(deleted.id);
    const deletedFeature = await store.updateFeature(feature.id, { taskId: deleted.id });
    const absentFence = (taskId: string) => ({
      featureId: deletedFeature.id, taskId, taskLiveness: "absent" as const,
      taskColumn: null, taskUpdatedAt: null, laneRole: "none" as const, resolvedAt: new Date().toISOString(),
    });
    await expect(store.repairFeatureValidationState(deletedFeature.id, {
      action: "clear", actor: { type: "agent", id: "agent", source: "test" }, resolvedStatus: "defined", groundTruth: absentFence(deleted.id),
    })).resolves.toMatchObject({ feature: { status: "defined", loopState: "idle" } });
  });

  it("accepts a matching live fence and records the verified ground truth", async () => {
    const { store, mission, feature } = await blockedFeature();
    const task = await h.store().createTask({ description: "matching live repair target", column: "in-progress" });
    const linked = await store.updateFeature(feature.id, { taskId: task.id });
    const repaired = await store.repairFeatureValidationState(linked.id, {
      action: "clear", actor: { type: "agent", id: "agent", source: "test" }, resolvedStatus: "in-progress", resolvedLoopState: "implementing",
      groundTruth: { featureId: linked.id, taskId: task.id, taskLiveness: "live", taskColumn: task.column, taskUpdatedAt: task.updatedAt, laneRole: "wip", resolvedAt: new Date().toISOString() },
    });
    expect(repaired.feature).toMatchObject({ status: "in-progress", loopState: "implementing" });
    expect((await store.getMissionEvents(mission.id, { limit: 20 })).events.find((event) => event.eventType === "feature_validation_repaired")?.metadata)
      .toMatchObject({ groundTruthTaskId: task.id, groundTruthTaskLiveness: "live", groundTruthTaskVerified: true });
  });

  it("rejects a live task with no resolved lifecycle lane instead of persisting defined", async () => {
    const { store, feature } = await blockedFeature();
    const task = await h.store().createTask({ description: "Custom live repair target", column: "done" });
    const linked = await store.updateFeature(feature.id, { taskId: task.id });
    await expect(store.repairFeatureValidationState(linked.id, {
      action: "clear", actor: { type: "agent", id: "agent", source: "test" }, resolvedStatus: "defined",
      groundTruth: { featureId: linked.id, taskId: task.id, taskLiveness: "live", taskColumn: task.column, taskUpdatedAt: task.updatedAt, laneRole: "none", resolvedAt: new Date().toISOString() },
    })).rejects.toThrow();
    expect(await store.getFeature(linked.id)).toMatchObject({ status: "blocked", loopState: "blocked" });
  });

  it("rejects live and absent fences that became stale without writing a repair event", async () => {
    const { store, mission, feature } = await blockedFeature();
    const task = await h.store().createTask({ description: "live repair target", column: "todo" });
    const linked = await store.updateFeature(feature.id, { taskId: task.id });
    const liveFence = { featureId: linked.id, taskId: task.id, taskLiveness: "live" as const, taskColumn: task.column, taskUpdatedAt: "stale", laneRole: "wip" as const, resolvedAt: new Date().toISOString() };
    await expect(store.repairFeatureValidationState(linked.id, {
      action: "clear", actor: { type: "agent", id: "agent", source: "test" }, resolvedStatus: "in-progress", groundTruth: liveFence,
    })).rejects.toThrow();
    expect(await store.getFeature(linked.id)).toMatchObject({ status: "blocked", loopState: "blocked" });
    expect((await store.getMissionEvents(mission.id, { limit: 20 })).events.some((event) => event.eventType === "feature_validation_repaired")).toBe(false);

    const liveAsAbsent = { ...liveFence, taskLiveness: "absent" as const, taskColumn: null, taskUpdatedAt: null, laneRole: "none" as const };
    await expect(store.repairFeatureValidationState(linked.id, {
      action: "clear", actor: { type: "agent", id: "agent", source: "test" }, resolvedStatus: "defined", groundTruth: liveAsAbsent,
    })).rejects.toThrow();
    expect(await store.getFeature(linked.id)).toMatchObject({ status: "blocked", loopState: "blocked" });
  });

  /*
  FNXC:MissionValidationRepair 2026-08-11-01:35:
  A database trigger forces the audit insert to fail after the repair has assembled its mutation.
  The transaction must roll back both clear state and a re-run's validator row, never leaving an unaudited repair.
  */
  it("rolls back repair state and validator runs when audit persistence fails", async () => {
    const { store, mission, milestone, feature } = await blockedFeature();
    await store.addContractAssertion(milestone.id, { title: "Rollback assertion", assertion: "must hold", scope: "feature", featureId: feature.id });
    await h.adminDb().execute(sql.raw(`
      CREATE FUNCTION public.fail_mission_validation_repair_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type = 'feature_validation_repaired' THEN RAISE EXCEPTION 'forced repair audit failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_mission_validation_repair_audit
      BEFORE INSERT ON project.mission_events FOR EACH ROW EXECUTE FUNCTION public.fail_mission_validation_repair_audit();
    `));
    const fence = { featureId: feature.id, taskId: null, taskLiveness: "absent" as const, taskColumn: null, taskUpdatedAt: null, laneRole: "none" as const, resolvedAt: new Date().toISOString() };
    try {
      await expect(store.repairFeatureValidationState(feature.id, { action: "clear", actor: { type: "agent", id: "agent", source: "test" }, resolvedStatus: "defined", groundTruth: fence }))
        .rejects.toThrow("Failed query");
      expect(await store.getFeature(feature.id)).toMatchObject({ status: "blocked", loopState: "blocked", implementationAttemptCount: 3 });
      await expect(store.repairFeatureValidationState(feature.id, { action: "re_run", actor: { type: "agent", id: "agent", source: "test" } }))
        .rejects.toThrow("Failed query");
      expect(await store.getValidatorRunsByFeature(feature.id)).toHaveLength(0);
      expect((await store.getMissionEvents(mission.id, { limit: 20 })).events.some((event) => event.eventType === "feature_validation_repaired")).toBe(false);
    } finally {
      await h.adminDb().execute(sql.raw("DROP TRIGGER IF EXISTS fail_mission_validation_repair_audit ON project.mission_events; DROP FUNCTION IF EXISTS public.fail_mission_validation_repair_audit();"));
    }
  });

  it("starts one validator run through the repair primitive", async () => {
    const { store, milestone, feature } = await blockedFeature();
    // Feature assertions are required by the existing validator entry point.
    await store.addContractAssertion(milestone.id, { title: "Assertion", assertion: "must hold", scope: "feature", featureId: feature.id });
    const result = await store.repairFeatureValidationState(feature.id, { action: "re_run", actor: { type: "operator", id: "operator", source: "test" } });
    expect(result.run).toMatchObject({ featureId: feature.id, status: "running", triggerType: "manual" });
    expect(result.feature.loopState).toBe("validating");
    // The post-run `validating` loop state is ineligible for another repair-driven run, so no second run can be created.
  });
});
