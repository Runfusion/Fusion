export class GrokRuntimeAdapter {
  readonly id = "grok";
  readonly name = "Grok Runtime";

  async createSession(options: { defaultModelId?: string; systemPrompt?: string }) {
    return {
      session: {
        model: options.defaultModelId ?? "grok/default",
        systemPrompt: options.systemPrompt,
        messages: [],
      },
      sessionFile: undefined,
    };
  }

  async promptWithFallback(): Promise<void> {
    // TODO(FN-7705): Implement Grok CLI prompt streaming once a stable
    // invocation contract beyond probe/discovery commands is confirmed.
    return;
  }

  describeModel(session: { model?: string }) {
    return `grok/${session.model ?? "default"}`;
  }
}
