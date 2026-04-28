/**
 * Hermes Runtime Adapter — drives the local `hermes` CLI as a subprocess.
 *
 * Each call to `promptWithFallback` invokes `hermes chat -q ... -Q --source tool`
 * and captures the resulting `session_id:` line. Subsequent calls on the same
 * session pass `--resume <id>` to continue the conversation.
 */
import type { HermesCliSettings } from "./cli-spawn.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSessionResult } from "./types.js";
export declare class HermesRuntimeAdapter implements AgentRuntime {
    readonly id = "hermes";
    readonly name = "Hermes Runtime";
    private readonly settings;
    constructor(settings?: Record<string, unknown> | HermesCliSettings);
    createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
    promptWithFallback(session: AgentSession, prompt: string, _options?: unknown): Promise<void>;
    describeModel(session: AgentSession): string;
    dispose(_session: AgentSession): Promise<void>;
    private describeFromSettings;
}
//# sourceMappingURL=runtime-adapter.d.ts.map