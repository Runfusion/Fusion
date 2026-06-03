// AgentRuntime adapter for the ACP runtime.
//
// U1 scaffold: implements the full `AgentRuntime` contract shape (including the
// required `describeModel`) with stubs that throw `not_implemented` until the
// session driver lands in U2/U3. The skeleton exists so the plugin loads,
// registers as `runtimeId: "acp"`, and conforms to the interface the engine
// resolves via `getRuntimeById`.

import { resolveCliSettings, type AcpCliSettings } from "./cli-spawn.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  AcpSession,
} from "./types.js";

export const ACP_NOT_IMPLEMENTED = "acp_not_implemented";

export class AcpRuntimeAdapter implements AgentRuntime {
  readonly id = "acp";
  readonly name = "ACP Runtime";
  private readonly settings: AcpCliSettings;

  constructor(settings?: Record<string, unknown>) {
    this.settings = resolveCliSettings(settings);
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    // Session establishment (spawn + initialize + session/new) lands in U2/U3.
    // The skeleton constructs the session shell so the contract is observable.
    const model = this.settings.model ?? options.defaultModelId ?? "acp";
    const session: AcpSession = {
      model,
      systemPrompt: options.systemPrompt,
      sessionId: "",
      cwd: options.cwd,
      lastModelDescription: `acp/${model}`,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
      gate: options.actionGateContext,
      dispose: () => undefined,
    };
    throw new Error(`${ACP_NOT_IMPLEMENTED}: createSession lands in U2/U3 (session=${session.lastModelDescription})`);
  }

  async promptWithFallback(_session: AgentSession, _prompt: string, _options?: unknown): Promise<void> {
    throw new Error(`${ACP_NOT_IMPLEMENTED}: promptWithFallback lands in U3`);
  }

  describeModel(session: AgentSession): string {
    return session.lastModelDescription || "acp";
  }

  async dispose(session: AgentSession): Promise<void> {
    // Best-effort teardown; the authoritative kill is the process registry (KTD4a).
    session.dispose();
  }
}
