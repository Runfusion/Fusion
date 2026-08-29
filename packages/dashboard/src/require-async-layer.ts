import type { AsyncDataLayer, TaskStore } from "@fusion/core";

/**
 * FNXC:PostgresSatelliteCutover 2026-07-14-17:30:
 * Dashboard runtime services share their scoped TaskStore's PostgreSQL layer.
 * SQLite fallback construction is forbidden after cutover, so incomplete
 * project-store wiring fails at the composition boundary with useful context.
 */
export function requireAsyncLayer(store: Pick<TaskStore, "getAsyncLayer">, consumer: string): AsyncDataLayer {
  const layer = store.getAsyncLayer();
  if (!layer) {
    throw new Error(`${consumer} requires the project PostgreSQL AsyncDataLayer`);
  }
  return layer;
}
