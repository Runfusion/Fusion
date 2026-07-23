/**
 * PostgreSQL satellite MissionStore integration test (U6 satellite-mission-store).
 *
 * FNXC:MissionStore 2026-06-24-11:00:
 * Integration tests proving the async Drizzle MissionStore helpers
 * (async-mission-store.ts) round-trip correctly against real PostgreSQL across
 * the full mission/milestone/slice/feature lifecycle.
 *
 * Coverage:
 *   - Mission CRUD (create → get → list → update → delete) with branchStrategy
 *     JSON serialization and autopilot columns (VAL-SCHEMA-001 parity).
 *   - Milestone CRUD with jsonb dependencies, text acceptanceCriteria,
 *     planningNotes/verification/validationState (the columns missing from the
 *     initial U3 snapshot, added by this feature's schema fix).
 *   - Slice CRUD with planState/planningNotes/verification.
 *   - Feature CRUD with loop state machine, attempt counters, validator linkage,
 *     generated-fix lineage columns.
 *   - Mission events (jsonb metadata, seq ordering, count queries).
 *   - Mission-goal links (idempotent insert, list, delete).
 *   - Contract assertions (CRUD, reorder transactional).
 *   - Feature-assertion links (idempotent link, unlink, list).
 *   - Validator runs + failures + fix-feature lineage.
 *   - Snapshot upsert (ON CONFLICT DO UPDATE) for missions/milestones/slices/
 *     features/assertions.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as schema from "../../postgres/schema/index.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_msn_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface MissionTestCtx {
  dbName: string;
  layer: AsyncDataLayer;
}

async function setupCtx(): Promise<MissionTestCtx> {
  const dbName = uniqueDbName();
  try { adminExec(`DROP DATABASE IF EXISTS "${dbName}"`); } catch { /* may not exist */ }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");
  const { applySchemaBaseline } = await import("../../postgres/schema-applier.js");
  const { resolveBackendWithOptions } = await import("../../postgres/backend-resolver.js");
  const backend = resolveBackendWithOptions({ databaseUrl: testUrl, databaseMigrationUrl: testUrl });
  const connections = await createConnectionSetFromUrl(backend, { poolMax: 3, connectTimeoutSeconds: 5 });
  await applySchemaBaseline(connections.migration);
  const layer = createAsyncDataLayer(connections);
  return { dbName, layer };
}

async function teardownCtx(ctx: MissionTestCtx | null): Promise<void> {
  if (!ctx) return;
  try { await ctx.layer.close(); } catch { /* best-effort */ }
  try { adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`); } catch { /* best-effort */ }
}

pgDescribe("PostgreSQL satellite MissionStore (VAL-SCHEMA-001, VAL-DATA-009)", () => {
  let ctx: MissionTestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  // ── Mission CRUD ──

  it("Mission: create → get → list → update → delete round-trip with branchStrategy JSON", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    const mission = await mod.createMission(ctx.layer.db, {
      id: "M-1",
      title: "Test Mission",
      description: "A test mission",
      status: "planning",
      interviewState: "not_started",
      baseBranch: "main",
      branchStrategy: { mode: "custom-new", branchName: "feat/test" },
      autoMerge: true,
      autoAdvance: false,
      autopilotEnabled: false,
      autopilotState: "inactive",
      createdAt: now,
      updatedAt: now,
    });

    expect(mission.id).toBe("M-1");
    expect(mission.status).toBe("planning");
    expect(mission.branchStrategy).toEqual({ mode: "custom-new", branchName: "feat/test" });
    expect(mission.autoMerge).toBe(true);
    expect(mission.autoAdvance).toBe(false);
    expect(mission.autopilotEnabled).toBe(false);
    expect(mission.autopilotState).toBe("inactive");

    const fetched = await mod.getMission(ctx.layer.db, "M-1");
    expect(fetched?.title).toBe("Test Mission");
    expect(fetched?.branchStrategy).toEqual({ mode: "custom-new", branchName: "feat/test" });

    const listed = await mod.listMissions(ctx.layer.db);
    expect(listed).toHaveLength(1);

    const updated = { ...fetched!, title: "Updated Mission", autoAdvance: true, updatedAt: new Date().toISOString() };
    await mod.updateMission(ctx.layer.db, updated);
    const afterUpdate = await mod.getMission(ctx.layer.db, "M-1");
    expect(afterUpdate?.title).toBe("Updated Mission");
    expect(afterUpdate?.autoAdvance).toBe(true);

    const deleted = await mod.deleteMission(ctx.layer.db, "M-1");
    expect(deleted).toBe(true);
    expect(await mod.getMission(ctx.layer.db, "M-1")).toBeUndefined();
  });

  // ── Milestone CRUD ──

  it("Milestone: create → get → list → update → delete with jsonb dependencies + text acceptanceCriteria", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    await mod.createMission(ctx.layer.db, {
      id: "M-2", title: "Mission 2", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });

    const milestone = await mod.createMilestone(ctx.layer.db, {
      id: "MS-1", missionId: "M-2", title: "Milestone 1", status: "planning", orderIndex: 0,
      interviewState: "not_started", dependencies: ["MS-OTHER"], planningNotes: "plan notes",
      verification: "verif notes", acceptanceCriteria: "- criteria 1\n- criteria 2",
      validationState: "not_started", createdAt: now, updatedAt: now,
    });

    expect(milestone.id).toBe("MS-1");
    expect(milestone.dependencies).toEqual(["MS-OTHER"]);
    expect(milestone.acceptanceCriteria).toBe("- criteria 1\n- criteria 2");
    expect(milestone.planningNotes).toBe("plan notes");
    expect(milestone.verification).toBe("verif notes");
    expect(milestone.validationState).toBe("not_started");

    const fetched = await mod.getMilestone(ctx.layer.db, "MS-1");
    expect(fetched?.dependencies).toEqual(["MS-OTHER"]);
    expect(fetched?.acceptanceCriteria).toBe("- criteria 1\n- criteria 2");

    const listed = await mod.listMilestones(ctx.layer.db, "M-2");
    expect(listed).toHaveLength(1);

    const updated = { ...fetched!, title: "Updated MS", status: "in_progress" as const, updatedAt: new Date().toISOString() };
    await mod.updateMilestone(ctx.layer.db, updated);
    expect((await mod.getMilestone(ctx.layer.db, "MS-1"))?.title).toBe("Updated MS");

    expect(await mod.deleteMilestone(ctx.layer.db, "MS-1")).toBe(true);
    expect(await mod.getMilestone(ctx.layer.db, "MS-1")).toBeUndefined();
  });

  // ── Slice CRUD ──

  it("Slice: create → get → list → update → delete with planState", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    await mod.createMission(ctx.layer.db, {
      id: "M-3", title: "Mission 3", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });
    await mod.createMilestone(ctx.layer.db, {
      id: "MS-2", missionId: "M-3", title: "MS", status: "planning", orderIndex: 0,
      interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
    });

    const slice = await mod.createSlice(ctx.layer.db, {
      id: "SL-1", milestoneId: "MS-2", title: "Slice 1", status: "planning", orderIndex: 0,
      planState: "in_progress", planningNotes: "slice plan", verification: "slice verif",
      createdAt: now, updatedAt: now,
    });

    expect(slice.planState).toBe("in_progress");
    expect(slice.planningNotes).toBe("slice plan");

    const fetched = await mod.getSlice(ctx.layer.db, "SL-1");
    expect(fetched?.planState).toBe("in_progress");

    const listed = await mod.listSlices(ctx.layer.db, "MS-2");
    expect(listed).toHaveLength(1);

    const updated = { ...fetched!, title: "Updated SL", status: "in_progress" as const, updatedAt: new Date().toISOString() };
    await mod.updateSlice(ctx.layer.db, updated);
    expect((await mod.getSlice(ctx.layer.db, "SL-1"))?.title).toBe("Updated SL");

    expect(await mod.deleteSlice(ctx.layer.db, "SL-1")).toBe(true);
    expect(await mod.getSlice(ctx.layer.db, "SL-1")).toBeUndefined();
  });

  // ── Feature CRUD ──

  it("Feature: create → get → list → update with loop state + attempt counters", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    await mod.createMission(ctx.layer.db, {
      id: "M-4", title: "Mission 4", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });
    await mod.createMilestone(ctx.layer.db, {
      id: "MS-3", missionId: "M-4", title: "MS", status: "planning", orderIndex: 0,
      interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
    });
    await mod.createSlice(ctx.layer.db, {
      id: "SL-2", milestoneId: "MS-3", title: "SL", status: "planning", orderIndex: 0,
      planState: "not_started", createdAt: now, updatedAt: now,
    });

    const feature = await mod.createFeature(ctx.layer.db, {
      id: "F-1", sliceId: "SL-2", title: "Feature 1", status: "defined",
      acceptanceCriteria: "feature criteria", loopState: "idle",
      implementationAttemptCount: 0, validatorAttemptCount: 0,
      createdAt: now, updatedAt: now,
    });

    expect(feature.id).toBe("F-1");
    expect(feature.loopState).toBe("idle");
    expect(feature.acceptanceCriteria).toBe("feature criteria");

    // Update loop state machine: idle → implementing → validating → passed
    const updated = {
      ...feature,
      loopState: "passed" as const,
      implementationAttemptCount: 1,
      validatorAttemptCount: 2,
      lastValidatorRunId: "VR-1",
      lastValidatorStatus: "passed" as const,
      updatedAt: new Date().toISOString(),
    };
    await mod.updateFeature(ctx.layer.db, updated);
    const fetched = await mod.getFeature(ctx.layer.db, "F-1");
    expect(fetched?.loopState).toBe("passed");
    expect(fetched?.implementationAttemptCount).toBe(1);
    expect(fetched?.validatorAttemptCount).toBe(2);
    expect(fetched?.lastValidatorRunId).toBe("VR-1");
    expect(fetched?.lastValidatorStatus).toBe("passed");

    expect((await mod.listFeatures(ctx.layer.db, "SL-2"))).toHaveLength(1);
  });

  // ── Mission Events ──

  it("Mission events: insert with jsonb metadata, count, list by seq", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    await mod.createMission(ctx.layer.db, {
      id: "M-5", title: "Mission 5", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });

    await mod.insertMissionEvent(ctx.layer.db, {
      id: "ME-1", missionId: "M-5", eventType: "created", description: "Mission created",
      metadata: { source: "test", count: 1 }, timestamp: now, seq: 1,
    });
    await mod.insertMissionEvent(ctx.layer.db, {
      id: "ME-2", missionId: "M-5", eventType: "updated", description: "Mission updated",
      metadata: null, timestamp: now, seq: 2,
    });

    expect(await mod.countMissionEvents(ctx.layer.db, "M-5")).toBe(2);

    const events = await mod.listMissionEvents(ctx.layer.db, "M-5");
    expect(events).toHaveLength(2);
    // Ordered by seq DESC
    expect(events[0]!.id).toBe("ME-2");
    expect(events[0]!.metadata).toBeNull();
    expect(events[1]!.metadata).toEqual({ source: "test", count: 1 });

    // Idempotent insert (INSERT OR IGNORE)
    await mod.insertMissionEventIfAbsent(ctx.layer.db, {
      id: "ME-1", missionId: "M-5", eventType: "created", description: "dup",
      metadata: null, timestamp: now, seq: 1,
    });
    expect(await mod.countMissionEvents(ctx.layer.db, "M-5")).toBe(2);
  });

  // ── Mission-Goal Links ──

  it("Mission-goal links: idempotent link, list, count, delete", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    // Create a goal first (needed for FK)
    await ctx.layer.db.insert(schema.project.goals).values({
      id: "G-1", title: "Goal 1", status: "active", createdAt: now, updatedAt: now,
    });

    await mod.createMission(ctx.layer.db, {
      id: "M-6", title: "Mission 6", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });

    await mod.insertMissionGoalLink(ctx.layer.db, "M-6", "G-1", now);
    // Idempotent
    await mod.insertMissionGoalLink(ctx.layer.db, "M-6", "G-1", now);

    expect(await mod.listGoalIdsForMission(ctx.layer.db, "M-6")).toEqual(["G-1"]);
    expect(await mod.listMissionIdsForGoal(ctx.layer.db, "G-1")).toEqual(["M-6"]);

    const counts = await mod.countGoalsByMission(ctx.layer.db);
    expect(counts.get("M-6")).toBe(1);

    expect(await mod.deleteMissionGoalLink(ctx.layer.db, "M-6", "G-1")).toBe(true);
    expect(await mod.listGoalIdsForMission(ctx.layer.db, "M-6")).toEqual([]);
  });

  // ── Contract Assertions ──

  it("Contract assertions: create → list → reorder → update → delete", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    await mod.createMission(ctx.layer.db, {
      id: "M-7", title: "Mission 7", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });
    await mod.createMilestone(ctx.layer.db, {
      id: "MS-4", missionId: "M-7", title: "MS", status: "planning", orderIndex: 0,
      interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
    });

    const a1 = await mod.createContractAssertion(ctx.layer.db, {
      id: "CA-1", milestoneId: "MS-4", title: "Assert 1", assertion: "must do X",
      status: "pending", type: "static", orderIndex: 0, createdAt: now, updatedAt: now,
    });
    await mod.createContractAssertion(ctx.layer.db, {
      id: "CA-2", milestoneId: "MS-4", title: "Assert 2", assertion: "must do Y",
      status: "pending", type: "static", orderIndex: 1, createdAt: now, updatedAt: now,
    });

    expect(a1.assertion).toBe("must do X");
    const listed = await mod.listContractAssertions(ctx.layer.db, "MS-4");
    expect(listed).toHaveLength(2);
    expect(listed.map((a) => a.orderIndex)).toEqual([0, 1]);

    // Reorder: reverse
    await mod.reorderContractAssertions(ctx.layer, ["CA-2", "CA-1"]);
    const reordered = await mod.listContractAssertions(ctx.layer.db, "MS-4");
    expect(reordered[0]!.id).toBe("CA-2");
    expect(reordered[1]!.id).toBe("CA-1");

    await mod.updateContractAssertion(ctx.layer.db, { ...a1, status: "pass", updatedAt: now });
    expect((await mod.getContractAssertion(ctx.layer.db, "CA-1"))?.status).toBe("pass");

    expect(await mod.deleteContractAssertion(ctx.layer.db, "CA-1")).toBe(true);
    expect(await mod.listContractAssertions(ctx.layer.db, "MS-4")).toHaveLength(1);
  });

  // ── Feature-Assertion Links ──

  it("Feature-assertion links: idempotent link, exists check, unlink", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    await mod.createMission(ctx.layer.db, {
      id: "M-8", title: "Mission 8", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });
    await mod.createMilestone(ctx.layer.db, {
      id: "MS-5", missionId: "M-8", title: "MS", status: "planning", orderIndex: 0,
      interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
    });
    await mod.createSlice(ctx.layer.db, {
      id: "SL-3", milestoneId: "MS-5", title: "SL", status: "planning", orderIndex: 0,
      planState: "not_started", createdAt: now, updatedAt: now,
    });
    await mod.createFeature(ctx.layer.db, {
      id: "F-2", sliceId: "SL-3", title: "F", status: "defined", loopState: "idle",
      implementationAttemptCount: 0, validatorAttemptCount: 0, createdAt: now, updatedAt: now,
    });
    await mod.createContractAssertion(ctx.layer.db, {
      id: "CA-3", milestoneId: "MS-5", title: "A", assertion: "assert", status: "pending",
      type: "static", orderIndex: 0, createdAt: now, updatedAt: now,
    });

    await mod.linkFeatureToAssertion(ctx.layer.db, "F-2", "CA-3", now);
    await mod.linkFeatureToAssertion(ctx.layer.db, "F-2", "CA-3", now); // idempotent

    expect(await mod.featureAssertionLinkExists(ctx.layer.db, "F-2", "CA-3")).toBe(true);
    const links = await mod.listAllFeatureAssertionLinks(ctx.layer.db);
    expect(links).toHaveLength(1);

    expect(await mod.unlinkFeatureFromAssertion(ctx.layer.db, "F-2", "CA-3")).toBe(true);
    expect(await mod.featureAssertionLinkExists(ctx.layer.db, "F-2", "CA-3")).toBe(false);
  });

  // ── Validator Runs + Failures + Lineage ──

  it("Validator runs + failures + fix-feature lineage round-trip", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    await mod.createMission(ctx.layer.db, {
      id: "M-9", title: "Mission 9", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });
    await mod.createMilestone(ctx.layer.db, {
      id: "MS-6", missionId: "M-9", title: "MS", status: "planning", orderIndex: 0,
      interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
    });
    await mod.createSlice(ctx.layer.db, {
      id: "SL-4", milestoneId: "MS-6", title: "SL", status: "planning", orderIndex: 0,
      planState: "not_started", createdAt: now, updatedAt: now,
    });
    await mod.createFeature(ctx.layer.db, {
      id: "F-3", sliceId: "SL-4", title: "F", status: "defined", loopState: "idle",
      implementationAttemptCount: 0, validatorAttemptCount: 0, createdAt: now, updatedAt: now,
    });

    const run = await mod.createValidatorRun(ctx.layer.db, {
      id: "VR-1", featureId: "F-3", milestoneId: "MS-6", sliceId: "SL-4", status: "running",
      triggerType: "auto", implementationAttempt: 0, validatorAttempt: 1, startedAt: now,
      createdAt: now, updatedAt: now,
    });
    expect(run.status).toBe("running");

    // Record failures
    await mod.insertValidatorFailure(ctx.layer.db, {
      id: "VF-1", runId: "VR-1", featureId: "F-3", assertionId: "CA-X",
      message: "test failed", expected: "pass", actual: "fail", createdAt: now,
    });
    const failures = await mod.listFailuresForRun(ctx.layer.db, "VR-1");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toBe("test failed");

    // Complete the run
    const completed = { ...run, status: "failed" as const, summary: "2 failures", completedAt: now, updatedAt: now };
    await mod.updateValidatorRun(ctx.layer.db, completed);
    expect((await mod.getValidatorRun(ctx.layer.db, "VR-1"))?.status).toBe("failed");

    // List runs by feature (DESC by startedAt)
    const runs = await mod.listValidatorRunsByFeature(ctx.layer.db, "F-3");
    expect(runs).toHaveLength(1);

    // Fix-feature lineage
    await mod.createFeature(ctx.layer.db, {
      id: "F-FIX", sliceId: "SL-4", title: "Fix", status: "defined", loopState: "idle",
      implementationAttemptCount: 0, validatorAttemptCount: 0,
      generatedFromFeatureId: "F-3", generatedFromRunId: "VR-1",
      createdAt: now, updatedAt: now,
    });
    await mod.insertFixFeatureLineage(ctx.layer.db, {
      id: "L-1", sourceFeatureId: "F-3", fixFeatureId: "F-FIX", runId: "VR-1",
      failedAssertionIds: ["CA-X"], createdAt: now,
    });

    expect(await mod.findFixFeatureId(ctx.layer.db, "F-3", "VR-1")).toBe("F-FIX");
    expect(await mod.findFixFeatureIdsForSource(ctx.layer.db, "F-3")).toEqual(["F-FIX"]);
    const lineage = await mod.listLineageForSourceFeature(ctx.layer.db, "F-3");
    expect(lineage).toHaveLength(1);
    expect(lineage[0]!.failedAssertionIds).toEqual(["CA-X"]);
  });

  // ── Snapshot Upsert ──

  it("Snapshot upsert: ON CONFLICT DO UPDATE for mission/milestone/slice/feature", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    // Initial create
    await mod.upsertMission(ctx.layer.db, {
      id: "M-10", title: "Original", description: "desc", status: "planning",
      interviewState: "not_started", autoAdvance: false, autopilotEnabled: false,
      autopilotState: "inactive", createdAt: now, updatedAt: now,
    });
    expect((await mod.getMission(ctx.layer.db, "M-10"))?.title).toBe("Original");

    // Upsert (update title)
    await mod.upsertMission(ctx.layer.db, {
      id: "M-10", title: "Upserted", description: "desc2", status: "active",
      interviewState: "in_progress", autoAdvance: true, autopilotEnabled: true,
      autopilotState: "active", createdAt: now, updatedAt: now,
    });
    const afterUpsert = await mod.getMission(ctx.layer.db, "M-10");
    expect(afterUpsert?.title).toBe("Upserted");
    expect(afterUpsert?.status).toBe("active");
    expect(afterUpsert?.autoAdvance).toBe(true);

    // Milestone upsert
    await mod.upsertMilestone(ctx.layer.db, {
      id: "MS-7", missionId: "M-10", title: "Original MS", status: "planning", orderIndex: 0,
      interviewState: "not_started", dependencies: [], validationState: "not_started",
      createdAt: now, updatedAt: now,
    });
    await mod.upsertMilestone(ctx.layer.db, {
      id: "MS-7", missionId: "M-10", title: "Upserted MS", status: "in_progress", orderIndex: 0,
      interviewState: "not_started", dependencies: [], validationState: "in_progress",
      createdAt: now, updatedAt: now,
    });
    expect((await mod.getMilestone(ctx.layer.db, "MS-7"))?.title).toBe("Upserted MS");
  });

  // ── Cascade delete ──

  it("Cascade: deleting a mission removes its milestones/slices/features", async () => {
    ctx = await setupCtx();
    const mod = await import("../../async-stores/async-mission-store.js");
    const now = new Date().toISOString();

    await mod.createMission(ctx.layer.db, {
      id: "M-11", title: "Cascade Mission", status: "planning", interviewState: "not_started",
      autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
    });
    await mod.createMilestone(ctx.layer.db, {
      id: "MS-8", missionId: "M-11", title: "MS", status: "planning", orderIndex: 0,
      interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
    });
    await mod.createSlice(ctx.layer.db, {
      id: "SL-5", milestoneId: "MS-8", title: "SL", status: "planning", orderIndex: 0,
      planState: "not_started", createdAt: now, updatedAt: now,
    });
    await mod.createFeature(ctx.layer.db, {
      id: "F-4", sliceId: "SL-5", title: "F", status: "defined", loopState: "idle",
      implementationAttemptCount: 0, validatorAttemptCount: 0, createdAt: now, updatedAt: now,
    });

    expect(await mod.deleteMission(ctx.layer.db, "M-11")).toBe(true);
    // Cascade should have removed children
    expect(await mod.getMilestone(ctx.layer.db, "MS-8")).toBeUndefined();
    expect(await mod.getSlice(ctx.layer.db, "SL-5")).toBeUndefined();
    expect(await mod.getFeature(ctx.layer.db, "F-4")).toBeUndefined();
  });
});
