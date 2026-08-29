import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import { linearSettingsSchema, LINEAR_PLUGIN_ID } from "./settings.js";
import { linearImportRoutes } from "./routes.js";
import { linearImportTools } from "./tools.js";

const dashboardViews = [
  {
    viewId: "linear-import",
    label: "Linear Import",
    componentPath: "./dashboard-view",
    icon: "ListPlus",
    placement: "more" as const,
    order: 55,
    description: "Browse Linear issues and import selected issues as Fusion tasks.",
  },
];

/*
FNXC:LinearImport 2026-07-02-00:00:
FN-7443 explicitly routes Linear import through the plugin system. Keep this server entry free of React/CSS imports, and expose only plugin-owned settings, routes, tools, and dashboard-view metadata so Fusion does not grow host-owned /api/linear routes or core Linear settings.
*/
const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: LINEAR_PLUGIN_ID,
    name: "Linear Import",
    version: "0.1.0",
    description: "Import Linear issues into Fusion tasks through plugin-owned settings, routes, tools, and dashboard view.",
    author: "Fusion",
    fusionVersion: ">=0.1.0",
    settingsSchema: linearSettingsSchema,
  },
  state: "installed",
  hooks: {},
  routes: linearImportRoutes,
  tools: linearImportTools,
  dashboardViews,
});

export default plugin;
export { linearSettingsSchema, resolveLinearSettings, hasLinearApiKey, LINEAR_PLUGIN_ID } from "./settings.js";
export { LinearClient, LinearApiError, linearErrorToResponse, buildLinearIssueFilter, LINEAR_GRAPHQL_ENDPOINT } from "./linear-client.js";
export { buildLinearImportPreview, buildLinearTaskCreateInput, findExistingLinearTask, importLinearIssue, taskMatchesLinearIssue } from "./import-linear.js";
export { linearImportRoutes } from "./routes.js";
export { linearImportTools } from "./tools.js";
