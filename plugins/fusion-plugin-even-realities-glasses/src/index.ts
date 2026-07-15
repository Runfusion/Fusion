import { definePlugin } from "@fusion/plugin-sdk";
import type { AsyncDataLayer } from "@fusion/core";
import type { FusionPlugin, PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { createNotifier } from "./notifier.js";
import { requestReview, startWork } from "./agent-actions.js";
import { runQuickCapture } from "./quick-capture.js";
import { quickCaptureRoutes } from "./routes/quick-capture-routes.js";
import { createNotificationRoutes } from "./routes/notification-routes.js";
import { agentActionRoutes } from "./routes/agent-action-routes.js";
import { boardRoutes } from "./routes/board-routes.js";
import {
  getCompanionWebhookUrl,
  getFusionToken,
  getNotifyColumns,
  getQuickCaptureColumn,
  settingsSchema,
} from "./settings.js";
import { WebhookGlassesTransport } from "./transport.js";
import { createTransportRoutes } from "./routes/transport-routes.js";

type PluginInstance = {
  transport: WebhookGlassesTransport;
  notifier: ReturnType<typeof createNotifier>;
};const instances = new Map<string, PluginInstance>();

function getPersistenceFromTaskStore(ctx: PluginContext): AsyncDataLayer {
  /*
  FNXC:EvenRealitiesPostgres 2026-07-14-17:55:
  The glasses notifier is a PostgreSQL-only runtime. It must receive the project TaskStore's bound AsyncDataLayer and fail loudly when unavailable; private PluginStore database casts and synchronous SQLite prepare/exec fallbacks are forbidden after cutover.
  */
  const layer = ctx.taskStore.getAsyncLayer();
  if (!layer?.projectId?.trim()) {
    throw new Error("Even Realities plugin requires a project-bound PostgreSQL AsyncDataLayer");
  }
  return layer;
}

function getInstanceOrResponse(ctx: PluginContext): { instance?: PluginInstance; error?: PluginRouteResponse } {
  const instance = instances.get(ctx.pluginId);
  if (!instance) return { error: { status: 503, body: { error: "Plugin instance not initialized" } } };
  return { instance };
}

const coreRoutes: PluginRouteDefinition[] = [
  {
    method: "GET",
    path: "/status",
    handler: async (_req, ctx) => {
      const { instance, error } = getInstanceOrResponse(ctx);
      if (!instance) return error as PluginRouteResponse;
      return {
        status: 200,
        body: {
          connected: instance.transport.connected,
          transport: instance.transport.status,
          lastPollTime: instance.notifier.lastPolledAt() ?? null,
          notifyOnColumns: getNotifyColumns(ctx.settings),
        },
      };
    },
  },
  {
    method: "POST",
    path: "/reconnect",
    handler: async (_req, ctx) => {
      const { instance, error } = getInstanceOrResponse(ctx);
      if (!instance) return error as PluginRouteResponse;
      await instance.transport.disconnect();
      await instance.transport.connect();
      return { status: 200, body: { ok: true } };
    },
  },
];

const notificationRoutes = createNotificationRoutes((ctx) => instances.get(ctx.pluginId)?.notifier);
const transportRoutes = createTransportRoutes((ctx) => instances.get(ctx.pluginId)?.transport);

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-even-realities-glasses",
    name: "Even Realities Glasses",
    version: "0.1.0",
    description: "Task-focused card bridge between Fusion and Even Realities glasses.",
    author: "Fusion Team",
    fusionVersion: ">=0.1.0",
    settingsSchema,
  },
  state: "installed",
  routes: [...coreRoutes, ...boardRoutes, ...quickCaptureRoutes, ...agentActionRoutes, ...notificationRoutes, ...transportRoutes],
  hooks: {
    onLoad: async (ctx) => {
      const token = getFusionToken(ctx.settings);
      if (!token) {
        ctx.logger.warn("fusionApiToken is missing; even-realities plugin not initialized");
        return;
      }
      const layer = getPersistenceFromTaskStore(ctx);
      const transport = new WebhookGlassesTransport({
        companionWebhookUrl: getCompanionWebhookUrl(ctx.settings),
      });
      await transport.connect();
      transport.onAction(async (action) => {
        if (action.type === "quick-capture") {
          await runQuickCapture(
            { text: action.text, column: undefined },
            {
              taskStore: ctx.taskStore,
              pluginId: ctx.pluginId,
              defaultColumn: getQuickCaptureColumn(ctx.settings),
            },
          );
          return;
        }

        if (!action.taskId) return;

        if (action.type === "start-work") {
          await startWork({ taskId: action.taskId }, { taskStore: ctx.taskStore, pluginId: ctx.pluginId });
          return;
        }

        if (action.type === "request-review") {
          await requestReview({ taskId: action.taskId }, { taskStore: ctx.taskStore, pluginId: ctx.pluginId });
        }
      });

      const notifier = createNotifier({
        taskStore: ctx.taskStore,
        layer,
        transport,
        settings: ctx.settings,
        logger: ctx.logger,
        pluginId: ctx.pluginId,
      });
      notifier.start();
      instances.set(ctx.pluginId, { transport, notifier });
    },
    onUnload: async () => {
      for (const [pluginId, instance] of instances.entries()) {
        await instance.notifier.stop();
        await instance.transport.disconnect();
        instances.delete(pluginId);
      }
    },
  },
});

export default plugin;
