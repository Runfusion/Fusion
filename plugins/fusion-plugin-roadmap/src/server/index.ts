import type { AsyncDataLayer } from "@fusion/core";
import { RoadmapStore } from "../store/roadmap-store.js";
import { AsyncRoadmapStore } from "../store/async-roadmap-store.js";

export { createRoadmapPluginRoutes } from "../routes/roadmap-routes.js";

export type RoadmapRuntimeStore = RoadmapStore | AsyncRoadmapStore;

export interface RoadmapTaskStoreAccess {
  getRoadmapStore?: () => RoadmapRuntimeStore;
  getAsyncLayer(): AsyncDataLayer | null;
}

const roadmapStoreCache = new WeakMap<object, AsyncRoadmapStore>();

/**
 * FNXC:ReportPipeline 2026-07-18-12:15:
 * Cross-package consumers obtain project-scoped roadmap reads through this
 * supported seam. It preserves the native bridge when supplied and otherwise
 * caches the AsyncRoadmapStore per TaskStore; callers may degrade when no
 * PostgreSQL layer is available rather than reaching into plugin internals.
 */
export function createRoadmapStoreForTaskStore(taskStore: RoadmapTaskStoreAccess): RoadmapRuntimeStore {
  if (typeof taskStore.getRoadmapStore === "function") return taskStore.getRoadmapStore();

  const key = taskStore as object;
  const cached = roadmapStoreCache.get(key);
  if (cached) return cached;

  const layer = taskStore.getAsyncLayer();
  if (!layer) throw new Error("Roadmap plugin routes require the project PostgreSQL AsyncDataLayer");
  const store = new AsyncRoadmapStore(layer);
  roadmapStoreCache.set(key, store);
  return store;
}
