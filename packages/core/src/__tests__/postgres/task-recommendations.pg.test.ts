/*
FNXC:TaskRecommendations 2026-08-08-06:11:
Recommendations are completion records rather than task-local UI state. Exercise the PostgreSQL
TaskStore boundary so JSONB serialization, validation, and project-partitioned rows remain durable
across the same persistence path used after an executor exits.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { insertTaskRow } from "../../task-store/async/async-persistence.js";
import { TaskStore } from "../../store.js";

pgDescribe("TaskStore recommendation persistence (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_task_recommendations",
  });

  beforeAll(async () => {
    await h.beforeAll();
    // The shared golden template may have an old task shape despite a stamped migration marker.
    await applySchemaBaseline(h.adminDb());
  });
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("round-trips valid records and atomically rejects malformed or duplicate recommendation ids", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Persist structured completion recommendations." });
    const recommendations = [{
      id: "rec-export",
      title: "Add task export",
      description: "Offer CSV export as a separate task outside this completed scope.",
      category: "feature" as const,
    }];

    await store.updateTask(created.id, { recommendations });
    expect((await store.getTask(created.id))?.recommendations).toEqual(recommendations);

    const persisted = await h.adminDb()
      .select({ recommendations: schema.project.tasks.recommendations })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, h.layer().projectId ?? "__legacy_unscoped__"),
        eq(schema.project.tasks.id, created.id),
      ));
    expect(persisted).toEqual([{ recommendations }]);

    await expect(store.updateTask(created.id, {
      recommendations: [...recommendations, { ...recommendations[0] }],
    })).rejects.toThrow("unique ids");
    await expect(store.updateTask(created.id, {
      recommendations: [{ ...recommendations[0], category: "invalid" as never }],
    })).rejects.toThrow("invalid category");
    await expect(store.updateTask(created.id, {
      recommendations: [{ ...recommendations[0], description: "Run pnpm export before filing this follow-up." }],
    })).rejects.toThrow("executable commands");
    await expect(store.updateTask(created.id, {
      recommendations: [{ ...recommendations[0], description: "Run ls -la before filing this follow-up." }],
    })).rejects.toThrow("executable commands");
    await expect(store.updateTask(created.id, {
      recommendations: [{ ...recommendations[0], description: "Execute ./cleanup.sh before filing this follow-up." }],
    })).rejects.toThrow("executable commands");
    await expect(store.updateTask(created.id, {
      recommendations: [{ ...recommendations[0], reasoning: "Internal implementation deliberation." } as never],
    })).rejects.toThrow("may contain only");
    expect((await store.getTask(created.id))?.recommendations).toEqual(recommendations);
  });

  it("serializes recommendation links from independent stores without dropping sibling JSONB entries", async () => {
    const store = h.store();
    // A separate store models another dashboard process: it has no shared in-memory task lock.
    const otherStore = new TaskStore(h.rootDir(), h.globalDir(), { asyncLayer: h.layer() });
    const parent = await store.createTask({ description: "Complete work before creating recommendation children." });
    await store.updateTask(parent.id, { recommendations: [
      { id: "rec-a", title: "Add export", description: "Build export as a separate follow-up.", category: "feature" },
      { id: "rec-b", title: "Improve filters", description: "Build saved filters as a separate follow-up.", category: "improvement" },
    ] });

    await Promise.all([
      store.linkTaskRecommendation(parent.id, "rec-a", "FN-CHILD-A"),
      otherStore.linkTaskRecommendation(parent.id, "rec-b", "FN-CHILD-B"),
    ]);

    expect((await store.getTask(parent.id))?.recommendations).toEqual([
      { id: "rec-a", title: "Add export", description: "Build export as a separate follow-up.", category: "feature", createdTaskId: "FN-CHILD-A" },
      { id: "rec-b", title: "Improve filters", description: "Build saved filters as a separate follow-up.", category: "improvement", createdTaskId: "FN-CHILD-B" },
    ]);
  });

  /*
  FNXC:TaskRecommendations 2026-08-08-08:17:
  A route mutex is only an optimization; the durable proposal claim and parent-link mutation are
  the production at-most-once boundary across dashboard processes. Exercise both independent
  TaskStore instances together so a repeated recommendation click cannot create a second child
  or lose the first persisted link after a process restart.
  */
  it("creates one durable child and link when independent stores replay the same recommendation claim", async () => {
    const store = h.store();
    const otherStore = new TaskStore(h.rootDir(), h.globalDir(), { asyncLayer: h.layer() });
    const parent = await store.createTask({ description: "Complete work before creating recommendation children." });
    await store.updateTask(parent.id, {
      column: "done",
      recommendations: [{ id: "rec-a", title: "Add export", description: "Build export as a separate follow-up.", category: "feature" }],
    });
    const proposalClaimId = `recommendation:${parent.lineageId}:rec-a`;
    const childInput = {
      title: "Add export",
      description: "Build export as a separate follow-up.",
      proposalClaimId,
      source: {
        sourceType: "api" as const,
        sourceParentTaskId: parent.id,
        sourceMetadata: { recommendationId: "rec-a", recommendationCategory: "feature" },
      },
    };

    const [first, replay] = await Promise.all([
      store.createTask(childInput),
      otherStore.createTask(childInput),
    ]);
    expect(replay.id).toBe(first.id);

    await Promise.all([
      store.linkTaskRecommendation(parent.id, "rec-a", first.id),
      otherStore.linkTaskRecommendation(parent.id, "rec-a", replay.id),
    ]);

    const children = (await store.listTasks()).filter((item) => item.proposalClaimId === proposalClaimId);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      id: first.id,
      sourceParentTaskId: parent.id,
      sourceMetadata: { recommendationId: "rec-a" },
    });
    expect((await otherStore.getTask(parent.id))?.recommendations?.[0]?.createdTaskId).toBe(first.id);
  });

  it("rejects a recommendation link when the parent has reopened", async () => {
    const store = h.store();
    const parent = await store.createTask({ description: "Complete work before creating recommendation children." });
    await store.updateTask(parent.id, {
      column: "done",
      recommendations: [{ id: "rec-a", title: "Add export", description: "Build export as a separate follow-up.", category: "feature" }],
    });
    await store.updateTask(parent.id, { column: "todo" });

    await expect(store.linkTaskRecommendation(parent.id, "rec-a", "FN-CHILD-A", new Set(["done"])))
      .rejects.toThrow("completed tasks");
    expect((await store.getTask(parent.id))?.recommendations?.[0]?.createdTaskId).toBeUndefined();
  });

  it("keeps identical task ids and recommendation payloads isolated by project", async () => {
    const taskId = "FN-SAME";
    const recommendations = [{
      id: "rec-shared",
      title: "Add follow-up",
      description: "Project-specific follow-up that is safe to persist independently.",
      category: "improvement" as const,
    }];
    const projectA = { ...h.layer(), projectId: "recommendations-project-a" };
    const projectB = { ...h.layer(), projectId: "recommendations-project-b" };
    const baseTask = {
      id: taskId,
      description: "Same task id in distinct project partitions.",
      column: "done",
      currentStep: 0,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      recommendations,
    };

    await insertTaskRow(projectA, baseTask, { lineageId: "recommendations-a" });
    await insertTaskRow(projectB, baseTask, { lineageId: "recommendations-b" });

    const rows = await h.adminDb()
      .select({ projectId: schema.project.tasks.projectId, recommendations: schema.project.tasks.recommendations })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, taskId));
    expect(rows).toEqual(expect.arrayContaining([
      { projectId: "recommendations-project-a", recommendations },
      { projectId: "recommendations-project-b", recommendations },
    ]));
  });
});
