/**
 * Drizzle schema for plugin-owned tables.
 *
 * FNXC:PostgresSchema 2026-06-24-03:15:
 * Plugin-owned tables are materialized via a schema-init hook rather than the
 * core migration baseline (VAL-SCHEMA-007). The roadmap plugin owns three
 * tables (roadmaps, roadmap_milestones, roadmap_features) that live in the
 * project schema alongside core tables. This module defines their Drizzle
 * shape so the migration applier's plugin hook can create them against
 * PostgreSQL, mirroring plugins/fusion-plugin-roadmap/src/roadmap-schema.ts.
 *
 * The hook contract: plugins register a schema-init function that receives
 * an executor (anything that can run DDL). The applier calls each registered
 * hook after the core baseline migration lands. This keeps plugin tables out
 * of the core migration file (so they evolve independently with the plugin)
 * while still materializing on a fresh database.
 */

import { text, integer, foreignKey, index } from "drizzle-orm/pg-core";
import { projectSchema } from "./project.js";

/**
 * Roadmap plugin tables. These live in the project schema because the roadmap
 * plugin instantiates core's Database against the project connection.
 */
export const roadmaps = projectSchema.table("roadmaps", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const roadmapMilestones = projectSchema.table("roadmap_milestones", {
  id: text("id").primaryKey(),
  roadmapId: text("roadmap_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  orderIndex: integer("order_index").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.roadmapId], foreignColumns: [roadmaps.id] }).onDelete("cascade"),
  index("idxRoadmapMilestonesRoadmapOrder").on(t.roadmapId, t.orderIndex, t.createdAt, t.id),
]);

export const roadmapFeatures = projectSchema.table("roadmap_features", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  orderIndex: integer("order_index").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.milestoneId], foreignColumns: [roadmapMilestones.id] }).onDelete("cascade"),
  index("idxRoadmapFeaturesMilestoneOrder").on(t.milestoneId, t.orderIndex, t.createdAt, t.id),
]);

/**
 * Registry of plugin-owned table names (per plugin), used by the schema-init
 * hook to verify plugin tables materialized after the hook runs.
 */
export const roadmapPluginTableNames = [
  "roadmaps",
  "roadmap_milestones",
  "roadmap_features",
] as const;
