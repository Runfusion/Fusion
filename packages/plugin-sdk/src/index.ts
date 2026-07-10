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
  PluginTraitContribution,
  PluginTraitHookDescriptor,
  PluginTraitFlags,
  WorkflowExtensionContribution,
  WorkflowExtensionMetadata,
  WorkflowExtensionBaseContribution,
  WorkflowColumnMetadataExtensionContribution,
  WorkflowMovePolicyExtensionContribution,
  WorkflowWorkEngineExtensionContribution,
  WorkflowNodeHandlerExtensionContribution,
  TaskVerdictProviderExtensionContribution,
  AutoMergeFactProviderExtensionContribution,
  WorkflowExtensionConfigField,
  WorkflowExtensionConfigSchema,
  WorkflowExtensionFallback,
  WorkflowExtensionKind,
  WorkflowMovePolicyDecision,
  WorkflowMovePolicyInput,
  WorkflowMovePolicyHandler,
  WorkflowWorkEngineDispatchResult,
  WorkflowWorkEngineInput,
  WorkflowWorkEngineHandler,
  WorkflowNodeExtensionResult,
  WorkflowNodeHandlerInput,
  WorkflowNodeExtensionHandler,
  TaskVerdictStatus,
  TaskVerdictProviderInput,
  TaskVerdictProviderResult,
  TaskVerdictProviderHandler,
  AutoMergeRoute,
  AutoMergeFactProviderInput,
  AutoMergeFactProviderResult,
  AutoMergeFactProviderHandler,
  PluginPromptSurface,
  /**
   * FNXC:PluginPrompt 2026-07-10-00:00:
   * Re-export the core-authored PluginPromptContribution type so SDK consumers see the enforced `condition` grammar in generated declarations.
   */
  PluginPromptContribution,
  PluginPromptContributions,
  ExecutorRuntimeTaskContext,
  ExecutorRuntimeEnvContribution,
  PluginExecutorRuntimeEnvHook,
  PluginSetupStatus,
  PluginSetupCheckResult,
  PluginSetupHooks,
  PluginSetupManifest,
  FusionPlugin,
  PluginState,
  PluginInstallation,
  BoardActionServices,
  BoardActionTaskStore,
  MoveBoardTaskInput,
  UpdateBoardTaskInput,
} from "@fusion/core";

export {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  workflowExtensionRegistryId,
  createBoardActionServices,
} from "@fusion/core";

// ── Step-inversion IR types (type-only) ──────────────────────────────────────
// TYPE-ONLY re-exports of the workflow-modelable step constructs (KTD-3/12/13/15)
// so plugin authors can author/validate workflow IR and step parsers against the
// canonical shapes. These are erased at build time, so the standalone plugin-sdk
// artifact carries no @fusion runtime specifiers (see cli plugin-sdk-export test).
export type {
  // Graph IR primitives.
  WorkflowIr,
  WorkflowIrV1,
  WorkflowIrV2,
  WorkflowIrNode,
  WorkflowIrEdge,
  WorkflowIrNodeKind,
  // Columns + per-column permanent-agent binding (column-agent plan KTD-1, R12).
  WorkflowIrColumn,
  WorkflowIrColumnTrait,
  WorkflowColumnAgent,
  // Foreach / artifacts / custom fields (step inversion).
  WorkflowForeachConfig,
  WorkflowLoopConfig,
  WorkflowLoopExitCondition,
  WorkflowIrArtifact,
  WorkflowFieldDefinition,
  WorkflowFieldType,
  WorkflowFieldOption,
  WorkflowFieldRender,
  // Workflow settings (typed, workflow-declared policy schema; values persist
  // per-(workflowId, projectId) — mirrors the custom-field surface one level up).
  WorkflowSettingDefinition,
  WorkflowSettingType,
  WorkflowSettingOption,
  WorkflowSettingRender,
  // Step-parser contract.
  StepParser,
  StepParseResult,
  ParsedStep,
} from "@fusion/core";

import type { StepParseResult } from "@fusion/core";

/**
 * A plugin's step-parser contribution (KTD-12). A plugin's runtime loader returns
 * these from its `getPluginStepParsers` getter; the engine wraps each fail-closed
 * and registers it under `plugin:<pluginId>:<parserId>`. `parse` is SYNCHRONOUS
 * (project-local trust tier) and may throw on malformed input — a throw maps to a
 * routable `outcome:parse-error`.
 *
 * Structurally identical to the engine-side `PluginStepParserContribution` the
 * plugin runner consumes; defined here so plugin authors do not depend on the
 * engine package (the SDK depends on @fusion/core only).
 */
export interface PluginStepParserContribution {
  parserId: string;
  parse: (content: string) => StepParseResult;
}

import type { FusionPlugin } from "@fusion/core";

// NOTE (U8): trait-contribution VALIDATION lives in @fusion/core
// (validatePluginTraitContribution) and runs engine-side at registration.
// It is deliberately NOT re-exported here — plugin-sdk's built artifact must
// carry no @fusion runtime specifiers (see cli plugin-sdk-export test); only
// type-level re-exports are allowed from @fusion/core.

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
