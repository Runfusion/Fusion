/*
FNXC:MissionRecovery 2026-07-19-15:30:
The synchronous MissionStore remains a supported transition surface even though
PostgreSQL owns persistence. Exercise its real transition method so the shared
feature-loop table cannot drift from AsyncMissionStore recovery behavior.
*/

import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db.js";
import { MissionStore } from "../mission-store.js";
import type { MissionFeature } from "../mission-types.js";

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
