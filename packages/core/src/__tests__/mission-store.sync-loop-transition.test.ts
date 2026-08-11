/*
FNXC:MissionRecovery 2026-07-19-15:30:
The synchronous MissionStore remains a supported transition surface even though
PostgreSQL owns persistence. Exercise its real transition method so the shared
feature-loop table cannot drift from AsyncMissionStore recovery behavior.
*/

import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/db.js";
import { MissionStore } from "../missions/mission-store.js";
import type { MissionFeature } from "../missions/mission-types.js";

describe("MissionStore synchronous loop transitions", () => {
  it("allows startup recovery to move an interrupted validation back to implementing", () => {
    const db = {
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
      bumpLastModified: vi.fn(),
    } as unknown as Database;
    const store = new MissionStore("/tmp/fusion-mission-store-test", db);
    const feature: MissionFeature = {
      id: "F-RECOVERY",
      sliceId: "SL-RECOVERY",
      title: "Interrupted validation",
      status: "in-progress",
      loopState: "validating",
      implementationAttemptCount: 1,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    };

    vi.spyOn(store, "getFeature").mockReturnValue(feature);
    const updateFeature = vi.spyOn(store, "updateFeature").mockImplementation((_id, updates) => ({
      ...feature,
      ...updates,
    }));

    expect(store.transitionLoopState(feature.id, "implementing")).toMatchObject({
      id: feature.id,
      loopState: "implementing",
    });
    expect(updateFeature).toHaveBeenCalledWith(feature.id, { loopState: "implementing" });
  });

  it("records a superseded validator completion without overwriting the replacement owner", () => {
    const db = {
      transaction: (callback: () => void) => callback(),
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined), run: vi.fn() }),
      bumpLastModified: vi.fn(),
    } as unknown as Database;
    const store = new MissionStore("/tmp/fusion-mission-store-test", db);
    const run = {
      id: "VR-OLD", featureId: "F-RECOVERY", milestoneId: "MS-1", sliceId: "SL-1",
      status: "running", implementationAttempt: 0, validatorAttempt: 1,
      startedAt: "2026-08-10T00:00:00.000Z", createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
    } as const;
    const completed = { ...run, status: "failed" as const, completedAt: "2026-08-11T00:00:00.000Z" };
    const feature = {
      id: run.featureId, sliceId: run.sliceId, title: "Owned by replacement", status: "in-progress",
      loopState: "validating", lastValidatorRunId: "VR-NEW",
      createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
    } as MissionFeature;
    vi.spyOn(store, "getValidatorRun").mockReturnValueOnce(run).mockReturnValue(completed);
    vi.spyOn(store, "getFeature").mockReturnValue(feature);
    const updateFeature = vi.spyOn(store, "updateFeature");

    expect(store.completeValidatorRun(run.id, "failed")).toEqual(completed);
    expect(updateFeature).not.toHaveBeenCalled();
  });
});

describe("MissionStore serial slice admission", () => {
  it("makes a sequential duplicate callback a no-op before events or triage", async () => {
    let status: "pending" | "active" = "pending";
    const db = {
      transaction: (callback: () => void) => callback(),
      prepare: vi.fn(() => ({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(() => {
          if (status !== "pending") return { changes: 0 };
          status = "active";
          return { changes: 1 };
        }),
      })),
      bumpLastModified: vi.fn(),
    } as unknown as Database;
    const store = new MissionStore("/tmp/fusion-mission-store-test", db);
    const slice = {
      id: "SL-ONE",
      milestoneId: "MS-ONE",
      title: "Only eligible slice",
      status,
      orderIndex: 0,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    } as const;
    vi.spyOn(store, "getMissionWithHierarchy").mockImplementation(() => ({
      id: "M-ONE",
      status: "active",
      milestones: [{ id: "MS-ONE", status: "planning", orderIndex: 0, dependencies: [], slices: [{ ...slice, status, features: [] }] }],
    }) as never);
    vi.spyOn(store, "getMilestone").mockReturnValue({ id: "MS-ONE", missionId: "M-ONE" } as never);
    vi.spyOn(store, "getMission").mockReturnValue({ id: "M-ONE", autopilotEnabled: false, autoAdvance: false } as never);
    vi.spyOn(store as any, "recomputeMilestoneStatus").mockImplementation(() => undefined);
    const activated = vi.fn();
    store.on("slice:activated", activated);

    expect((await store.tryActivateNextPendingSlice("M-ONE"))?.id).toBe("SL-ONE");
    expect(await store.tryActivateNextPendingSlice("M-ONE")).toBeUndefined();
    expect(activated).toHaveBeenCalledTimes(1);
  });
});

describe("MissionStore synchronous assertion schema compatibility", () => {
  it("adds scope and origin before querying legacy assertion rows", () => {
    const executed: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue(sql.startsWith("PRAGMA table_info") ? [
          { name: "id" },
          { name: "milestoneId" },
          { name: "assertion" },
        ] : []),
        run: vi.fn(() => executed.push(sql)),
      })),
      bumpLastModified: vi.fn(),
    } as unknown as Database;

    new MissionStore("/tmp/fusion-mission-store-test", db);

    expect(executed).toEqual(expect.arrayContaining([
      expect.stringContaining("ADD COLUMN scope"),
      expect.stringContaining("ADD COLUMN origin"),
      expect.stringContaining("SET scope = 'feature'"),
      expect.stringContaining("SET origin = 'authored'"),
    ]));
  });
});

describe("MissionStore derived milestone assertion invariant", () => {
  it("rejects a second canonical derived assertion before sync insertion", () => {
    const db = {
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
      bumpLastModified: vi.fn(),
    } as unknown as Database;
    const store = new MissionStore("/tmp/fusion-mission-store-test", db);
    vi.spyOn(store, "getMilestone").mockReturnValue({ id: "MS-1" } as never);
    vi.spyOn(store, "listContractAssertions").mockReturnValue([{
      id: "CA-DERIVED",
      milestoneId: "MS-1",
      scope: "milestone",
      origin: "derived_milestone_acceptance",
    } as never]);
    (db.prepare as unknown as ReturnType<typeof vi.fn>).mockClear();

    expect(() => store.addContractAssertion("MS-1", {
      title: "Canonical milestone criteria",
      assertion: "Parent contract",
      scope: "milestone",
      origin: "derived_milestone_acceptance",
    })).toThrow("already has a derived milestone acceptance assertion");
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
