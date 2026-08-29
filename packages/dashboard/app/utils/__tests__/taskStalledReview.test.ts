import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";

import { getStalledReviewSignal } from "../taskStalledReview";

describe("getStalledReviewSignal", () => {
  it("returns task.stalledReview when present", () => {
    const task = { stalledReview: { reason: "x", heuristic: "reenqueue-churn", matchCount: 3, firstMatchAt: "a", lastMatchAt: "b" } } as Task;
    expect(getStalledReviewSignal(task)?.heuristic).toBe("reenqueue-churn");
  });

  it("returns undefined when stalledReview is absent", () => {
    const task = {} as Task;
    expect(getStalledReviewSignal(task)).toBeUndefined();
  });
});
