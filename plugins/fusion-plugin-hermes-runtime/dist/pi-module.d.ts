/**
 * Pi Module Seam
 *
 * Provides a mockable import path for pi functions used by the HermesRuntimeAdapter.
 */
export interface PiAgentSession {
    dispose?: () => Promise<void> | void;
}
export interface PiAgentResult {
    session: PiAgentSession;
    sessionFile?: string;
}
export interface PiAgentOptions {
    cwd: string;
    systemPrompt: string;
    tools?: unknown;
    customTools?: unknown;
    onText?: (text: string) => void;
    onThinking?: (text: string) => void;
    onToolStart?: (toolName: string, args?: unknown) => void;
    onToolEnd?: (toolName: string, result?: unknown) => void;
    defaultProvider?: string;
    defaultModelId?: string;
    fallbackProvider?: string;
    fallbackModelId?: string;
    defaultThinkingLevel?: string;
    sessionManager?: unknown;
    skillSelection?: unknown;
    skills?: string[];
}
export declare const createFnAgent: (options: PiAgentOptions) => Promise<PiAgentResult>;
export declare const promptWithFallback: (session: PiAgentSession, prompt: string, options?: unknown) => Promise<void>;
export declare const describeModel: (session: PiAgentSession) => string;
//# sourceMappingURL=pi-module.d.ts.map