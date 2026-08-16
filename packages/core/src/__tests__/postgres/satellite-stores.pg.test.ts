/**
 * PostgreSQL satellite stores integration tests (U6) — consolidated.
 *
 * FNXC:SlowTestCondense 2026-08-16-03:43:
 * Consolidates the three U6 satellite files (satellite-mission-store.test.ts,
 * satellite-fusiondir-stores.test.ts, satellite-db-injected-stores.test.ts)
 * into ONE file on the shared PG harness. The originals each hand-rolled
 * CREATE DATABASE + full applySchemaBaseline() PER TEST (3 files / 3 boots /
 * 38 fresh databases, ~75s combined). The shared harness boots one
 * golden-template database per file and TRUNCATEs between tests, which gives
 * the same isolation (every test still starts from empty application tables)
 * at a fraction of the cost. Every original describe/it name and assertion is
 * preserved verbatim below; only the fixture plumbing changed
 * (ctx.layer -> h.layer()).
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
 * FNXC:SatelliteFusionDirStores 2026-06-24-16:00:
 * Integration tests proving the async Drizzle helper modules for the
 * fusion-dir-owned satellite stores (AgentStore, PluginStore, AutomationStore,
 * RoutineStore) round-trip correctly against real PostgreSQL.
 *
 * VAL-DATA-015 (document/artifact parent-task scoping under soft-delete) is
 * preserved because these stores use the same project/central schema tables
 * and the same deletedAt-filtering invariants the task-store modules enforce;
 * the helper round-trips here prove the jsonb/integer columns the stores depend
 * on survive the backend swap.
 *
 * VAL-DATA-016 (plugin store contract stability) is directly exercised by the
 * PluginStore section: the central.plugin_installs and
 * central.project_plugin_states tables are the contract surface
 * fusion-plugin-roadmap depends on.
 *
 * ReflectionStore is NOT covered here because it is JSONL-file based (no SQLite
 * / PostgreSQL data path); its persistence layer does not change in this
 * migration. It is documented in the library note.
 *
 * FNXC:SatelliteStores 2026-06-24-10:00:
 * Integration tests proving the async Drizzle helper modules for the 9
 * DB-injected project-schema satellite stores (TodoStore, GoalStore,
 * MessageStore, ApprovalRequestStore, EvalStore, ExperimentSessionStore,
 * InsightStore, ResearchStore, ChatStore) round-trip correctly against real
 * PostgreSQL. This covers VAL-DATA-016 (plugin store contract stability —
 * the project-schema tables these stores write to are the same tables plugins
 * and consumers depend on).
 *
 * Coverage:
 *   - Each store's create → read → update → delete round-trip through jsonb/text
 *     columns (VAL-SCHEMA-004).
 *   - Transaction atomicity: the create-with-audit and decide-with-audit
 *     patterns commit/rollback together.
 *   - The active-goal-limit enforcement.
 *   - The approval-request state-machine transitions.
 *   - The conversation/mailbox query semantics.
 *
 * Skipped when PostgreSQL is unreachable (via the harness's pgDescribe TCP
 * probe) so the merge gate stays green without a running server.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";

/**
 * Seed a minimal parent agent row so satellite tables with FK constraints
 * (heartbeats, runs, task sessions, API keys, config revisions, blocked
 * states) referencing project.agents.id can be inserted.
 */
async function seedAgent(layer: AsyncDataLayer, agentId: string): Promise<void> {
  const { writeAgent } = await import("../../async-stores/async-agent-store.js");
  const now = new Date().toISOString();
  await writeAgent(layer.db, {
    id: agentId,
    name: `Seed ${agentId}`,
    role: "worker",
    state: "active",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
}

pgDescribe("PostgreSQL satellite stores (U6 consolidated, shared harness)", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_satellite" });
  // The harness layer is project-agnostic (projectId undefined) just like the
  // original per-test createConnectionSetFromUrl fixtures, so the unbound
  // fail-closed assertions below keep their exact semantics.
  const layer = (): AsyncDataLayer => h.layer();

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  describe("PostgreSQL satellite MissionStore (VAL-SCHEMA-001, VAL-DATA-009)", () => {
    // ── Mission CRUD ──

    it("Mission: create → get → list → update → delete round-trip with branchStrategy JSON", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      const mission = await mod.createMission(layer().db, {
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

      const fetched = await mod.getMission(layer().db, "M-1");
      expect(fetched?.title).toBe("Test Mission");
      expect(fetched?.branchStrategy).toEqual({ mode: "custom-new", branchName: "feat/test" });

      const listed = await mod.listMissions(layer().db);
      expect(listed).toHaveLength(1);

      const updated = { ...fetched!, title: "Updated Mission", autoAdvance: true, updatedAt: new Date().toISOString() };
      await mod.updateMission(layer().db, updated);
      const afterUpdate = await mod.getMission(layer().db, "M-1");
      expect(afterUpdate?.title).toBe("Updated Mission");
      expect(afterUpdate?.autoAdvance).toBe(true);

      const deleted = await mod.deleteMission(layer().db, "M-1");
      expect(deleted).toBe(true);
      expect(await mod.getMission(layer().db, "M-1")).toBeUndefined();
    });

    // ── Milestone CRUD ──

    it("Milestone: create → get → list → update → delete with jsonb dependencies + text acceptanceCriteria", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      await mod.createMission(layer().db, {
        id: "M-2", title: "Mission 2", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });

      const milestone = await mod.createMilestone(layer().db, {
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

      const fetched = await mod.getMilestone(layer().db, "MS-1");
      expect(fetched?.dependencies).toEqual(["MS-OTHER"]);
      expect(fetched?.acceptanceCriteria).toBe("- criteria 1\n- criteria 2");

      const listed = await mod.listMilestones(layer().db, "M-2");
      expect(listed).toHaveLength(1);

      const updated = { ...fetched!, title: "Updated MS", status: "in_progress" as const, updatedAt: new Date().toISOString() };
      await mod.updateMilestone(layer().db, updated);
      expect((await mod.getMilestone(layer().db, "MS-1"))?.title).toBe("Updated MS");

      expect(await mod.deleteMilestone(layer().db, "MS-1")).toBe(true);
      expect(await mod.getMilestone(layer().db, "MS-1")).toBeUndefined();
    });

    // ── Slice CRUD ──

    it("Slice: create → get → list → update → delete with planState", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      await mod.createMission(layer().db, {
        id: "M-3", title: "Mission 3", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });
      await mod.createMilestone(layer().db, {
        id: "MS-2", missionId: "M-3", title: "MS", status: "planning", orderIndex: 0,
        interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
      });

      const slice = await mod.createSlice(layer().db, {
        id: "SL-1", milestoneId: "MS-2", title: "Slice 1", status: "planning", orderIndex: 0,
        planState: "in_progress", planningNotes: "slice plan", verification: "slice verif",
        createdAt: now, updatedAt: now,
      });

      expect(slice.planState).toBe("in_progress");
      expect(slice.planningNotes).toBe("slice plan");

      const fetched = await mod.getSlice(layer().db, "SL-1");
      expect(fetched?.planState).toBe("in_progress");

      const listed = await mod.listSlices(layer().db, "MS-2");
      expect(listed).toHaveLength(1);

      const updated = { ...fetched!, title: "Updated SL", status: "in_progress" as const, updatedAt: new Date().toISOString() };
      await mod.updateSlice(layer().db, updated);
      expect((await mod.getSlice(layer().db, "SL-1"))?.title).toBe("Updated SL");

      expect(await mod.deleteSlice(layer().db, "SL-1")).toBe(true);
      expect(await mod.getSlice(layer().db, "SL-1")).toBeUndefined();
    });

    // ── Feature CRUD ──

    it("Feature: create → get → list → update with loop state + attempt counters", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      await mod.createMission(layer().db, {
        id: "M-4", title: "Mission 4", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });
      await mod.createMilestone(layer().db, {
        id: "MS-3", missionId: "M-4", title: "MS", status: "planning", orderIndex: 0,
        interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
      });
      await mod.createSlice(layer().db, {
        id: "SL-2", milestoneId: "MS-3", title: "SL", status: "planning", orderIndex: 0,
        planState: "not_started", createdAt: now, updatedAt: now,
      });

      const feature = await mod.createFeature(layer().db, {
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
      await mod.updateFeature(layer().db, updated);
      const fetched = await mod.getFeature(layer().db, "F-1");
      expect(fetched?.loopState).toBe("passed");
      expect(fetched?.implementationAttemptCount).toBe(1);
      expect(fetched?.validatorAttemptCount).toBe(2);
      expect(fetched?.lastValidatorRunId).toBe("VR-1");
      expect(fetched?.lastValidatorStatus).toBe("passed");

      expect((await mod.listFeatures(layer().db, "SL-2"))).toHaveLength(1);
    });

    // ── Mission Events ──

    it("Mission events: insert with jsonb metadata, count, list by seq", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      await mod.createMission(layer().db, {
        id: "M-5", title: "Mission 5", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });

      await mod.insertMissionEvent(layer().db, {
        id: "ME-1", missionId: "M-5", eventType: "created", description: "Mission created",
        metadata: { source: "test", count: 1 }, timestamp: now, seq: 1,
      });
      await mod.insertMissionEvent(layer().db, {
        id: "ME-2", missionId: "M-5", eventType: "updated", description: "Mission updated",
        metadata: null, timestamp: now, seq: 2,
      });

      expect(await mod.countMissionEvents(layer().db, "M-5")).toBe(2);

      const events = await mod.listMissionEvents(layer().db, "M-5");
      expect(events).toHaveLength(2);
      // Ordered by seq DESC
      expect(events[0]!.id).toBe("ME-2");
      expect(events[0]!.metadata).toBeNull();
      expect(events[1]!.metadata).toEqual({ source: "test", count: 1 });

      // Idempotent insert (INSERT OR IGNORE)
      await mod.insertMissionEventIfAbsent(layer().db, {
        id: "ME-1", missionId: "M-5", eventType: "created", description: "dup",
        metadata: null, timestamp: now, seq: 1,
      });
      expect(await mod.countMissionEvents(layer().db, "M-5")).toBe(2);
    });

    // ── Mission-Goal Links ──

    it("Mission-goal links: idempotent link, list, count, delete", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      // Create a goal first (needed for FK)
      await layer().db.insert(schema.project.goals).values({
        id: "G-1", title: "Goal 1", status: "active", createdAt: now, updatedAt: now,
      });

      await mod.createMission(layer().db, {
        id: "M-6", title: "Mission 6", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });

      await mod.insertMissionGoalLink(layer().db, "M-6", "G-1", now);
      // Idempotent
      await mod.insertMissionGoalLink(layer().db, "M-6", "G-1", now);

      expect(await mod.listGoalIdsForMission(layer().db, "M-6")).toEqual(["G-1"]);
      expect(await mod.listMissionIdsForGoal(layer().db, "G-1")).toEqual(["M-6"]);

      const counts = await mod.countGoalsByMission(layer().db);
      expect(counts.get("M-6")).toBe(1);

      expect(await mod.deleteMissionGoalLink(layer().db, "M-6", "G-1")).toBe(true);
      expect(await mod.listGoalIdsForMission(layer().db, "M-6")).toEqual([]);
    });

    // ── Contract Assertions ──

    it("Contract assertions: create → list → reorder → update → delete", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      await mod.createMission(layer().db, {
        id: "M-7", title: "Mission 7", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });
      await mod.createMilestone(layer().db, {
        id: "MS-4", missionId: "M-7", title: "MS", status: "planning", orderIndex: 0,
        interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
      });

      const a1 = await mod.createContractAssertion(layer().db, {
        id: "CA-1", milestoneId: "MS-4", title: "Assert 1", assertion: "must do X",
        status: "pending", type: "static", orderIndex: 0, createdAt: now, updatedAt: now,
      });
      await mod.createContractAssertion(layer().db, {
        id: "CA-2", milestoneId: "MS-4", title: "Assert 2", assertion: "must do Y",
        status: "pending", type: "static", orderIndex: 1, createdAt: now, updatedAt: now,
      });

      expect(a1.assertion).toBe("must do X");
      const listed = await mod.listContractAssertions(layer().db, "MS-4");
      expect(listed).toHaveLength(2);
      expect(listed.map((a) => a.orderIndex)).toEqual([0, 1]);

      // Reorder: reverse
      await mod.reorderContractAssertions(layer(), ["CA-2", "CA-1"]);
      const reordered = await mod.listContractAssertions(layer().db, "MS-4");
      expect(reordered[0]!.id).toBe("CA-2");
      expect(reordered[1]!.id).toBe("CA-1");

      await mod.updateContractAssertion(layer().db, { ...a1, status: "pass", updatedAt: now });
      expect((await mod.getContractAssertion(layer().db, "CA-1"))?.status).toBe("pass");

      expect(await mod.deleteContractAssertion(layer().db, "CA-1")).toBe(true);
      expect(await mod.listContractAssertions(layer().db, "MS-4")).toHaveLength(1);
    });

    // ── Feature-Assertion Links ──

    it("Feature-assertion links: idempotent link, exists check, unlink", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      await mod.createMission(layer().db, {
        id: "M-8", title: "Mission 8", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });
      await mod.createMilestone(layer().db, {
        id: "MS-5", missionId: "M-8", title: "MS", status: "planning", orderIndex: 0,
        interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
      });
      await mod.createSlice(layer().db, {
        id: "SL-3", milestoneId: "MS-5", title: "SL", status: "planning", orderIndex: 0,
        planState: "not_started", createdAt: now, updatedAt: now,
      });
      await mod.createFeature(layer().db, {
        id: "F-2", sliceId: "SL-3", title: "F", status: "defined", loopState: "idle",
        implementationAttemptCount: 0, validatorAttemptCount: 0, createdAt: now, updatedAt: now,
      });
      await mod.createContractAssertion(layer().db, {
        id: "CA-3", milestoneId: "MS-5", title: "A", assertion: "assert", status: "pending",
        type: "static", orderIndex: 0, createdAt: now, updatedAt: now,
      });

      await mod.linkFeatureToAssertion(layer().db, "F-2", "CA-3", now);
      await mod.linkFeatureToAssertion(layer().db, "F-2", "CA-3", now); // idempotent

      expect(await mod.featureAssertionLinkExists(layer().db, "F-2", "CA-3")).toBe(true);
      const links = await mod.listAllFeatureAssertionLinks(layer().db);
      expect(links).toHaveLength(1);

      expect(await mod.unlinkFeatureFromAssertion(layer().db, "F-2", "CA-3")).toBe(true);
      expect(await mod.featureAssertionLinkExists(layer().db, "F-2", "CA-3")).toBe(false);
    });

    // ── Validator Runs + Failures + Lineage ──

    it("Validator runs + failures + fix-feature lineage round-trip", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      await mod.createMission(layer().db, {
        id: "M-9", title: "Mission 9", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });
      await mod.createMilestone(layer().db, {
        id: "MS-6", missionId: "M-9", title: "MS", status: "planning", orderIndex: 0,
        interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
      });
      await mod.createSlice(layer().db, {
        id: "SL-4", milestoneId: "MS-6", title: "SL", status: "planning", orderIndex: 0,
        planState: "not_started", createdAt: now, updatedAt: now,
      });
      await mod.createFeature(layer().db, {
        id: "F-3", sliceId: "SL-4", title: "F", status: "defined", loopState: "idle",
        implementationAttemptCount: 0, validatorAttemptCount: 0, createdAt: now, updatedAt: now,
      });

      const run = await mod.createValidatorRun(layer().db, {
        id: "VR-1", featureId: "F-3", milestoneId: "MS-6", sliceId: "SL-4", status: "running",
        triggerType: "auto", implementationAttempt: 0, validatorAttempt: 1, startedAt: now,
        createdAt: now, updatedAt: now,
      });
      expect(run.status).toBe("running");

      // Record failures
      await mod.insertValidatorFailure(layer().db, {
        id: "VF-1", runId: "VR-1", featureId: "F-3", assertionId: "CA-X",
        message: "test failed", expected: "pass", actual: "fail", createdAt: now,
      });
      const failures = await mod.listFailuresForRun(layer().db, "VR-1");
      expect(failures).toHaveLength(1);
      expect(failures[0]!.message).toBe("test failed");

      // Complete the run
      const completed = { ...run, status: "failed" as const, summary: "2 failures", completedAt: now, updatedAt: now };
      await mod.updateValidatorRun(layer().db, completed);
      expect((await mod.getValidatorRun(layer().db, "VR-1"))?.status).toBe("failed");

      // List runs by feature (DESC by startedAt)
      const runs = await mod.listValidatorRunsByFeature(layer().db, "F-3");
      expect(runs).toHaveLength(1);

      // Fix-feature lineage
      await mod.createFeature(layer().db, {
        id: "F-FIX", sliceId: "SL-4", title: "Fix", status: "defined", loopState: "idle",
        implementationAttemptCount: 0, validatorAttemptCount: 0,
        generatedFromFeatureId: "F-3", generatedFromRunId: "VR-1",
        createdAt: now, updatedAt: now,
      });
      await mod.insertFixFeatureLineage(layer().db, {
        id: "L-1", sourceFeatureId: "F-3", fixFeatureId: "F-FIX", runId: "VR-1",
        failedAssertionIds: ["CA-X"], createdAt: now,
      });

      expect(await mod.findFixFeatureId(layer().db, "F-3", "VR-1")).toBe("F-FIX");
      expect(await mod.findFixFeatureIdsForSource(layer().db, "F-3")).toEqual(["F-FIX"]);
      const lineage = await mod.listLineageForSourceFeature(layer().db, "F-3");
      expect(lineage).toHaveLength(1);
      expect(lineage[0]!.failedAssertionIds).toEqual(["CA-X"]);
    });

    // ── Snapshot Upsert ──

    it("Snapshot upsert: ON CONFLICT DO UPDATE for mission/milestone/slice/feature", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      // Initial create
      await mod.upsertMission(layer().db, {
        id: "M-10", title: "Original", description: "desc", status: "planning",
        interviewState: "not_started", autoAdvance: false, autopilotEnabled: false,
        autopilotState: "inactive", createdAt: now, updatedAt: now,
      });
      expect((await mod.getMission(layer().db, "M-10"))?.title).toBe("Original");

      // Upsert (update title)
      await mod.upsertMission(layer().db, {
        id: "M-10", title: "Upserted", description: "desc2", status: "active",
        interviewState: "in_progress", autoAdvance: true, autopilotEnabled: true,
        autopilotState: "active", createdAt: now, updatedAt: now,
      });
      const afterUpsert = await mod.getMission(layer().db, "M-10");
      expect(afterUpsert?.title).toBe("Upserted");
      expect(afterUpsert?.status).toBe("active");
      expect(afterUpsert?.autoAdvance).toBe(true);

      // Milestone upsert
      await mod.upsertMilestone(layer().db, {
        id: "MS-7", missionId: "M-10", title: "Original MS", status: "planning", orderIndex: 0,
        interviewState: "not_started", dependencies: [], validationState: "not_started",
        createdAt: now, updatedAt: now,
      });
      await mod.upsertMilestone(layer().db, {
        id: "MS-7", missionId: "M-10", title: "Upserted MS", status: "in_progress", orderIndex: 0,
        interviewState: "not_started", dependencies: [], validationState: "in_progress",
        createdAt: now, updatedAt: now,
      });
      expect((await mod.getMilestone(layer().db, "MS-7"))?.title).toBe("Upserted MS");
    });

    // ── Cascade delete ──

    it("Cascade: deleting a mission removes its milestones/slices/features", async () => {
      const mod = await import("../../async-stores/async-mission-store.js");
      const now = new Date().toISOString();

      await mod.createMission(layer().db, {
        id: "M-11", title: "Cascade Mission", status: "planning", interviewState: "not_started",
        autoAdvance: false, autopilotEnabled: false, autopilotState: "inactive", createdAt: now, updatedAt: now,
      });
      await mod.createMilestone(layer().db, {
        id: "MS-8", missionId: "M-11", title: "MS", status: "planning", orderIndex: 0,
        interviewState: "not_started", dependencies: [], validationState: "not_started", createdAt: now, updatedAt: now,
      });
      await mod.createSlice(layer().db, {
        id: "SL-5", milestoneId: "MS-8", title: "SL", status: "planning", orderIndex: 0,
        planState: "not_started", createdAt: now, updatedAt: now,
      });
      await mod.createFeature(layer().db, {
        id: "F-4", sliceId: "SL-5", title: "F", status: "defined", loopState: "idle",
        implementationAttemptCount: 0, validatorAttemptCount: 0, createdAt: now, updatedAt: now,
      });

      expect(await mod.deleteMission(layer().db, "M-11")).toBe(true);
      // Cascade should have removed children
      expect(await mod.getMilestone(layer().db, "MS-8")).toBeUndefined();
      expect(await mod.getSlice(layer().db, "SL-5")).toBeUndefined();
      expect(await mod.getFeature(layer().db, "F-4")).toBeUndefined();
    });
  });

  describe("PostgreSQL satellite fusion-dir stores (VAL-DATA-015, VAL-DATA-016)", () => {
    // ── AutomationStore ──

    it("AutomationStore: create → get → list → update (upsert) → due query → delete", async () => {
      const { upsertSchedule, getSchedule, findSchedule, listSchedules, deleteSchedule, getDueSchedules } = await import("../../async-stores/async-automation-store.js");
      const boundLayer = { ...layer(), projectId: "automation-round-trip" } as AsyncDataLayer;
      const now = new Date().toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();

      const schedule = {
        id: `auto-${randomUUID().slice(0, 8)}`,
        name: "Nightly Build",
        description: "Run the build",
        scheduleType: "daily" as const,
        cronExpression: "0 2 * * *",
        command: "pnpm build",
        enabled: true,
        timeoutMs: 60_000,
        steps: [{ id: "s1", name: "step1", command: "echo hi" }],
        nextRunAt: past,
        lastRunAt: undefined,
        lastRunResult: undefined,
        runCount: 0,
        runHistory: [],
        scope: "project" as const,
        createdAt: now,
        updatedAt: now,
      };

      await upsertSchedule(boundLayer, schedule);
      const fetched = await getSchedule(boundLayer, schedule.id);
      expect(fetched.name).toBe("Nightly Build");
      expect(fetched.enabled).toBe(true);
      expect(fetched.steps).toHaveLength(1);
      expect(fetched.cronExpression).toBe("0 2 * * *");

      // Update via upsert (change enabled + lastRunResult)
      const updated = {
        ...schedule,
        enabled: false,
        lastRunAt: now,
        lastRunResult: { success: true, output: "ok", startedAt: past, completedAt: now },
        runCount: 1,
        runHistory: [{ success: true, output: "ok", startedAt: past, completedAt: now }],
        updatedAt: now,
      };
      await upsertSchedule(boundLayer, updated);
      const afterUpdate = await getSchedule(boundLayer, schedule.id);
      expect(afterUpdate.enabled).toBe(false);
      expect(afterUpdate.runCount).toBe(1);
      expect(afterUpdate.lastRunResult).toEqual(updated.lastRunResult);
      expect(afterUpdate.runHistory).toHaveLength(1);

      // List
      const all = await listSchedules(boundLayer);
      expect(all).toHaveLength(1);

      // Due query (enabled=false now, so not due)
      const dueDisabled = await getDueSchedules(boundLayer, now, "project");
      expect(dueDisabled).toHaveLength(0);

      // Re-enable and check due
      await upsertSchedule(boundLayer, { ...updated, enabled: true });
      const dueEnabled = await getDueSchedules(boundLayer, now, "project");
      expect(dueEnabled).toHaveLength(1);
      expect(dueEnabled[0]!.id).toBe(schedule.id);

      // findSchedule returns the row, deleteSchedule removes it
      expect((await findSchedule(boundLayer, schedule.id))?.id).toBe(schedule.id);
      expect(await deleteSchedule(boundLayer, schedule.id)).toBe(true);
      expect(await findSchedule(boundLayer, schedule.id)).toBeUndefined();
    });

    /**
     * FNXC:AutomationIsolation 2026-07-13-22:37:
     * Embedded PostgreSQL shares one physical automations table across projects, while SQLite provided isolation through one file per project. Every automation operation must therefore use the bound AsyncDataLayer projectId. This regression covers unbound rejection, empty, duplicate-ID, and populated states and proves that listing, mutation, deletion, and the due-run claim boundary cannot cross projects. A `global` scope remains an execution lane owned by the project that created it; it is not permission for another project's cron runner to execute the command.
     *
     * FNXC:AutomationIsolation 2026-07-14-00:37:
     * Missing project ownership is an invalid automation-store state. Unbound helpers must reject rather than creating an invisible schedule in the empty-string partition.
     */
    it("AutomationStore: isolates duplicate IDs and due-run claims across two bound projects", async () => {
      const { upsertSchedule, listSchedules } = await import("../../async-stores/async-automation-store.js");
      const { AutomationStore } = await import("../../automation/automation-store.js");
      const layerA = { ...layer(), projectId: "project-a" } as AsyncDataLayer;
      const layerB = { ...layer(), projectId: "project-b" } as AsyncDataLayer;
      const now = new Date().toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();
      const duplicateId = "shared-automation-id";
      const schedule = (name: string, scope: "global" | "project") => ({
        id: duplicateId,
        name,
        scheduleType: "custom" as const,
        cronExpression: "* * * * *",
        command: `echo ${name}`,
        enabled: true,
        runCount: 0,
        runHistory: [],
        nextRunAt: past,
        scope,
        createdAt: now,
        updatedAt: now,
      });

      expect(await listSchedules(layerA)).toEqual([]);
      expect(await listSchedules(layerB)).toEqual([]);

      await expect(
        upsertSchedule(layer(), { ...schedule("unbound", "project"), id: "unbound-id" }),
      ).rejects.toThrow("AutomationStore backend operations require asyncLayer.projectId");
      expect(await listSchedules(layerA)).toEqual([]);
      expect(await listSchedules(layerB)).toEqual([]);

      await upsertSchedule(layerA, schedule("project-a", "project"));
      await upsertSchedule(layerB, schedule("project-b-global", "global"));

      const storeA = new AutomationStore("/tmp/fusion-automation-project-a", { asyncLayer: layerA });
      const storeB = new AutomationStore("/tmp/fusion-automation-project-b", { asyncLayer: layerB });
      expect((await storeA.listSchedules()).map(({ name }) => name)).toEqual(["project-a"]);
      expect((await storeB.listSchedules()).map(({ name }) => name)).toEqual(["project-b-global"]);

      await storeA.updateSchedule(duplicateId, { name: "project-a-updated" });
      expect((await storeA.getSchedule(duplicateId)).name).toBe("project-a-updated");
      expect((await storeB.getSchedule(duplicateId)).name).toBe("project-b-global");

      expect((await storeA.getDueSchedules("project")).map(({ name }) => name)).toEqual(["project-a-updated"]);
      expect((await storeB.getDueSchedules("project"))).toEqual([]);
      expect((await storeB.getDueSchedules("global")).map(({ name }) => name)).toEqual(["project-b-global"]);

      expect(await storeA.claimDueSchedule(duplicateId, past)).toBe(true);
      expect(await storeA.getDueSchedules("project")).toEqual([]);
      expect((await storeB.getDueSchedules("global")).map(({ name }) => name)).toEqual(["project-b-global"]);

      await storeA.deleteSchedule(duplicateId);
      expect(await storeA.listSchedules()).toEqual([]);
      expect((await storeB.listSchedules()).map(({ name }) => name)).toEqual(["project-b-global"]);
    });

    // ── RoutineStore ──

    it("RoutineStore: create (cron trigger) → get → list → update → due query → delete", async () => {
      const { upsertRoutine, getRoutine, findRoutine, listRoutines, deleteRoutine, getDueRoutines } = await import("../../async-stores/async-routine-store.js");
      const now = new Date().toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();

      const routine = {
        id: `routine-${randomUUID().slice(0, 8)}`,
        agentId: "agent-1",
        name: "Health Check",
        description: "Check system health",
        trigger: { type: "cron" as const, cronExpression: "*/5 * * * *", timezone: "UTC" },
        command: "fn health",
        steps: undefined,
        timeoutMs: 30_000,
        catchUpPolicy: "run_one" as const,
        executionPolicy: "queue" as const,
        enabled: true,
        lastRunAt: undefined,
        lastRunResult: undefined,
        nextRunAt: past,
        runCount: 0,
        runHistory: [],
        catchUpLimit: 5,
        cronExpression: "*/5 * * * *",
        scope: "project" as const,
        createdAt: now,
        updatedAt: now,
      };

      await upsertRoutine(layer().db, routine);
      const fetched = await getRoutine(layer().db, routine.id);
      expect(fetched.name).toBe("Health Check");
      expect(fetched.trigger.type).toBe("cron");
      expect(fetched.trigger).toEqual({ type: "cron", cronExpression: "*/5 * * * *", timezone: "UTC" });
      expect(fetched.enabled).toBe(true);
      expect(fetched.agentId).toBe("agent-1");

      // List
      const all = await listRoutines(layer().db);
      expect(all).toHaveLength(1);

      // Due query
      const due = await getDueRoutines(layer().db, now, "project");
      expect(due).toHaveLength(1);
      expect(due[0]!.id).toBe(routine.id);

      // Update (change trigger to manual)
      const updated = {
        ...routine,
        trigger: { type: "manual" as const },
        enabled: false,
        cronExpression: undefined,
        nextRunAt: undefined,
        updatedAt: now,
      };
      await upsertRoutine(layer().db, updated);
      const afterUpdate = await getRoutine(layer().db, routine.id);
      expect(afterUpdate.trigger.type).toBe("manual");
      expect(afterUpdate.enabled).toBe(false);

      // Disabled routine is not due
      const dueAfterDisable = await getDueRoutines(layer().db, now, "project");
      expect(dueAfterDisable).toHaveLength(0);

      // Delete
      expect(await deleteRoutine(layer().db, routine.id)).toBe(true);
      expect(await findRoutine(layer().db, routine.id)).toBeUndefined();
    });

    it("RoutineStore: webhook + api trigger config round-trips through jsonb", async () => {
      const { upsertRoutine, getRoutine } = await import("../../async-stores/async-routine-store.js");
      const now = new Date().toISOString();

      const webhookRoutine = {
        id: `rw-${randomUUID().slice(0, 8)}`,
        agentId: "agent-2",
        name: "Webhook Routine",
        trigger: { type: "webhook" as const, webhookPath: "/hook/test", secret: "s3cr3t" },
        command: "fn run",
        catchUpPolicy: "run_one" as const,
        executionPolicy: "queue" as const,
        enabled: true,
        runCount: 0,
        runHistory: [],
        catchUpLimit: 5,
        scope: "project" as const,
        createdAt: now,
        updatedAt: now,
      };
      await upsertRoutine(layer().db, webhookRoutine);
      const fetched = await getRoutine(layer().db, webhookRoutine.id);
      expect(fetched.trigger).toEqual({ type: "webhook", webhookPath: "/hook/test", secret: "s3cr3t" });

      const apiRoutine = {
        id: `ra-${randomUUID().slice(0, 8)}`,
        agentId: "agent-3",
        name: "API Routine",
        trigger: { type: "api" as const, endpoint: "/api/trigger" },
        command: "fn api-run",
        catchUpPolicy: "run_one" as const,
        executionPolicy: "queue" as const,
        enabled: true,
        runCount: 0,
        runHistory: [],
        catchUpLimit: 5,
        scope: "global" as const,
        createdAt: now,
        updatedAt: now,
      };
      await upsertRoutine(layer().db, apiRoutine);
      const apiFetched = await getRoutine(layer().db, apiRoutine.id);
      expect(apiFetched.trigger).toEqual({ type: "api", endpoint: "/api/trigger" });
      expect(apiFetched.scope).toBe("global");
    });

    // ── PluginStore (VAL-DATA-016) ──

    it("PluginStore: register → get → list → enable/disable → state → settings → update → unregister (VAL-DATA-016)", async () => {
      const {
        registerPlugin, getPlugin, listPlugins, enablePlugin, disablePlugin,
        updatePluginState, updatePluginSettings, updatePluginInstall, unregisterPlugin,
        getProjectState,
      } = await import("../../async-stores/async-plugin-store.js");

      const projectPath = "/test/project";
      const manifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        description: "A test plugin",
        author: "Test",
        homepage: "https://example.com",
        dependencies: [],
        settingsSchema: {
          apiKey: { type: "string" as const, required: false, defaultValue: "" },
        },
      };

      const plugin = await registerPlugin(layer(), {
        manifest,
        path: "/plugins/test-plugin",
        settings: { apiKey: "secret-key" },
        aiScanOnLoad: true,
        projectPath,
      });

      expect(plugin.id).toBe("test-plugin");
      expect(plugin.enabled).toBe(true);
      expect(plugin.state).toBe("installed");
      expect(plugin.settings.apiKey).toBe("secret-key");
      expect(plugin.aiScanOnLoad).toBe(true);
      expect(plugin.dependencies).toEqual([]);

      // getPlugin
      const fetched = await getPlugin(layer().db, "test-plugin", projectPath);
      expect(fetched.name).toBe("Test Plugin");

      // listPlugins
      const all = await listPlugins(layer().db, projectPath);
      expect(all).toHaveLength(1);

      // disable / enable
      const disabled = await disablePlugin(layer().db, "test-plugin", projectPath);
      expect(disabled.enabled).toBe(false);
      const stateAfterDisable = await getProjectState(layer().db, projectPath, "test-plugin");
      expect(stateAfterDisable?.enabled).toBe(0);

      const enabled = await enablePlugin(layer().db, "test-plugin", projectPath);
      expect(enabled.enabled).toBe(true);

      // updatePluginState (installed -> started)
      const started = await updatePluginState(layer().db, "test-plugin", projectPath, "started");
      expect(started.state).toBe("started");

      // error state with error message
      const errored = await updatePluginState(layer().db, "test-plugin", projectPath, "error", "Crashed");
      expect(errored.state).toBe("error");
      expect(errored.error).toBe("Crashed");

      // updatePluginSettings (merge)
      await updatePluginSettings(layer().db, "test-plugin", { apiKey: "new-key", extra: "val" });
      const afterSettings = await getPlugin(layer().db, "test-plugin", projectPath);
      expect(afterSettings.settings.apiKey).toBe("new-key");
      expect(afterSettings.settings.extra).toBe("val");

      // updatePluginInstall (version bump + dependencies + lastSecurityScan jsonb-in-text)
      await updatePluginInstall(layer().db, "test-plugin", {
        version: "1.1.0",
        dependencies: ["dep-a"],
        lastSecurityScan: { passed: true, issues: [] },
      });
      const afterUpdate = await getPlugin(layer().db, "test-plugin", projectPath);
      expect(afterUpdate.version).toBe("1.1.0");
      expect(afterUpdate.dependencies).toEqual(["dep-a"]);
      expect(afterUpdate.lastSecurityScan).toEqual({ passed: true, issues: [] });

      // filter list by enabled
      const enabledOnly = await listPlugins(layer().db, projectPath, { enabled: true });
      expect(enabledOnly).toHaveLength(1);

      // unregister (cascade deletes project state)
      const deleted = await unregisterPlugin(layer().db, "test-plugin", projectPath);
      expect(deleted.id).toBe("test-plugin");
      await expect(getPlugin(layer().db, "test-plugin", projectPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("PluginStore: duplicate registration throws EEXISTS", async () => {
      const { registerPlugin } = await import("../../async-stores/async-plugin-store.js");
      const manifest = { id: "dup-plugin", name: "Dup", version: "1.0.0", dependencies: [] };
      await registerPlugin(layer(), { manifest, path: "/p", projectPath: "/proj" });
      await expect(
        registerPlugin(layer(), { manifest, path: "/p2", projectPath: "/proj" }),
      ).rejects.toMatchObject({ code: "EEXISTS" });
    });

    // ── AgentStore ──

    /**
     * FNXC:AgentHeartbeatIsolation 2026-07-14-00:37:
     * Heartbeat and run APIs are project-owned in backend mode. An unbound AgentStore must reject before it can read or write the shared PostgreSQL heartbeat/run state.
     */
    it("AgentStore: unbound backend heartbeat/run APIs fail closed", async () => {
      const { AgentStore } = await import("../../agents/agent-store.js");
      const store = new AgentStore({ rootDir: "/tmp/fusion-unbound-agent-store", asyncLayer: layer() });
      const run = {
        id: "unbound-run",
        agentId: "unbound-agent",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active" as const,
      };

      await expect(store.saveRun(run)).rejects.toThrow(
        "AgentStore backend heartbeat/run operations require asyncLayer.projectId",
      );
      await expect(store.listActiveHeartbeatRuns()).rejects.toThrow(
        "AgentStore backend heartbeat/run operations require asyncLayer.projectId",
      );
      await expect(store.recordHeartbeat(run.agentId, "ok", run.id)).rejects.toThrow(
        "AgentStore backend heartbeat/run operations require asyncLayer.projectId",
      );
      await expect(store.getHeartbeatHistory(run.agentId)).rejects.toThrow(
        "AgentStore backend heartbeat/run operations require asyncLayer.projectId",
      );
    });

    it("AgentStore: write/read agent (jsonb data) → list → find by name → delete", async () => {
      const { writeAgent, readAgent, listAgentRows, findAgentRowsByName, deleteAgent, agentToData } = await import("../../async-stores/async-agent-store.js");
      const now = new Date().toISOString();
      const agent = {
        id: `agent-${randomUUID().slice(0, 8)}`,
        name: "Test Agent",
        role: "orchestrator" as const,
        state: "active" as const,
        createdAt: now,
        updatedAt: now,
        metadata: { team: "alpha" },
        title: "Lead",
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 3600000 },
        permissions: { createTask: true },
        totalInputTokens: 100,
        totalOutputTokens: 50,
      };

      await writeAgent(layer().db, agent);
      const fetched = await readAgent(layer().db, agent.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(agent.id);
      expect(fetched!.name).toBe("Test Agent");
      expect(fetched!.role).toBe("orchestrator");
      expect(fetched!.state).toBe("active");
      expect(fetched!.metadata).toEqual({ team: "alpha" });
      expect(fetched!.title).toBe("Lead");
      expect(fetched!.runtimeConfig).toEqual({ enabled: true, heartbeatIntervalMs: 3600000 });
      expect(fetched!.totalInputTokens).toBe(100);

      // agentToData round-trips the extended fields
      const data = agentToData(agent);
      expect(data.title).toBe("Lead");

      // Update via upsert (change state)
      await writeAgent(layer().db, { ...agent, state: "paused", pauseReason: "testing", updatedAt: now });
      const afterUpdate = await readAgent(layer().db, agent.id);
      expect(afterUpdate!.state).toBe("paused");
      expect(afterUpdate!.pauseReason).toBe("testing");

      // list filtered by state
      const paused = await listAgentRows(layer().db, { state: "paused" });
      expect(paused).toHaveLength(1);
      const active = await listAgentRows(layer().db, { state: "active" });
      expect(active).toHaveLength(0);

      // find by name
      const byName = await findAgentRowsByName(layer().db, "Test Agent");
      expect(byName).toHaveLength(1);

      // delete
      expect(await deleteAgent(layer().db, agent.id)).toBe(true);
      expect(await readAgent(layer().db, agent.id)).toBeNull();
    });

    it("AgentStore: heartbeat event + history round-trip", async () => {
      const { writeAgent, recordHeartbeat, getHeartbeatHistory } = await import("../../async-stores/async-agent-store.js");
      const now = new Date().toISOString();
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      await writeAgent(layer().db, { id: agentId, name: "HB", role: "worker", state: "active", createdAt: now, updatedAt: now, metadata: {} });

      await recordHeartbeat(layer().db, { agentId, timestamp: now, status: "ok", runId: "run-1" });
      await recordHeartbeat(layer().db, { agentId, timestamp: new Date(Date.now() + 1000).toISOString(), status: "missed", runId: "run-1" });

      const history = await getHeartbeatHistory(layer().db, agentId, 10);
      expect(history).toHaveLength(2);
      // newest first
      expect(history[0]!.status).toBe("missed");
      expect(history[1]!.status).toBe("ok");
    });

    it("AgentStore: run save/get/recent/active-list/status-counts round-trip", async () => {
      const { saveRun, getRunDetail, getRunById, getRecentRuns, listActiveHeartbeatRuns, getRunStatusCounts, insertRunIfAbsent } = await import("../../async-stores/async-agent-store.js");
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      await seedAgent(layer(), agentId);
      const run = {
        id: `run-${randomUUID().slice(0, 8)}`,
        agentId,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active" as const,
      };

      await saveRun(layer().db, layer().projectId ?? "", run);
      expect((await getRunDetail(layer().db, layer().projectId ?? "", agentId, run.id))?.id).toBe(run.id);
      const byId = await getRunById(layer().db, layer().projectId ?? "", run.id);
      expect(byId?.agentId).toBe(agentId);
      expect(byId?.run?.id).toBe(run.id);

      // recent runs
      const recent = await getRecentRuns(layer().db, layer().projectId ?? "", agentId, 10);
      expect(recent).toHaveLength(1);

      // active list
      const active = await listActiveHeartbeatRuns(layer().db, layer().projectId ?? "");
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe(run.id);

      // end the run
      const endedRun = { ...run, endedAt: new Date().toISOString(), status: "completed" as const };
      await saveRun(layer().db, layer().projectId ?? "", endedRun);
      const counts = await getRunStatusCounts(layer().db, layer().projectId ?? "", [agentId]);
      expect(counts.completedRuns).toBe(1);
      expect(counts.failedRuns).toBe(0);

      // insertRunIfAbsent is a no-op on existing
      expect(await insertRunIfAbsent(layer().db, layer().projectId ?? "", run)).toBe(false);
    });

    it("AgentStore: task session upsert/get/delete", async () => {
      const { upsertTaskSession, getTaskSession, deleteTaskSession } = await import("../../async-stores/async-agent-store.js");
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      await seedAgent(layer(), agentId);
      const taskId = "FN-1";
      const session = { agentId, taskId, context: { step: 1 }, notes: "first" } as never;

      await upsertTaskSession(layer().db, session);
      expect((await getTaskSession(layer().db, agentId, taskId))?.taskId).toBe(taskId);

      // update
      await upsertTaskSession(layer().db, { agentId, taskId, context: { step: 2 }, notes: "second" } as never);
      const updated = await getTaskSession(layer().db, agentId, taskId);
      expect((updated as { notes?: string })?.notes).toBe("second");

      await deleteTaskSession(layer().db, agentId, taskId);
      expect(await getTaskSession(layer().db, agentId, taskId)).toBeNull();
    });

    it("AgentStore: API key insert/list/revoke", async () => {
      const { insertApiKey, readApiKeys, revokeApiKeyRow } = await import("../../async-stores/async-agent-store.js");
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      await seedAgent(layer(), agentId);
      const now = new Date().toISOString();
      const key = { id: `key-${randomUUID().slice(0, 8)}`, agentId, tokenHash: "hash-abc", createdAt: now };

      await insertApiKey(layer().db, key);
      const keys = await readApiKeys(layer().db, agentId);
      expect(keys).toHaveLength(1);
      expect(keys[0]!.tokenHash).toBe("hash-abc");

      // revoke
      const revoked = { ...key, revokedAt: now };
      await revokeApiKeyRow(layer().db, key.id, agentId, revoked);
      const afterRevoke = await readApiKeys(layer().db, agentId);
      expect(afterRevoke[0]!.revokedAt).toBe(now);
    });

    it("AgentStore: config revision append/read/find", async () => {
      const { appendConfigRevision, readConfigRevisions, findConfigRevisionById } = await import("../../async-stores/async-agent-store.js");
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      await seedAgent(layer(), agentId);
      const revision = {
        id: `rev-${randomUUID().slice(0, 8)}`,
        agentId,
        createdAt: new Date().toISOString(),
        before: { name: "Old" } as never,
        after: { name: "New" } as never,
        diffs: [{ field: "name", before: "Old", after: "New" }] as never,
        summary: "Updated name",
        source: "user" as const,
      };

      await appendConfigRevision(layer().db, revision);
      const revisions = await readConfigRevisions(layer().db, agentId);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.summary).toBe("Updated name");

      const found = await findConfigRevisionById(layer().db, revision.id);
      expect(found?.id).toBe(revision.id);
    });

    it("AgentStore: rating add/get/filter/delete with score CHECK constraint", async () => {
      const { addRating, getRatings, deleteRating } = await import("../../async-stores/async-agent-store.js");
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();

      const r1 = { id: `r-${randomUUID().slice(0, 8)}`, agentId, raterType: "user" as const, score: 5, category: "quality", comment: "great", createdAt: now };
      const r2 = { id: `r-${randomUUID().slice(0, 8)}`, agentId, raterType: "agent" as const, raterId: "a-1", score: 3, category: "speed", createdAt: now };
      await addRating(layer().db, r1);
      await addRating(layer().db, r2);

      const all = await getRatings(layer().db, agentId);
      expect(all).toHaveLength(2);

      const quality = await getRatings(layer().db, agentId, { category: "quality" });
      expect(quality).toHaveLength(1);
      expect(quality[0]!.score).toBe(5);

      const limited = await getRatings(layer().db, agentId, { limit: 1 });
      expect(limited).toHaveLength(1);

      // Score CHECK constraint rejects out-of-range scores (VAL-SCHEMA-005)
      await expect(
        addRating(layer().db, { id: `r-${randomUUID().slice(0, 8)}`, agentId, raterType: "user", score: 0, createdAt: now }),
      ).rejects.toThrow();

      expect(await deleteRating(layer().db, r1.id)).toBe(true);
      expect(await getRatings(layer().db, agentId)).toHaveLength(1);
    });

    it("AgentStore: blocked state set/get/clear + all-blocked snapshot", async () => {
      const { getLastBlockedState, setLastBlockedState, clearLastBlockedState, getAllBlockedStates } = await import("../../async-stores/async-agent-store.js");
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      await seedAgent(layer(), agentId);
      const state = { taskId: "FN-1", reason: "stuck", at: new Date().toISOString() } as never;

      expect(await getLastBlockedState(layer().db, agentId)).toBeNull();
      await setLastBlockedState(layer().db, agentId, state);
      expect((await getLastBlockedState(layer().db, agentId))?.taskId).toBe("FN-1");

      // update (upsert)
      const state2 = { taskId: "FN-2", reason: "blocked", at: new Date().toISOString() } as never;
      await setLastBlockedState(layer().db, agentId, state2);
      expect((await getLastBlockedState(layer().db, agentId))?.taskId).toBe("FN-2");

      const all = await getAllBlockedStates(layer().db);
      expect(all).toHaveLength(1);
      expect(all[0]!.agentId).toBe(agentId);

      await clearLastBlockedState(layer().db, agentId);
      expect(await getLastBlockedState(layer().db, agentId)).toBeNull();
    });

    it("AgentStore: __meta migration marker upsert/get", async () => {
      const { getMetaValue, upsertMetaValue } = await import("../../async-stores/async-agent-store.js");
      const key = "testMigrationMarker";

      expect(await getMetaValue(layer().db, key)).toBeUndefined();
      await upsertMetaValue(layer().db, key, "1");
      expect(await getMetaValue(layer().db, key)).toBe("1");
      // update
      await upsertMetaValue(layer().db, key, "2");
      expect(await getMetaValue(layer().db, key)).toBe("2");
    });
  });

  describe("PostgreSQL satellite DB-injected stores (VAL-DATA-016)", () => {
    // ── TodoStore ──

    it("TodoStore: create list → add items → toggle → reorder round-trip", async () => {
      const { createTodoList, getTodoList, listTodoLists, createTodoItem, listTodoItems, updateTodoItem, deleteTodoItem, reorderTodoItems, getTodoListsWithItems } = await import("../../async-stores/async-todo-store.js");
      const now = new Date().toISOString();
      const list = await createTodoList(layer().db, { id: "TDL-1", projectId: "P1", title: "My List", createdAt: now, updatedAt: now });
      expect(list.id).toBe("TDL-1");
      expect((await getTodoList(layer().db, "TDL-1"))?.title).toBe("My List");
      expect((await listTodoLists(layer().db, "P1"))).toHaveLength(1);

      const item1 = await createTodoItem(layer().db, { id: "TDI-1", listId: "TDL-1", text: "Task 1", completed: false, completedAt: null, sortOrder: undefined, createdAt: now, updatedAt: now });
      const item2 = await createTodoItem(layer().db, { id: "TDI-2", listId: "TDL-1", text: "Task 2", completed: false, completedAt: null, sortOrder: undefined, createdAt: now, updatedAt: now });
      expect(item1.sortOrder).toBe(0);
      expect(item2.sortOrder).toBe(1);

      const toggled = await updateTodoItem(layer().db, "TDI-1", { completed: true });
      expect(toggled?.completed).toBe(true);
      expect(toggled?.completedAt).toBeTruthy();

      const reordered = await reorderTodoItems(layer(), "TDL-1", ["TDI-2", "TDI-1"]);
      expect(reordered[0]!.id).toBe("TDI-2");
      expect(reordered[0]!.sortOrder).toBe(0);

      const withItems = await getTodoListsWithItems(layer().db, "P1");
      expect(withItems).toHaveLength(1);
      expect(withItems[0]!.items).toHaveLength(2);

      expect(await deleteTodoItem(layer().db, "TDI-1")).toBe(true);
      expect((await listTodoItems(layer().db, "TDL-1"))).toHaveLength(1);
    });

    // ── GoalStore ──

    it("GoalStore: create → list → archive → unarchive with active-limit enforcement", async () => {
      const { createGoal, getGoal, listGoals, archiveGoal, unarchiveGoal } = await import("../../async-stores/async-goal-store.js");
      const { ACTIVE_GOAL_LIMIT } = await import("../../goals/goal-types.js");

      const goal = await createGoal(layer(), { id: "G-1", title: "Ship", description: "Ship the product" });
      expect(goal.status).toBe("active");
      expect((await getGoal(layer().db, "G-1"))?.title).toBe("Ship");

      const archived = await archiveGoal(layer().db, "G-1");
      expect(archived.status).toBe("archived");

      const active = await listGoals(layer().db, { status: "active" });
      expect(active).toHaveLength(0);
      const archivedGoals = await listGoals(layer().db, { status: "archived" });
      expect(archivedGoals).toHaveLength(1);

      const unarchived = await unarchiveGoal(layer(), "G-1");
      expect(unarchived.status).toBe("active");

      // Active-limit enforcement: fill up to ACTIVE_GOAL_LIMIT and expect rejection.
      for (let i = 2; i <= ACTIVE_GOAL_LIMIT; i++) {
        await createGoal(layer(), { id: `G-${i}`, title: `Goal ${i}` });
      }
      await expect(createGoal(layer(), { id: "G-OVER", title: "Over limit" })).rejects.toThrow();
    });

    // ── MessageStore ──

    it("MessageStore: send → inbox → mark read → conversation → mailbox round-trip", async () => {
      const { sendMessage, queryMessagesByParticipant, markMessageAsRead, getConversation, getMailbox } = await import("../../async-stores/async-message-store.js");
      const now = new Date().toISOString();
      const msg = await sendMessage(layer().db, { id: "msg-1", fromId: "agent-a", fromType: "agent", toId: "agent-b", toType: "agent", content: "Hello", type: "agent-to-agent", read: false, metadata: { key: "val" }, createdAt: now, updatedAt: now });
      expect(msg.read).toBe(false);

      const inbox = await queryMessagesByParticipant(layer().db, "to", "agent-b", "agent");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.metadata).toEqual({ key: "val" });

      const read = await markMessageAsRead(layer().db, "msg-1");
      expect(read?.read).toBe(true);

      // Conversation
      await sendMessage(layer().db, { id: "msg-2", fromId: "agent-b", fromType: "agent", toId: "agent-a", toType: "agent", content: "Hi back", type: "agent-to-agent", read: false, metadata: null, createdAt: now, updatedAt: now });
      const convo = await getConversation(layer().db, { id: "agent-a", type: "agent" }, { id: "agent-b", type: "agent" });
      expect(convo).toHaveLength(2);

      /*
      FNXC:MessageStorePerf 2026-07-11 (PR #1793 review):
      getConversation is capped to the most recent `limit` messages (default 200)
      and must keep oldest-first ordering. Pin the cap window: with limit 1 only
      the NEWEST message survives, and the default read stays ascending.
      */
      const later = new Date(Date.now() + 1000).toISOString();
      await sendMessage(layer().db, { id: "msg-3", fromId: "agent-a", fromType: "agent", toId: "agent-b", toType: "agent", content: "Newest", type: "agent-to-agent", read: false, metadata: null, createdAt: later, updatedAt: later });
      const capped = await getConversation(layer().db, { id: "agent-a", type: "agent" }, { id: "agent-b", type: "agent" }, { limit: 1 });
      expect(capped.map((m) => m.id)).toEqual(["msg-3"]);
      const full = await getConversation(layer().db, { id: "agent-a", type: "agent" }, { id: "agent-b", type: "agent" });
      expect(full[full.length - 1]!.id).toBe("msg-3");
      expect(full).toHaveLength(3);

      // Mailbox
      const mailbox = await getMailbox(layer().db, "agent-a", "agent");
      expect(mailbox.unreadCount).toBeGreaterThanOrEqual(0);
      expect(mailbox.lastMessage).toBeTruthy();
    });

    // ── ApprovalRequestStore ──

    it("ApprovalRequestStore: create → decide → complete with audit history", async () => {
      const { createApprovalRequest, decideApprovalRequest, markApprovalRequestCompleted, getApprovalAuditHistory } = await import("../../async-stores/async-approval-request-store.js");
      const req = await createApprovalRequest(layer(), {
        id: "apr-1",
        requester: { actorId: "agent-1", actorType: "agent", actorName: "Bot" },
        targetAction: { category: "shell", action: "exec", summary: "run cmd", resourceType: "host", resourceId: "local", context: { cmd: "ls" } },
      });
      expect(req.status).toBe("pending");
      expect(req.targetAction.context).toEqual({ cmd: "ls" });

      expect((await getApprovalAuditHistory(layer().db, "apr-1"))).toHaveLength(1);

      const approved = await decideApprovalRequest(layer(), "apr-1", "approved", { actor: { actorId: "user-1", actorType: "user", actorName: "Admin" }, note: "ok" });
      expect(approved.status).toBe("approved");

      const completed = await markApprovalRequestCompleted(layer(), "apr-1", { actor: { actorId: "user-1", actorType: "user", actorName: "Admin" } });
      expect(completed.status).toBe("completed");

      const history = await getApprovalAuditHistory(layer().db, "apr-1");
      expect(history.length).toBeGreaterThanOrEqual(3); // created + approved + completed
    });

    /*
    FNXC:ApprovalLifecycleSecurity 2026-07-26-13:50:
    Replay/conflict/expiry/ownership hardening for the async approval store: a replayed decision must throw
    the invalid-transition error the dashboard maps to HTTP 409 (it previously re-stamped decidedAt and
    forged a duplicate audit event), completed grants expire 15 minutes after decidedAt, and markCompleted
    enforces the requester-ownership check.
    */
    it("ApprovalRequestStore: replayed/conflicting decisions 409, grants expire, ownership enforced", async () => {
      const { createApprovalRequest, decideApprovalRequest, markApprovalRequestCompleted, getApprovalAuditHistory } = await import("../../async-stores/async-approval-request-store.js");
      const { eq } = await import("drizzle-orm");
      const requester = { actorId: "agent-1", actorType: "agent" as const, actorName: "Bot" };
      const admin = { actorId: "user-1", actorType: "user" as const, actorName: "Admin" };
      await createApprovalRequest(layer(), {
        id: "apr-2",
        requester,
        targetAction: { category: "shell", action: "exec", summary: "run cmd", resourceType: "host", resourceId: "local" },
      });
      await decideApprovalRequest(layer(), "apr-2", "approved", { actor: admin });

      // Replay approve -> conflict; conflicting deny -> conflict; audit history stays unforged.
      await expect(decideApprovalRequest(layer(), "apr-2", "approved", { actor: admin })).rejects.toThrow(
        "Invalid approval request transition: approved -> approved",
      );
      await expect(decideApprovalRequest(layer(), "apr-2", "denied", { actor: admin })).rejects.toThrow(
        "Invalid approval request transition: approved -> denied",
      );
      expect((await getApprovalAuditHistory(layer().db, "apr-2")).map((e) => e.eventType)).toEqual([
        "created",
        "approved",
      ]);

      // Ownership: a different runtime cannot burn agent-1's grant.
      await expect(
        markApprovalRequestCompleted(layer(), "apr-2", { actor: admin, expectedRequesterActorId: "agent-2" }),
      ).rejects.toThrow("Approval request apr-2 requester mismatch");

      // Expiry: backdate decidedAt past the 15-minute grant TTL -> redemption fails closed.
      /*
      FNXC:ApprovalLifecycleSecurity 2026-07-30-13:40 (TTL is configurable now — stop hardcoding the default):
      This offset was written as 16 minutes against the original 15-minute grant TTL. The review follow-up
      raised the DEFAULT to one hour and made it configurable, which left this assertion asserting nothing:
      a 16-minute-old grant is simply valid now, so the redemption succeeded and the test failed.

      Pin the TTL for the test instead of chasing the default, so the expiry rule is what is under test
      rather than whatever the shipping default happens to be.
      */
      const { configureApprovalRequestTtls } = await import("../../types/agents/index.js");
      configureApprovalRequestTtls({ grantTtlMs: 60_000 });
      const staleDecidedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      await layer().db
        .update(schema.project.approvalRequests)
        .set({ decidedAt: staleDecidedAt })
        .where(eq(schema.project.approvalRequests.id, "apr-2"));
      await expect(markApprovalRequestCompleted(layer(), "apr-2", { actor: requester })).rejects.toThrow(
        "Approval request apr-2 expired",
      );
      configureApprovalRequestTtls({ grantTtlMs: undefined });
    });

    // ── EvalStore ──

    it("EvalStore: create run → upsert result → list → append event", async () => {
      const { createEvalRun, getEvalRun, upsertEvalTaskResult, getEvalTaskResultByRunTask, appendEvalRunEvent, listEvalRunEvents } = await import("../../async-stores/async-eval-store.js");
      const now = new Date().toISOString();
      const run = await createEvalRun(layer().db, { id: "ER-1", projectId: "P1", trigger: "manual", scope: "all", window: { days: 7 }, requestedTaskIds: ["T1"], counts: { totalTasks: 1, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 }, createdAt: now, updatedAt: now });
      expect(run.status).toBe("pending");
      expect(run.window).toEqual({ days: 7 });
      expect((await getEvalRun(layer().db, "ER-1"))?.id).toBe("ER-1");

      await upsertEvalTaskResult(layer().db, {
        id: "ETR-1", runId: "ER-1", taskId: "T1", taskSnapshot: { taskId: "T1" }, status: "scored",
        overallScore: 8, maxScore: 10, categoryScores: [{ name: "quality", score: 8 }],
        evidence: [], deterministicSignals: [], followUps: [], createdAt: now, updatedAt: now,
      });
      const result = await getEvalTaskResultByRunTask(layer().db, "ER-1", "T1");
      expect(result?.overallScore).toBe(8);

      // Upsert again to test ON CONFLICT update
      await upsertEvalTaskResult(layer().db, {
        id: "ETR-2", runId: "ER-1", taskId: "T1", taskSnapshot: { taskId: "T1" }, status: "scored",
        overallScore: 9, maxScore: 10, categoryScores: [], evidence: [], deterministicSignals: [], followUps: [], createdAt: now, updatedAt: now,
      });
      const updated = await getEvalTaskResultByRunTask(layer().db, "ER-1", "T1");
      expect(updated?.overallScore).toBe(9); // upserted, not duplicated

      const evt = await appendEvalRunEvent(layer(), { id: "ERE-1", runId: "ER-1", type: "status_changed", message: "started" });
      expect(evt.seq).toBe(1);
      expect((await listEvalRunEvents(layer().db, "ER-1"))).toHaveLength(1);
    });

    // ── ExperimentSessionStore ──

    it("ExperimentSessionStore: create session → append record → list round-trip", async () => {
      const { createExperimentSession, getExperimentSession, appendExperimentRecord, listExperimentRecords } = await import("../../async-stores/async-experiment-session-store.js");
      const now = new Date().toISOString();
      const session = await createExperimentSession(layer().db, {
        id: "EXP-1", name: "Test", projectId: "P1", status: "active",
        metric: { name: "latency", direction: "minimize" }, currentSegment: 1,
        keptRunIds: [], tags: ["x"], createdAt: now, updatedAt: now,
      });
      expect(session.metric).toEqual({ name: "latency", direction: "minimize" });

      const fetched = await getExperimentSession(layer().db, "EXP-1");
      expect(fetched?.metric).toEqual({ name: "latency", direction: "minimize" });
      expect(fetched?.tags).toEqual(["x"]);

      const rec = await appendExperimentRecord(layer(), { id: "EXPR-1", sessionId: "EXP-1", segment: 1, type: "config", payload: { setting: "v" } });
      expect(rec.seq).toBe(1);
      const recs = await listExperimentRecords(layer().db, "EXP-1");
      expect(recs).toHaveLength(1);
    });

    // ── InsightStore ──

    it("InsightStore: create → upsert by fingerprint → list → run round-trip", async () => {
      const { createInsight, getInsight, upsertInsight, listInsights, createInsightRun, findActiveInsightRun } = await import("../../async-stores/async-insight-store.js");
      const now = new Date().toISOString();
      await createInsight(layer().db, {
        id: "INS-1", projectId: "P1", title: "Slow builds", content: "Builds are slow",
        category: "performance", status: "generated", fingerprint: "abc12345",
        provenance: { trigger: "manual" }, lastRunId: null, createdAt: now, updatedAt: now,
      });
      expect((await getInsight(layer().db, "INS-1"))?.title).toBe("Slow builds");

      // Upsert by fingerprint should update, not create
      const upserted = await upsertInsight(layer().db, "P1", { id: "INS-2", title: "Updated title", content: null, category: "performance", status: "confirmed", fingerprint: "abc12345", provenance: { trigger: "manual" } });
      expect(upserted.id).toBe("INS-1"); // preserved id
      expect(upserted.title).toBe("Updated title");
      expect((await listInsights(layer().db, { projectId: "P1" }))).toHaveLength(1);

      // Run
      await createInsightRun(layer().db, { id: "INSR-1", projectId: "P1", trigger: "schedule", createdAt: now });
      const active = await findActiveInsightRun(layer().db, "P1", "schedule");
      expect(active?.id).toBe("INSR-1");
    });

    // ── ResearchStore ──

    it("ResearchStore: create run → persist → append event → export round-trip", async () => {
      const { createResearchRun, getResearchRun, persistResearchRun, appendResearchRunEvent, listResearchRunEvents, createResearchExport, getResearchExports, getResearchStats } = await import("../../async-stores/async-research-store.js");
      const now = new Date().toISOString();
      const run = await createResearchRun(layer().db, {
        id: "RR-1", query: "best practices", topic: "testing", status: "queued", projectId: "P1",
        trigger: "manual", sources: [], events: [], tags: ["research"], lifecycle: { attempt: 1, maxAttempts: 3 },
        createdAt: now, updatedAt: now,
      });
      expect((await getResearchRun(layer().db, "RR-1"))?.query).toBe("best practices");

      // Persist update
      run.status = "running";
      run.startedAt = now;
      await persistResearchRun(layer().db, run);
      expect((await getResearchRun(layer().db, "RR-1"))?.status).toBe("running");

      await appendResearchRunEvent(layer(), { id: "REVT-1", runId: "RR-1", type: "status_changed", message: "started" });
      expect((await listResearchRunEvents(layer().db, "RR-1"))).toHaveLength(1);

      await createResearchExport(layer().db, { id: "REXP-1", runId: "RR-1", format: "markdown", content: "# Report", createdAt: now });
      expect((await getResearchExports(layer().db, "RR-1"))).toHaveLength(1);

      const stats = await getResearchStats(layer().db);
      expect(stats.total).toBe(1);
      expect(stats.byStatus.running).toBe(1);
    });

    // ── ChatStore ──

    it("ChatStore: session + messages + room + members + room messages round-trip", async () => {
      const { createChatSession, getChatSession, addChatMessage, getChatMessages, getLastMessageForSessions, createChatRoom, getChatRoom, addChatRoomMessage, getChatRoomMessages, clearChatRoomMessages } = await import("../../async-stores/async-chat-store.js");
      const now = new Date().toISOString();

      // Session + messages
      await createChatSession(layer().db, {
        id: "chat-1", agentId: "agent-1", title: "Test", status: "active", projectId: "P1",
        modelProvider: null, modelId: null, createdAt: now, updatedAt: now,
        cliSessionFile: null, inFlightGeneration: null, cliExecutorAdapterId: null,
      });
      expect((await getChatSession(layer().db, "chat-1"))?.agentId).toBe("agent-1");

      await addChatMessage(layer().db, { id: "msg-1", sessionId: "chat-1", role: "user", content: "Hi", thinkingOutput: null, metadata: { turn: 1 }, attachments: null, createdAt: now });
      await addChatMessage(layer().db, { id: "msg-2", sessionId: "chat-1", role: "assistant", content: "Hello!", thinkingOutput: null, metadata: null, attachments: null, createdAt: now });
      expect((await getChatMessages(layer().db, "chat-1"))).toHaveLength(2);

      const lastMsgs = await getLastMessageForSessions(layer().db, ["chat-1"]);
      expect(lastMsgs.get("chat-1")?.content).toBe("Hello!");

      // Room + members + room messages
      const { room, members } = await createChatRoom(layer(), {
        id: "room-1", name: "General", slug: "general", description: "General chat",
        projectId: "P1", createdBy: "agent-1", status: "active", createdAt: now, updatedAt: now,
      }, ["agent-1", "agent-2"]);
      expect(room.slug).toBe("general");
      expect(members).toHaveLength(2);
      expect((await getChatRoom(layer().db, "room-1"))?.name).toBe("General");

      await addChatRoomMessage(layer().db, { id: "rmsg-1", roomId: "room-1", role: "user", content: "Room hello", thinkingOutput: null, metadata: null, attachments: null, senderAgentId: "agent-1", mentions: ["agent-2"], createdAt: now });
      expect((await getChatRoomMessages(layer().db, "room-1"))).toHaveLength(1);

      /*
      FNXC:ChatPinned 2026-07-16-12:30:
      A pin must never survive archiving, and an archived session must reject a
      later pin request. The store's row lock makes these invariants hold when
      archive and pin requests overlap as well as in this serial regression case.
      */
      const chatStore = new (await import("../../chat/chat-store.js")).ChatStore(layer());
      const pinned = await chatStore.setSessionPinned("chat-1", true);
      expect(pinned?.pinnedAt).not.toBeNull();
      const archived = await chatStore.archiveSession("chat-1");
      expect(archived).toMatchObject({ status: "archived", pinnedAt: null });
      await expect(chatStore.setSessionPinned("chat-1", true)).rejects.toThrow("Archived conversations cannot be pinned");

      const cleared = await clearChatRoomMessages(layer().db, "room-1");
      expect(cleared).toBe(1);
    });

    // ── JSON round-trip parity (VAL-SCHEMA-004) ──

    it("JSON columns round-trip identical shape across all stores (VAL-SCHEMA-004)", async () => {
      const { createChatSession, getChatSession } = await import("../../async-stores/async-chat-store.js");
      const now = new Date().toISOString();
      const complexMetadata = { nested: { deep: [1, 2, { x: true }], null: null, str: "text" } };
      await createChatSession(layer().db, {
        id: "chat-json", agentId: "a", title: "JSON", status: "active", projectId: null,
        modelProvider: null, modelId: null, createdAt: now, updatedAt: now,
        cliSessionFile: null, inFlightGeneration: { provider: "openai", step: 3 }, cliExecutorAdapterId: null,
      });
      // Use addChatMessage to test metadata jsonb
      const { addChatMessage, getChatMessage } = await import("../../async-stores/async-chat-store.js");
      await addChatMessage(layer().db, { id: "msg-json", sessionId: "chat-json", role: "user", content: "x", thinkingOutput: null, metadata: complexMetadata, attachments: [{ type: "file", name: "test.txt" }], createdAt: now });
      const msg = await getChatMessage(layer().db, "msg-json");
      expect(msg?.metadata).toEqual(complexMetadata);
      expect(msg?.attachments).toEqual([{ type: "file", name: "test.txt" }]);

      const session = await getChatSession(layer().db, "chat-json");
      expect(session?.inFlightGeneration).toEqual({ provider: "openai", step: 3 });
    });
  });
});
