/**
 * Hermes Runtime Adapter — drives the local `hermes` CLI as a subprocess.
 *
 * Each call to `promptWithFallback` invokes `hermes chat -q ... -Q --source tool`
 * and captures the resulting `session_id:` line. Subsequent calls on the same
 * session pass `--resume <id>` to continue the conversation.
 */
import { invokeHermesCli, resolveCliSettings } from "./cli-spawn.js";
export class HermesRuntimeAdapter {
    id = "hermes";
    name = "Hermes Runtime";
    settings;
    constructor(settings) {
        this.settings = resolveCliSettings(settings);
    }
    async createSession(options) {
        const session = {
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
    async promptWithFallback(session, prompt, _options) {
        const resumeId = session.sessionId || undefined;
        const result = await invokeHermesCli(prompt, this.settings, resumeId);
        session.sessionId = result.sessionId;
        session.lastModelDescription = this.describeFromSettings();
        if (result.body) {
            session.callbacks.onText?.(result.body);
        }
    }
    describeModel(session) {
        return session.lastModelDescription || this.describeFromSettings();
    }
    async dispose(_session) {
        // No persistent resources to release — the hermes CLI process exits per turn.
    }
    describeFromSettings() {
        const provider = this.settings.provider;
        const model = this.settings.model;
        if (provider && model)
            return `hermes/${provider}/${model}`;
        if (model)
            return `hermes/${model}`;
        if (provider)
            return `hermes/${provider}`;
        return "hermes";
    }
}
//# sourceMappingURL=runtime-adapter.js.map