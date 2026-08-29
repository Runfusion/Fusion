import { definePlugin } from "@fusion/plugin-sdk";
import type { AsyncDataLayer } from "@fusion/core";
import { createCliPrintingPressRoutes } from "./routes/wizard-routes.js";
import { buildExecutorRuntimeEnv } from "./runtime/executor-runtime-env.js";
import { createCliPressStore, ensureCliPressSchema, type CliPressStore } from "./store/cli-press-store.js";
import { CLI_PRINTING_PRESS_WORKFLOW_STEPS } from "./workflow-steps.js";
import { cliPrintingPressTools } from "./tools.js";

/*
FNXC:CliPrintingPressAgentVocabulary 2026-07-14-18:47:
CLI definitions are an agent-native project domain. Prompt contributions teach agents to use validated CRUD, generation, and bounded test primitives and to report persisted definition and artifact state rather than editing plugin tables or generated files directly.
*/

interface TaskStoreLike {
  getAsyncLayer(): AsyncDataLayer | null;
}

const storeByTaskStore = new WeakMap<object, CliPressStore>();

function getStore(taskStore: TaskStoreLike): CliPressStore {
  const cached = storeByTaskStore.get(taskStore as object);
  if (cached) return cached;
  const asyncLayer = taskStore.getAsyncLayer();
  if (!asyncLayer) throw new Error("CLI Printing Press plugin requires the project PostgreSQL AsyncDataLayer");
  const next = createCliPressStore(null, asyncLayer);
  storeByTaskStore.set(taskStore as object, next);
  return next;
}

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-cli-printing-press",
    name: "CLI Printing Press",
    version: "0.1.0",
    description: "Guided wizard for drafting external service CLI definitions",
    workflowSteps: CLI_PRINTING_PRESS_WORKFLOW_STEPS.map((step) => ({ stepId: step.stepId, name: step.name })),
    promptSurfaces: ["executor-system", "executor-task"],
  },
  state: "installed",
  hooks: {
    onSchemaInit: ensureCliPressSchema,
  },
  routes: createCliPrintingPressRoutes(),
  tools: cliPrintingPressTools,
  promptContributions: {
    enabledByDefault: true,
    contributions: [
      {
        surface: "executor-system",
        content: "CLI Printing Press definitions are project-scoped ServiceDraft records. Use cli_press_list/get/create/update/delete for validated persistence, cli_press_generate for artifacts, and cli_press_test for bounded endpoint verification. Never edit plugin tables or generated artifacts directly.",
      },
      {
        surface: "executor-task",
        content: "For CLI definition work, return the persisted definition id and validation state; after generation or testing also return artifact metadata or test exit status.",
      },
    ],
  },
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
export { createCliPrintingPressTools, cliPrintingPressTools } from "./tools.js";
export * from "./store/cli-press-types.js";
