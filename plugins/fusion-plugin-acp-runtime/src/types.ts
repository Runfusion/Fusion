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

import type { AcpConnection } from "./provider.js";

/** Callbacks the engine wires to surface streamed agent output into Fusion's UI/logs. */
export interface AcpCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

/**
 * A stdio MCP server forwarded to the agent on `session/new` (U10 — Route A).
 * `env` is explicit name/value pairs; inherited `process.env` is NEVER forwarded
 * to the untrusted agent. Maps 1:1 onto an ACP `mcpServers` entry and onto what
 * `pi-claude-cli`'s `mcp-config.ts` builds for `--mcp-config`.
 */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/** Per-category permission disposition (mirrors the engine policy shape). */
export type GateDisposition = "allow" | "block" | "require-approval";

/**
 * Fusion action-gate categories — the full policy-rule keyspace, used to read
 * `permissionPolicy.rules[category]`. `"exempt"` is implicit (read-only / benign)
 * and always allows.
 *
 * Note: ACP's `ToolKind` has no git/task discriminator, so `classifyToolKind`
 * only ever produces `file_write_delete` / `command_execution` / `network_api`
 * (+ exempt). `git_write` and `task_agent_mutation` remain part of the category
 * type because the policy rules are keyed by all categories — git writes in
 * particular route through `file_write_delete` gating PLUS the path-jail's hard
 * `.git/**` reject (KTD6a), not a dedicated `git_write` classification.
 */
export type FusionCategory =
  | "git_write"
  | "file_write_delete"
  | "command_execution"
  | "network_api"
  | "task_agent_mutation";

/** Approval lifecycle status as returned by the gate's lookup closure. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "completed";

/**
 * Narrow structural view of the engine's `AgentActionGateContext`
 * (`packages/engine/src/agent-action-gate.ts`). The plugin reads only these
 * members; typing them locally avoids a hard dependency on `@fusion/engine`.
 *
 * `permissionPolicy.rules` is the per-category disposition map the U5 floor
 * consults — NEVER a preset id (S1/KTD3a). All HITL closures except
 * `createApprovalRequest` are optional: when the HITL machinery is absent, the
 * permission floor (U5) default-denies `require-approval` categories rather than
 * throwing (Risk S1).
 */
export interface PermissionGate {
  permissionPolicy?: {
    rules?: Record<string, GateDisposition>;
  };
  /** Register an approval request; returns the created record (with an `id`). */
  createApprovalRequest?: (
    decision: unknown,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  /** Look up a prior decision by dedupe key (decision reuse). */
  findApprovalByDedupeKey?: (
    dedupeKey: string,
  ) => Promise<{ id: string; status: ApprovalStatus } | null> | { id: string; status: ApprovalStatus } | null;
  /** Block until the human resolves the referenced approval request. */
  pauseForApproval?: (info: {
    approvalRequestId: string;
    decision: unknown;
  }) => Promise<void> | void;
  /** Mark an approval request finalized after the decision is consumed. */
  markApprovalCompleted?: (approvalRequestId: string) => Promise<void> | void;
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
  /**
   * MCP servers to forward on `session/new` (U10 — Route A). When present and
   * non-empty, the agent can call these tools (each call still routes through the
   * U5 permission floor). Absent/empty preserves Route B's read-only ask posture.
   */
  mcpServers?: AcpMcpServer[];
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
  /**
   * Live ACP connection backing this session (U3). Prompt/dispose reach the
   * agent through it. Undefined only for the bare session shell used in tests.
   */
  connection?: AcpConnection;
  /**
   * Reset the event bridge's per-turn state (tool correlation, delta
   * accumulators, output-cap latch). Called by `promptWithFallback` at the start
   * of each turn (FIX 1). Undefined for the bare session shell used in tests.
   */
  resetTurn?: () => void;
  dispose(): void;
}

export type AgentSession = AcpSession;

export interface AgentPromptResult {
  stopReason?: string;
}

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

/** The Fusion runtime contract this plugin implements (mirrors the engine interface). */
export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void | AgentPromptResult>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}
