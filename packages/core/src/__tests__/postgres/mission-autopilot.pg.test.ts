/**
 * FNXC:MissionStore 2026-06-28-12:50:
 * PostgreSQL integration coverage for the MissionAutopilot STORE-access + loop path.
 *
 * Mission autopilot was previously instanceof-gated OFF in PG backend mode because it
 * was coupled to the sync EventEmitter `MissionStore` and called its methods
 * synchronously. The autopilot now types its store as `MissionStore | AsyncMissionStore`
 * and `await`s every store call (mirrors the ResearchOrchestrator union+await port), so
 * its LOOP (watch missions, recompute statuses, detect completion, recover) runs against
 * the AsyncMissionStore-backed PG store and PERSISTS state through it.
 *
 * This drives the REAL engine MissionAutopilot (imported from engine SOURCE so it
 * reflects the current port, not a possibly-stale dist build) against embedded PG with
 * NO real AI / scheduler / network. Slice EXECUTION (creating tasks for the next slice)
 * is delegated to `scheduler.activateNextPendingSlice` and needs runtime providers — out
 * of scope here — so the autopilot is constructed WITHOUT a scheduler and only its
 * store-driven sub-operations are exercised. It asserts:
 *   - watchMission persists autopilotState="watching" through AsyncMissionStore, and
 *     getAutopilotStatus (now async) reflects enabled/state/watched.
 *   - checkMissionCompletion: marking the only feature done cascades slice→milestone→
 *     mission status, and the autopilot marks the mission `complete` + autopilotState
 *     `inactive`, persisted through AsyncMissionStore, and stops watching it.
 *   - recoverStaleMission runs the reconcile/recompute recover path without a scheduler
 *     and persists an `autopilot_stale` recovery mission event through the async store.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncMissionStore } from "../../async-stores/async-mission-store.js";
// Import the autopilot from engine SOURCE (not the @fusion/engine barrel, which resolves
// to a possibly-stale dist build) so this test exercises the current await-converted port.
import { MissionAutopilot } from "../../../../engine/src/mission-autopilot.js";

const pgTest = pgDescribe;

pgTest("Mission autopilot loop (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_mission_autopilot",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getMissionStore() returns AsyncMissionStore (async methods).
  const missions = (): AsyncMissionStore => h.store().getMissionStore() as AsyncMissionStore;

  // createMission hardcodes autopilotEnabled=false; enable it via updateMission so the
  // autopilot will actually watch the mission (watchMission early-returns otherwise).
  const createAutopilotMission = async (m: AsyncMissionStore, title: string) => {
    const mission = await m.createMission({ title });
    return m.updateMission(mission.id, { autopilotEnabled: true });
  };

  it("watchMission persists autopilotState through AsyncMissionStore and getAutopilotStatus reflects it", async () => {
    const m = missions();
    const mission = await createAutopilotMission(m, "Watched mission");
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    await m.addFeature(slice.id, { title: "F" });

    const autopilot = new MissionAutopilot(h.store(), m);

    await autopilot.watchMission(mission.id);
    expect(autopilot.isWatching(mission.id)).toBe(true);

    // State persisted through the async store (re-read independently).
    const persisted = await m.getMission(mission.id);
    expect(persisted?.autopilotState).toBe("watching");

    // getAutopilotStatus is now async and reads the mission through the union store.
    const status = await autopilot.getAutopilotStatus(mission.id);
    expect(status.enabled).toBe(true);
    expect(status.state).toBe("watching");
    expect(status.watched).toBe(true);
  });

  it("checkMissionCompletion marks the mission complete and persists state via AsyncMissionStore", async () => {
    const m = missions();
    const mission = await createAutopilotMission(m, "Completable mission");
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    const feature = await m.addFeature(slice.id, { title: "F" });

    const autopilot = new MissionAutopilot(h.store(), m);
    await autopilot.watchMission(mission.id);

    // Marking the only feature done cascades slice→milestone status via recompute.
    await m.updateFeatureStatus(feature.id, "done");
    const completedMilestone = await m.getMilestone(milestone.id);
    expect(completedMilestone?.status).toBe("complete");

    // The autopilot's store-driven completion path detects + persists completion.
    const complete = await autopilot.checkMissionCompletion(mission.id);
    expect(complete).toBe(true);

    // Mission state persisted through AsyncMissionStore; autopilot stops watching it.
    const finished = await m.getMission(mission.id);
    expect(finished?.status).toBe("complete");
    expect(finished?.autopilotState).toBe("inactive");
    expect(autopilot.isWatching(mission.id)).toBe(false);
  });

  it("recoverStaleMission runs the recover path (no scheduler) and persists a recovery event", async () => {
    const m = missions();
    const mission = await createAutopilotMission(m, "Stale mission");
    const milestone = await m.addMilestone(mission.id, { title: "MS" });
    const slice = await m.addSlice(milestone.id, { title: "SL" });
    await m.addFeature(slice.id, { title: "F" });

    const autopilot = new MissionAutopilot(h.store(), m);
    await autopilot.watchMission(mission.id);

    // Recover path: reconcile + recompute + (no-scheduler) advance. Must not throw and
    // must persist an autopilot_stale recovery event through the async store.
    await autopilot.recoverStaleMission(mission.id);

    const { events } = await m.getMissionEvents(mission.id, { eventType: "autopilot_stale" });
    expect(events.length).toBeGreaterThan(0);

    // Mission remains readable/consistent through AsyncMissionStore after recovery.
    const after = await m.getMission(mission.id);
    expect(after?.id).toBe(mission.id);
  });
});
