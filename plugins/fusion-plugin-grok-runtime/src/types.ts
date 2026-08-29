/*
FNXC:GrokAcp 2026-07-11-12:00:
Grok runtime now drives xAI Grok Build TUI over ACP (`grok agent stdio`) instead
of one-shot `--output-format json`. Session state mirrors the chat/executor
contract (top-level `messages` + optional `state.errorMessage`) while the live
ACP connection lives on the composed AcpSession fields (`connection`, `dispose`).
*/

/** Narrow permission gate view (structural copy; no @fusion/engine import). */
export type GateDisposition = "allow" | "block" | "require-approval";

export interface PermissionGate {
  permissionPolicy?: {
    rules?: Record<string, GateDisposition>;
  };
  createApprovalRequest?: (
    decision: unknown,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  findApprovalByDedupeKey?: (
    dedupeKey: string,
  ) => Promise<{ id: string; status: string } | null> | { id: string; status: string } | null;
  pauseForApproval?: (info: {
    approvalRequestId: string;
    decision: unknown;
  }) => Promise<void> | void;
  markApprovalCompleted?: (approvalRequestId: string) => Promise<void> | void;
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface GrokCallbacks {
  /** Streams assistant text deltas from ACP `agent_message_chunk` updates. */
  onText?: (text: string) => void;
  /** Streams reasoning from ACP `agent_thought_chunk` updates. */
  onThinking?: (text: string) => void;
  /** ACP `tool_call` / start of a tool invocation. */
  onToolStart?: (toolName: string, args?: unknown) => void;
  /** ACP `tool_call_update` terminal status. */
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

export interface GrokSession {
  model: string;
  systemPrompt?: string;
  messages: unknown[];
  state: { errorMessage?: string; messages: unknown[] };
  sessionId?: string;
  lastModelDescription: string;
  /** Fixed diagnostic outcome when requested Fusion custom-tool bridge could not start. */
  fusionToolBridgeError?: { reasonCode: "mcp-schema-server-missing" | "bridge-start-failed" };
  callbacks: GrokCallbacks;
  /** Live ACP connection when createSession succeeded (composed AcpSession). */
  connection?: unknown;
  resetTurn?: () => void;
  dispose?: () => void;
}

export type AgentSession = GrokSession;

export interface AgentRuntimeOptions {
  cwd?: string;
  systemPrompt?: string;
  tools?: "coding" | "readonly";
  defaultModelId?: string;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  signal?: AbortSignal;
  actionGateContext?: PermissionGate;
  mcpServers?: AcpMcpServer[] | unknown[];
  /** Engine-injected Fusion tools (fn_*) with in-process execute closures. */
  customTools?: unknown[];
  /** Convenience skill name list. */
  skills?: string[];
  /** Structured skill selection from session skill context. */
  skillSelection?: { requestedSkillNames?: string[] };
  /** Extra skill roots (plugin skills, CE install dirs). */
  additionalSkillPaths?: string[];
  /** Opaque ACP session/new._meta (pluginDirs / rules / systemPromptOverride). */
  sessionMeta?: Record<string, unknown>;
}

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

export interface AgentPromptResult {
  stopReason?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(
    session: AgentSession,
    prompt: string,
    options?: unknown,
  ): Promise<void | AgentPromptResult>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}

export interface GrokBinaryStatus {
  available: boolean;
  /**
   * FNXC:GrokCli 2026-07-09-00:00:
   * FN-7716: means "Grok CLI runtime ready" (the `grok` binary is available
   * on PATH or at a configured path) — NOT "a Fusion-visible API key was
   * found". The `grok` CLI owns its own authentication (env var, project
   * `.env`, `grok -k`, etc.); Fusion no longer requires visibility into a
   * key to treat the provider as authenticated. See `apiKeyDetected` for the
   * non-blocking informational key-presence signal.
   */
  authenticated?: boolean;
  /**
   * FNXC:GrokCli 2026-07-09-00:00:
   * FN-7716: non-blocking informational hint only — true when Fusion itself
   * detected a Grok API key (GROK_API_KEY env var or
   * ~/.grok/user-settings.json `apiKey`). Never gates `authenticated` or
   * enable/disable; the direct xAI OpenAI-compatible streaming path
   * (FN-7711/FN-7714) uses $GROK_API_KEY when present regardless of this CLI
   * probe.
   */
  apiKeyDetected?: boolean;
  binaryPath?: string;
  binaryName?: string;
  configuredBinaryPath?: string;
  usingConfiguredBinaryPath?: boolean;
  diagnostics?: string[];
  version?: string;
  reason?: string;
  probeDurationMs: number;
}
