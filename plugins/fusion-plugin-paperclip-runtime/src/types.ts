/**
 * Paperclip Runtime Plugin - Type Definitions
 *
 * The plugin runtime contract is defined locally in this example plugin to avoid
 * a hard compile-time dependency on internal engine package exports.
 */

// ── Local Agent Runtime Contract ──────────────────────────────────────────────

/** Minimal session shape used by the runtime adapter. */
export interface AgentSession {
  dispose?: () => Promise<void> | void;
}

/** Options for creating an agent session. Mirrors createFnAgent inputs used by the adapter. */
export interface AgentRuntimeOptions {
  cwd: string;
  systemPrompt: string;
  tools?: unknown;
  customTools?: unknown;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultThinkingLevel?: string;
  sessionManager?: unknown;
  skillSelection?: unknown;
  skills?: string[];
}

/** Result of creating a session. */
export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

/** Agent runtime adapter interface. */
export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}

// ── Plugin Registration Types (from @fusion/plugin-sdk) ─────────────────────

export type {
  PluginRuntimeManifestMetadata,
  PluginRuntimeFactory,
  PluginRuntimeRegistration,
  FusionPlugin,
} from "@fusion/plugin-sdk";
