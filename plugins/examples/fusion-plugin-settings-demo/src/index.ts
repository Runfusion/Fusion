/**
 * Settings Demo Plugin
 *
 * Example Fusion plugin that demonstrates:
 * - Settings schema with multiple field types (string, number, boolean, enum)
 * - Hooks that read configuration at runtime
 * - Tools that expose settings-driven functionality
 *
 * This plugin suggests tags for tasks based on configurable keywords
 * and provides a status endpoint for checking configuration.
 */

import { definePlugin } from "@fusion/plugin-sdk";
import type {
  FusionPlugin,
  PluginContext,
  PluginSettingSchema,
  PluginToolDefinition,
  PluginToolResult,
} from "@fusion/plugin-sdk";

// ── Settings Schema ─────────────────────────────────────────────────────────────

/**
 * Settings schema for the plugin.
 * Users can configure these values via the dashboard Settings → Plugins UI.
 */
const settingsSchema: Record<string, PluginSettingSchema> = {
  webhookSecret: {
    type: "password",
    label: "Webhook Secret",
    description: "Secret for webhook signatures",
  },
  customMessage: {
    type: "string",
    label: "Custom Message",
    description: "Multi-line message shown on load",
    multiline: true,
    defaultValue: "Hello from Settings Demo!",
  },
  greetingMessage: {
    type: "string",
    label: "Greeting Message",
    description: "Custom greeting message shown when the plugin loads",
    defaultValue: "Hello from Settings Demo!",
  },
  maxTags: {
    type: "number",
    label: "Max Tags",
    description: "Maximum number of tags to suggest per task",
    defaultValue: 3,
  },
  enableLogging: {
    type: "boolean",
    label: "Enable Logging",
    description: "Log plugin activity to the console",
    defaultValue: true,
  },
  logLevel: {
    type: "enum",
    label: "Log Level",
    description: "Minimum log level to output",
    enumValues: ["debug", "info", "warn", "error"],
    defaultValue: "info",
  },
  priorityTags: {
    type: "array",
    label: "Priority Tags",
    description: "Tags to prioritize in suggestions",
    itemType: "string",
    defaultValue: ["bug", "feature"],
  },
};

// ── Tag Keywords Configuration ─────────────────────────────────────────────────

/**
 * Keyword-to-tag mappings for automatic tag suggestion.
 * In a real plugin, this would be user-configurable.
 */
const TAG_KEYWORDS: Record<string, string[]> = {
  bug: ["fix", "bug", "error", "crash", "broken", "issue"],
  feature: ["add", "implement", "create", "new", "feature"],
  refactor: ["refactor", "cleanup", "improve", "optimize", "restructure"],
  docs: ["docs", "documentation", "readme", "comment"],
  test: ["test", "testing", "spec", "coverage"],
  security: ["security", "vulnerability", "auth", "permission"],
  performance: ["performance", "speed", "optimize", "fast"],
  ui: ["ui", "interface", "design", "visual", "frontend"],
  backend: ["api", "backend", "server", "database"],
};

// ── Helper Functions ───────────────────────────────────────────────────────────

/**
 * Extract suggested tags from task description based on keywords.
 */
function suggestTags(
  description: string,
  maxTags: number,
): string[] {
  if (!description) return [];

  const lowerDesc = description.toLowerCase();
  const suggestions: { tag: string; count: number }[] = [];

  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    const matchCount = keywords.filter((kw) => lowerDesc.includes(kw)).length;
    if (matchCount > 0) {
      suggestions.push({ tag, count: matchCount });
    }
  }

  // Sort by match count (most matches first) and take up to maxTags
  return suggestions
    .sort((a, b) => b.count - a.count)
    .slice(0, maxTags)
    .map((s) => s.tag);
}

/**
 * Check if a log level should be output based on configured minimum level.
 */
function shouldLog(
  configuredLevel: string,
  messageLevel: string,
): boolean {
  const levels = ["debug", "info", "warn", "error"];
  const configuredIdx = levels.indexOf(configuredLevel);
  const messageIdx = levels.indexOf(messageLevel);
  return messageIdx >= configuredIdx;
}

// ── Plugin Tool ───────────────────────────────────────────────────────────────

/**
 * Tool for getting tag suggestions for a task.
 * Demonstrates how tools can read and use plugin settings.
 */
const suggestTagsTool: PluginToolDefinition = {
  name: "settings_demo_suggest_tags",
  description: "Suggest tags for a task based on its description using keyword matching. Returns up to the configured max tags.",
  parameters: {
    type: "object",
    properties: {
      taskDescription: {
        type: "string",
        description: "The task description to analyze for tag suggestions",
      },
    },
    required: ["taskDescription"],
  },
  execute: async (
    params: Record<string, unknown>,
    ctx: PluginContext,
  ): Promise<PluginToolResult> => {
    const description = params.taskDescription as string;
    const maxTagsSetting = ctx.settings.maxTags as number | undefined;
    // Use 3 as default only if maxTags is not explicitly set (undefined or NaN)
    // Allow maxTags=0 to return no tags
    const maxTags = maxTagsSetting !== undefined && !isNaN(maxTagsSetting) ? maxTagsSetting : 3;

    // Log tool usage if enabled
    if (ctx.settings.enableLogging) {
      ctx.logger.info(`Suggesting tags for description: ${description.slice(0, 50)}...`);
    }

    const tags = suggestTags(description, maxTags);

    const result: PluginToolResult = {
      content: [
        {
          type: "text",
          text: tags.length === 0
            ? "No tags could be suggested based on the task description."
            : `Suggested tags: ${tags.join(", ")}`,
        },
      ],
      details: {
        tags,
        count: tags.length,
      },
    };

    return result;
  },
};

/**
 * Tool for getting plugin configuration status.
 * Demonstrates how tools expose current settings.
 */
const statusTool: PluginToolDefinition = {
  name: "settings_demo_status",
  description: "Get the current configuration status of the Settings Demo plugin",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: async (
    _params: Record<string, unknown>,
    ctx: PluginContext,
  ): Promise<PluginToolResult> => {
    // Return raw settings values for status display
    const webhookSecret = ctx.settings.webhookSecret as string | undefined;
    const customMessage = ctx.settings.customMessage as string | undefined;
    const greetingMessage = ctx.settings.greetingMessage as string | undefined;
    const maxTags = ctx.settings.maxTags as number | undefined;
    const enableLogging = ctx.settings.enableLogging as boolean | undefined;
    const logLevel = ctx.settings.logLevel as string | undefined;
    const priorityTags = ctx.settings.priorityTags as string[] | undefined;

    // Use resolved values for display text
    const webhookConfigured = webhookSecret ? "configured" : "not configured";
    const displayCustomMessage = customMessage || "Not configured";
    const greeting = greetingMessage || "Not configured";
    const displayMaxTags = maxTags ?? 3;
    const displayEnableLogging = enableLogging ?? true;
    const displayLogLevel = logLevel || "info";
    const displayPriorityTags = priorityTags?.join(", ") || "bug, feature";

    return {
      content: [
        {
          type: "text",
          text: [
            "Settings Demo Plugin Status:",
            `- Webhook Secret: ${webhookConfigured}`,
            `- Custom Message: ${displayCustomMessage}`,
            `- Greeting: ${greeting}`,
            `- Max Tags: ${displayMaxTags}`,
            `- Logging: ${displayEnableLogging ? "enabled" : "disabled"}`,
            `- Log Level: ${displayLogLevel}`,
            `- Priority Tags: ${displayPriorityTags}`,
          ].join("\n"),
        },
      ],
      details: {
        webhookSecret: webhookSecret ? "(configured)" : undefined,
        customMessage,
        greetingMessage,
        maxTags,
        enableLogging,
        logLevel,
        priorityTags,
      },
    };
  },
};

// ── Plugin Definition ───────────────────────────────────────────────────────────

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-settings-demo",
    name: "Settings Demo Plugin",
    version: "0.1.0",
    description: "Example plugin demonstrating settings schema, hooks, and tools",
    settingsSchema,
  },
  state: "installed",
  tools: [suggestTagsTool, statusTool],
  hooks: {
    onLoad: (ctx: PluginContext) => {
      const webhookSecret = ctx.settings.webhookSecret as string | undefined;
      const customMessage =
        (ctx.settings.customMessage as string) || "Hello from Settings Demo!";
      const greeting =
        (ctx.settings.greetingMessage as string) || "Hello from Settings Demo!";
      const enableLogging = (ctx.settings.enableLogging as boolean) ?? true;
      const logLevel = (ctx.settings.logLevel as string) || "info";
      const priorityTags = (ctx.settings.priorityTags as string[] | undefined) || ["bug", "feature"];

      if (enableLogging && shouldLog(logLevel, "info")) {
        if (webhookSecret) {
          ctx.logger.info("Webhook secret is configured");
        }
        ctx.logger.info(customMessage);
        ctx.logger.info(`Plugin configured with maxTags: ${ctx.settings.maxTags || 3}`);
        ctx.logger.info(`Priority tags: ${priorityTags.join(", ")}`);
      }
    },

    onTaskCreated: async (task: { id: string; title?: string; description?: string }, ctx: PluginContext) => {
      const enableLogging = (ctx.settings.enableLogging as boolean) ?? true;
      const logLevel = (ctx.settings.logLevel as string) || "info";

      if (!enableLogging || !shouldLog(logLevel, "debug")) {
        return;
      }

      ctx.logger.debug(`Task created: ${task.id} - ${task.title || "untitled"}`);

      // Auto-suggest tags for new tasks
      if (task.description) {
        const maxTags = (ctx.settings.maxTags as number) || 3;
        const tags = suggestTags(task.description, maxTags);
        if (tags.length > 0) {
          ctx.logger.debug(`Suggested tags for ${task.id}: ${tags.join(", ")}`);
        }
      }
    },

    onTaskCompleted: async (task: { id: string; title?: string }, ctx: PluginContext) => {
      const enableLogging = (ctx.settings.enableLogging as boolean) ?? true;
      const logLevel = (ctx.settings.logLevel as string) || "info";

      if (enableLogging && shouldLog(logLevel, "info")) {
        ctx.logger.info(`Task completed: ${task.id} - ${task.title || "untitled"}`);
      }
    },
  },
});

export default plugin;
