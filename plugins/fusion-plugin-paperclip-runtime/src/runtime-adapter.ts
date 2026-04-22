/**
 * Paperclip Runtime Adapter
 *
 * Implements the AgentRuntime interface for Fusion's plugin system, providing
 * AI agent sessions backed by the user's configured pi provider and model.
 *
 * ## Responsibilities
 *
 * - Wraps `createFnAgent` from the engine's pi module
 * - Delegates `promptWithFallback` to the pi implementation
 * - Provides model description via pi's `describeModel`
 * - Handles session disposal when explicitly requested
 *
 * ## Usage
 *
 * ```typescript
 * import { PaperclipRuntimeAdapter } from "./runtime-adapter.js";
 *
 * const adapter = new PaperclipRuntimeAdapter();
 * const { session } = await adapter.createSession({
 *   cwd: process.cwd(),
 *   systemPrompt: "You are a helpful assistant",
 *   skills: ["bash", "read"],
 * });
 *
 * await adapter.promptWithFallback(session, "Hello, world!");
 * console.log(adapter.describeModel(session)); // e.g., "anthropic/claude-sonnet-4-5"
 *
 * await adapter.dispose(session);
 * ```
 */

import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult } from "./types.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

// ── describeModel (from pi.ts, not re-exported from @fusion/engine) ─────────────
//
// describeModel is defined in packages/engine/src/pi.ts but is NOT exported from
// the @fusion/engine public API. We import it via relative path for use in the adapter.
// This is acceptable within the monorepo workspace. External plugins would need a
// different approach (e.g., the engine could export it publicly in the future).
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { describeModel: getModelDescription } = require("../../engine/src/pi.js");

/**
 * Paperclip runtime adapter implementing the Fusion AgentRuntime interface.
 *
 * This adapter wraps the existing pi agent creation and session management,
 * making it available through Fusion's plugin runtime system.
 *
 * ## Disposal Semantics
 *
 * The `dispose()` method is provided as an extension to the AgentRuntime interface.
 * Engine session consumers may call `dispose()` to clean up sessions when done.
 * If the session doesn't support disposal, this is a no-op.
 */
export class PaperclipRuntimeAdapter implements AgentRuntime {
  /** Unique runtime identifier */
  readonly id = "paperclip";

  /** Human-readable runtime name */
  readonly name = "Paperclip Runtime";

  /**
   * Create a new agent session using the pi backend.
   *
   * @param options - Session creation options including cwd, systemPrompt, model selection, and skills
   * @returns Promise resolving to the session result with session and optional sessionFile
   */
  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const { createFnAgent } = await import("@fusion/engine");
    return createFnAgent({
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      customTools: options.customTools,
      onText: options.onText,
      onThinking: options.onThinking,
      onToolStart: options.onToolStart,
      onToolEnd: options.onToolEnd,
      defaultProvider: options.defaultProvider,
      defaultModelId: options.defaultModelId,
      fallbackProvider: options.fallbackProvider,
      fallbackModelId: options.fallbackModelId,
      defaultThinkingLevel: options.defaultThinkingLevel,
      sessionManager: options.sessionManager,
      skillSelection: options.skillSelection,
      skills: options.skills,
    });
  }

  /**
   * Prompt the session with user input, with automatic retry and compaction.
   *
   * Delegates to the pi backend's promptWithFallback implementation which handles:
   * - Automatic retry on transient errors
   * - Context compaction on context limit errors
   * - Model fallback on retryable model selection errors
   *
   * @param session - The agent session to prompt
   * @param prompt - The prompt text
   * @param options - Optional prompt options (e.g., images for vision)
   */
  async promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
    const { promptWithFallback: pwf } = await import("@fusion/engine");
    return pwf(session, prompt, options);
  }

  /**
   * Get a human-readable model description from a session.
   *
   * Returns the model in the format `"<provider>/<modelId>"`
   * or `"unknown model"` when the session has no model set.
   *
   * @param session - The agent session to describe
   * @returns Model description string
   */
  describeModel(session: AgentSession): string {
    return getModelDescription(session);
  }

  /**
   * Dispose of an agent session.
   *
   * Calls `session.dispose()` if the session supports disposal,
   * otherwise this is a no-op. This extension method provides
   * explicit cleanup semantics expected by engine session consumers.
   *
   * @param session - The agent session to dispose
   */
  async dispose(session: AgentSession): Promise<void> {
    if (typeof (session as { dispose?: () => Promise<void> }).dispose === "function") {
      await (session as { dispose: () => Promise<void> }).dispose();
    }
  }
}
