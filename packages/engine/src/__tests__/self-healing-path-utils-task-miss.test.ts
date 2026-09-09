import { TaskDeletedError, TaskNotFoundError, type Task } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import { isMissingTaskLookupError, readLinkedTaskOrUndefined } from "../healing/self-healing-path-utils.js";

describe("isMissingTaskLookupError", () => {
  it("recognizes typed and structural task lookup misses across task-id prefixes", () => {
    expect(isMissingTaskLookupError(new TaskNotFoundError("ERR-024"))).toBe(true);
    expect(isMissingTaskLookupError({ name: "TaskNotFoundError", code: "TASK_NOT_FOUND" })).toBe(true);
    expect(isMissingTaskLookupError(new TaskDeletedError("KB-1", "2026-08-10T00:00:00.000Z"))).toBe(true);
    expect(isMissingTaskLookupError({ name: "TaskDeletedError" })).toBe(true);
    expect(isMissingTaskLookupError(new Error("Task ERR-024 not found"))).toBe(true);
  });

  it("rejects unrelated, non-error values", () => {
    expect(isMissingTaskLookupError(new Error("connection terminated unexpectedly"))).toBe(false);
    expect(isMissingTaskLookupError(undefined)).toBe(false);
    expect(isMissingTaskLookupError("Task ERR-024 not found")).toBe(false);
  });
});

describe("readLinkedTaskOrUndefined", () => {
  it("preserves resolved active and completed tasks", async () => {
    const live = { id: "FN-1", column: "todo" } as Task;
    const completed = { id: "FN-2", column: "done" } as Task;
    const getTask = vi.fn()
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce(completed);
    const store = { getTask } as any;

    await expect(readLinkedTaskOrUndefined(store, "FN-1")).resolves.toBe(live);
    await expect(readLinkedTaskOrUndefined(store, "FN-2")).resolves.toBe(completed);
  });

  it("normalizes nullable and throwing task misses", async () => {
    const getTask = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new TaskNotFoundError("ERR-024"));
    const store = { getTask } as any;

    await expect(readLinkedTaskOrUndefined(store, "FN-1")).resolves.toBeUndefined();
    await expect(readLinkedTaskOrUndefined(store, "ERR-024")).resolves.toBeUndefined();
  });

  it("rethrows transient lookup failures", async () => {
    const error = new Error("connection terminated unexpectedly");
    const store = { getTask: vi.fn().mockRejectedValue(error) } as any;

    await expect(readLinkedTaskOrUndefined(store, "FN-1")).rejects.toBe(error);
  });
});
