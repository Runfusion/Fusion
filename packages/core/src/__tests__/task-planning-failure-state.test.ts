import { describe, expect, it } from "vitest";
import { SCHEMA_BASELINE_VERSION, TASK_PLANNING_FAILURE_VERSION } from "../postgres/schema-applier.js";
import { TASK_COLUMN_DESCRIPTOR_BY_COLUMN, type TaskRow } from "../task-store/persistence.js";
import { rowToTask } from "../task-store/serialization.js";
import type { Task } from "../types.js";

function taskFixture(planningFailure?: Task["planningFailure"]): Task {
  return {
    id: "FN-9273", title: "Planning failure", description: "", priority: "normal", column: "todo",
    currentStep: 0, steps: [], dependencies: [], log: [], createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z", planningFailure,
  } as Task;
}

function rowFixture(planningFailure: string | null): TaskRow {
  return {
    id: "FN-9273", lineageId: null, title: "Planning failure", description: "", priority: "normal",
    column: "todo", status: null, currentStep: 0, createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z", dependencies: "[]", steps: "[]", log: "[]", planningFailure,
  } as TaskRow;
}

describe("planning failure persistence", () => {
  it("round-trips engine-owned planning evidence without workflow custom fields", () => {
    const planningFailure = {
      specLockUnavailable: { sourceHash: "hash", reason: "section-duplicate", sections: ["mission"], at: "2026-09-07T00:00:00.000Z", attempt: 1 },
      lifecycleLockTransport: { message: "transport unavailable", at: "2026-09-07T00:00:01.000Z", attempt: 2 },
    };
    const serialized = TASK_COLUMN_DESCRIPTOR_BY_COLUMN.get("planningFailure")!.serialize(taskFixture(planningFailure), { lineageId: "lineage" });
    expect(rowToTask(rowFixture(serialized as string)).planningFailure).toEqual(planningFailure);
    expect(rowToTask(rowFixture(null)).planningFailure).toBeUndefined();
  });

  it("keeps migration 0072's immutable identity while later baselines advance", () => {
    expect(TASK_PLANNING_FAILURE_VERSION).toBe("0072");
    expect(Number(SCHEMA_BASELINE_VERSION)).toBeGreaterThanOrEqual(72);
  });
});
