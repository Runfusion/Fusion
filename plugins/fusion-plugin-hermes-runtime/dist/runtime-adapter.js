import { createStreamSession, describeStreamModel, streamPrompt } from "./pi-module.js";
export class HermesRuntimeAdapter {
    config;
    id = "hermes";
    name = "Hermes Runtime";
    constructor(config = {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
    }) {
        this.config = config;
    }
    async createSession(options) {
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
    async promptWithFallback(session, prompt, _options) {
        const userMessage = { role: "user", content: prompt };
        session.messages.push(userMessage);
        await streamPrompt(session, userMessage);
    }
    describeModel(session) {
        return describeStreamModel(session);
    }
    async dispose(session) {
        if (typeof session.dispose === "function") {
            session.dispose();
        }
    }
}
//# sourceMappingURL=runtime-adapter.js.map