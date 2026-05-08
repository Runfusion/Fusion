import type { Database } from "@fusion/core";
import { definePlugin } from "@fusion/plugin-sdk";
import { createRoadmapPluginRoutes } from "./roadmap-routes.js";

export function ensureRoadmapSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roadmaps (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roadmap_milestones (
      id TEXT PRIMARY KEY,
      roadmapId TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      orderIndex INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (roadmapId) REFERENCES roadmaps(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS roadmap_features (
      id TEXT PRIMARY KEY,
      milestoneId TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      orderIndex INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (milestoneId) REFERENCES roadmap_milestones(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idxRoadmapMilestonesRoadmapOrder
      ON roadmap_milestones(roadmapId, orderIndex, createdAt, id);

    CREATE INDEX IF NOT EXISTS idxRoadmapFeaturesMilestoneOrder
      ON roadmap_features(milestoneId, orderIndex, createdAt, id);
  `);
}

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-roadmap",
    name: "Roadmaps",
    version: "0.1.0",
    description: "Standalone roadmap planning plugin",
  },
  state: "installed",
  hooks: {
    onSchemaInit: ensureRoadmapSchema,
  },
  routes: createRoadmapPluginRoutes(),
  dashboardViews: [
    {
      viewId: "roadmaps",
      label: "Roadmaps",
      componentPath: "./dashboard-view",
      icon: "Map",
      placement: "primary",
      order: 30,
    },
  ],
});

export default plugin;

export type {
  Roadmap,
  RoadmapMilestone,
  RoadmapFeature,
  RoadmapCreateInput,
  RoadmapUpdateInput,
  RoadmapMilestoneCreateInput,
  RoadmapMilestoneUpdateInput,
  RoadmapFeatureCreateInput,
  RoadmapFeatureUpdateInput,
  RoadmapMilestoneReorderInput,
  RoadmapFeatureReorderInput,
  RoadmapFeatureMoveInput,
  RoadmapFeatureMoveResult,
  RoadmapMilestoneWithFeatures,
  RoadmapWithHierarchy,
  RoadmapExportBundle,
  RoadmapFeatureSourceRef,
  RoadmapFeatureTaskPlanningHandoff,
  RoadmapMissionPlanningMilestoneHandoff,
  RoadmapMissionPlanningHandoff,
} from "./roadmap-types.js";

export {
  normalizeRoadmapMilestoneOrder,
  applyRoadmapMilestoneReorder,
  normalizeRoadmapFeatureOrder,
  applyRoadmapFeatureReorder,
  moveRoadmapFeature,
} from "./store/roadmap-ordering.js";

export {
  mapFeatureToTaskHandoff,
  mapRoadmapToMissionHandoff,
  mapRoadmapWithHierarchyToMissionHandoff,
  mapAllFeaturesToTaskHandoffs,
} from "./store/roadmap-handoff.js";

export { RoadmapStore } from "./store/roadmap-store.js";
export type { RoadmapStoreEvents } from "./store/roadmap-store.js";

export { RoadmapDashboardView } from "./dashboard-view.js";
export * from "./server/index.js";
