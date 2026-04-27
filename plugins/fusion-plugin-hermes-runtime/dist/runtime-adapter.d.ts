import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult, HermesModelConfig } from "./types.js";
export declare class HermesRuntimeAdapter implements AgentRuntime {
    private readonly config;
    readonly id = "hermes";
    readonly name = "Hermes Runtime";
    constructor(config?: HermesModelConfig);
    createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
    promptWithFallback(session: AgentSession, prompt: string, _options?: unknown): Promise<void>;
    describeModel(session: AgentSession): string;
    dispose(session: AgentSession): Promise<void>;
}
//# sourceMappingURL=runtime-adapter.d.ts.map