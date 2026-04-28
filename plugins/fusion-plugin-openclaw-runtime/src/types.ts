/**
 * OpenClaw runtime adapter contracts.
 *
 * The runtime drives the local `openclaw` CLI as a subprocess (no daemon).
 * Types are kept local to this package to stay decoupled from internal engine modules.
 */

export type GatewayRole = "developer" | "user" | "assistant";

export interface GatewayMessage {
  role: GatewayRole;
  content: string;
}

/**
 * Resolved settings used by the CLI spawn helpers.
 *
 * `useGateway: false` (default) passes `--local` to the openclaw CLI so the
 * agent runs embedded with no daemon. `useGateway: true` lets the CLI try the
 * WebSocket gateway and fall back to embedded if unreachable (slower).
 */
export interface CliConfig {
  binaryPath: string;
  agentId: string;
  model?: string;
  thinking: string; // off | minimal | low | medium | high | xhigh | adaptive | max
  cliTimeoutSec: number; // openclaw-side timeout (0 = no limit)
  cliTimeoutMs: number; // hard kill on our side
  useGateway: boolean;
}

export interface GatewayCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

/**
 * In-memory session object held by the adapter. The `sessionId` is passed to
 * `openclaw agent --session-id` so consecutive calls share state server-side.
 *
 * `messages` is a transcript-style local mirror; the openclaw CLI does NOT
 * receive this array — it manages its own session store under
 * `~/.openclaw/agents/<agentId>/sessions/`.
 */
export interface GatewaySession {
  sessionId: string;
  agentId: string;
  systemPrompt: string;
  messages: GatewayMessage[];
  /** Last-known model description; populated after each turn from the CLI JSON. */
  lastModelDescription: string;
  /** Last-known token usage from the CLI JSON's `meta.agentMeta.usage`. */
  lastUsage?: Record<string, number>;
  callbacks?: GatewayCallbacks;
  dispose?: () => Promise<void> | void;
}

export interface AgentRuntimeOptions extends GatewayCallbacks {
  cwd: string;
  systemPrompt: string;
  tools?: unknown;
  customTools?: unknown;
  defaultProvider?: string;
  defaultModelId?: string;
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultThinkingLevel?: string;
  sessionManager?: unknown;
  skillSelection?: unknown;
  skills?: string[];
}

export interface AgentSessionResult {
  session: GatewaySession;
  sessionFile?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: GatewaySession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: GatewaySession): string;
  dispose?(session: GatewaySession): Promise<void>;
}

/**
 * Shape of the JSON document emitted by `openclaw agent --json` on stdout.
 * Used by the CLI parser; declared here so callers can introspect the result.
 */
export interface OpenClawAgentJson {
  payloads?: Array<{
    text?: string;
    isError?: boolean;
    isReasoning?: boolean;
    mediaUrl?: string;
    mediaUrls?: string[];
  }>;
  meta?: {
    durationMs?: number;
    aborted?: boolean;
    stopReason?: string;
    finalAssistantVisibleText?: string;
    error?: { kind: string; message: string };
    agentMeta?: {
      sessionId?: string;
      provider?: string;
      model?: string;
      usage?: Record<string, number>;
    };
  };
}
