/**
 * Paperclip Runtime Plugin - Type Definitions
 *
 * Re-exports runtime contract types from @fusion/engine and plugin types from @fusion/plugin-sdk.
 * These types define the interface that the Paperclip runtime adapter must implement.
 *
 * ## Type Sources
 *
 * - `AgentRuntime`, `AgentRuntimeOptions`, `AgentSessionResult`: from @fusion/engine (FN-2256 contract)
 * - `PluginRuntimeRegistration`, `PluginRuntimeManifestMetadata`, `FusionPlugin`: from @fusion/plugin-sdk
 *
 * ## Internal Types
 *
 * `AgentSession` and `ToolDefinition` are used internally in the adapter implementation
 * but are NOT re-exported here since they come from @mariozechner/pi-coding-agent,
 * which is not a direct dependency of this plugin. They are accessible via
 * `AgentSessionResult.session` and `AgentRuntimeOptions.customTools` respectively.
 */

// ── Agent Runtime Contract (from @fusion/engine) ──────────────────────────────

export type {
  /**
   * Agent runtime adapter interface.
   *
   * All session runtimes (default pi runtime, plugin-provided runtimes) must
   * implement this interface to ensure consistent behavior across engine subsystems.
   */
  AgentRuntime,
  /**
   * Options for creating an agent session.
   * Mirrors the options accepted by createFnAgent.
   */
  AgentRuntimeOptions,
  /**
   * Result of creating an agent session.
   */
  AgentSessionResult,
} from "@fusion/engine";

// ── Plugin Registration Types (from @fusion/plugin-sdk) ───────────────────────

export type {
  /**
   * Plugin runtime registration metadata.
   * Contains identity and versioning information for a runtime.
   */
  PluginRuntimeManifestMetadata,
  /**
   * Plugin runtime factory function.
   * Creates a runtime instance when the plugin is loaded.
   */
  PluginRuntimeFactory,
  /**
   * Plugin runtime registration with metadata and factory.
   * The primary registration format used by Fusion's plugin system.
   */
  PluginRuntimeRegistration,
  /**
   * Fusion plugin definition.
   * The main export type for all Fusion plugins.
   */
  FusionPlugin,
} from "@fusion/plugin-sdk";

// ── Note on describeModel ──────────────────────────────────────────────────────
//
// describeModel is NOT exported from @fusion/engine's public API.
// It is defined in packages/engine/src/pi.ts but only used internally.
// Plugin adapters should import describeModel directly from the relative path:
//   import { describeModel } from "../../engine/src/pi.js";
//
// This relative import is only valid within the monorepo workspace.
// External plugins would need a different approach.
