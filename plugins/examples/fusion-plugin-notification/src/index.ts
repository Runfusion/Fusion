import { definePlugin } from "@fusion/plugin-sdk";
import type {
  FusionPlugin,
  PluginContext,
  PluginSettingSchema,
} from "@fusion/plugin-sdk";

// ── Settings Schema ─────────────────────────────────────────────────────────────

const settingsSchema: Record<string, PluginSettingSchema> = {
  webhookUrl: {
    type: "string",
    label: "Webhook URL",
    description: "URL to send notifications to",
    required: true,
  },
  webhookType: {
    type: "enum",
    label: "Webhook Type",
    description: "Format of the webhook payload",
    enumValues: ["slack", "discord", "generic"],
    defaultValue: "generic",
  },
  events: {
    type: "string",
    label: "Events Filter",
    description:
      "Comma-separated list: task-completed,task-moved,task-failed (empty = all)",
    defaultValue: "",
  },
};

// ── Event Filter Helper ────────────────────────────────────────────────────────

function isEventAllowed(settings: Record<string, unknown>, event: string): boolean {
  const eventsSetting = settings.events as string | undefined;
  if (!eventsSetting || eventsSetting.trim() === "") {
    return true; // Empty = all events
  }
  const allowedEvents = eventsSetting
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  return allowedEvents.includes(event);
}

// ── Webhook Payload Formatters ──────────────────────────────────────────────────

function formatSlackPayload(message: string): { text: string } {
  return { text: message };
}

function formatDiscordPayload(message: string): { content: string } {
  return { content: message };
}

function formatGenericPayload(data: {
  event: string;
  taskId?: string;
  taskTitle?: string;
  fromColumn?: string;
  toColumn?: string;
  errorMessage?: string;
}): Record<string, unknown> {
  return {
    event: data.event,
    timestamp: new Date().toISOString(),
    task: data.taskId
      ? {
          id: data.taskId,
          title: data.taskTitle,
          from: data.fromColumn,
          to: data.toColumn,
        }
      : undefined,
    error: data.errorMessage,
  };
}

// ── Notification Sender ─────────────────────────────────────────────────────────

async function sendWebhook(
  url: string,
  payload: unknown,
  webhookType: string,
  logger: PluginContext["logger"],
): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.error(
        `Webhook request failed with status ${response.status}: ${response.statusText}`,
      );
    }
  } catch (err) {
    // Errors are logged but never propagated
    logger.error(
      `Webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Plugin Definition ───────────────────────────────────────────────────────────

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-notification",
    name: "Notification Plugin",
    version: "0.1.0",
    description: "Sends webhook notifications on task lifecycle events",
    settingsSchema,
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      ctx.logger.info("Notification plugin loaded");
      const webhookUrl = ctx.settings.webhookUrl as string | undefined;
      if (!webhookUrl) {
        ctx.logger.warn(
          "No webhook URL configured. Plugin will not send notifications until webhookUrl is set.",
        );
      }
    },

    onTaskCompleted: async (task, ctx) => {
      const webhookUrl = ctx.settings.webhookUrl as string | undefined;
      const webhookType = (ctx.settings.webhookType as string) || "generic";

      if (!webhookUrl) return;
      if (!isEventAllowed(ctx.settings, "task-completed")) return;

      const message = `✅ Task completed: ${task.title || task.id}`;
      let payload: unknown;

      if (webhookType === "slack") {
        payload = formatSlackPayload(message);
      } else if (webhookType === "discord") {
        payload = formatDiscordPayload(message);
      } else {
        payload = formatGenericPayload({
          event: "task-completed",
          taskId: task.id,
          taskTitle: task.title,
        });
      }

      await sendWebhook(webhookUrl, payload, webhookType, ctx.logger);
    },

    onTaskMoved: async (task, fromColumn, toColumn, ctx) => {
      const webhookUrl = ctx.settings.webhookUrl as string | undefined;
      const webhookType = (ctx.settings.webhookType as string) || "generic";

      if (!webhookUrl) return;
      if (!isEventAllowed(ctx.settings, "task-moved")) return;

      const message = `📋 Task moved: ${task.title || task.id} (${fromColumn} → ${toColumn})`;
      let payload: unknown;

      if (webhookType === "slack") {
        payload = formatSlackPayload(message);
      } else if (webhookType === "discord") {
        payload = formatDiscordPayload(message);
      } else {
        payload = formatGenericPayload({
          event: "task-moved",
          taskId: task.id,
          taskTitle: task.title,
          fromColumn,
          toColumn,
        });
      }

      await sendWebhook(webhookUrl, payload, webhookType, ctx.logger);
    },

    onError: async (error, ctx) => {
      const webhookUrl = ctx.settings.webhookUrl as string | undefined;
      const webhookType = (ctx.settings.webhookType as string) || "generic";

      if (!webhookUrl) return;
      if (!isEventAllowed(ctx.settings, "task-failed")) return;

      const message = `❌ Error: ${error.message}`;
      let payload: unknown;

      if (webhookType === "slack") {
        payload = formatSlackPayload(message);
      } else if (webhookType === "discord") {
        payload = formatDiscordPayload(message);
      } else {
        payload = formatGenericPayload({
          event: "error",
          errorMessage: error.message,
        });
      }

      await sendWebhook(webhookUrl, payload, webhookType, ctx.logger);
    },
  },
});

export default plugin;
