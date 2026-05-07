import { definePlugin } from "@fusion/plugin-sdk";

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-roadmap",
    name: "Roadmap",
    version: "0.1.0",
    description: "Roadmap domain package for plugin-owned roadmap migration",
  },
  state: "installed",
  hooks: {},
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
