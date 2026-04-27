import { type Message } from "@mariozechner/pi-ai";
import type { HermesCallbacks, HermesStreamSession, ResolvedModelConfig } from "./types.js";
export declare function resolveModelConfig(settings?: Record<string, unknown>): ResolvedModelConfig;
export declare function createStreamSession(options: {
    provider: string;
    modelId: string;
    apiKey?: string;
    thinkingLevel?: string;
    systemPrompt: string;
    callbacks?: HermesCallbacks;
}): HermesStreamSession;
export declare function streamPrompt(session: HermesStreamSession, _userMessage: Message): Promise<void>;
export declare function describeStreamModel(session: HermesStreamSession): string;
//# sourceMappingURL=pi-module.d.ts.map