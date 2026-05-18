import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import type { TaskStore } from "../store.js";

describe("TaskStore reliability aggregations", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  const insertActivity = (entry: {
    id: string;
    timestamp: string;
    type: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
  }) => {
    (store as any).db
      .prepare(
        `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.timestamp,
        entry.type,
        entry.taskId ?? null,
        null,
        "test",
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      );
  };

  it("returns empty results when no rows match", async () => {
    const counts = await store.getTaskMovedCountsByDay({
      since: "2026-05-10T00:00:00.000Z",
      until: "2026-05-20T00:00:00.000Z",
      toColumn: "in-review",
    });
    const durationEvents = await store.getInReviewDurationEvents({
      since: "2026-05-10T00:00:00.000Z",
      until: "2026-05-20T00:00:00.000Z",
    });
    const mergedTaskIds = await store.getTaskMergedTaskIds({
      since: "2026-05-10T00:00:00.000Z",
      until: "2026-05-20T00:00:00.000Z",
    });

    expect(counts).toEqual({});
    expect(durationEvents).toEqual([]);
    expect(mergedTaskIds).toEqual(new Set());
  });

  it("aggregates task:moved rows by day with from/to filters", async () => {
    insertActivity({
      id: "a1",
      timestamp: "2026-05-16T10:00:00.000Z",
      type: "task:moved",
      taskId: "FN-1",
      metadata: { from: "todo", to: "in-review" },
    });
    insertActivity({
      id: "a2",
      timestamp: "2026-05-16T12:00:00.000Z",
      type: "task:moved",
      taskId: "FN-2",
      metadata: { from: "todo", to: "in-review" },
    });
    insertActivity({
      id: "a3",
      timestamp: "2026-05-17T09:00:00.000Z",
      type: "task:moved",
      taskId: "FN-3",
      metadata: { from: "in-review", to: "in-progress" },
    });

    const entered = await store.getTaskMovedCountsByDay({
      since: "2026-05-15T00:00:00.000Z",
      until: "2026-05-18T00:00:00.000Z",
      toColumn: "in-review",
    });
    const bounced = await store.getTaskMovedCountsByDay({
      since: "2026-05-15T00:00:00.000Z",
      until: "2026-05-18T00:00:00.000Z",
      fromColumn: "in-review",
      toColumn: "in-progress",
    });

    expect(entered).toEqual({ "2026-05-16": 2 });
    expect(bounced).toEqual({ "2026-05-17": 1 });
  });

  it("uses strict since and inclusive until boundaries", async () => {
    insertActivity({
      id: "b1",
      timestamp: "2026-05-16T00:00:00.000Z",
      type: "task:moved",
      taskId: "FN-1",
      metadata: { from: "todo", to: "in-review" },
    });
    insertActivity({
      id: "b2",
      timestamp: "2026-05-16T00:00:00.001Z",
      type: "task:moved",
      taskId: "FN-2",
      metadata: { from: "todo", to: "in-review" },
    });

    const counts = await store.getTaskMovedCountsByDay({
      since: "2026-05-16T00:00:00.000Z",
      until: "2026-05-16T00:00:00.001Z",
      toColumn: "in-review",
    });

    expect(counts).toEqual({ "2026-05-16": 1 });
  });

  it("returns focused in-review duration event set ordered ascending", async () => {
    insertActivity({
      id: "d1",
      timestamp: "2026-05-16T10:00:00.000Z",
      type: "task:moved",
      taskId: "FN-1",
      metadata: { from: "todo", to: "in-review" },
    });
    insertActivity({
      id: "d2",
      timestamp: "2026-05-16T11:00:00.000Z",
      type: "task:moved",
      taskId: "FN-1",
      metadata: { from: "in-review", to: "done" },
    });
    insertActivity({
      id: "d3",
      timestamp: "2026-05-16T12:00:00.000Z",
      type: "task:moved",
      taskId: "FN-1",
      metadata: { from: "in-review", to: "in-progress" },
    });

    const events = await store.getInReviewDurationEvents({
      since: "2026-05-16T09:00:00.000Z",
      until: "2026-05-16T13:00:00.000Z",
    });

    expect(events.map((event) => event.id)).toEqual(["d1", "d2"]);
  });

  it("returns distinct merged task ids in window", async () => {
    insertActivity({ id: "m1", timestamp: "2026-05-16T10:00:00.000Z", type: "task:merged", taskId: "FN-1" });
    insertActivity({ id: "m2", timestamp: "2026-05-16T11:00:00.000Z", type: "task:merged", taskId: "FN-1" });
    insertActivity({ id: "m3", timestamp: "2026-05-16T12:00:00.000Z", type: "task:merged", taskId: "FN-2" });

    const mergedTaskIds = await store.getTaskMergedTaskIds({
      since: "2026-05-16T09:00:00.000Z",
      until: "2026-05-16T12:00:00.000Z",
    });

    expect(mergedTaskIds).toEqual(new Set(["FN-1", "FN-2"]));
  });

  it("aggregates correctly with 60k+ rows", async () => {
    const insert = (store as any).db.prepare(
      `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
       VALUES (?, ?, 'task:moved', ?, NULL, 'bulk', ?)`,
    );

    for (let i = 0; i < 60_100; i += 1) {
      const day = i < 100 ? "2026-05-15" : "2026-05-16";
      insert.run(`bulk-${i}`, `${day}T12:00:00.000Z`, `FN-${i}`, JSON.stringify({ from: "todo", to: "in-review" }));
    }

    const counts = await store.getTaskMovedCountsByDay({
      since: "2026-05-14T00:00:00.000Z",
      until: "2026-05-17T00:00:00.000Z",
      toColumn: "in-review",
    });

    expect(counts).toEqual({
      "2026-05-15": 100,
      "2026-05-16": 60_000,
    });
  });
});
