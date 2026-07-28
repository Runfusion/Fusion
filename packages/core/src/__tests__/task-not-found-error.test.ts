/*
FNXC:TaskLookup404 2026-07-26-12:40:
Guards the two contracts the dashboard 404 mapping depends on:
1. `TaskNotFoundError.message` stays byte-identical to the legacy
   `Task ${id} not found` string, so message-matching callers/tests still work
   after the switch from a bare `Error`.
2. `isTaskNotFoundError` is structural, so the guard survives a duplicated
   `@fusion/core` module instance (bundled CLI vs workspace dist) and errors that
   crossed a serialization boundary — an `instanceof`-only check would silently
   regress those callers back to 500.
*/
import { describe, it, expect } from "vitest";
import { TaskNotFoundError, isTaskNotFoundError } from "../task-store/errors.js";

describe("TaskNotFoundError", () => {
  it("keeps the legacy `Task <id> not found` message byte-identical", () => {
    expect(new TaskNotFoundError("FN-8610").message).toBe("Task FN-8610 not found");
  });

  it("carries the task id and a stable code/name", () => {
    const err = new TaskNotFoundError("FN-8610");
    expect(err.taskId).toBe("FN-8610");
    expect(err.name).toBe("TaskNotFoundError");
    expect(err.code).toBe("TASK_NOT_FOUND");
  });

  it("recognizes its own instances", () => {
    expect(isTaskNotFoundError(new TaskNotFoundError("FN-1"))).toBe(true);
  });

  it("recognizes a structurally equivalent error from a duplicate module instance", () => {
    const cloned = Object.assign(new Error("Task FN-1 not found"), {
      name: "TaskNotFoundError",
      code: "TASK_NOT_FOUND",
      taskId: "FN-1",
    });
    expect(isTaskNotFoundError(cloned)).toBe(true);
  });

  it("does not match unrelated errors, including same-message bare Errors from other layers", () => {
    expect(isTaskNotFoundError(new Error("Task FN-1 not found"))).toBe(false);
    expect(isTaskNotFoundError(new Error("connection terminated unexpectedly"))).toBe(false);
    expect(isTaskNotFoundError(undefined)).toBe(false);
    expect(isTaskNotFoundError("Task FN-1 not found")).toBe(false);
  });
});
