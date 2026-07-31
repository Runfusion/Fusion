/**
 * FNXC:PostgresMigrationCoverage 2026-07-13-22:54:
 * The PostgreSQL cutover must preserve the activity log's best-effort write contract, structured metadata, newest-first filtering, bounded reads, and explicit clearing. These are live operator-facing audit invariants formerly asserted only by the removed SQLite TaskStore suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";

pgDescribe("activity log parity (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_activity_parity",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("records TaskStore lifecycle events after backend initialization", async () => {
    const store = h.store();

    expect(store.activityListenersWired).toBe(true);
    for (const event of [
      "task:created",
      "task:moved",
      "task:merged",
      "task:updated",
      "task:deleted",
      "settings:updated",
    ] as const) {
      expect(store.listenerCount(event), `${event} activity listener`).toBeGreaterThan(0);
    }

    const task = await store.createTask({
      title: "Backend lifecycle activity",
      description: "Verify PostgreSQL lifecycle activity logging",
    });
    await store.moveTask(task.id, "in-progress", { moveSource: "user" });

    await vi.waitFor(async () => {
      const entries = await store.getActivityLog({ limit: 10 });
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "task:created",
          taskId: task.id,
          taskTitle: task.title,
        }),
        expect.objectContaining({
          type: "task:moved",
          taskId: task.id,
          // FNXC:MergedPlanningColumn 2026-07-29-15:25 (U11): the default lineage's first column
          // is now `todo`, so the first recorded transition leaves it rather than `triage`.
          metadata: { from: "todo", to: "in-progress" },
        }),
      ]));
    });
  });

  it("keeps failed writes best-effort so audit storage cannot break product operations", async () => {
    const layer = h.layer();
    const insert = vi.spyOn(layer.db, "insert").mockImplementation(() => {
      throw new Error("activity insert failed");
    });

    try {
      await expect(
        h.store().recordActivity({
          type: "task:created",
          taskId: "FN-404",
          taskTitle: "Resilient operation",
          details: "Create event",
          metadata: { source: "test" },
        }),
      ).resolves.toMatchObject({
        type: "task:created",
        taskId: "FN-404",
        metadata: { source: "test" },
      });
      expect(await h.store().getActivityLog()).toEqual([]);
    } finally {
      insert.mockRestore();
    }
  });

  it("filters by timestamp and type, orders newest first, applies a limit, and clears", async () => {
    const store = h.store();
    const first = await store.recordActivity({
      type: "task:created",
      taskId: "FN-001",
      taskTitle: "First task",
      details: "Created",
    });
    const moved = await store.recordActivity({
      type: "task:moved",
      taskId: "FN-001",
      taskTitle: "First task",
      details: "Moved",
      metadata: { from: "todo", to: "in-progress" },
    });
    const latest = await store.recordActivity({
      type: "task:created",
      taskId: "FN-002",
      taskTitle: "Second task",
      details: "Created later",
    });
    await h.adminDb().insert(schema.project.activityLog).values({
      projectId: "other-project",
      id: "other-project-event",
      timestamp: "2026-07-13T20:03:00.000Z",
      type: "task:created",
      taskId: "FN-OTHER",
      details: "Must remain isolated",
    });

    await h.adminDb().update(schema.project.activityLog).set({ timestamp: "2026-07-13T20:00:00.000Z" }).where(eq(schema.project.activityLog.id, first.id));
    await h.adminDb().update(schema.project.activityLog).set({ timestamp: "2026-07-13T20:01:00.000Z" }).where(eq(schema.project.activityLog.id, moved.id));
    await h.adminDb().update(schema.project.activityLog).set({ timestamp: "2026-07-13T20:02:00.000Z" }).where(eq(schema.project.activityLog.id, latest.id));

    expect((await h.adminDb().select({ projectId: schema.project.activityLog.projectId, id: schema.project.activityLog.id }).from(schema.project.activityLog))
      .filter((row) => row.id !== "other-project-event"))
      .toEqual(expect.arrayContaining([
        { projectId: h.layer().projectId ?? "__legacy_unscoped__", id: first.id },
        { projectId: h.layer().projectId ?? "__legacy_unscoped__", id: moved.id },
        { projectId: h.layer().projectId ?? "__legacy_unscoped__", id: latest.id },
      ]));

    expect((await store.getActivityLog({ limit: 2 })).map((event) => event.taskId)).toEqual([
      "FN-002",
      "FN-001",
    ]);
    const movedEvents = await store.getActivityLog({ type: "task:moved" });
    expect(movedEvents).toHaveLength(1);
    expect(movedEvents[0]?.metadata).toEqual({ from: "todo", to: "in-progress" });
    expect((await store.getActivityLog({ since: "2026-07-13T20:01:30.000Z" })).map((event) => event.taskId)).toEqual(["FN-002"]);

    await store.clearActivityLog();
    expect(await store.getActivityLog()).toEqual([]);
    const otherProject = await h.adminDb()
      .select({ id: schema.project.activityLog.id })
      .from(schema.project.activityLog)
      .where(eq(schema.project.activityLog.projectId, "other-project"));
    expect(otherProject).toEqual([{ id: "other-project-event" }]);
  });

  it("serves reliability duration and merged-task metrics without accessing SQLite", async () => {
    const store = h.store();
    const projectId = h.layer().projectId ?? "__legacy_unscoped__";
    await h.adminDb().insert(schema.project.activityLog).values([
      {
        projectId,
        id: "reliability-entered",
        timestamp: "2026-07-14T20:01:00.000Z",
        type: "task:moved",
        taskId: "FN-REL-1",
        details: "Entered review",
        metadata: { from: "in-progress", to: "in-review" },
      },
      {
        projectId,
        id: "reliability-done",
        timestamp: "2026-07-14T20:02:00.000Z",
        type: "task:moved",
        taskId: "FN-REL-1",
        details: "Completed review",
        metadata: { from: "in-review", to: "done" },
      },
      {
        projectId,
        id: "reliability-merged",
        timestamp: "2026-07-14T20:03:00.000Z",
        type: "task:merged",
        taskId: "FN-REL-1",
        details: "Merged",
      },
      {
        projectId: "other-project",
        id: "reliability-other-project",
        timestamp: "2026-07-14T20:04:00.000Z",
        type: "task:merged",
        taskId: "FN-REL-OTHER",
        details: "Must stay isolated",
      },
    ]);

    const window = { since: "2026-07-14T20:00:00.000Z", until: "2026-07-14T20:05:00.000Z" };
    const durationEvents = await store.getInReviewDurationEvents(window);
    expect(durationEvents.map((event) => event.id)).toEqual(["reliability-entered", "reliability-done"]);
    expect(await store.getTaskMergedTaskIds(window)).toEqual(new Set(["FN-REL-1"]));
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-22:15:
  THE INVARIANT: the duration query reads the board's OWN review and complete lanes.

  The predicate had `in-review` and `done` baked into a `sql` template — the one place neither the
  lifecycle census (which scans comparisons) nor the unwired-lane-parameter guard (which scans
  declarations) can see them. So this was the Reliability panel's LAST blind input after #2861 fixed
  the two counts beside it, and the panel read as partially healthy: entries and bounces populated,
  duration reporting `no-in-review-entries` forever. Partial blindness is harder to spot than total.

  A REAL PostgreSQL row set on purpose. This is a SQL predicate change; a mocked store would assert
  the arguments and prove nothing about the query that actually runs, which is the whole risk when
  the literal lives inside `sql`.

  The legacy-lane case above stays green in the same file, which is the compatibility half: the union
  covers move records written under the OLD id as well as the new one, and a past move recorded the
  name as it was at the time.

  REVERT PROOF, measured: restore the hardcoded `= 'in-review'` / `= 'done'` fragments and this fails
  with `expected [] to deeply equal [ 'renamed-entered', 'renamed-done' ]`.
  */
  it("finds duration events on a board whose review and complete lanes are renamed", async () => {
    const store = h.store();
    /* Same derivation as the rest of this file: the tasks/activity tables partition on the
       `__legacy_unscoped__` sentinel when the layer carries no project id, so asserting `!` here
       would write `projectId: undefined` on an unscoped harness and the query would match nothing.
       I hit exactly that in #2886 and fixed it there; this one happened to work, which is worse. */
    const projectId = h.layer().projectId ?? "__legacy_unscoped__";
    await store.createWorkflowDefinition({
      name: "Renamed review and complete",
      ir: {
        version: "v2",
        name: "Renamed review and complete",
        columns: [
          { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
          { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [
          { id: "start", kind: "start", column: "building" },
          { id: "end", kind: "end", column: "shipped" },
        ],
        edges: [{ from: "start", to: "end", condition: "success" }],
      } as never,
    });

    await h.adminDb().insert(schema.project.activityLog).values([
      {
        projectId,
        id: "renamed-entered",
        timestamp: "2026-07-15T20:01:00.000Z",
        type: "task:moved",
        taskId: "FN-REN-1",
        details: "Entered sign-off",
        metadata: { from: "building", to: "signoff" },
      },
      {
        projectId,
        id: "renamed-done",
        timestamp: "2026-07-15T20:02:00.000Z",
        type: "task:moved",
        taskId: "FN-REN-1",
        details: "Shipped",
        metadata: { from: "signoff", to: "shipped" },
      },
      {
        projectId,
        id: "renamed-unrelated",
        timestamp: "2026-07-15T20:03:00.000Z",
        type: "task:moved",
        taskId: "FN-REN-1",
        details: "Not a review transition",
        metadata: { from: "building", to: "building" },
      },
    ]);

    const events = await store.getInReviewDurationEvents({
      since: "2026-07-15T20:00:00.000Z",
      until: "2026-07-15T20:05:00.000Z",
    });

    expect(events.map((event) => event.id)).toEqual(["renamed-entered", "renamed-done"]);
  });
});
