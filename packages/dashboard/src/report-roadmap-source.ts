import { createRoadmapStoreForTaskStore, type RoadmapTaskStoreAccess } from "@fusion-plugin-examples/roadmap";
import { getOrCreateProjectStore } from "./project-store-resolver.js";

export interface RoadmapCandidate {
  featureId: string;
  title: string;
  body: string | null;
}

export type RoadmapDedupSource = (keywords: string[]) => Promise<RoadmapCandidate[]>;

type RoadmapHierarchyStore = {
  listRoadmaps(): Promise<Array<{ id: string }>>;
  getRoadmapWithHierarchy(id: string): Promise<{
    milestones: Array<{
      features: Array<{ id: string; title: string; description?: string }>;
    }>;
  } | undefined>;
};

export interface RoadmapDedupSourceDeps {
  createRoadmapStore?: (taskStore: RoadmapTaskStoreAccess) => RoadmapHierarchyStore;
}

/**
 * FNXC:ReportPipeline 2026-07-18-12:15:
 * The roadmap is a read-only report deduplication corpus. A candidate match
 * only informs pipeline routing and never mutates roadmap data or egresses it.
 */
export function createRoadmapDedupSourceForTaskStore(
  taskStore: RoadmapTaskStoreAccess,
  deps: RoadmapDedupSourceDeps = {},
): RoadmapDedupSource {
  const createStore = deps.createRoadmapStore ?? createRoadmapStoreForTaskStore;
  return async () => {
    try {
      const store = createStore(taskStore);
      const roadmaps = await store.listRoadmaps();
      const hierarchies = await Promise.all(roadmaps.map(({ id }) => store.getRoadmapWithHierarchy(id)));
      return hierarchies.flatMap((roadmap) => roadmap?.milestones.flatMap((milestone) => milestone.features.map((feature) => ({
        featureId: feature.id,
        title: feature.title,
        body: feature.description ?? null,
      }))) ?? []);
    } catch {
      // The optional roadmap plugin and its PostgreSQL layer must not block reports.
      return [];
    }
  };
}

export function createProjectRoadmapDedupSource(
  projectId: string,
  deps: RoadmapDedupSourceDeps = {},
): RoadmapDedupSource {
  return async (keywords) => {
    try {
      const taskStore = await getOrCreateProjectStore(projectId);
      return await createRoadmapDedupSourceForTaskStore(taskStore, deps)(keywords);
    } catch {
      return [];
    }
  };
}
