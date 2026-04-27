import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  HermesModelConfig,
} from "./types.js";
import { createStreamSession, describeStreamModel, streamPrompt } from "./pi-module.js";

export class HermesRuntimeAdapter implements AgentRuntime {
  readonly id = "hermes";
  readonly name = "Hermes Runtime";

  constructor(
    private readonly config: HermesModelConfig = {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    },
  ) {}

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const session = createStreamSession({
      provider: this.config.provider,
      modelId: this.config.modelId,
      apiKey: this.config.apiKey,
      thinkingLevel: this.config.thinkingLevel,
      systemPrompt: options.systemPrompt,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
    });

    return {
      session,
      sessionFile: undefined,
    };
  }

  async promptWithFallback(session: AgentSession, prompt: string, _options?: unknown): Promise<void> {
    const userMessage = { role: "user", content: prompt };
    session.messages.push(userMessage);
    await streamPrompt(session, userMessage as any);
  }

  describeModel(session: AgentSession): string {
    return describeStreamModel(session);
  }

  async dispose(session: AgentSession): Promise<void> {
    if (typeof session.dispose === "function") {
      session.dispose();
    }
  }
}
