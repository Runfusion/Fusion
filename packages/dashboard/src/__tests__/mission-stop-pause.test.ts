import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { pauseMissionTasksForOperatorStop } from "../mission-routes.js";

describe("pauseMissionTasksForOperatorStop", () => {
  it("durably marks every linked mission task as user-paused", async () => {
    const pauseTask = vi.fn().mockResolvedValue(undefined);
    const store = { pauseTask } as unknown as TaskStore;
    const hierarchy = {
      milestones: [
        {
          slices: [
            {
              features: [
                { taskId: "FN-001" },
                {},
                { taskId: "FN-002" },
              ],
            },
          ],
        },
      ],
    };

    await expect(pauseMissionTasksForOperatorStop(store, hierarchy)).resolves.toEqual([
      "FN-001",
      "FN-002",
    ]);
    expect(pauseTask).toHaveBeenNthCalledWith(1, "FN-001", true, undefined, { userPaused: true });
    expect(pauseTask).toHaveBeenNthCalledWith(2, "FN-002", true, undefined, { userPaused: true });
  });

  it("continues after one linked task can no longer be paused", async () => {
    const pauseTask = vi.fn()
      .mockRejectedValueOnce(new Error("task not found"))
      .mockResolvedValueOnce(undefined);
    const store = { pauseTask } as unknown as TaskStore;
    const hierarchy = {
      milestones: [{ slices: [{ features: [{ taskId: "FN-gone" }, { taskId: "FN-live" }] }] }],
    };

    await expect(pauseMissionTasksForOperatorStop(store, hierarchy)).resolves.toEqual(["FN-live"]);
    expect(pauseTask).toHaveBeenNthCalledWith(1, "FN-gone", true, undefined, { userPaused: true });
    expect(pauseTask).toHaveBeenNthCalledWith(2, "FN-live", true, undefined, { userPaused: true });
  });
});
