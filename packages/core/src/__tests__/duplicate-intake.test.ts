import { describe, expect, it, vi } from "vitest";

import { findSameAgentDuplicates, flagSameAgentDuplicate } from "../duplicate-intake.js";
import type { TaskStore } from "../store.js";

describe("findSameAgentDuplicates", () => {
  const nowMs = Date.now();

  it("returns same-agent high-similarity match within window", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck in secrets sync", description: "promisify scrypt causes typecheck error" },
      [{
        id: "FN-1",
        title: "Fix typecheck in secrets sync",
        description: "promisify scrypt causes typecheck error",
        column: "todo",
        createdAt: nowMs - 60 * 60 * 1000,
        sourceAgentId: "agent-x",
      }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches[0]?.id).toBe("FN-1");
  });

  it("filters out entries older than 24h", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "todo", createdAt: nowMs - 25 * 60 * 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("filters out candidates with no shared caller identity", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "todo", createdAt: nowMs - 60 * 1000, sourceAgentId: null }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("filters archived candidates via duplicate matcher defaults", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "archived", createdAt: nowMs - 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("respects threshold", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix parser", description: "parse errors on sync job" },
      [{ id: "FN-1", title: "Refactor dashboard layout", description: "button spacing and css", column: "todo", createdAt: nowMs - 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("matches siblings sharing the same parent task even when sourceAgentId differs", () => {
    const matches = findSameAgentDuplicates(
      {
        title: "Add structured run-audit event for lane selection",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        sourceParentTaskId: "FN-5206",
      },
      [{
        id: "FN-5544",
        title: "Add structured run-audit event for per-lane provider/runtime selection",
        description: "Emit run-audit event recording per-lane provider/runtime selection",
        column: "triage",
        createdAt: nowMs - 5 * 60 * 1000,
        sourceAgentId: "different-agent",
        sourceParentTaskId: "FN-5206",
      }],
      { nowMs, sourceAgentId: "calling-agent" },
    );
    expect(matches[0]?.id).toBe("FN-5544");
  });

  it("does not match sibling with different parent task", () => {
    const matches = findSameAgentDuplicates(
      {
        title: "Add structured run-audit event",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        sourceParentTaskId: "FN-5206",
      },
      [{
        id: "FN-5544",
        title: "Add structured run-audit event",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        column: "triage",
        createdAt: nowMs - 5 * 60 * 1000,
        sourceAgentId: "agent-x",
        sourceParentTaskId: "FN-OTHER",
      }],
      { nowMs, sourceAgentId: "agent-y" },
    );
    expect(matches).toEqual([]);
  });

  it("falls back to sourceAgentId match when parent is unset", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "promisify scrypt causes typecheck error" },
      [{
        id: "FN-1",
        title: "Fix typecheck",
        description: "promisify scrypt causes typecheck error",
        column: "todo",
        createdAt: nowMs - 60 * 60 * 1000,
        sourceAgentId: "agent-x",
        sourceParentTaskId: null,
      }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches[0]?.id).toBe("FN-1");
  });
});

describe("flagSameAgentDuplicate (FN-7658)", () => {
  function createMockStore() {
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const recordActivity = vi.fn().mockResolvedValue(undefined);
    const updateTask = vi.fn().mockResolvedValue(undefined);
    return {
      store: { logEntry, recordActivity, updateTask } as unknown as TaskStore,
      logEntry,
      recordActivity,
      updateTask,
    };
  }

  it("logs, records a flag-only activity, and sets the near-duplicate marker without moving the task", async () => {
    const { store, logEntry, recordActivity, updateTask } = createMockStore();

    await flagSameAgentDuplicate(store, "FN-2", ["FN-1"], { "FN-1": 0.9 });

    expect(logEntry).toHaveBeenCalledTimes(1);
    expect(logEntry.mock.calls[0]?.[0]).toBe("FN-2");

    expect(recordActivity).toHaveBeenCalledTimes(1);
    const activity = recordActivity.mock.calls[0]?.[0];
    expect(activity).toMatchObject({
      type: "task:auto-archived-duplicate",
      taskId: "FN-2",
      metadata: { siblingTaskIds: ["FN-1"], scores: { "FN-1": 0.9 }, source: "same-agent-flagged" },
    });

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith("FN-2", {
      sourceMetadataPatch: { nearDuplicateOf: "FN-1", nearDuplicateScore: 0.9 },
    });

    // Must NOT call moveTask — flagSameAgentDuplicate leaves the task's column alone.
    expect((store as unknown as { moveTask?: unknown }).moveTask).toBeUndefined();
  });

  it("picks the first sibling id as the canonical near-duplicate marker", async () => {
    const { store, updateTask } = createMockStore();

    await flagSameAgentDuplicate(store, "FN-3", ["FN-1", "FN-2"], { "FN-1": 0.8, "FN-2": 0.95 });

    expect(updateTask).toHaveBeenCalledWith("FN-3", {
      sourceMetadataPatch: { nearDuplicateOf: "FN-1", nearDuplicateScore: 0.8 },
    });
  });
});
