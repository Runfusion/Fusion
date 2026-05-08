import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginSettingSchema } from "@fusion/plugin-sdk";
import { boardRoutes } from "./routes/board-routes.js";

const settingsSchema: Record<string, PluginSettingSchema> = {
  apiKey: {
    type: "password",
    label: "Companion API Key",
    description: "Bearer token used by the glasses companion app.",
    required: true,
    group: "Authentication",
  },
  boardPollingMs: {
    type: "number",
    label: "Board Polling Interval (ms)",
    defaultValue: 10000,
    group: "On-device Cards",
  },
};

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-even-cards",
    name: "Even Cards",
    version: "0.1.0",
    description: "On-device card payloads for board/task status in Even Realities flows",
    author: "Fusion Team",
    settingsSchema,
  },
  state: "installed",
  routes: [...boardRoutes],
  hooks: {
    onLoad: async (ctx) => {
      ctx.logger.info("Even Cards plugin loaded");
    },
  },
});

export default plugin;
