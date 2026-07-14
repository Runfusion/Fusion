/*
 * FNXC:RoadmapPostgresPersistence 2026-07-13-23:40:
 * Canonical PostgreSQL coverage exercises the full mutable hierarchy, lifecycle event parity, exports/handoffs, ownership validation, a populated second project, and safe upgrade behavior for pre-partition rows.
 */
import { expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { AsyncDataLayer } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../../packages/core/src/__test-utils__/pg-test-harness.js";
import { roadmapPluginSchemaInit } from "../../../../packages/core/src/postgres/plugin-schema-hook.js";
import { AsyncRoadmapStore } from "../store/async-roadmap-store.js";

function bind(layer: AsyncDataLayer, projectId: string): AsyncDataLayer {
  return { ...layer, projectId };
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * FNXC:RoadmapOrderingConcurrency 2026-07-14-00:43:
 * PostgreSQL ordering regressions coordinate at the advisory-lock query itself. The first caller holds its real transaction after acquiring the lock, while the second caller signals its lock attempt before PostgreSQL blocks it; this proves serialization without sleeps, polling, or timeout-based assertions.
 */
function controlledOrderingLayer(
  layer: AsyncDataLayer,
  mode: "hold-after-first-query" | "signal-first-query",
): {
  layer: AsyncDataLayer;
  reached: Promise<void>;
  release: () => void;
} {
  const reached = deferred();
  const release = deferred();
  let firstTransaction = true;
  const controlled = {
    ...layer,
    transactionImmediate: async <T>(
      fn: Parameters<AsyncDataLayer["transactionImmediate"]>[0],
      options?: Parameters<AsyncDataLayer["transactionImmediate"]>[1],
    ): Promise<T> => layer.transactionImmediate(async (tx) => {
      if (!firstTransaction)
        return fn(tx) as Promise<T>;
      firstTransaction = false;
      let firstQuery = true;
      const proxy = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "execute")
            return Reflect.get(target, property, receiver);
          return async (...args: Parameters<typeof tx.execute>) => {
            if (!firstQuery)
              return tx.execute(...args);
            firstQuery = false;
            if (mode === "signal-first-query") {
              reached.resolve();
              return tx.execute(...args);
            }
            const result = await tx.execute(...args);
            reached.resolve();
            await release.promise;
            return result;
          };
        },
      });
      return fn(proxy) as Promise<T>;
    }, options),
  } as AsyncDataLayer;
  return { layer: controlled, reached: reached.promise, release: release.resolve };
}

pgDescribe("AsyncRoadmapStore", () => {
  it("serializes concurrent milestone appends at the roadmap lock", async () => {
    const h = await createTaskStoreForTest({
      prefix: "roadmap_milestone_create_concurrency",
    });
    try {
      const setup = new AsyncRoadmapStore(bind(h.layer, "project-a"));
      const roadmap = await setup.createRoadmap({
        title: "Concurrent milestone creates",
      });
      const firstControl = controlledOrderingLayer(
        bind(h.layer, "project-a"),
        "hold-after-first-query",
      );
      const secondControl = controlledOrderingLayer(
        bind(h.layer, "project-a"),
        "signal-first-query",
      );
      const first = new AsyncRoadmapStore(firstControl.layer);
      const second = new AsyncRoadmapStore(secondControl.layer);

      const firstCreate = first.createMilestone(roadmap.id, { title: "First" });
      await firstControl.reached;
      const secondCreate = second.createMilestone(roadmap.id, {
        title: "Second",
      });
      await secondControl.reached;
      firstControl.release();
      await Promise.all([firstCreate, secondCreate]);

      expect(
        (await setup.listMilestones(roadmap.id)).map(
          (item) => item.orderIndex,
        ),
      ).toEqual([0, 1]);
    } finally {
      await h.teardown();
    }
  });

  it("serializes concurrent feature appends at the roadmap lock", async () => {
    const h = await createTaskStoreForTest({
      prefix: "roadmap_feature_create_concurrency",
    });
    try {
      const setup = new AsyncRoadmapStore(bind(h.layer, "project-a"));
      const roadmap = await setup.createRoadmap({
        title: "Concurrent feature creates",
      });
      const milestone = await setup.createMilestone(roadmap.id, {
        title: "Milestone",
      });
      const firstControl = controlledOrderingLayer(
        bind(h.layer, "project-a"),
        "hold-after-first-query",
      );
      const secondControl = controlledOrderingLayer(
        bind(h.layer, "project-a"),
        "signal-first-query",
      );
      const first = new AsyncRoadmapStore(firstControl.layer);
      const second = new AsyncRoadmapStore(secondControl.layer);

      const firstCreate = first.createFeature(milestone.id, { title: "First" });
      await firstControl.reached;
      const secondCreate = second.createFeature(milestone.id, {
        title: "Second",
      });
      await secondControl.reached;
      firstControl.release();
      await Promise.all([firstCreate, secondCreate]);

      expect(
        (await setup.listFeatures(milestone.id)).map(
          (item) => item.orderIndex,
        ),
      ).toEqual([0, 1]);
    } finally {
      await h.teardown();
    }
  });

  /*
   * FNXC:RoadmapOrderingConcurrency 2026-07-14-01:24:
   * Deterministic PostgreSQL races cover create/create and create/reorder surfaces. A reorder queued behind an append must validate against the committed hierarchy and reject an obsolete client order instead of erasing the append's position.
   */
  it("revalidates a feature reorder after a concurrent append commits", async () => {
    const h = await createTaskStoreForTest({
      prefix: "roadmap_create_reorder_concurrency",
    });
    try {
      const setup = new AsyncRoadmapStore(bind(h.layer, "project-a"));
      const roadmap = await setup.createRoadmap({ title: "Create then reorder" });
      const milestone = await setup.createMilestone(roadmap.id, {
        title: "Milestone",
      });
      const alpha = await setup.createFeature(milestone.id, { title: "Alpha" });
      const firstControl = controlledOrderingLayer(
        bind(h.layer, "project-a"),
        "hold-after-first-query",
      );
      const secondControl = controlledOrderingLayer(
        bind(h.layer, "project-a"),
        "signal-first-query",
      );
      const creator = new AsyncRoadmapStore(firstControl.layer);
      const reorderer = new AsyncRoadmapStore(secondControl.layer);

      const create = creator.createFeature(milestone.id, { title: "Beta" });
      await firstControl.reached;
      const reorder = reorderer.reorderFeatures({
        roadmapId: roadmap.id,
        milestoneId: milestone.id,
        orderedFeatureIds: [alpha.id],
      });
      await secondControl.reached;
      firstControl.release();
      const beta = await create;
      await expect(reorder).rejects.toThrow(
        "Expected 2 feature ids but received 1",
      );

      expect((await setup.listFeatures(milestone.id)).map((item) => item.id)).toEqual([
        alpha.id,
        beta.id,
      ]);
    } finally {
      await h.teardown();
    }
  });

  it("serializes concurrent feature moves against the committed roadmap ordering", async () => {
    const h = await createTaskStoreForTest({ prefix: "roadmap_move_concurrency" });
    try {
      const setup = new AsyncRoadmapStore(bind(h.layer, "project-a"));
      const roadmap = await setup.createRoadmap({ title: "Concurrent moves" });
      const source = await setup.createMilestone(roadmap.id, { title: "Source" });
      const target = await setup.createMilestone(roadmap.id, { title: "Target" });
      const alpha = await setup.createFeature(source.id, { title: "Alpha" });
      const beta = await setup.createFeature(source.id, { title: "Beta" });
      const gamma = await setup.createFeature(source.id, { title: "Gamma" });
      const delta = await setup.createFeature(target.id, { title: "Delta" });
      const firstControl = controlledOrderingLayer(bind(h.layer, "project-a"), "hold-after-first-query");
      const secondControl = controlledOrderingLayer(bind(h.layer, "project-a"), "signal-first-query");
      const first = new AsyncRoadmapStore(firstControl.layer);
      const second = new AsyncRoadmapStore(secondControl.layer);

      const firstMove = first.moveFeature({
        roadmapId: roadmap.id,
        featureId: gamma.id,
        fromMilestoneId: source.id,
        toMilestoneId: target.id,
        targetOrderIndex: 0,
      });
      await firstControl.reached;
      const secondMove = second.moveFeature({
        roadmapId: roadmap.id,
        featureId: beta.id,
        fromMilestoneId: source.id,
        toMilestoneId: target.id,
        targetOrderIndex: 0,
      });
      await secondControl.reached;
      firstControl.release();
      await Promise.all([firstMove, secondMove]);

      expect((await setup.listFeatures(source.id)).map((item) => item.id)).toEqual([alpha.id]);
      expect((await setup.listFeatures(target.id)).map((item) => item.id)).toEqual([
        beta.id,
        gamma.id,
        delta.id,
      ]);
    } finally {
      await h.teardown();
    }
  });

  it("revalidates a feature reorder after a concurrent move commits", async () => {
    const h = await createTaskStoreForTest({ prefix: "roadmap_reorder_concurrency" });
    try {
      const setup = new AsyncRoadmapStore(bind(h.layer, "project-a"));
      const roadmap = await setup.createRoadmap({ title: "Concurrent reorder" });
      const source = await setup.createMilestone(roadmap.id, { title: "Source" });
      const target = await setup.createMilestone(roadmap.id, { title: "Target" });
      const alpha = await setup.createFeature(source.id, { title: "Alpha" });
      const beta = await setup.createFeature(source.id, { title: "Beta" });
      const gamma = await setup.createFeature(source.id, { title: "Gamma" });
      const firstControl = controlledOrderingLayer(bind(h.layer, "project-a"), "hold-after-first-query");
      const secondControl = controlledOrderingLayer(bind(h.layer, "project-a"), "signal-first-query");
      const mover = new AsyncRoadmapStore(firstControl.layer);
      const reorderer = new AsyncRoadmapStore(secondControl.layer);

      const move = mover.moveFeature({
        roadmapId: roadmap.id,
        featureId: beta.id,
        fromMilestoneId: source.id,
        toMilestoneId: target.id,
        targetOrderIndex: 0,
      });
      await firstControl.reached;
      const reorder = reorderer.reorderFeatures({
        roadmapId: roadmap.id,
        milestoneId: source.id,
        orderedFeatureIds: [gamma.id, beta.id, alpha.id],
      });
      await secondControl.reached;
      firstControl.release();
      await move;
      await expect(reorder).rejects.toThrow("Expected 2 feature ids but received 3");

      expect((await setup.listFeatures(source.id)).map((item) => item.id)).toEqual([
        alpha.id,
        gamma.id,
      ]);
      expect((await setup.listFeatures(target.id)).map((item) => item.id)).toEqual([beta.id]);
    } finally {
      await h.teardown();
    }
  });

  it("preserves CRUD, ordering, move, handoff, event, and project-isolation invariants", async () => {
    const h = await createTaskStoreForTest({ prefix: "roadmap_store" });
    try {
      const storeA = new AsyncRoadmapStore(bind(h.layer, "project-a"));
      const storeB = new AsyncRoadmapStore(bind(h.layer, "project-b"));
      const events = {
        roadmapUpdated: vi.fn(),
        milestoneCreated: vi.fn(),
        milestoneUpdated: vi.fn(),
        milestoneDeleted: vi.fn(),
        milestoneReordered: vi.fn(),
        featureCreated: vi.fn(),
        featureUpdated: vi.fn(),
        featureDeleted: vi.fn(),
        featureReordered: vi.fn(),
        featureMoved: vi.fn(),
      };
      storeA.on("roadmap:updated", events.roadmapUpdated);
      storeA.on("milestone:created", events.milestoneCreated);
      storeA.on("milestone:updated", events.milestoneUpdated);
      storeA.on("milestone:deleted", events.milestoneDeleted);
      storeA.on("milestone:reordered", events.milestoneReordered);
      storeA.on("feature:created", events.featureCreated);
      storeA.on("feature:updated", events.featureUpdated);
      storeA.on("feature:deleted", events.featureDeleted);
      storeA.on("feature:reordered", events.featureReordered);
      storeA.on("feature:moved", events.featureMoved);

      const roadmap = await storeA.createRoadmap({ title: "A" });
      const otherRoadmap = await storeA.createRoadmap({ title: "Other" });
      const first = await storeA.createMilestone(roadmap.id, { title: "First" });
      const second = await storeA.createMilestone(roadmap.id, { title: "Second" });
      const foreign = await storeA.createMilestone(otherRoadmap.id, { title: "Foreign" });
      const alpha = await storeA.createFeature(first.id, { title: "Alpha" });
      const beta = await storeA.createFeature(first.id, { title: "Beta" });

      await expect(storeA.moveFeature({
        roadmapId: roadmap.id,
        featureId: alpha.id,
        fromMilestoneId: first.id,
        toMilestoneId: foreign.id,
        targetOrderIndex: 0,
      })).rejects.toThrow("cannot move across roadmaps");
      expect((await storeA.getFeature(alpha.id))?.milestoneId).toBe(first.id);

      await storeA.updateRoadmap(roadmap.id, { title: "A updated" });
      await storeA.updateMilestone(first.id, { title: "First updated" });
      await storeA.updateFeature(alpha.id, { title: "Alpha updated" });
      expect((await storeA.reorderMilestones({
        roadmapId: roadmap.id,
        orderedMilestoneIds: [second.id, first.id],
      })).map((item) => item.id)).toEqual([second.id, first.id]);
      expect((await storeA.reorderFeatures({
        roadmapId: roadmap.id,
        milestoneId: first.id,
        orderedFeatureIds: [beta.id, alpha.id],
      })).map((item) => item.id)).toEqual([beta.id, alpha.id]);

      await storeA.moveFeature({
        roadmapId: roadmap.id,
        featureId: alpha.id,
        fromMilestoneId: first.id,
        toMilestoneId: second.id,
        targetOrderIndex: 0,
      });
      expect((await storeA.getFeature(alpha.id))?.milestoneId).toBe(second.id);

      const hierarchy = await storeA.getRoadmapWithHierarchy(roadmap.id);
      expect(hierarchy?.milestones.flatMap((item) => item.features).map((item) => item.id).sort()).toEqual([alpha.id, beta.id].sort());
      expect((await storeA.getRoadmapExport(roadmap.id)).features).toHaveLength(2);
      expect((await storeA.getMissionPlanningHandoff(roadmap.id)).milestones).toHaveLength(2);
      expect((await storeA.getRoadmapFeatureHandoff(roadmap.id, second.id, alpha.id)).source.featureId).toBe(alpha.id);
      expect(await storeA.listFeatureTaskPlanningHandoffs(roadmap.id)).toHaveLength(2);

      const roadmapB = await storeB.createRoadmap({ title: "B" });
      const milestoneB = await storeB.createMilestone(roadmapB.id, { title: "B milestone" });
      await storeB.createFeature(milestoneB.id, { title: "B feature" });
      expect((await storeB.getRoadmapWithHierarchy(roadmapB.id))?.milestones[0]?.features).toHaveLength(1);
      expect(await storeB.getRoadmap(roadmap.id)).toBeUndefined();
      expect((await storeA.listRoadmaps()).map((item) => item.id)).not.toContain(roadmapB.id);

      await storeA.deleteFeature(beta.id);
      await storeA.deleteMilestone(first.id);
      await storeA.deleteRoadmap(otherRoadmap.id);
      expect(events.roadmapUpdated).toHaveBeenCalledTimes(1);
      expect(events.milestoneCreated).toHaveBeenCalledTimes(3);
      expect(events.milestoneUpdated).toHaveBeenCalledTimes(1);
      expect(events.milestoneDeleted).toHaveBeenCalledWith(first.id);
      expect(events.milestoneReordered).toHaveBeenCalledTimes(1);
      expect(events.featureCreated).toHaveBeenCalledTimes(2);
      expect(events.featureUpdated).toHaveBeenCalledTimes(1);
      expect(events.featureDeleted).toHaveBeenCalledWith(expect.objectContaining({ id: beta.id }));
      expect(events.featureReordered).toHaveBeenCalledTimes(1);
      expect(events.featureMoved).toHaveBeenCalledWith(expect.objectContaining({
        feature: expect.objectContaining({ id: alpha.id, milestoneId: second.id }),
        fromMilestoneId: first.id,
        toMilestoneId: second.id,
      }));
    } finally {
      await h.teardown();
    }
  });

  it("backfills a pre-project hierarchy only when one registered owner exists", async () => {
    const h = await createTaskStoreForTest({ prefix: "roadmap_upgrade_single" });
    try {
      await h.adminDb.execute(sql.raw(`
        ALTER TABLE project.roadmap_features ALTER COLUMN project_id DROP NOT NULL;
        ALTER TABLE project.roadmap_milestones ALTER COLUMN project_id DROP NOT NULL;
        ALTER TABLE project.roadmaps ALTER COLUMN project_id DROP NOT NULL;
        INSERT INTO central.projects(id, name, path, created_at, updated_at)
          VALUES ('project-only', 'Only', '/only', '2026-07-13', '2026-07-13');
        INSERT INTO project.roadmaps(id, project_id, title, created_at, updated_at)
          VALUES ('RM-OLD', NULL, 'Old', '2026-07-13', '2026-07-13');
        INSERT INTO project.roadmap_milestones(id, project_id, roadmap_id, title, order_index, created_at, updated_at)
          VALUES ('RMS-OLD', NULL, 'RM-OLD', 'Old milestone', 0, '2026-07-13', '2026-07-13');
        INSERT INTO project.roadmap_features(id, project_id, milestone_id, title, order_index, created_at, updated_at)
          VALUES ('RF-OLD', NULL, 'RMS-OLD', 'Old feature', 0, '2026-07-13', '2026-07-13');
      `));

      await roadmapPluginSchemaInit.init(h.adminDb);
      const ownership = await h.adminDb.execute(sql.raw(`
        SELECT project_id FROM project.roadmaps WHERE id='RM-OLD'
        UNION ALL SELECT project_id FROM project.roadmap_milestones WHERE id='RMS-OLD'
        UNION ALL SELECT project_id FROM project.roadmap_features WHERE id='RF-OLD'
      `)) as unknown as Array<{ project_id: string }>;
      expect(ownership.map((row) => row.project_id)).toEqual([
        "project-only",
        "project-only",
        "project-only",
      ]);
      const nullable = await h.adminDb.execute(sql.raw(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema='project'
          AND table_name IN ('roadmaps','roadmap_milestones','roadmap_features')
          AND column_name='project_id'
      `)) as unknown as Array<{ is_nullable: string }>;
      expect(nullable.every((row) => row.is_nullable === "NO")).toBe(true);
    } finally {
      await h.teardown();
    }
  });

  it("fails closed when pre-project Roadmap ownership is ambiguous", async () => {
    const h = await createTaskStoreForTest({ prefix: "roadmap_upgrade_ambiguous" });
    try {
      await h.adminDb.execute(sql.raw(`
        ALTER TABLE project.roadmaps ALTER COLUMN project_id DROP NOT NULL;
        INSERT INTO central.projects(id, name, path, created_at, updated_at) VALUES
          ('project-a', 'A', '/a', '2026-07-13', '2026-07-13'),
          ('project-b', 'B', '/b', '2026-07-13', '2026-07-13');
        INSERT INTO project.roadmaps(id, project_id, title, created_at, updated_at)
          VALUES ('RM-AMBIGUOUS', NULL, 'Ambiguous', '2026-07-13', '2026-07-13');
      `));

      let failure: unknown;
      try {
        await roadmapPluginSchemaInit.init(h.adminDb);
      } catch (error) {
        failure = error;
      }
      expect(errorChain(failure)).toContain(
        "cannot assign 1 pre-project row(s) across 2 registered projects",
      );
    } finally {
      await h.teardown();
    }
  });
});
