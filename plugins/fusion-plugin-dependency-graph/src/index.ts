import { definePlugin } from "@fusion/plugin-sdk";

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-dependency-graph",
    name: "Dependency Graph",
    version: "0.1.0",
    description: "Top-level dependency graph dashboard view",
  },
  state: "installed",
  hooks: {},
  dashboardViews: [
    {
      viewId: "graph",
      label: "Graph",
      componentPath: "./dashboard-view",
      icon: "Network",
      placement: "more",
      order: 40,
    },
  ],
});

export default plugin;
