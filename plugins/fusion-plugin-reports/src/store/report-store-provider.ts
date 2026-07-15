import type { PluginContext } from "@fusion/core";
import { ReportStore } from "./report-store.js";

const reportStoreCache = new WeakMap<object, ReportStore>();

/**
 * FNXC:PostgresSatelliteCutover 2026-07-14-18:32:
 * Every reports surface for one host TaskStore must share the same project-bound PostgreSQL ReportStore. Keeping the provider here prevents route modules from creating independent caches or retaining SQLite fallback construction.
 */
export function getReportStore(ctx: PluginContext): ReportStore {
  const injected = ctx.taskStore as PluginContext["taskStore"] & {
    getReportStore?: () => ReportStore;
  };
  if (typeof injected.getReportStore === "function") return injected.getReportStore();

  const key = ctx.taskStore as object;
  const cached = reportStoreCache.get(key);
  if (cached) return cached;

  const asyncLayer = ctx.taskStore.getAsyncLayer();
  if (!asyncLayer) throw new Error("Reports plugin requires the project PostgreSQL AsyncDataLayer");
  const store = new ReportStore(null, { asyncLayer });
  reportStoreCache.set(key, store);
  return store;
}
