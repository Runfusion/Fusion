import { createFnAgent, describeModel, promptWithFallback } from "./pi-module.js";
const getModelDescription = describeModel;
export class HermesRuntimeAdapter {
    id = "hermes";
    name = "Hermes Runtime";
    async createSession(options) {
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
    async promptWithFallback(session, prompt, options) {
        return promptWithFallback(session, prompt, options);
    }
    describeModel(session) {
        return getModelDescription(session);
    }
    async dispose(session) {
        if (typeof session.dispose === "function") {
            await session.dispose();
        }
    }
}
//# sourceMappingURL=runtime-adapter.js.map