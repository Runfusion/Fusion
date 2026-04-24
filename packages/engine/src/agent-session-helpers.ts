/**
 * Helper functions for creating agent sessions with runtime resolution.
 *
 * These helpers wrap the runtime resolution pattern so that subsystems
 * don't need to duplicate the resolution logic. They use the resolver
 * to select the appropriate runtime and then delegate to it for session
 * creation and prompting.
 */

import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type { PluginRunner } from "./plugin-runner.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { resolveRuntime, buildRuntimeResolutionContext, type SessionPurpose } from "./runtime-resolution.js";
import { createLogger } from "./logger.js";

/** Logger for agent session helpers */
const sessionLog = createLogger("agent-session");

/**
 * Options for creating an agent session with runtime resolution.
 */
export interface ResolvedSessionOptions extends AgentRuntimeOptions {
  /** Session purpose for runtime selection */
  sessionPurpose: SessionPurpose;
  /** Plugin runner for runtime lookup. When provided, enables plugin runtime selection. */
  pluginRunner?: PluginRunner;
  /** Optional runtime hint from task/agent configuration */
  runtimeHint?: string;
}

/**
 * Result of creating an agent session with runtime resolution.
 */
export interface ResolvedSessionResult {
  /** The created agent session */
  session: AgentSession;
  /** Path to the persisted session file (undefined for in-memory sessions) */
  sessionFile?: string;
  /** The runtime ID that was used */
  runtimeId: string;
  /** Whether the runtime was explicitly configured */
  wasConfigured: boolean;
}

/**
 * Create an agent session using runtime resolution.
 *
 * This function:
 * 1. Resolves the appropriate runtime based on sessionPurpose, runtimeHint, and pluginRunner
 * 2. Creates the session using the resolved runtime
 * 3. Returns the session along with metadata about which runtime was used
 *
 * @param options - Session creation options including purpose and runtime configuration
 * @returns Promise resolving to the session result with runtime metadata
 */
export async function createResolvedAgentSession(
  options: ResolvedSessionOptions,
): Promise<ResolvedSessionResult> {
  const { sessionPurpose, pluginRunner, runtimeHint, ...runtimeOptions } = options;

  // Build the resolution context
  const context = buildRuntimeResolutionContext(sessionPurpose, pluginRunner, runtimeHint);

  // Resolve the runtime
  const resolved = await resolveRuntime(context);

  sessionLog.log(
    `[${sessionPurpose}] Using runtime "${resolved.runtimeId}" (configured=${resolved.wasConfigured})`,
  );

  // Create the session using the resolved runtime
  const result = await resolved.runtime.createSession(runtimeOptions);

  return {
    session: result.session,
    sessionFile: result.sessionFile,
    runtimeId: resolved.runtimeId,
    wasConfigured: resolved.wasConfigured,
  };
}

/**
 * Prompt an agent session with automatic retry and compaction.
 *
 * This is a convenience wrapper that delegates to the runtime's promptWithFallback.
 *
 * @param session - The session to prompt
 * @param prompt - The prompt text
 * @param options - Optional prompt options (e.g., images)
 */
export async function promptWithAutoRetry(
  session: AgentSession,
  prompt: string,
  options?: unknown,
): Promise<void> {
  // Dynamic import to get the default runtime's promptWithFallback
  // This works because the default runtime delegates to the existing implementation
  const { promptWithFallback: pwf } = await import("./pi.js");
  return pwf(session, prompt, options);
}

/**
 * Get a human-readable model description from a session.
 *
 * @param session - The session to describe
 * @returns Model description string
 */
export async function describeAgentModel(session: AgentSession): Promise<string> {
  const { describeModel: dm } = await import("./pi.js");
  return dm(session);
}
