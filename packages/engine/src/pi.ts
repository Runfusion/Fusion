/**
 * Shared pi SDK setup for hai engine agents.
 *
 * Uses the user's existing pi auth (API keys / OAuth from ~/.pi/agent/auth.json).
 * Provides factory functions for creating triage and executor agent sessions.
 */

import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

export interface AgentResult {
  session: AgentSession;
}

export interface AgentOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  customTools?: ToolDefinition[];
  onText?: (delta: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean) => void;
  /** Default model provider (e.g. "anthropic"). Used with `defaultModelId` to select a specific model. */
  defaultProvider?: string;
  /** Default model ID within the provider (e.g. "claude-sonnet-4-5"). Used with `defaultProvider`. */
  defaultModelId?: string;
}

/**
 * Create a pi agent session configured for hai.
 * Reuses the user's existing pi auth and model configuration.
 */
export async function createHaiAgent(options: AgentOptions): Promise<AgentResult> {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  const tools =
    options.tools === "readonly"
      ? createReadOnlyTools(options.cwd)
      : createCodingTools(options.cwd);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  // Resolve explicit model selection if provider and model ID are specified
  const selectedModel = options.defaultProvider && options.defaultModelId
    ? modelRegistry.find(options.defaultProvider, options.defaultModelId)
    : undefined;

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    authStorage,
    modelRegistry,
    resourceLoader,
    tools,
    customTools: options.customTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    ...(selectedModel ? { model: selectedModel } : {}),
  });

  // Wire up event listeners
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      options.onText?.(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      options.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);
    }
    if (event.type === "tool_execution_end") {
      options.onToolEnd?.(event.toolName, event.isError);
    }
  });

  return { session };
}
