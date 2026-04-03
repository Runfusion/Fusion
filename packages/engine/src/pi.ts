/**
 * Shared pi SDK setup for kb engine agents.
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

export interface PromptableSession extends AgentSession {
  promptWithFallback: (prompt: string, options?: unknown) => Promise<void>;
}

export async function promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
  const maybePromptable = session as Partial<PromptableSession>;
  if (typeof maybePromptable.promptWithFallback === "function") {
    await maybePromptable.promptWithFallback(prompt, options);
    return;
  }

  if (options === undefined) {
    await session.prompt(prompt);
  } else {
    await (session.prompt as any)(prompt, options);
  }
}

/**
 * Extract a human-readable model description from an AgentSession.
 * Returns `"<provider>/<modelId>"` (e.g. `"anthropic/claude-sonnet-4-5"`)
 * or `"unknown model"` when the session has no model set.
 */
export function describeModel(session: AgentSession): string {
  const model = session.model;
  if (!model) return "unknown model";
  return `${model.provider}/${model.id}`;
}

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
}

function isRetryableModelSelectionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("rate limit")
    || normalized.includes("too many requests")
    || normalized.includes("429")
    || normalized.includes("overloaded")
    || normalized.includes("quota")
    || normalized.includes("capacity")
    || normalized.includes("temporarily unavailable");
}

/**
 * Create a pi agent session configured for kb.
 * Reuses the user's existing pi auth and model configuration.
 */
export async function createKbAgent(options: AgentOptions): Promise<AgentResult> {
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
  const fallbackModel = options.fallbackProvider && options.fallbackModelId
    ? modelRegistry.find(options.fallbackProvider, options.fallbackModelId)
    : undefined;

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const createSessionWithModel = async (modelOverride?: typeof selectedModel) => {
    return createAgentSession({
      cwd: options.cwd,
      authStorage,
      modelRegistry,
      resourceLoader,
      tools,
      customTools: options.customTools,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      ...(modelOverride ? { model: modelOverride } : {}),
    });
  };

  let sessionResult;
  let usingFallback = false;
  try {
    sessionResult = await createSessionWithModel(selectedModel);
  } catch (err: any) {
    if (!fallbackModel || !selectedModel || !isRetryableModelSelectionError(err?.message || "")) {
      throw err;
    }
    usingFallback = true;
    sessionResult = await createSessionWithModel(fallbackModel);
  }

  const { session } = sessionResult;
  const promptableSession = session as PromptableSession;

  promptableSession.promptWithFallback = async (prompt: string, promptOptions?: unknown) => {
    try {
      if (promptOptions === undefined) {
        await session.prompt(prompt);
      } else {
        await (session.prompt as any)(prompt, promptOptions);
      }
      return;
    } catch (err: any) {
      if (!fallbackModel || usingFallback || !isRetryableModelSelectionError(err?.message || "")) {
        throw err;
      }

      usingFallback = true;
      try {
        session.dispose();
      } catch {
        // ignore dispose errors while swapping sessions
      }

      const fallbackSessionResult = await createSessionWithModel(fallbackModel);
      const fallbackSession = fallbackSessionResult.session as PromptableSession;

      if (options.defaultThinkingLevel) {
        fallbackSession.setThinkingLevel(options.defaultThinkingLevel as any);
      }

      fallbackSession.subscribe((event) => {
        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            options.onText?.(msgEvent.delta);
          } else if (msgEvent.type === "thinking_delta") {
            options.onThinking?.(msgEvent.delta);
          }
        }
        if (event.type === "tool_execution_start") {
          options.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);
        }
        if (event.type === "tool_execution_end") {
          options.onToolEnd?.(event.toolName, event.isError, event.result);
        }
      });

      Object.setPrototypeOf(promptableSession, Object.getPrototypeOf(fallbackSession));
      Object.assign(promptableSession, fallbackSession);
      promptableSession.promptWithFallback = fallbackSession.promptWithFallback ?? promptableSession.promptWithFallback;

      if (promptOptions === undefined) {
        await fallbackSession.prompt(prompt);
      } else {
        await (fallbackSession.prompt as any)(prompt, promptOptions);
      }
    }
  };

  // Apply thinking level if specified
  if (options.defaultThinkingLevel) {
    promptableSession.setThinkingLevel(options.defaultThinkingLevel as any);
  }

  // Wire up event listeners
  promptableSession.subscribe((event) => {
    if (event.type === "message_update") {
      const msgEvent = event.assistantMessageEvent;
      if (msgEvent.type === "text_delta") {
        options.onText?.(msgEvent.delta);
      } else if (msgEvent.type === "thinking_delta") {
        options.onThinking?.(msgEvent.delta);
      }
    }
    if (event.type === "tool_execution_start") {
      options.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);
    }
    if (event.type === "tool_execution_end") {
      options.onToolEnd?.(event.toolName, event.isError, event.result);
    }
  });

  return { session: promptableSession };
}
