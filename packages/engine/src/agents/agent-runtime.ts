/**
 * Agent runtime adapter abstraction layer.
 *
 * Provides a typed interface for creating and managing agent sessions
 * across different runtime implementations (default pi runtime, plugin-provided runtimes).
 *
 * ## Interface Contract
 *
 * All runtimes must implement:
 * - `id`: Unique runtime identifier (e.g., "pi", "code-interpreter")
 * - `name`: Human-readable name
 * - `createSession()`: Create a new agent session
 * - `promptWithFallback()`: Prompt with automatic retry/compaction
 * - `describeModel()`: Get model description from session
 */

import type { AgentSession, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PermanentAgentGatingContext, ResolvedMcpServerDefinition } from "@fusion/core";
import type { SkillSelectionContext } from "../cli-runtime/skill-resolver.js";
import type { FallbackModelUsedPayload } from "../pi.js";
import type { AgentActionGateContext } from "./agent-action-gate.js";
import type { SystemPromptLayers } from "../execution/prompt-layers.js";

/**
 * Options for creating an agent session.
 * Mirrors the options accepted by createFnAgent.
 */
export interface AgentRuntimeContext {
  sessionPurpose?: string;
  toolMode?: "coding" | "readonly";
  customToolNames?: string[];
  requestedSkillNames?: string[];
}

/**
 * A stdio MCP server forwarded to a runtime's agent session (U10 — Route A ACP).
 * `env` is explicit name/value pairs; inherited `process.env` is never forwarded.
 * Runtimes that don't speak MCP ignore this field.
 */
export interface AgentMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export type AgentRuntimeMcpServerConfig = ResolvedMcpServerDefinition | AgentMcpServerConfig;

export function normalizeAgentRuntimeMcpServers(
  servers: AgentRuntimeMcpServerConfig[] | undefined,
): ResolvedMcpServerDefinition[] | undefined {
  if (!servers || servers.length === 0) return undefined;
  return servers.map((server) => {
    if ("transport" in server) return server;
    return {
      name: server.name,
      transport: "stdio",
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
    };
  });
}

export interface AgentRuntimeOptions {
  /** Working directory for the agent session */
  cwd: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /*
  FNXC:MergeQueue 2026-07-15-11:08:
  Session purpose must reach createFnAgent so merger lanes can skip host-extension fn_* tools.
  Those tools boot a second TaskStore via createTaskStoreForBackend and have been observed wedging merges on hung fn_task_show (no per-tool timeout, AbortSignal ignored).
  */
  /** Lane purpose (executor/merger/triage/…). Used for host-extension policy and diagnostics. */
  sessionPurpose?: string;
  /**
   * Optional structured prompt layers for cross-session caching.
   * When present, runtimes that support prompt caching use the `stable`
   * layer as a cacheable prefix and the `dynamic` layer as the per-session
   * suffix. Runtimes that don't support caching ignore this and use
   * `systemPrompt` (the collapsed string) instead.
   *
   * Callers MUST also provide `systemPrompt` as the collapsed equivalent
   * for backward compatibility.
   */
  systemPromptLayers?: SystemPromptLayers;
  /** Tool set to use: "coding" for full tools, "readonly" for read-only access */
  tools?: "coding" | "readonly";
  /** Additional custom tools to merge with the base toolset */
  customTools?: ToolDefinition[];
  /** Callback for text output from the agent */
  onText?: (delta: string) => void;
  /** Callback for thinking/thought output from the agent */
  onThinking?: (delta: string) => void;
  /** Callback when a tool starts execution */
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  /** Callback when a tool finishes execution */
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
  /** Default model provider (e.g. "anthropic") */
  defaultProvider?: string;
  /** Default model ID within the provider (e.g. "claude-sonnet-4-5") */
  defaultModelId?: string;
  /** Optional fallback model provider for retryable errors */
  fallbackProvider?: string;
  /** Optional fallback model ID */
  fallbackModelId?: string;
  /**
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Runtime session options carry the fallback model's own thinking level so a fallback swap can apply it, or fall back to `defaultThinkingLevel` when unset.
   */
  fallbackThinkingLevel?: string;
  /** Default thinking effort level (e.g. "medium", "high") */
  defaultThinkingLevel?: string;
  /** Optional pre-configured SessionManager for persistence */
  sessionManager?: SessionManager;
  /** Optional skill selection context */
  skillSelection?: SkillSelectionContext;
  /** Convenience: skill names to include in the session */
  skills?: string[];
  /** Extra directories to scan for skills (each holding `<id>/SKILL.md`), in
   *  addition to the default cwd/agent-dir roots. Forwarded to the resource
   *  loader so caller-requested `skills`/`skillSelection` names installed to a
   *  private dir (e.g. a plugin's bundled-skill root) are discoverable in the
   *  live session. Mirrors `AgentOptions.additionalSkillPaths` in pi.ts. */
  additionalSkillPaths?: string[];
  /** Runtime-facing context for non-pi runtimes that cannot consume JS ToolDefinition objects directly. */
  runtimeContext?: AgentRuntimeContext;
  /**
   * MCP servers to forward to the runtime's agent session. New callers pass the
   * FN-7022 resolved/materialized three-transport shape; the legacy U10 Route A
   * stdio-only ACP shape remains accepted as a subset/adapter.
   *
   * FNXC:McpConfig 2026-06-25-21:55:
   * All AI lanes share this runtime option so executor, reviewer, validator,
   * merger, workflow-node, summarization, evaluator, planning, and chat sessions
   * receive the same trusted MCP server set when their selected runtime supports
   * MCP. Runtime implementations that cannot consume MCP must skip it without
   * logging server contents.
   */
  mcpServers?: AgentRuntimeMcpServerConfig[];
  /** Optional task-scoped environment variables for session-local subprocesses. */
  taskEnv?: NodeJS.ProcessEnv;
  /**
   * Last-chance abort hook fired by the runtime *immediately before* the
   * underlying LLM session is instantiated — i.e., after all of the runtime's
   * own awaited setup work (provider registration, resource loading, etc.).
   * Throw from this callback to cancel session creation.
   *
   * Runtimes SHOULD invoke this hook at their latest synchronous decision
   * point so callers can enforce time-sensitive predicates (notably the
   * engine pause flag) without a TOCTOU window between an outer check and
   * the actual session spawn. Runtimes that ignore this hook degrade
   * gracefully — the caller's outer check still fires before
   * `runtime.createSession()` is invoked, so the abort window is bounded by
   * the runtime's internal setup latency rather than unbounded.
   */
  beforeSpawnSession?: () => Promise<void> | void;
  /** Callback fired when runtime falls back from primary model to fallback model. */
  onFallbackModelUsed?: (payload: FallbackModelUsedPayload) => Promise<void> | void;
  /** Optional task context for fallback notifications. */
  taskId?: string;
  taskTitle?: string;
  actionGateContext?: AgentActionGateContext;
  /** Permanent-agent action gating context for v1 category classification enforcement. */
  permanentAgentGating?: PermanentAgentGatingContext;
}

/**
 * Result of creating an agent session.
 */
export interface AgentPromptResult {
  stopReason?: string;
}

export interface AgentSessionResult {
  /** The created agent session */
  session: AgentSession;
  /** Path to the persisted session file (undefined for in-memory sessions) */
  sessionFile?: string;
}

/**
 * Agent runtime adapter interface.
 *
 * All session runtimes (default pi runtime, plugin-provided runtimes) must
 * implement this interface to ensure consistent behavior across engine subsystems.
 *
 * ## Implementation Notes
 *
 * - `createSession()` should return a fully initialized session ready for prompting
 * - `promptWithFallback()` should handle retry/compaction automatically
 * - `describeModel()` should return a human-readable model identifier
 */
export interface AgentRuntime {
  /** Unique runtime identifier (e.g., "pi", "code-interpreter", "web-search") */
  readonly id: string;
  /** Human-readable name for the runtime */
  readonly name: string;

  /**
   * Create a new agent session.
   *
   * @param options - Session creation options
   * @returns Promise resolving to the session result
   */
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;

  /**
   * Prompt the session with user input.
   *
   * Implementations should handle:
   * - Automatic retry on transient errors
   * - Context compaction on context limit errors
   * - Model fallback on retryable model selection errors
   *
   * @param session - The session to prompt
   * @param prompt - The prompt text
   * @param options - Optional prompt options (e.g., images for vision)
   */
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void | AgentPromptResult>;

  /**
   * Get a human-readable model description from a session.
   *
   * @param session - The session to describe
   * @returns Model description (e.g., "anthropic/claude-sonnet-4-5") or "unknown model"
   */
  describeModel(session: AgentSession): string;
}
