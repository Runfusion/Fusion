/**
 * CLI agent session type definitions (CLI Agent Executor, U1).
 *
 * Defines the durable record shape for a CLI agent session — the long-lived
 * process that drives a single autonomy unit (a task execution, a planning
 * pass, a validator run, a CE run, or an interactive chat). These records
 * outlive the in-memory executor so a crashed/restarted Fusion instance can
 * reason about, resume, or reap sessions from their persisted state.
 *
 * Follows the same conventions as chat-types.ts:
 * - String-literal unions for enums.
 * - Nullable owning-entity references (taskId / chatSessionId).
 * - JSON-serialized structured columns (autonomyPosture).
 */

// ── Enums / String Literals ─────────────────────────────────────────────

/**
 * Lifecycle state of a CLI agent session.
 *
 * Transitions (typical): starting → ready → busy ↔ waitingOnInput → done,
 * with dead / needsAttention reachable from any active state on failure or
 * a condition requiring operator intervention.
 */
export type CliAgentState =
  | "starting"
  | "ready"
  | "busy"
  | "waitingOnInput"
  | "done"
  | "dead"
  | "needsAttention";

/** All valid agent states, for runtime validation at the store boundary. */
export const CLI_AGENT_STATES: readonly CliAgentState[] = [
  "starting",
  "ready",
  "busy",
  "waitingOnInput",
  "done",
  "dead",
  "needsAttention",
] as const;

/**
 * Why a CLI agent session terminated. Null while the session is still live.
 *
 * Termination taxonomy (KTD):
 * - completed   — the agent finished its unit of work successfully.
 * - userExited  — the user/operator deliberately stopped the session.
 * - killed      — the session was force-terminated (e.g. supervisor reap).
 * - crashed     — the underlying process exited abnormally / unexpectedly.
 * - authFailed  — the session ended because credentials/auth were rejected.
 * - engineDeath — the owning Fusion engine/process died, orphaning the session.
 */
export type CliTerminationReason =
  | "completed"
  | "userExited"
  | "killed"
  | "crashed"
  | "authFailed"
  | "engineDeath";

/** All valid termination reasons, for runtime validation at the store boundary. */
export const CLI_TERMINATION_REASONS: readonly CliTerminationReason[] = [
  "completed",
  "userExited",
  "killed",
  "crashed",
  "authFailed",
  "engineDeath",
] as const;

/**
 * The purpose a CLI agent session serves — which autonomy unit it drives.
 *
 * - execute   — a task execution run.
 * - planning  — a planning / triage pass.
 * - validator — a validator / acceptance run.
 * - ce        — a compound-engineering run.
 * - chat      — an interactive chat session.
 */
export type CliSessionPurpose = "execute" | "planning" | "validator" | "ce" | "chat";

/** All valid session purposes, for runtime validation at the store boundary. */
export const CLI_SESSION_PURPOSES: readonly CliSessionPurpose[] = [
  "execute",
  "planning",
  "validator",
  "ce",
  "chat",
] as const;

// ── Core Types ──────────────────────────────────────────────────────────

/**
 * Operator-configured autonomy posture for a session. Stored as JSON.
 *
 * Kept intentionally open-ended (structured but extensible) so posture
 * controls can evolve without a schema migration. Persisted verbatim.
 */
export interface CliAutonomyPosture {
  /** Whether the session may proceed without per-step approval. */
  autoApprove?: boolean;
  /** Maximum number of resume attempts permitted before giving up. */
  maxResumeAttempts?: number;
  /** Free-form, forward-compatible posture fields. */
  [key: string]: unknown;
}

/**
 * A durable CLI agent session record.
 *
 * Exactly one of `taskId` / `chatSessionId` is typically set, matching the
 * owning entity for the session's `purpose` (chat → chatSessionId; the rest →
 * taskId). Both may be null for sessions not yet attached to an entity.
 */
export interface CliSession {
  /** Stable primary key. */
  id: string;
  /** Owning task ID, when this session drives task work. Null otherwise. */
  taskId: string | null;
  /** Owning chat session ID, when purpose is "chat". Null otherwise. */
  chatSessionId: string | null;
  /** What autonomy unit this session drives. */
  purpose: CliSessionPurpose;
  /** Project this session belongs to. */
  projectId: string;
  /** Adapter (CLI agent integration) backing the session. */
  adapterId: string;
  /** Current lifecycle state. */
  agentState: CliAgentState;
  /** Why the session terminated, or null while live. */
  terminationReason: CliTerminationReason | null;
  /** Native (adapter/process) session identifier, for resume. Null until known. */
  nativeSessionId: string | null;
  /** Number of resume attempts made so far. */
  resumeAttempts: number;
  /** Operator-configured autonomy posture. */
  autonomyPosture: CliAutonomyPosture | null;
  /** Worktree path the session operates in. */
  worktreePath: string | null;
  /** When the record was created (ISO 8601). */
  createdAt: string;
  /** When the record was last updated (ISO 8601). */
  updatedAt: string;
}

/** Input for creating a CLI session record. */
export interface CliSessionCreateInput {
  /** Optional explicit ID; generated when omitted. */
  id?: string;
  taskId?: string | null;
  chatSessionId?: string | null;
  purpose: CliSessionPurpose;
  projectId: string;
  adapterId: string;
  /** Initial state; defaults to "starting" when omitted. */
  agentState?: CliAgentState;
  terminationReason?: CliTerminationReason | null;
  nativeSessionId?: string | null;
  resumeAttempts?: number;
  autonomyPosture?: CliAutonomyPosture | null;
  worktreePath?: string | null;
}

/** Partial updates to a CLI session record. */
export interface CliSessionUpdateInput {
  taskId?: string | null;
  chatSessionId?: string | null;
  agentState?: CliAgentState;
  terminationReason?: CliTerminationReason | null;
  nativeSessionId?: string | null;
  resumeAttempts?: number;
  autonomyPosture?: CliAutonomyPosture | null;
  worktreePath?: string | null;
}

// ── Validation helpers ───────────────────────────────────────────────────

/** Narrow an unknown value to a valid CliAgentState. */
export function isCliAgentState(value: unknown): value is CliAgentState {
  return typeof value === "string" && (CLI_AGENT_STATES as readonly string[]).includes(value);
}

/** Narrow an unknown value to a valid CliTerminationReason. */
export function isCliTerminationReason(value: unknown): value is CliTerminationReason {
  return (
    typeof value === "string" && (CLI_TERMINATION_REASONS as readonly string[]).includes(value)
  );
}

/** Narrow an unknown value to a valid CliSessionPurpose. */
export function isCliSessionPurpose(value: unknown): value is CliSessionPurpose {
  return typeof value === "string" && (CLI_SESSION_PURPOSES as readonly string[]).includes(value);
}
