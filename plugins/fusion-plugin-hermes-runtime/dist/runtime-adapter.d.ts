import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult } from "./types.js";
export declare class HermesRuntimeAdapter implements AgentRuntime {
    readonly id = "hermes";
    readonly name = "Hermes Runtime";
    createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
    promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
    describeModel(session: AgentSession): string;
    dispose(session: AgentSession): Promise<void>;
}
//# sourceMappingURL=runtime-adapter.d.ts.map