/**
 * Fusion Plugin SDK
 *
 * This package provides type definitions and helpers for creating Fusion plugins.
 * It re-exports all plugin-related types from @fusion/core.
 *
 * @example
 * ```typescript
 * import { definePlugin } from "@fusion/plugin-sdk";
 *
 * export default definePlugin({
 *   manifest: {
 *     id: "my-plugin",
 *     name: "My Plugin",
 *     version: "1.0.0",
 *   },
 *   hooks: {
 *     onLoad: async (ctx) => {
 *       ctx.logger.info("Plugin loaded!");
 *     },
 *   },
 *   tools: [
 *     {
 *       name: "my_tool",
 *       description: "Does something useful",
 *       parameters: { type: "object", properties: { input: { type: "string" } } },
 *       execute: async (params, ctx) => ({
 *         content: [{ type: "text", text: `Processed: ${params.input}` }],
 *       }),
 *     },
 *   ],
 * });
 * ```
 */

// Re-export all plugin types from @fusion/core
export type {
  PluginManifest,
  PluginSettingSchema,
  PluginSettingType,
  PluginOnLoad,
  PluginOnUnload,
  PluginOnTaskCreated,
  PluginOnTaskMoved,
  PluginOnTaskCompleted,
  PluginOnError,
  PluginToolDefinition,
  PluginToolResult,
  PluginRouteDefinition,
  PluginRouteMethod,
  PluginUiSlotDefinition,
  PluginContext,
  PluginLogger,
  FusionPlugin,
  PluginState,
  PluginInstallation,
} from "../../core/src/plugin-types.js";

export { validatePluginManifest } from "../../core/src/plugin-types.js";

import type { FusionPlugin } from "../../core/src/plugin-types.js";

/**
 * Type-safe helper for defining a Fusion plugin.
 *
 * Provides autocompletion and compile-time validation for plugin definitions.
 * This is an identity function - it returns the input unchanged.
 *
 * @example
 * ```typescript
 * export default definePlugin({
 *   manifest: {
 *     id: "my-plugin",
 *     name: "My Plugin",
 *     version: "1.0.0",
 *     description: "Does something cool",
 *   },
 *   hooks: {
 *     onLoad: async (ctx) => {
 *       ctx.logger.info("Plugin loaded!");
 *     },
 *     onTaskCompleted: async (task, ctx) => {
 *       ctx.logger.info(`Task ${task.id} completed!`);
 *     },
 *   },
 *   tools: [
 *     {
 *       name: "my_tool",
 *       description: "Does something useful",
 *       parameters: { type: "object", properties: { input: { type: "string" } } },
 *       execute: async (params, ctx) => ({
 *         content: [{ type: "text", text: `Processed: ${params.input}` }],
 *       }),
 *     },
 *   ],
 * });
 * ```
 */
export function definePlugin(plugin: FusionPlugin): FusionPlugin {
  return plugin;
}
