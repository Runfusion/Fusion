/**
 * Shared pi SDK setup for fn engine agents.
 *
 * Uses Fusion auth for writes and legacy pi auth as a read-only fallback.
 * Provides factory functions for creating triage and executor agent sessions.
 */
import { SessionManager, type AgentSession, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type SkillSelectionContext } from "./skill-resolver.js";
export interface AgentResult {
    session: AgentSession;
    /** Path to the persisted session file (undefined for in-memory sessions). */
    sessionFile?: string;
}
export interface PromptableSession extends AgentSession {
    promptWithFallback: (prompt: string, options?: unknown) => Promise<void>;
}
export declare function promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
/**
 * Extract a human-readable model description from an AgentSession.
 * Returns `"<provider>/<modelId>"` (e.g. `"anthropic/claude-sonnet-4-5"`)
 * or `"unknown model"` when the session has no model set.
 */
export declare function describeModel(session: AgentSession): string;
/**
 * Default instructions used when calling `session.compact()` for loop recovery.
 * These guide the compaction summary to preserve essential context while
 * freeing up the context window for continued work.
 */
export declare const COMPACTION_FALLBACK_INSTRUCTIONS: string;
/**
 * Compact an agent session's context to free up the context window.
 *
 * Uses the SDK's native `session.compact()` method when available (the
 * preferred path — it produces structured, LLM-generated summaries).
 *
 * @param session — The agent session to compact
 * @param customInstructions — Optional instructions for the compaction summary.
 *   When not provided, uses COMPACTION_FALLBACK_INSTRUCTIONS.
 * @returns The compaction result with summary and token metrics, or null if
 *   compaction was not available or failed.
 */
export declare function compactSessionContext(session: AgentSession, customInstructions?: string): Promise<{
    summary: string;
    tokensBefore: number;
} | null>;
export interface AgentOptions {
    cwd: string;
    systemPrompt: string;
    tools?: "coding" | "readonly";
    customTools?: ToolDefinition[];
    onText?: (delta: string) => void;
    onThinking?: (delta: string) => void;
    onToolStart?: (name: string, args?: Record<string, unknown>) => void;
    onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
    /** Default model provider (e.g. "anthropic"). Used with `defaultModelId` to select a specific model. */
    defaultProvider?: string;
    /** Default model ID within the provider (e.g. "claude-sonnet-4-5"). Used with `defaultProvider`. */
    defaultModelId?: string;
    /** Optional fallback model provider used when the primary selected model hits
     *  a retryable provider-side failure such as rate limiting or overload. */
    fallbackProvider?: string;
    /** Optional fallback model ID used with `fallbackProvider`. */
    fallbackModelId?: string;
    /** Default thinking effort level (e.g. "medium", "high"). When provided, sets the session's thinking level after creation. */
    defaultThinkingLevel?: string;
    /** Optional pre-configured SessionManager. When provided, the agent session
     *  uses this instead of creating an in-memory session. Pass a file-based
     *  SessionManager to enable session persistence and pause/resume. */
    sessionManager?: SessionManager;
    /** Optional skill selection context. When provided, the agent session's
     *  skills are filtered according to project execution settings and any
     *  caller-requested skill names. Omit to use default skill discovery
     *  (all discovered skills included). */
    skillSelection?: SkillSelectionContext;
    /** Convenience: skill names to include in the session. When provided
     *  (and `skillSelection` is not), auto-constructs a SkillSelectionContext
     *  from the cwd and these names. Ignored when `skillSelection` is set. */
    skills?: string[];
}
/**
 * Wrap tools with worktree boundary validation.
 * When cwd is a worktree path, file operations are validated against worktree boundaries.
 *
 * @param tools - Array of tool definitions to wrap
 * @param worktreePath - Absolute path to the worktree directory (if applicable)
 * @param projectRoot - Absolute path to the project root (if applicable)
 * @returns Wrapped tools with boundary validation
 */
export declare function wrapToolsWithBoundary(tools: ToolDefinition[], worktreePath: string | null, projectRoot: string | null): ToolDefinition[];
/**
 * Create a pi agent session configured for fn.
 * Reuses the user's existing pi auth and model configuration.
 */
export declare function createFnAgent(options: AgentOptions): Promise<AgentResult>;
//# sourceMappingURL=pi.d.ts.map