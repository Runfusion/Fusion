/**
 * Plugin System Type Definitions for Fusion
 *
 * This module defines all types for the Fusion plugin system, including:
 * - PluginManifest: metadata and capability declaration
 * - Plugin hooks: lifecycle callbacks
 * - Plugin tools: AI agent tool definitions
 * - Plugin routes: custom dashboard API routes
 * - PluginContext: API surface available to plugins at runtime
 * - FusionPlugin: loaded plugin instance
 * - PluginInstallation: persisted plugin record
 */

import type { TaskStore } from "./store.js";

// ── Plugin Manifest ───────────────────────────────────────────────────

/**
 * Metadata and capability declaration for a plugin.
 */
export interface PluginManifest {
  /** Unique identifier (e.g., "fusion-plugin-slack") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semver version string */
  version: string;
  /** Short description */
  description?: string;
  /** Author name or org */
  author?: string;
  /** URL to plugin docs/repo */
  homepage?: string;
  /** Minimum Fusion version required */
  fusionVersion?: string;
  /** IDs of other plugins this depends on */
  dependencies?: string[];
  /** Settings schema for validation */
  settingsSchema?: Record<string, PluginSettingSchema>;
}

// ── Plugin Setting Schema ──────────────────────────────────────────────

export type PluginSettingType = "string" | "number" | "boolean" | "enum" | "password" | "array";

/**
 * Schema for a single plugin setting.
 */
export interface PluginSettingSchema {
  type: PluginSettingType;
  /** Human-readable label for UI */
  label?: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
  /** Only when type is "enum" */
  enumValues?: string[];
  /** Only when type is "string" - renders as textarea when true */
  multiline?: boolean;
  /** Only when type is "array" - type of items in the array */
  itemType?: "string" | "number";
}

// ── Plugin Hooks ─────────────────────────────────────────────────────

/**
 * Context object passed to plugins at runtime.
 * Contains task store access, settings, logging, and event emission.
 */
export interface PluginContext {
  pluginId: string;
  /** Read-only access to task data */
  taskStore: TaskStore;
  /** Plugin's own settings */
  settings: Record<string, unknown>;
  /** Structured logger */
  logger: PluginLogger;
  /** Emit custom events */
  emitEvent: (event: string, data: unknown) => void;
}

/**
 * Structured logger interface for plugins.
 */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/** Lifecycle hook: called when plugin is loaded */
export type PluginOnLoad = (ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when plugin is unloaded */
export type PluginOnUnload = () => Promise<void> | void;
/** Lifecycle hook: called when a task is created */
export type PluginOnTaskCreated = (task: Task, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when a task moves between columns */
export type PluginOnTaskMoved = (task: Task, fromColumn: string, toColumn: string, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when a task is completed */
export type PluginOnTaskCompleted = (task: Task, ctx: PluginContext) => Promise<void> | void;
/** Lifecycle hook: called when an error occurs */
export type PluginOnError = (error: Error, ctx: PluginContext) => Promise<void> | void;

// ── Plugin Tools ─────────────────────────────────────────────────────

/**
 * Tool registration for AI agents.
 * Tools are prefixed with "plugin_" at runtime.
 */
export interface PluginToolDefinition {
  /** Tool name (prefixed with "plugin_" at runtime) */
  name: string;
  /** Description for the AI agent */
  description: string;
  /** TypeBox-style parameter schema */
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>, ctx: PluginContext) => Promise<PluginToolResult>;
}

/**
 * Result returned by a plugin tool execution.
 */
export interface PluginToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

// ── Plugin Routes ────────────────────────────────────────────────────

export type PluginRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Custom dashboard API route definition.
 */
export interface PluginRouteDefinition {
  method: PluginRouteMethod;
  /** Relative path under /api/plugins/:pluginId/ */
  path: string;
  handler: (req: unknown, ctx: PluginContext) => Promise<unknown>;
  description?: string;
}

// ── Fusion Plugin ────────────────────────────────────────────────────

export type PluginState = "installed" | "started" | "stopped" | "error";

/**
 * Loaded plugin instance with all hooks, tools, and routes.
 */
export interface FusionPlugin {
  manifest: PluginManifest;
  state: PluginState;
  hooks: {
    onLoad?: PluginOnLoad;
    onUnload?: PluginOnUnload;
    onTaskCreated?: PluginOnTaskCreated;
    onTaskMoved?: PluginOnTaskMoved;
    onTaskCompleted?: PluginOnTaskCompleted;
    onError?: PluginOnError;
  };
  tools?: PluginToolDefinition[];
  routes?: PluginRouteDefinition[];
}

// ── Plugin Installation ───────────────────────────────────────────────

/**
 * Persisted plugin record in the store.
 */
export interface PluginInstallation {
  /** Same as manifest.id */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Absolute path to plugin directory or npm package */
  path: string;
  enabled: boolean;
  state: PluginState;
  settings: Record<string, unknown>;
  settingsSchema?: Record<string, PluginSettingSchema>;
  /** Last error message (if state is "error") */
  error?: string;
  dependencies?: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Manifest Validation ──────────────────────────────────────────────

/**
 * Validate a plugin manifest.
 *
 * @returns Object with valid=true and empty errors array on success,
 *          or valid=false with descriptive error messages on failure.
 */
export function validatePluginManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (manifest === null || manifest === undefined) {
    return { valid: false, errors: ["Manifest is required"] };
  }

  if (typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;

  // Required fields
  if (!m.id || typeof m.id !== "string" || m.id.trim() === "") {
    errors.push("id is required and must be a non-empty string");
  } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(m.id)) {
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

  // Optional: dependencies
  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies)) {
      errors.push("dependencies must be an array");
    } else {
      const invalidDeps = m.dependencies.filter(
        (d) => typeof d !== "string" || d.trim() === "",
      );
      if (invalidDeps.length > 0) {
        errors.push("All dependencies must be non-empty strings");
      }
    }
  }

  // Optional: settingsSchema
  if (m.settingsSchema !== undefined) {
    if (typeof m.settingsSchema !== "object" || m.settingsSchema === null) {
      errors.push("settingsSchema must be an object");
    } else {
      const settingsSchema = m.settingsSchema as Record<string, unknown>;
      for (const [key, schema] of Object.entries(settingsSchema)) {
        if (!schema || typeof schema !== "object") {
          errors.push(`settingsSchema.${key} must be an object`);
          continue;
        }
        const setting = schema as Record<string, unknown>;
        if (!setting.type || !["string", "number", "boolean", "enum", "password", "array"].includes(setting.type as string)) {
          errors.push(`settingsSchema.${key}.type must be one of: string, number, boolean, enum, password, array`);
        }
        if (setting.type === "enum" && (!Array.isArray(setting.enumValues) || setting.enumValues.length === 0)) {
          errors.push(`settingsSchema.${key}.enumValues is required and must be a non-empty array when type is enum`);
        }
        if (setting.type === "array" && (!setting.itemType || !["string", "number"].includes(setting.itemType as string))) {
          errors.push(`settingsSchema.${key}.itemType is required and must be "string" or "number" when type is array`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ── Re-export Task type for hook signatures ───────────────────────────
// The Task type is used in hook signatures; we import it via types.js
import type { Task } from "./types.js";
