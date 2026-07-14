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
    if (!(await this.getRoadmap(id)))
      throw new Error(`Roadmap ${id} not found`);
    await this.layer.db.execute(
      sql`DELETE FROM project.roadmaps WHERE project_id=${this.projectId} AND id=${id}`,
    );
    this.emit("roadmap:deleted", id);
  }

  async createMilestone(
    roadmapId: string,
    input: RoadmapMilestoneCreateInput,
  ): Promise<RoadmapMilestone> {
    if (!(await this.getRoadmap(roadmapId)))
      throw new Error(`Roadmap ${roadmapId} not found`);
    const existing = await this.listMilestones(roadmapId);
    const now = new Date().toISOString();
    const milestone: RoadmapMilestone = {
      id: this.id("RMS"),
      roadmapId,
      title: input.title,
      description: input.description,
      orderIndex: nextOrderIndex(existing),
      createdAt: now,
      updatedAt: now,
    };
    await this.layer.db.execute(
      sql`INSERT INTO project.roadmap_milestones(id, project_id, roadmap_id, title, description, order_index, created_at, updated_at) VALUES(${milestone.id}, ${this.projectId}, ${roadmapId}, ${milestone.title}, ${milestone.description ?? null}, ${milestone.orderIndex}, ${now}, ${now})`,
    );
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
    if (!(await this.getMilestone(id)))
      throw new Error(`Milestone ${id} not found`);
    await this.layer.db.execute(
      sql`DELETE FROM project.roadmap_milestones WHERE project_id=${this.projectId} AND id=${id}`,
    );
    this.emit("milestone:deleted", id);
  }

  async createFeature(
    milestoneId: string,
    input: RoadmapFeatureCreateInput,
  ): Promise<RoadmapFeature> {
    if (!(await this.getMilestone(milestoneId)))
      throw new Error(`Milestone ${milestoneId} not found`);
    const existing = await this.listFeatures(milestoneId);
    const now = new Date().toISOString();
    const feature: RoadmapFeature = {
      id: this.id("RF"),
      milestoneId,
      title: input.title,
      description: input.description,
      orderIndex: nextOrderIndex(existing),
      createdAt: now,
      updatedAt: now,
    };
    await this.layer.db.execute(
      sql`INSERT INTO project.roadmap_features(id, project_id, milestone_id, title, description, order_index, created_at, updated_at) VALUES(${feature.id}, ${this.projectId}, ${milestoneId}, ${feature.title}, ${feature.description ?? null}, ${feature.orderIndex}, ${now}, ${now})`,
    );
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
    const feature = await this.getFeature(id);
    if (!feature)
      throw new Error(`Feature ${id} not found`);
    await this.layer.db.execute(
      sql`DELETE FROM project.roadmap_features WHERE project_id=${this.projectId} AND id=${id}`,
    );
    this.emit("feature:deleted", feature);
  }

  async reorderMilestones(
    input: RoadmapMilestoneReorderInput,
  ): Promise<RoadmapMilestone[]> {
    if (!(await this.getRoadmap(input.roadmapId)))
      throw new Error(`Roadmap ${input.roadmapId} not found`);
    const result = applyRoadmapMilestoneReorder(
      await this.listMilestones(input.roadmapId),
      input,
    );
    await this.layer.transactionImmediate(async (tx) => {
      for (const item of result)
        await tx.execute(
          sql`UPDATE project.roadmap_milestones SET order_index=${item.orderIndex}, updated_at=${new Date().toISOString()} WHERE project_id=${this.projectId} AND id=${item.id}`,
        );
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
    const milestone = await this.getMilestone(input.milestoneId);
    if (!milestone) throw new Error(`Milestone ${input.milestoneId} not found`);
    if (milestone.roadmapId !== input.roadmapId)
      throw new Error(
        `Milestone ${input.milestoneId} does not belong to roadmap ${input.roadmapId}`,
      );
    const result = applyRoadmapFeatureReorder(
      await this.listFeatures(input.milestoneId),
      input,
    );
    await this.layer.transactionImmediate(async (tx) => {
      for (const item of result)
        await tx.execute(
          sql`UPDATE project.roadmap_features SET order_index=${item.orderIndex}, updated_at=${new Date().toISOString()} WHERE project_id=${this.projectId} AND id=${item.id}`,
        );
    });
    this.emit("feature:reordered", {
      milestoneId: input.milestoneId,
      features: result,
    });
    return result;
  }
  async moveFeature(input: RoadmapFeatureMoveInput): Promise<void> {
    const from = await this.getMilestone(input.fromMilestoneId);
    const to = await this.getMilestone(input.toMilestoneId);
    if (!from)
      throw new Error(`Source milestone ${input.fromMilestoneId} not found`);
    if (!to)
      throw new Error(`Destination milestone ${input.toMilestoneId} not found`);
    const feature = await this.getFeature(input.featureId);
    if (!feature || feature.milestoneId !== input.fromMilestoneId)
      throw new Error(
        `Feature ${input.featureId} does not belong to source milestone ${input.fromMilestoneId}`,
      );
    /*
     * FNXC:RoadmapMoveOwnership 2026-07-13-23:40:
     * A feature move is confined to the requested roadmap. Checking both milestone parents prevents a caller from using valid IDs to splice one project's or roadmap's hierarchy into another.
     */
    if (
      from.roadmapId !== input.roadmapId
      || to.roadmapId !== input.roadmapId
    ) {
      throw new Error(
        `Feature ${input.featureId} cannot move across roadmaps`,
      );
    }
    const source = await this.listFeatures(input.fromMilestoneId);
    const target =
      input.fromMilestoneId === input.toMilestoneId
        ? []
        : await this.listFeatures(input.toMilestoneId);
    const moved = moveRoadmapFeature([...source, ...target], input);
    await this.layer.transactionImmediate(async (tx) => {
      for (const item of moved.affectedFeatures)
        await tx.execute(
          sql`UPDATE project.roadmap_features SET milestone_id=${item.milestoneId}, order_index=${item.orderIndex}, updated_at=${new Date().toISOString()} WHERE project_id=${this.projectId} AND id=${item.id}`,
        );
    });
    const movedFeature = moved.affectedFeatures.find(
      (item) => item.id === input.featureId,
    );
    if (!movedFeature) {
      throw new Error(`Feature ${input.featureId} was not moved`);
    }
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
