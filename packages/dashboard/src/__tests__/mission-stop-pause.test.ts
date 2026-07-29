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
});
