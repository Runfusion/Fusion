import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
} from "./types.js";
import { createFnAgent, describeModel, promptWithFallback } from "./pi-module.js";

const getModelDescription = describeModel;

export class HermesRuntimeAdapter implements AgentRuntime {
  readonly id = "hermes";
  readonly name = "Hermes Runtime";

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
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

  async promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
    return promptWithFallback(session, prompt, options);
  }

  describeModel(session: AgentSession): string {
    return getModelDescription(session);
  }

  async dispose(session: AgentSession): Promise<void> {
    if (typeof (session as { dispose?: () => Promise<void> }).dispose === "function") {
      await (session as { dispose: () => Promise<void> }).dispose();
    }
  }
}
