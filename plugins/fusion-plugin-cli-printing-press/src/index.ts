import { definePlugin } from "@fusion/plugin-sdk";

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-cli-printing-press",
    name: "CLI Printing Press",
    version: "0.1.0",
    description: "Generate and manage CLIs for external services using cli-printing-press",
  },
  state: "installed",
  hooks: {},
});

export default plugin;
