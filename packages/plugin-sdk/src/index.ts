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
  PluginOnSchemaInit,
  PluginOnTaskCreated,
  PluginOnTaskMoved,
  PluginOnTaskCompleted,
  PluginOnError,
  PluginToolDefinition,
  PluginToolResult,
  PluginRouteDefinition,
  PluginRouteMethod,
  PluginRouteResponse,
  PluginRouteResult,
  PluginUiSurface,
  PluginUiSlotDefinition,
  PluginUiContributionSurface,
  PluginUiContributionWhen,
  PluginUiActionDescriptor,
  SettingsProviderCardContribution,
  SettingsConfigSectionContribution,
  OnboardingProviderCardContribution,
  OnboardingSetupHelpContribution,
  OnboardingProviderRecommendationContribution,
  PostOnboardingRecommendationContribution,
  PluginUiContributionDefinition,
  PluginUiContributionInputDefinition,
  PluginDashboardViewDefinition,
  PluginRuntimeManifestMetadata,
  PluginRuntimeFactory,
  PluginRuntimeRegistration,
  CliProviderType,
  CliProviderActionMetadata,
  CliProviderProbeResult,
  CliProviderModelDiscoveryResult,
  CliProviderRuntimeRegistration,
  CliProviderContribution,
  PluginContext,
  PluginLogger,
  PluginSkillContribution,
  PluginWorkflowStepContribution,
  PluginPromptSurface,
  PluginPromptContribution,
  PluginPromptContributions,
  PluginSetupStatus,
  PluginSetupCheckResult,
  PluginSetupHooks,
  PluginSetupManifest,
  FusionPlugin,
  PluginState,
  PluginInstallation,
} from "@fusion/core";

import type { FusionPlugin } from "@fusion/core";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validatePluginManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (manifest === null || manifest === undefined) {
    return { valid: false, errors: ["Manifest is required"] };
  }

  if (typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;

  if (!m.id || typeof m.id !== "string" || m.id.trim() === "") {
    errors.push("id is required and must be a non-empty string");
  } else if (!SLUG_PATTERN.test(m.id)) {
    errors.push("id must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)");
  }

  if (!m.name || typeof m.name !== "string" || m.name.trim() === "") {
    errors.push("name is required and must be a non-empty string");
  }

  if (!m.version || typeof m.version !== "string" || m.version.trim() === "") {
    errors.push("version is required and must be a non-empty string");
  } else if (!/^\d+\.\d+\.\d+$/.test(m.version)) {
    errors.push("version must be a valid semver string (e.g., 1.0.0)");
  }

  return { valid: errors.length === 0, errors };
}

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
