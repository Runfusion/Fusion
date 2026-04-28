/**
 * Hermes Runtime Adapter — drives the local `hermes` CLI as a subprocess.
 *
 * Each call to `promptWithFallback` invokes `hermes chat -q ... -Q --source tool`
 * and captures the resulting `session_id:` line. Subsequent calls on the same
 * session pass `--resume <id>` to continue the conversation.
 */

import { invokeHermesCli, resolveCliSettings } from "./cli-spawn.js";
import type { HermesCliSettings } from "./cli-spawn.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  HermesStreamSession,
} from "./types.js";

export class HermesRuntimeAdapter implements AgentRuntime {
  readonly id = "hermes";
  readonly name = "Hermes Runtime";

  private readonly settings: HermesCliSettings;

  constructor(settings?: Record<string, unknown> | HermesCliSettings) {
    this.settings = resolveCliSettings(
      settings as Record<string, unknown> | undefined,
    );
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const session: HermesStreamSession = {
      model: undefined,
      systemPrompt: options.systemPrompt,
      messages: [],
      apiKey: undefined,
      thinkingLevel: undefined,
      sessionId: "",
      lastModelDescription: this.describeFromSettings(),
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
      dispose: () => undefined,
    };

    return { session, sessionFile: undefined };
  }

  async promptWithFallback(
    session: AgentSession,
    prompt: string,
    _options?: unknown,
  ): Promise<void> {
    const resumeId = session.sessionId || undefined;
    const result = await invokeHermesCli(prompt, this.settings, resumeId);

    session.sessionId = result.sessionId;
    session.lastModelDescription = this.describeFromSettings();

    if (result.body) {
      session.callbacks.onText?.(result.body);
    }
  }

  describeModel(session: AgentSession): string {
    return session.lastModelDescription || this.describeFromSettings();
  }

  async dispose(_session: AgentSession): Promise<void> {
    // No persistent resources to release — the hermes CLI process exits per turn.
  }

  private describeFromSettings(): string {
    const provider = this.settings.provider;
    const model = this.settings.model;
    if (provider && model) return `hermes/${provider}/${model}`;
    if (model) return `hermes/${model}`;
    if (provider) return `hermes/${provider}`;
    return "hermes";
  }
}
