import { definePlugin } from "@fusion/plugin-sdk";
import { createCliPrintingPressRoutes } from "./routes/wizard-routes.js";
import { buildExecutorRuntimeEnv } from "./runtime/executor-runtime-env.js";
import { createCliPressStore, ensureCliPressSchema } from "./store/cli-press-store.js";
import { CLI_PRINTING_PRESS_WORKFLOW_STEPS } from "./workflow-steps.js";

const storeByDb = new WeakMap<object, ReturnType<typeof createCliPressStore>>();

function getStore(taskStore: { getDatabase: () => object }) {
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
  executorRuntimeEnv: (taskCtx, ctx) => {
    const store = getStore(ctx.taskStore as { getDatabase: () => object });
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
export { CliPrintingPressWizardView } from "./dashboard-view.js";
export { CliPrintingPressManageView } from "./manage-view.js";
export { CliPrintingPressTestRunner } from "./run/TestRunnerPanel.js";
export { createCliPressStore, ensureCliPressSchema } from "./store/cli-press-store.js";
export { CLI_PRINTING_PRESS_WORKFLOW_STEPS } from "./workflow-steps.js";
export * from "./store/cli-press-types.js";
