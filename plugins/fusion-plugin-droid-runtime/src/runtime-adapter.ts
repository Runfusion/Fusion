import { streamViaCli } from "./provider.js";
import { resolveCliSettings } from "./cli-spawn.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult, DroidSession } from "./types.js";

export class DroidRuntimeAdapter implements AgentRuntime {
  readonly id = "droid";
  readonly name = "Droid Runtime";
  private readonly settings: ReturnType<typeof resolveCliSettings>;

  constructor(settings?: Record<string, unknown>) {
    this.settings = resolveCliSettings(settings);
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const model = this.settings.model ?? options.defaultModelId ?? "droid";
    const session: DroidSession = {
      model,
      systemPrompt: options.systemPrompt,
      messages: [],
      apiKey: undefined,
      thinkingLevel: options.defaultThinkingLevel,
      sessionId: "",
      lastModelDescription: `droid/${model}`,
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

  async promptWithFallback(session: AgentSession, prompt: string, _options?: unknown): Promise<void> {
    const model = {
      id: String(session.model ?? this.settings.model ?? "droid"),
      provider: "droid-cli",
      api: "droid-cli",
    } as any;

    const stream = streamViaCli(model, {
      messages: [{ role: "user", content: prompt }],
      systemPrompt: session.systemPrompt,
    } as any, { sessionId: session.sessionId } as any);

    await new Promise<void>((resolve) => {
      const streamAny = stream as any;
      streamAny.on?.("text_delta", (event: any) => session.callbacks.onText?.(event.text ?? ""));
      streamAny.on?.("thinking_delta", (event: any) => session.callbacks.onThinking?.(event.text ?? ""));
      streamAny.on?.("done", () => resolve());
      streamAny.on?.("error", () => resolve());
    });
  }

  describeModel(session: AgentSession): string {
    return session.lastModelDescription || "droid";
  }
}
