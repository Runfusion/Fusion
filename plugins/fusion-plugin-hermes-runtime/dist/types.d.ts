/**
 * Hermes Runtime Plugin - Type Definitions
 *
 * The runtime contract is defined locally to avoid compile-time coupling to
 * internal engine exports.
 */
export interface HermesCallbacks {
    onText?: (text: string) => void;
    onThinking?: (text: string) => void;
    onToolStart?: (toolName: string, args?: unknown) => void;
    onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}
export interface HermesStreamSession {
    model: unknown;
    systemPrompt: string;
    messages: unknown[];
    apiKey: string | undefined;
    thinkingLevel: string | undefined;
    sessionId: string;
    lastModelDescription: string;
    callbacks: HermesCallbacks;
    usage?: unknown;
    dispose(): void;
}
export type AgentSession = HermesStreamSession;
/**
 * Options for creating an agent session.
 * Mirrors the engine's runtime options shape. Hermes accepts these options
 * for compatibility and silently ignores Pi-specific fields.
 */
export interface AgentRuntimeOptions {
    cwd: string;
    systemPrompt: string;
    tools?: "coding" | "readonly";
    customTools?: unknown;
    onText?: (text: string) => void;
    onThinking?: (text: string) => void;
    onToolStart?: (toolName: string, args?: unknown) => void;
    onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
    defaultProvider?: string;
    defaultModelId?: string;
    fallbackProvider?: string;
    fallbackModelId?: string;
    defaultThinkingLevel?: string;
    sessionManager?: unknown;
    skillSelection?: unknown;
    skills?: string[];
}
/** Result of creating a session. */
export interface AgentSessionResult {
    session: AgentSession;
    sessionFile?: string;
}
/** Agent runtime adapter interface. */
export interface AgentRuntime {
    id: string;
    name: string;
    createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
    promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
    describeModel(session: AgentSession): string;
    dispose?(session: AgentSession): Promise<void>;
}
export interface HermesModelConfig {
    provider: string;
    modelId: string;
    apiKey?: string;
    thinkingLevel?: string;
}
export interface ResolvedModelConfig {
    provider: string;
    modelId: string;
    apiKey: string | undefined;
    thinkingLevel: string | undefined;
}
//# sourceMappingURL=types.d.ts.map