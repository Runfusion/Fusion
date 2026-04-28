/**
 * OpenClaw Runtime Adapter — drives the local `openclaw` CLI as a subprocess.
 *
 * Each call to `promptWithFallback` invokes
 *   `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`
 * (and `--model`, `--thinking`, `--timeout`, `--agent` if configured),
 * parses the JSON document on stdout, and forwards visible/reasoning text
 * via the session callbacks.
 *
 * Session continuity: the UUID minted on session create is reused on every
 * subsequent prompt as `--session-id`, so openclaw resumes the same agent
 * conversation server-side.
 */

import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSessionResult,
  CliConfig,
  GatewaySession,
} from "./types.js";
import {
  createCliSession,
  describeCliModel,
  promptCli,
  resolveCliConfig,
} from "./pi-module.js";

export class OpenClawRuntimeAdapter implements AgentRuntime {
  readonly id = "openclaw";
  readonly name = "OpenClaw Runtime";

  private readonly config: CliConfig;

  constructor(settings?: Partial<CliConfig> | Record<string, unknown>) {
    this.config = resolveCliConfig(settings as Record<string, unknown> | undefined);
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const session = createCliSession({
      systemPrompt: options.systemPrompt,
      agentId: this.config.agentId,
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
    });

    return { session, sessionFile: undefined };
  }

  async promptWithFallback(
    session: GatewaySession,
    prompt: string,
    options?: unknown,
  ): Promise<void> {
    const overrideCallbacks = (options ?? undefined) as
      | Parameters<typeof promptCli>[3]
      | undefined;
    await promptCli(session, prompt, this.config, overrideCallbacks);
  }

  describeModel(session: GatewaySession): string {
    return describeCliModel(session);
  }

  async dispose(_session: GatewaySession): Promise<void> {
    // No persistent resources — each prompt spawns a fresh subprocess.
  }
}
