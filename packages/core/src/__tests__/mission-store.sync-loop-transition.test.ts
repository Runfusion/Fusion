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
