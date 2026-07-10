/**
 * Runtime resolution utilities for selecting and instantiating agent runtimes.
 *
 * Provides a resolution layer that:
 * 1. Looks up plugin-provided runtimes when a runtime hint is configured
 * 2. Falls back to the default pi runtime when no hint is provided or lookup fails
 * 3. Provides structured logging for debugging runtime selection decisions
 */

import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult } from "./agent-runtime.js";
import { normalizeAgentRuntimeMcpServers } from "./agent-runtime.js";
import type { PluginRunner } from "./plugin-runner.js";
import * as fusionCore from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createLogger } from "./logger.js";
import { createFnAgent, promptWithFallback, describeModel } from "./pi.js";

const MOCK_PROVIDER_ID = (() => {
  try {
    const value = Reflect.get(fusionCore as object, "MOCK_PROVIDER_ID");
    return typeof value === "string" && value.trim().length > 0 ? value : "mock";
  } catch {
    return "mock";
  }
})();

export function isMockProviderId(provider: string | undefined): boolean {
  return provider?.trim().toLowerCase() === MOCK_PROVIDER_ID;
}

/** Logger for the runtime resolution subsystem */
const runtimeLog = createLogger("runtime-resolver");

/**
 * Session purpose for runtime selection context.
 * Determines which runtime selection rules apply.
 */
export type SessionPurpose =
  | "executor"
  | "triage"
  | "reviewer"
  | "merger"
  | "heartbeat"
  | "validation";

/**
 * Context for runtime resolution.
 * Provides all information needed to select and configure a runtime.
 */
export interface RuntimeResolutionContext {
  /** Purpose of the session (affects runtime selection behavior) */
  sessionPurpose: SessionPurpose;
  /** Optional runtime hint (runtimeId) from task/agent configuration.
   *  When provided and non-empty, the resolver attempts to find a matching
   *  plugin runtime before falling back to the default. */
  runtimeHint?: string;
  /** PluginRunner for looking up plugin-provided runtimes */
  pluginRunner: PluginRunner;
}

/**
 * Result of runtime resolution.
 */
export interface ResolvedRuntime {
  /** The resolved runtime instance */
  runtime: AgentRuntime;
  /** Whether this runtime was explicitly configured via hint (vs. default) */
  wasConfigured: boolean;
  /** The runtime ID that was resolved */
  runtimeId: string;
  /**
   * When wasConfigured is false because a configured hint could not be
   * resolved, the reason for that fallback ("not_found" vs "factory_error").
   * Absent when there was no configured hint at all, or when hint was
   * "pi"/"default" (no fallback occurred).
   */
  fallbackReason?: FallbackReason;
}

/**
 * Reason for fallback when configured runtime is unavailable.
 */
export type FallbackReason =
  /** Runtime hint was provided but no matching runtime was found */
  | "not_found"
  /** Runtime factory function threw an error during instantiation */
  | "factory_error"
  /** Runtime was found but failed to initialize */
  | "init_error";

/**
 * Default pi-based runtime implementation.
 *
 * This runtime wraps the existing createFnAgent + promptWithFallback
 * implementation without any behavior changes. It serves as:
 * 1. The default runtime when no runtime hint is configured
 * 2. The fallback runtime when a configured plugin runtime is unavailable
 */
export class DefaultPiRuntime implements AgentRuntime {
  readonly id = "pi";
  readonly name = "Default PI Runtime";

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    // FNXC:McpConfig 2026-06-25-22:04:
    // DefaultPiRuntime is the typed bridge from shared AgentRuntimeOptions into createFnAgent. Normalize the legacy stdio ACP shape here so all lanes can pass the FN-7022 three-transport shape without breaking older Route A callers.
    return createFnAgent({
      ...options,
      mcpServers: normalizeAgentRuntimeMcpServers(options.mcpServers),
    });
  }

  async promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
    return promptWithFallback(session, prompt, options);
  }

  describeModel(session: AgentSession): string {
    return describeModel(session);
  }
}

/**
 * Singleton instance of the default pi runtime.
 * Reused across all resolution requests.
 */
let defaultPiRuntimeInstance: DefaultPiRuntime | null = null;

/**
 * Get the singleton default pi runtime instance.
 */
export function getDefaultPiRuntime(): AgentRuntime {
  if (!defaultPiRuntimeInstance) {
    defaultPiRuntimeInstance = new DefaultPiRuntime();
  }
  return defaultPiRuntimeInstance;
}

/**
 * Result of a plugin runtime lookup attempt: either a successfully resolved
 * runtime, or a miss carrying the distinguishing FallbackReason so callers
 * can tell "never registered" apart from "factory threw".
 */
type ResolvePluginRuntimeResult =
  | { ok: true; runtime: AgentRuntime; pluginId: string }
  | { ok: false; reason: FallbackReason };

/**
 * Resolve a plugin runtime by its runtimeId.
 *
 * @param pluginRunner - PluginRunner for looking up runtimes
 * @param runtimeId - The runtime ID to find
 * @returns The resolved runtime wrapper, or a miss tagged with the
 *          FallbackReason distinguishing "not_found" from "factory_error"
 */
async function resolvePluginRuntime(
  pluginRunner: PluginRunner,
  runtimeId: string,
): Promise<ResolvePluginRuntimeResult> {
  // Use the convenience method for single runtime lookup
  const registration = pluginRunner.getRuntimeById(runtimeId);
  if (!registration) {
    return { ok: false, reason: "not_found" };
  }

  const { pluginId, runtime } = registration;
  runtimeLog.log(`Found plugin runtime "${runtimeId}" from plugin "${pluginId}"`);

  try {
    // Create plugin context for runtime factory
    const pluginContext = await pluginRunner.createRuntimeContext(pluginId);
    if (!pluginContext) {
      // The registration exists (found above) but the plugin failed to produce a
      // usable context, so this is an initialization failure, not a "never
      // registered" miss -- must be distinguishable as "init_error".
      runtimeLog.warn(`Plugin "${pluginId}" runtime factory context unavailable`);
      return { ok: false, reason: "init_error" };
    }

    // Instantiate the runtime via factory
    const factoryResult = runtime.factory(pluginContext);
    const instance = await (factoryResult instanceof Promise ? factoryResult : Promise.resolve(factoryResult));

    if (!instance) {
      runtimeLog.warn(`Plugin "${pluginId}" runtime factory returned null`);
      return { ok: false, reason: "factory_error" };
    }

    // Wrap the plugin runtime to conform to AgentRuntime interface
    // The plugin may return its own interface, so we adapt if needed
    const wrappedRuntime = wrapPluginRuntime(instance, runtime.metadata.runtimeId, runtime.metadata.name);

    return { ok: true, runtime: wrappedRuntime, pluginId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtimeLog.error(`Plugin "${pluginId}" runtime factory error: ${message}`);
    return { ok: false, reason: "factory_error" };
  }
}

/**
 * Wrap a plugin runtime instance to conform to the AgentRuntime interface.
 *
 * Plugin runtimes may return their own interface types. This function
 * adapts them to the standard AgentRuntime interface.
 */
function wrapPluginRuntime(
  instance: unknown,
  runtimeId: string,
  runtimeName: string,
): AgentRuntime {
  // If it's already an AgentRuntime, return as-is
  if (isAgentRuntime(instance)) {
    return instance;
  }

  // Otherwise, wrap in a compatibility layer
  // The plugin should return something compatible with our interface
  // but we provide a defensive fallback
  runtimeLog.warn(`Plugin runtime "${runtimeId}" does not conform to AgentRuntime interface, wrapping with adapter`);

  return {
    id: runtimeId,
    name: runtimeName,
    createSession: async (options: AgentRuntimeOptions) => {
      const adapter = instance as Record<string, unknown>;
      if (typeof adapter.createSession === "function") {
        const result = await adapter.createSession(options);
        return {
          session: (result as AgentSessionResult).session ?? (result as AgentSession),
          sessionFile: (result as AgentSessionResult).sessionFile,
        };
      }
      throw new Error(`Plugin runtime "${runtimeId}" does not implement createSession`);
    },
    promptWithFallback: async (session: AgentSession, prompt: string, options?: unknown) => {
      const adapter = instance as Record<string, unknown>;
      if (typeof adapter.promptWithFallback === "function") {
        return adapter.promptWithFallback(session, prompt, options);
      }
      // Fallback to default pi promptWithFallback
      return promptWithFallback(session, prompt, options);
    },
    describeModel: (session: AgentSession) => {
      const adapter = instance as Record<string, unknown>;
      if (typeof adapter.describeModel === "function") {
        return (adapter.describeModel as (s: AgentSession) => string)(session);
      }
      // Fallback to default pi describeModel
      return describeModel(session);
    },
  };
}

/**
 * Type guard to check if an object conforms to AgentRuntime.
 */
function isAgentRuntime(obj: unknown): obj is AgentRuntime {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "id" in obj &&
    "name" in obj &&
    typeof (obj as AgentRuntime).createSession === "function" &&
    typeof (obj as AgentRuntime).promptWithFallback === "function" &&
    typeof (obj as AgentRuntime).describeModel === "function"
  );
}

/**
 * Resolve an agent runtime based on the resolution context.
 *
 * Resolution algorithm:
 * 1. If runtimeHint is provided and non-empty:
 *    a. Look up runtime by ID from plugin runner
 *    b. If found: instantiate and return with wasConfigured=true
 *    c. If not found: log structured warning, fall back to pi runtime
 * 2. If no runtimeHint:
 *    a. Return the default pi runtime with wasConfigured=false
 *
 * @param context - Resolution context with purpose, hint, and plugin runner
 * @returns The resolved runtime with metadata about how it was selected
 */
export async function resolveRuntime(context: RuntimeResolutionContext): Promise<ResolvedRuntime> {
  const { sessionPurpose, runtimeHint, pluginRunner } = context;

  // Case 1: No runtime hint provided — use default pi runtime
  if (!runtimeHint || runtimeHint.trim() === "") {
    runtimeLog.log(`[${sessionPurpose}] No runtime hint configured, using default pi runtime`);
    return {
      runtime: getDefaultPiRuntime(),
      wasConfigured: false,
      runtimeId: "pi",
    };
  }

  // Case 2: Runtime hint provided — try to find matching plugin runtime
  const runtimeId = runtimeHint.trim();

  // Check if the hint is explicitly "pi" — use default runtime
  if (runtimeId === "pi" || runtimeId === "default") {
    runtimeLog.log(`[${sessionPurpose}] Runtime hint is "pi/default", using default pi runtime`);
    return {
      runtime: getDefaultPiRuntime(),
      wasConfigured: true,
      runtimeId: "pi",
    };
  }

  // Look up the plugin runtime
  let fallbackReason: FallbackReason = "not_found";
  try {
    const resolved = await resolvePluginRuntime(pluginRunner, runtimeId);

    if (resolved.ok) {
      runtimeLog.log(`[${sessionPurpose}] Using configured plugin runtime "${runtimeId}" from "${resolved.pluginId}"`);
      return {
        runtime: resolved.runtime,
        wasConfigured: true,
        runtimeId,
      };
    }

    fallbackReason = resolved.reason;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtimeLog.error(`[${sessionPurpose}] Error resolving plugin runtime "${runtimeId}": ${message}`);
    fallbackReason = "factory_error";
  }

  // Case 3: Runtime not found or error — fall back to pi with warning
  logRuntimeFallback(sessionPurpose, runtimeId, fallbackReason);
  return {
    runtime: getDefaultPiRuntime(),
    wasConfigured: false,
    runtimeId: "pi",
    fallbackReason,
  };
}

/**
 * Log structured fallback warning when configured runtime is unavailable.
 */
function logRuntimeFallback(
  sessionPurpose: SessionPurpose,
  requestedRuntimeId: string,
  reason: FallbackReason,
): void {
  runtimeLog.warn(
    `[${sessionPurpose}] Runtime "${requestedRuntimeId}" unavailable (${reason}), falling back to default pi runtime`,
  );
}

/**
 * Build a RuntimeResolutionContext with a default plugin runner.
 *
 * When a subsystem has a pluginRunner, use this helper to create the context
 * with sensible defaults. The runtimeHint should come from the task/agent
 * configuration when available.
 *
 * @param sessionPurpose - The purpose of the session
 * @param pluginRunner - The plugin runner for runtime lookup
 * @param runtimeHint - Optional runtime hint from task/agent configuration
 * @returns The resolution context
 */
export function buildRuntimeResolutionContext(
  sessionPurpose: SessionPurpose,
  pluginRunner: PluginRunner | undefined,
  runtimeHint?: string,
): RuntimeResolutionContext {
  return {
    sessionPurpose,
    runtimeHint,
    pluginRunner: pluginRunner ?? createNoOpPluginRunner(),
  };
}

/**
 * Create a no-op plugin runner for subsystems that don't have access to the real one.
 * This allows the resolver to still return the default pi runtime.
 */
function createNoOpPluginRunner(): PluginRunner {
  return {
    getPluginRuntimes: () => [],
    getRuntimeById: () => undefined,
    createRuntimeContext: async () => null,
  } as unknown as PluginRunner;
}
