/*
FNXC:OmpAcp 2026-07-11-23:35:
OMP runtime drives Oh My Pi (`omp acp`) over the Agent Client Protocol. Session
state mirrors chat/executor expectations (top-level messages + optional
state.errorMessage) while the live ACP connection lives on composed AcpSession
fields (connection, dispose). Auth is owned by the operator's local `omp`
install under ~/.omp — Fusion does not inject provider keys.
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

export interface OmpCallbacks {
  /** Streams assistant text deltas from ACP `agent_message_chunk` updates. */
  onText?: (text: string) => void;
  /** Streams reasoning from ACP `agent_thought_chunk` updates. */
  onThinking?: (text: string) => void;
  /** ACP `tool_call` / start of a tool invocation. */
  onToolStart?: (toolName: string, args?: unknown) => void;
  /** ACP `tool_call_update` terminal status. */
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

export interface OmpSession {
  model: string;
  systemPrompt?: string;
  messages: unknown[];
  state: { errorMessage?: string; messages: unknown[] };
  sessionId?: string;
  lastModelDescription: string;
  callbacks: OmpCallbacks;
  /** Live ACP connection when createSession succeeded (composed AcpSession). */
  connection?: unknown;
  resetTurn?: () => void;
  dispose?: () => void;
}

export type AgentSession = OmpSession;

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
  customTools?: unknown[];
  skills?: string[];
  skillSelection?: { requestedSkillNames?: string[] };
  additionalSkillPaths?: string[];
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

export interface OmpBinaryStatus {
  available: boolean;
  /**
   * FNXC:OmpAcp 2026-07-11-23:35:
   * Means "OMP CLI runtime ready" (the `omp` binary is available). Auth is
   * owned by omp under ~/.omp; Fusion does not require a Fusion-visible API key.
   */
  authenticated?: boolean;
  binaryPath?: string;
  binaryName?: string;
  configuredBinaryPath?: string;
  usingConfiguredBinaryPath?: boolean;
  diagnostics?: string[];
  version?: string;
  reason?: string;
  probeDurationMs: number;
}
