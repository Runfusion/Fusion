// Local types for the ACP (Agent Client Protocol) runtime plugin.
//
// The wire protocol types come from `@agentclientprotocol/sdk` (the `schema`
// namespace). These local types describe (a) the Fusion `AgentRuntime` contract
// this plugin implements and (b) the ACP session state this plugin tracks.
//
// The `AgentRuntimeOptions` here is a plugin-local structural copy of the engine
// contract (`packages/engine/src/agent-runtime.ts`). It deliberately includes
// only the fields this runtime reads. `actionGateContext` is the engine-populated
// per-run permission gate — see `PermissionGate` below, the narrow structural
// view this plugin couples to instead of importing `@fusion/engine` internals.

/** Callbacks the engine wires to surface streamed agent output into Fusion's UI/logs. */
export interface AcpCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

/**
 * Narrow structural view of the engine's `AgentActionGateContext`
 * (`packages/engine/src/agent-action-gate.ts`). The plugin reads only these
 * members; typing them locally avoids a hard dependency on `@fusion/engine`.
 *
 * All HITL closures are optional: when absent, the permission floor (U5)
 * default-denies `require-approval` categories rather than throwing.
 */
export interface PermissionGate {
  permissionPolicy?: unknown;
  evaluate?: (toolName: string, args: unknown) => unknown;
  resolveGateOutcome?: (evaluation: unknown) => unknown;
  createApprovalRequest?: (...args: unknown[]) => Promise<unknown> | unknown;
  findApprovalByDedupeKey?: (...args: unknown[]) => Promise<unknown> | unknown;
  pauseForApproval?: (...args: unknown[]) => Promise<unknown> | unknown;
  markApprovalCompleted?: (...args: unknown[]) => Promise<unknown> | unknown;
}

/** Plugin-local copy of the engine's AgentRuntimeOptions (subset this runtime reads). */
export interface AgentRuntimeOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: string;
  /** Per-run permission gate, populated by the engine. See PermissionGate. */
  actionGateContext?: PermissionGate;
}

/** Live ACP session state tracked by the runtime adapter. */
export interface AcpSession {
  /** Model/agent identifier resolved for this session. */
  model: string;
  systemPrompt: string;
  /** ACP session id returned by `session/new` (empty until established). */
  sessionId: string;
  /** Working directory the agent operates over (the task worktree). */
  cwd: string;
  lastModelDescription: string;
  callbacks: AcpCallbacks;
  /** Per-run permission gate captured at createSession (U5/U7 read this). */
  gate?: PermissionGate;
  dispose(): void;
}

export type AgentSession = AcpSession;

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

/** The Fusion runtime contract this plugin implements (mirrors the engine interface). */
export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}
