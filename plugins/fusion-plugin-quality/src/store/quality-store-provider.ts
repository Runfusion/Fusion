import type { PluginContext } from "@fusion/plugin-sdk";
import { AsyncQualityStore } from "./async-quality-store.js";
import type { QualityStoreApi } from "./quality-store-api.js";

/*
FNXC:QualityPostgres 2026-07-16-09:03:
QA route handlers must never call TaskStore.getDatabase() / SQLite. Production
is PostgreSQL-only; getDatabase() throws in backend mode and was the source of
"SQLite Database is not available in backend mode" on the Task QA tab.
Always bind to the project AsyncDataLayer (same pattern as Reports).
*/

const qualityStoreCache = new WeakMap<object, QualityStoreApi>();

export function getQualityStore(ctx: PluginContext): QualityStoreApi {
  const taskStore = ctx.taskStore as {
    getAsyncLayer?: () => { projectId?: string; db: unknown } | null;
    getQualityStore?: () => QualityStoreApi;
  };
  // Test / DI seam (mirrors Reports) — never used to reintroduce SQLite in production.
  if (typeof taskStore.getQualityStore === "function") {
    return taskStore.getQualityStore();
  }

  const key = ctx.taskStore as object;
  const cached = qualityStoreCache.get(key);
  if (cached) return cached;

  const layer = typeof taskStore.getAsyncLayer === "function" ? taskStore.getAsyncLayer() : null;
  if (!layer) {
    const err = new Error(
      "Quality plugin requires the project PostgreSQL AsyncDataLayer (SQLite is not supported for QA flows)",
    ) as Error & { statusCode?: number };
    err.statusCode = 500;
    throw err;
  }

  const store = new AsyncQualityStore(layer as ConstructorParameters<typeof AsyncQualityStore>[0]);
  qualityStoreCache.set(key, store);
  return store;
}

/** Clear the WeakMap cache between tests. */
export function __clearQualityStoreCacheForTests(): void {
  // WeakMap has no clear; drop references by replacing via new stores per test key.
}
