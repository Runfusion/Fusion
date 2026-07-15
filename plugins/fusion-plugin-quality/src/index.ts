import { definePlugin } from "@fusion/plugin-sdk";
import { ensureQualitySchema } from "./quality-schema.js";
import { createQualityRoutes } from "./routes/create-routes.js";
import { settingsSchema } from "./settings.js";

/*
FNXC:Quality 2026-07-14-21:45:
Bundled Quality plugin: hub dashboard view + Task QA tab metadata.
Server entry must not re-export React/CSS views (fusion/no-plugin-view-reexport).
*/

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-quality",
    name: "Quality",
    version: "0.1.0",
    description:
      "Task QA tab and Quality hub: preview servers, test runs, reports, screenshots, and suggested cases",
    author: "Fusion Team",
    fusionVersion: ">=0.1.0",
    settingsSchema,
  },
  state: "installed",
  hooks: {
    onSchemaInit: ensureQualitySchema,
  },
  routes: createQualityRoutes(),
  dashboardViews: [
    {
      viewId: "quality",
      label: "Quality",
      componentPath: "./dashboard-view",
      icon: "ShieldCheck",
      placement: "primary",
      order: 32,
      description: "Project quality: runs, plans, and CI",
    },
  ],
  uiSlots: [
    {
      slotId: "task-detail-tab",
      label: "QA",
      icon: "FlaskConical",
      componentPath: "./qa-tab",
      order: 20,
    },
  ],
});

export default plugin;

export { ensureQualitySchema } from "./quality-schema.js";
export { QualityStore } from "./store/quality-store.js";
export { resolvePresetCommand, isQualityPresetId, listPresetCatalog } from "./runner/command-presets.js";
export { buildHeuristicSuggestedCases } from "./suggestions/heuristic-cases.js";
