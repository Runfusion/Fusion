import { EventEmitter } from "node:events";
import type { AsyncDataLayer } from "@fusion/core";
import { sql } from "drizzle-orm";
/* FNXC:RoadmapPostgresPersistence 2026-07-13-23:42: Import SQL construction from Drizzle directly because bundled plugins resolve @fusion/core through a restricted runtime shim that intentionally exposes types and plugin APIs, not database query builders. */
import type { RoadmapStoreEvents } from "./roadmap-store.js";
import type {
  Roadmap,
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestone,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeature,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapMilestoneReorderInput,
  RoadmapFeatureReorderInput,
  RoadmapFeatureMoveInput,
  RoadmapWithHierarchy,
  RoadmapExportBundle,
  RoadmapMissionPlanningHandoff,
  RoadmapFeatureTaskPlanningHandoff,
} from "../roadmap-types.js";
import {
  applyRoadmapFeatureReorder,
  applyRoadmapMilestoneReorder,
  moveRoadmapFeature,
} from "./roadmap-ordering.js";

type RoadmapRow = {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};
type MilestoneRow = {
  id: string;
  roadmap_id: string;
  title: string;
  description: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
};
type FeatureRow = {
  id: string;
  milestone_id: string;
  title: string;
  description: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
};

function nextOrderIndex(items: ReadonlyArray<{ orderIndex: number }>): number {
  return items.length === 0
    ? 0
    : Math.max(...items.map((item) => item.orderIndex)) + 1;
}

/**
 * FNXC:RoadmapPostgresPersistence 2026-07-13-22:37:
 * Roadmap routes in backend mode must use the bound AsyncDataLayer. Every read and mutation is scoped by project_id because all project plugins share the same PostgreSQL schema.
 */
export class AsyncRoadmapStore extends EventEmitter<RoadmapStoreEvents> {
  private sequence = 0;
  private readonly projectId: string;
  constructor(private readonly layer: AsyncDataLayer) {
    super();
    this.setMaxListeners(50);
    if (!layer.projectId)
      throw new Error(
        "Roadmap PostgreSQL persistence requires a project-bound data layer",
      );
    this.projectId = layer.projectId;
  }
  private id(prefix: "RM" | "RMS" | "RF"): string {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${(this.sequence++).toString(36).toUpperCase().padStart(4, "0")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }
  private roadmap(row: RoadmapRow): Roadmap {
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private milestone(row: MilestoneRow): RoadmapMilestone {
    return {
      id: row.id,
      roadmapId: row.roadmap_id,
      title: row.title,
      description: row.description ?? undefined,
      orderIndex: row.order_index,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private feature(row: FeatureRow): RoadmapFeature {
    return {
      id: row.id,
      milestoneId: row.milestone_id,
      title: row.title,
      description: row.description ?? undefined,
      orderIndex: row.order_index,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createRoadmap(input: RoadmapCreateInput): Promise<Roadmap> {
    const now = new Date().toISOString();
    const roadmap: Roadmap = {
      id: this.id("RM"),
      title: input.title,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
    await this.layer.db.execute(
      sql`INSERT INTO project.roadmaps(id, project_id, title, description, created_at, updated_at) VALUES(${roadmap.id}, ${this.projectId}, ${roadmap.title}, ${roadmap.description ?? null}, ${now}, ${now})`,
    );
    this.emit("roadmap:created", roadmap);
    return roadmap;
  }
  async getRoadmap(id: string): Promise<Roadmap | undefined> {
    const rows = (await this.layer.db.execute(
      sql`SELECT * FROM project.roadmaps WHERE project_id=${this.projectId} AND id=${id} LIMIT 1`,
    )) as unknown as RoadmapRow[];
    return rows[0] ? this.roadmap(rows[0]) : undefined;
  }
  async listRoadmaps(): Promise<Roadmap[]> {
    const rows = (await this.layer.db.execute(
      sql`SELECT * FROM project.roadmaps WHERE project_id=${this.projectId} ORDER BY created_at DESC, id`,
    )) as unknown as RoadmapRow[];
    return rows.map((r) => this.roadmap(r));
  }
  async updateRoadmap(
    id: string,
    updates: RoadmapUpdateInput,
  ): Promise<Roadmap> {
    const old = await this.getRoadmap(id);
    if (!old) throw new Error(`Roadmap ${id} not found`);
    const next = {
      ...old,
      ...updates,
      id,
      createdAt: old.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.layer.db.execute(
      sql`UPDATE project.roadmaps SET title=${next.title}, description=${next.description ?? null}, updated_at=${next.updatedAt} WHERE project_id=${this.projectId} AND id=${id}`,
    );
    this.emit("roadmap:updated", next);
    return next;
  }
  async deleteRoadmap(id: string): Promise<void> {
    await this.layer.transactionImmediate(async (tx) => {
      /*
       * FNXC:RoadmapOrderingConcurrency 2026-07-14-01:32:
       * Deleting a roadmap cascades through its entire ordered hierarchy, so it must serialize with create, reorder, move, and child delete operations. Holding the roadmap lock through existence validation and cascade prevents a concurrent ordering mutation from returning or emitting a hierarchy that the delete removed mid-transaction.
       */
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:roadmap-order:${this.projectId}:${id}`}, 0))`,
      );
      const rows = (await tx.execute(
        sql`SELECT * FROM project.roadmaps WHERE project_id=${this.projectId} AND id=${id} LIMIT 1`,
      )) as unknown as RoadmapRow[];
      if (!rows[0]) throw new Error(`Roadmap ${id} not found`);
      await tx.execute(
        sql`DELETE FROM project.roadmaps WHERE project_id=${this.projectId} AND id=${id}`,
      );
    });
    this.emit("roadmap:deleted", id);
  }

  async createMilestone(
    roadmapId: string,
    input: RoadmapMilestoneCreateInput,
  ): Promise<RoadmapMilestone> {
    const milestone = await this.layer.transactionImmediate(async (tx) => {
      /*
       * FNXC:RoadmapOrderingConcurrency 2026-07-14-01:24:
       * Appending a milestone is an ordering mutation. It must hold the same project-and-roadmap transaction lock as reorder and move from the existence check through the insert, so concurrent creates cannot choose the same order index and a reorder cannot overwrite a newly appended item from a stale hierarchy snapshot.
       */
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:roadmap-order:${this.projectId}:${roadmapId}`}, 0))`,
      );
      const roadmapRows = (await tx.execute(
        sql`SELECT * FROM project.roadmaps WHERE project_id=${this.projectId} AND id=${roadmapId} LIMIT 1`,
      )) as unknown as RoadmapRow[];
      if (!roadmapRows[0]) throw new Error(`Roadmap ${roadmapId} not found`);
      const rows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND roadmap_id=${roadmapId} ORDER BY order_index, created_at, id`,
      )) as unknown as MilestoneRow[];
      const now = new Date().toISOString();
      const created: RoadmapMilestone = {
        id: this.id("RMS"),
        roadmapId,
        title: input.title,
        description: input.description,
        orderIndex: nextOrderIndex(rows.map((row) => this.milestone(row))),
        createdAt: now,
        updatedAt: now,
      };
      await tx.execute(
        sql`INSERT INTO project.roadmap_milestones(id, project_id, roadmap_id, title, description, order_index, created_at, updated_at) VALUES(${created.id}, ${this.projectId}, ${roadmapId}, ${created.title}, ${created.description ?? null}, ${created.orderIndex}, ${now}, ${now})`,
      );
      return created;
    });
    this.emit("milestone:created", milestone);
    return milestone;
  }
  async getMilestone(id: string): Promise<RoadmapMilestone | undefined> {
    const rows = (await this.layer.db.execute(
      sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND id=${id} LIMIT 1`,
    )) as unknown as MilestoneRow[];
    return rows[0] ? this.milestone(rows[0]) : undefined;
  }
  async listMilestones(roadmapId: string): Promise<RoadmapMilestone[]> {
    const rows = (await this.layer.db.execute(
      sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND roadmap_id=${roadmapId} ORDER BY order_index, created_at, id`,
    )) as unknown as MilestoneRow[];
    return rows.map((r) => this.milestone(r));
  }
  async updateMilestone(
    id: string,
    updates: RoadmapMilestoneUpdateInput,
  ): Promise<RoadmapMilestone> {
    const old = await this.getMilestone(id);
    if (!old) throw new Error(`Milestone ${id} not found`);
    const next = {
      ...old,
      ...updates,
      id,
      roadmapId: old.roadmapId,
      createdAt: old.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.layer.db.execute(
      sql`UPDATE project.roadmap_milestones SET title=${next.title}, description=${next.description ?? null}, updated_at=${next.updatedAt} WHERE project_id=${this.projectId} AND id=${id}`,
    );
    this.emit("milestone:updated", next);
    return next;
  }
  async deleteMilestone(id: string): Promise<void> {
    const candidate = await this.getMilestone(id);
    if (!candidate)
      throw new Error(`Milestone ${id} not found`);
    await this.layer.transactionImmediate(async (tx) => {
      /*
       * FNXC:RoadmapOrderingConcurrency 2026-07-14-01:32:
       * Milestone deletion is a destructive roadmap-order mutation. Revalidate and cascade-delete it under the shared roadmap lock so a queued reorder observes the committed removal rather than persisting a stale pre-delete list. Deletion intentionally preserves SQLite parity by leaving sibling order indexes unchanged until an explicit reorder normalizes them.
       */
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:roadmap-order:${this.projectId}:${candidate.roadmapId}`}, 0))`,
      );
      const rows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND id=${id} LIMIT 1`,
      )) as unknown as MilestoneRow[];
      const milestone = rows[0] ? this.milestone(rows[0]) : undefined;
      if (!milestone) throw new Error(`Milestone ${id} not found`);
      if (milestone.roadmapId !== candidate.roadmapId)
        throw new Error(`Milestone ${id} changed roadmaps`);
      await tx.execute(
        sql`DELETE FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND id=${id}`,
      );
    });
    this.emit("milestone:deleted", id);
  }

  async createFeature(
    milestoneId: string,
    input: RoadmapFeatureCreateInput,
  ): Promise<RoadmapFeature> {
    const candidateMilestone = await this.getMilestone(milestoneId);
    if (!candidateMilestone)
      throw new Error(`Milestone ${milestoneId} not found`);
    const feature = await this.layer.transactionImmediate(async (tx) => {
      /*
       * FNXC:RoadmapOrderingConcurrency 2026-07-14-01:24:
       * Feature appends share the roadmap ordering lock with create, reorder, and move. The milestone and sibling list are authoritative only after this lock is held, and the append stays in that transaction through commit.
       */
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:roadmap-order:${this.projectId}:${candidateMilestone.roadmapId}`}, 0))`,
      );
      const milestoneRows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND id=${milestoneId} LIMIT 1`,
      )) as unknown as MilestoneRow[];
      const milestone = milestoneRows[0]
        ? this.milestone(milestoneRows[0])
        : undefined;
      if (!milestone) throw new Error(`Milestone ${milestoneId} not found`);
      if (milestone.roadmapId !== candidateMilestone.roadmapId)
        throw new Error(`Milestone ${milestoneId} changed roadmaps`);
      const rows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_features WHERE project_id=${this.projectId} AND milestone_id=${milestoneId} ORDER BY order_index, created_at, id`,
      )) as unknown as FeatureRow[];
      const now = new Date().toISOString();
      const created: RoadmapFeature = {
        id: this.id("RF"),
        milestoneId,
        title: input.title,
        description: input.description,
        orderIndex: nextOrderIndex(rows.map((row) => this.feature(row))),
        createdAt: now,
        updatedAt: now,
      };
      await tx.execute(
        sql`INSERT INTO project.roadmap_features(id, project_id, milestone_id, title, description, order_index, created_at, updated_at) VALUES(${created.id}, ${this.projectId}, ${milestoneId}, ${created.title}, ${created.description ?? null}, ${created.orderIndex}, ${now}, ${now})`,
      );
      return created;
    });
    this.emit("feature:created", feature);
    return feature;
  }
  async getFeature(id: string): Promise<RoadmapFeature | undefined> {
    const rows = (await this.layer.db.execute(
      sql`SELECT * FROM project.roadmap_features WHERE project_id=${this.projectId} AND id=${id} LIMIT 1`,
    )) as unknown as FeatureRow[];
    return rows[0] ? this.feature(rows[0]) : undefined;
  }
  async listFeatures(milestoneId: string): Promise<RoadmapFeature[]> {
    const rows = (await this.layer.db.execute(
      sql`SELECT * FROM project.roadmap_features WHERE project_id=${this.projectId} AND milestone_id=${milestoneId} ORDER BY order_index, created_at, id`,
    )) as unknown as FeatureRow[];
    return rows.map((r) => this.feature(r));
  }
  async updateFeature(
    id: string,
    updates: RoadmapFeatureUpdateInput,
  ): Promise<RoadmapFeature> {
    const old = await this.getFeature(id);
    if (!old) throw new Error(`Feature ${id} not found`);
    const next = {
      ...old,
      ...updates,
      id,
      milestoneId: old.milestoneId,
      createdAt: old.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.layer.db.execute(
      sql`UPDATE project.roadmap_features SET title=${next.title}, description=${next.description ?? null}, updated_at=${next.updatedAt} WHERE project_id=${this.projectId} AND id=${id}`,
    );
    this.emit("feature:updated", next);
    return next;
  }
  async deleteFeature(id: string): Promise<void> {
    const candidate = await this.getFeature(id);
    if (!candidate)
      throw new Error(`Feature ${id} not found`);
    const candidateMilestone = await this.getMilestone(candidate.milestoneId);
    if (!candidateMilestone)
      throw new Error(`Milestone ${candidate.milestoneId} not found`);
    const feature = await this.layer.transactionImmediate(async (tx) => {
      /*
       * FNXC:RoadmapOrderingConcurrency 2026-07-14-01:32:
       * Feature deletion shares the project-and-roadmap lock with every ordering mutation. Re-read its current parent and delete within that transaction so reorder and move cannot commit from a sibling snapshot that still contains the deleted feature; sibling indexes retain SQLite delete semantics until explicit normalization.
       */
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:roadmap-order:${this.projectId}:${candidateMilestone.roadmapId}`}, 0))`,
      );
      const featureRows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_features WHERE project_id=${this.projectId} AND id=${id} LIMIT 1`,
      )) as unknown as FeatureRow[];
      const committed = featureRows[0]
        ? this.feature(featureRows[0])
        : undefined;
      if (!committed) throw new Error(`Feature ${id} not found`);
      const milestoneRows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND id=${committed.milestoneId} LIMIT 1`,
      )) as unknown as MilestoneRow[];
      const milestone = milestoneRows[0]
        ? this.milestone(milestoneRows[0])
        : undefined;
      if (!milestone) throw new Error(`Milestone ${committed.milestoneId} not found`);
      if (milestone.roadmapId !== candidateMilestone.roadmapId)
        throw new Error(`Feature ${id} changed roadmaps`);
      await tx.execute(
        sql`DELETE FROM project.roadmap_features WHERE project_id=${this.projectId} AND id=${id}`,
      );
      return committed;
    });
    this.emit("feature:deleted", feature);
  }

  async reorderMilestones(
    input: RoadmapMilestoneReorderInput,
  ): Promise<RoadmapMilestone[]> {
    const result = await this.layer.transactionImmediate(async (tx) => {
      /*
       * FNXC:RoadmapOrderingConcurrency 2026-07-14-00:43:
       * Every PostgreSQL reorder and move for one project roadmap must acquire the same transaction-scoped advisory lock before reading its hierarchy. This makes validation and recomputation observe the last committed ordering instead of overwriting it with a pre-transaction snapshot.
       */
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:roadmap-order:${this.projectId}:${input.roadmapId}`}, 0))`,
      );
      const roadmapRows = (await tx.execute(
        sql`SELECT * FROM project.roadmaps WHERE project_id=${this.projectId} AND id=${input.roadmapId} LIMIT 1`,
      )) as unknown as RoadmapRow[];
      if (!roadmapRows[0])
        throw new Error(`Roadmap ${input.roadmapId} not found`);
      const rows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND roadmap_id=${input.roadmapId} ORDER BY order_index, created_at, id`,
      )) as unknown as MilestoneRow[];
      const updatedAt = new Date().toISOString();
      const reordered = applyRoadmapMilestoneReorder(
        rows.map((row) => this.milestone(row)),
        input,
      ).map((item) => ({ ...item, updatedAt }));
      for (const item of reordered)
        await tx.execute(
          sql`UPDATE project.roadmap_milestones SET order_index=${item.orderIndex}, updated_at=${item.updatedAt} WHERE project_id=${this.projectId} AND id=${item.id}`,
        );
      return reordered;
    });
    /*
     * FNXC:RoadmapPostgresEvents 2026-07-13-23:40:
     * PostgreSQL mutations must publish the same typed lifecycle events as the SQLite RoadmapStore so plugin integrations do not change behavior when persistence backends switch.
     */
    this.emit("milestone:reordered", {
      roadmapId: input.roadmapId,
      milestones: result,
    });
    return result;
  }
  async reorderFeatures(
    input: RoadmapFeatureReorderInput,
  ): Promise<RoadmapFeature[]> {
    const result = await this.layer.transactionImmediate(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:roadmap-order:${this.projectId}:${input.roadmapId}`}, 0))`,
      );
      const milestoneRows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND id=${input.milestoneId} LIMIT 1`,
      )) as unknown as MilestoneRow[];
      const milestone = milestoneRows[0]
        ? this.milestone(milestoneRows[0])
        : undefined;
      if (!milestone)
        throw new Error(`Milestone ${input.milestoneId} not found`);
      if (milestone.roadmapId !== input.roadmapId)
        throw new Error(
          `Milestone ${input.milestoneId} does not belong to roadmap ${input.roadmapId}`,
        );
      const rows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_features WHERE project_id=${this.projectId} AND milestone_id=${input.milestoneId} ORDER BY order_index, created_at, id`,
      )) as unknown as FeatureRow[];
      const updatedAt = new Date().toISOString();
      const reordered = applyRoadmapFeatureReorder(
        rows.map((row) => this.feature(row)),
        input,
      ).map((item) => ({ ...item, updatedAt }));
      for (const item of reordered)
        await tx.execute(
          sql`UPDATE project.roadmap_features SET order_index=${item.orderIndex}, updated_at=${item.updatedAt} WHERE project_id=${this.projectId} AND id=${item.id}`,
        );
      return reordered;
    });
    this.emit("feature:reordered", {
      milestoneId: input.milestoneId,
      features: result,
    });
    return result;
  }
  async moveFeature(input: RoadmapFeatureMoveInput): Promise<void> {
    const movedFeature = await this.layer.transactionImmediate(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion:roadmap-order:${this.projectId}:${input.roadmapId}`}, 0))`,
      );
      const milestoneRows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND id IN (${input.fromMilestoneId}, ${input.toMilestoneId})`,
      )) as unknown as MilestoneRow[];
      const fromRow = milestoneRows.find((row) => row.id === input.fromMilestoneId);
      const toRow = milestoneRows.find((row) => row.id === input.toMilestoneId);
      const from = fromRow ? this.milestone(fromRow) : undefined;
      const to = toRow ? this.milestone(toRow) : undefined;
      if (!from)
        throw new Error(`Source milestone ${input.fromMilestoneId} not found`);
      if (!to)
        throw new Error(`Destination milestone ${input.toMilestoneId} not found`);
      /*
       * FNXC:RoadmapMoveOwnership 2026-07-14-00:43:
       * Validate feature and milestone ownership only after taking the roadmap ordering lock so a concurrent move cannot invalidate the hierarchy snapshot used to compute this move.
       */
      if (from.roadmapId !== input.roadmapId || to.roadmapId !== input.roadmapId)
        throw new Error(`Feature ${input.featureId} cannot move across roadmaps`);
      const featureRows = (await tx.execute(
        sql`SELECT * FROM project.roadmap_features WHERE project_id=${this.projectId} AND milestone_id IN (${input.fromMilestoneId}, ${input.toMilestoneId}) ORDER BY order_index, created_at, id`,
      )) as unknown as FeatureRow[];
      const features = featureRows.map((row) => this.feature(row));
      const feature = features.find((item) => item.id === input.featureId);
      if (!feature || feature.milestoneId !== input.fromMilestoneId)
        throw new Error(
          `Feature ${input.featureId} does not belong to source milestone ${input.fromMilestoneId}`,
        );
      const updatedAt = new Date().toISOString();
      const moved = moveRoadmapFeature(features, input);
      const affectedFeatures = moved.affectedFeatures.map((item) => ({
        ...item,
        updatedAt,
      }));
      for (const item of affectedFeatures)
        await tx.execute(
          sql`UPDATE project.roadmap_features SET milestone_id=${item.milestoneId}, order_index=${item.orderIndex}, updated_at=${item.updatedAt} WHERE project_id=${this.projectId} AND id=${item.id}`,
        );
      const committed = affectedFeatures.find((item) => item.id === input.featureId);
      if (!committed)
        throw new Error(`Feature ${input.featureId} was not moved`);
      return committed;
    });
    this.emit("feature:moved", {
      feature: movedFeature,
      fromMilestoneId: input.fromMilestoneId,
      toMilestoneId: input.toMilestoneId,
    });
  }

  async getRoadmapWithHierarchy(
    id: string,
  ): Promise<RoadmapWithHierarchy | undefined> {
    const roadmap = await this.getRoadmap(id);
    if (!roadmap) return undefined;
    const milestones = await this.listMilestones(id);
    return {
      ...roadmap,
      milestones: await Promise.all(
        milestones.map(async (m) => ({
          ...m,
          features: await this.listFeatures(m.id),
        })),
      ),
    };
  }
  async getRoadmapExport(id: string): Promise<RoadmapExportBundle> {
    const hierarchy = await this.getRoadmapWithHierarchy(id);
    if (!hierarchy) throw new Error(`Roadmap ${id} not found`);
    const { milestones, ...roadmap } = hierarchy;
    return {
      roadmap,
      milestones,
      features: milestones.flatMap((m) => m.features),
    };
  }
  async getMissionPlanningHandoff(
    id: string,
  ): Promise<RoadmapMissionPlanningHandoff> {
    const hierarchy = await this.getRoadmapWithHierarchy(id);
    if (!hierarchy) throw new Error(`Roadmap ${id} not found`);
    return {
      sourceRoadmapId: hierarchy.id,
      title: hierarchy.title,
      description: hierarchy.description,
      milestones: hierarchy.milestones.map((m) => ({
        sourceMilestoneId: m.id,
        title: m.title,
        description: m.description,
        orderIndex: m.orderIndex,
        features: m.features.map((f) => ({
          sourceFeatureId: f.id,
          title: f.title,
          description: f.description,
          orderIndex: f.orderIndex,
        })),
      })),
    };
  }
  async getRoadmapFeatureHandoff(
    roadmapId: string,
    milestoneId: string,
    featureId: string,
  ): Promise<RoadmapFeatureTaskPlanningHandoff> {
    const roadmap = await this.getRoadmap(roadmapId);
    const milestone = await this.getMilestone(milestoneId);
    const feature = await this.getFeature(featureId);
    if (!roadmap) throw new Error(`Roadmap ${roadmapId} not found`);
    if (!milestone || milestone.roadmapId !== roadmapId)
      throw new Error(`Milestone ${milestoneId} not found`);
    if (!feature || feature.milestoneId !== milestoneId)
      throw new Error(`Feature ${featureId} not found`);
    return {
      source: {
        roadmapId,
        milestoneId,
        featureId,
        roadmapTitle: roadmap.title,
        milestoneTitle: milestone.title,
        milestoneOrderIndex: milestone.orderIndex,
        featureOrderIndex: feature.orderIndex,
      },
      title: feature.title,
      description: feature.description,
    };
  }
  async listFeatureTaskPlanningHandoffs(
    id: string,
  ): Promise<RoadmapFeatureTaskPlanningHandoff[]> {
    const hierarchy = await this.getRoadmapWithHierarchy(id);
    if (!hierarchy) throw new Error(`Roadmap ${id} not found`);
    return hierarchy.milestones.flatMap((m) =>
      m.features.map((f) => ({
        source: {
          roadmapId: hierarchy.id,
          milestoneId: m.id,
          featureId: f.id,
          roadmapTitle: hierarchy.title,
          milestoneTitle: m.title,
          milestoneOrderIndex: m.orderIndex,
          featureOrderIndex: f.orderIndex,
        },
        title: f.title,
        description: f.description,
      })),
    );
  }
}
