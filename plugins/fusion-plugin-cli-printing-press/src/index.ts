import { definePlugin } from "@fusion/plugin-sdk";
import { createCliPrintingPressRoutes } from "./routes/wizard-routes.js";
import { buildExecutorRuntimeEnv } from "./runtime/executor-runtime-env.js";
import { createCliPressStore, ensureCliPressSchema, type CliPressStore } from "./store/cli-press-store.js";
import { CLI_PRINTING_PRESS_WORKFLOW_STEPS } from "./workflow-steps.js";

interface TaskStoreLike {
  getDatabase(): object;
  isBackendMode(): boolean;
  getAsyncLayer(): { db: unknown } | null;
}

// Cache keyed by the SQLite db object (legacy mode). In backend mode the store
// is cached by the TaskStore instance instead (the async layer is stable per
// TaskStore), so a null-db store is never cached here.
const storeByDb = new WeakMap<object, CliPressStore>();
const storeByTaskStore = new WeakMap<object, CliPressStore>();

function getStore(taskStore: TaskStoreLike): CliPressStore {
  // FNXC:PostgresCutover 2026-07-04-00:00:
  // Dual-mode: in backend mode pass the AsyncDataLayer so the store routes to
  // Drizzle queries against the plugin-owned PG tables (materialized by the
  // cliPressPluginSchemaInit hook). Legacy SQLite mode passes the sync db.
  if (taskStore.isBackendMode()) {
    const cached = storeByTaskStore.get(taskStore as object);
    if (cached) return cached;
    const next = createCliPressStore(null, taskStore.getAsyncLayer());
    storeByTaskStore.set(taskStore as object, next);
    return next;
  }
  const db = taskStore.getDatabase();
  const existing = storeByDb.get(db);
  if (existing) return existing;
  const next = createCliPressStore(db as never);
  storeByDb.set(db, next);
  return next;
}

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-cli-printing-press",
    name: "CLI Printing Press",
    version: "0.1.0",
    description: "Guided wizard for drafting external service CLI definitions",
    workflowSteps: CLI_PRINTING_PRESS_WORKFLOW_STEPS.map((step) => ({ stepId: step.stepId, name: step.name })),
  },
  state: "installed",
  hooks: {
    onSchemaInit: ensureCliPressSchema,
  },
  routes: createCliPrintingPressRoutes(),
  executorRuntimeEnv: async (taskCtx, ctx) => {
    const store = getStore(ctx.taskStore as TaskStoreLike);
    return buildExecutorRuntimeEnv(store, taskCtx, ctx);
  },
  workflowSteps: CLI_PRINTING_PRESS_WORKFLOW_STEPS,
  dashboardViews: [
    {
      viewId: "wizard",
      label: "Create Service CLI",
      componentPath: "./dashboard-view",
      icon: "Wand2",
      placement: "primary",
      order: 60,
    },
    {
      viewId: "manage",
      label: "Manage Service CLIs",
      componentPath: "./manage-view",
      icon: "List",
      placement: "primary",
      order: 61,
    },
  ],
});

export default plugin;
export { createCliPressStore, ensureCliPressSchema } from "./store/cli-press-store.js";
export type { CliPressStore } from "./store/cli-press-store.js";
export { CLI_PRINTING_PRESS_WORKFLOW_STEPS } from "./workflow-steps.js";
export * from "./store/cli-press-types.js";
