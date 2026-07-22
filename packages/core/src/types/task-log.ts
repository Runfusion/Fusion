/**
 * FNXC:CodeOrganization 2026-07-22-14:00:
 * Task steps, activity/agent logs, attachments, and comments peeled from types.ts.
 */

import type { ColumnId } from "./board.js";

export type StepStatus = "pending" | "in-progress" | "done" | "skipped";

export interface TaskStep {
  name: string;
  status: StepStatus;
  /**
   * Step-inversion (KTD-11): 0-indexed indices of steps this step depends on,
   * parsed from the PROMPT.md `### Step N (depends: 1,2): Title` annotation
   * or structured parser output (1-indexed step numbers in authored content →
   * 0-indexed indices here).
   *
   * FNXC:WorkflowSteps 2026-06-29-17:52:
   * Absence and emptiness are different planner contracts. Absent means unannotated and therefore implicitly depends on the previous step; an explicit empty array means this step has no dependencies and may run as a parallel root.
   */
  dependsOn?: number[];
}

/** Correlation metadata linking a task mutation to the agent run that caused it. */
export interface RunMutationContext {
  /** The heartbeat run ID that initiated this mutation. */
  runId: string;
  /** The agent ID that performed the mutation. */
  agentId: string;
  /** Optional invocation source of the run (e.g., "on_demand", "timer", "assignment"). */
  source?: string;
}

export interface TaskLogEntry {
  timestamp: string;
  action: string;
  outcome?: string;
  /** Correlation metadata linking this entry to the agent run that produced it. */
  runContext?: RunMutationContext;
}

export type WorkflowTransitionNotificationKind =
  | "manual-merge-hold"
  | "recovery-requeue";

export interface WorkflowTransitionNotificationMarker {
  kind: WorkflowTransitionNotificationKind;
  column: ColumnId;
  transitionId: string;
  nodeId?: string;
  reason?: string;
  createdAt: string;
}

export type ActivityEventType =
  | "task:created"
  | "task:moved"
  | "task:updated"
  | "task:deleted"
  | "task:merged"
  | "task:failed"
  | "task:duplicate-warning-overridden"
  | "task:auto-archived-deterministic-duplicate"
  | "task:auto-archived-near-duplicate"
  | "task:near-duplicate-flagged"
  /*
   * FNXC:ReleaseAuthorizationGate 2026-07-09-01:00:
   * The triage release-authorization planning gate and its `task:release-authorization-required`
   * activity type were removed (FN-7732, following the engine gate removal in b5b0458). Releases
   * are kept out of Fusion by agent instruction (AGENTS.md -> "Releasing"), not by an activity/gate.
   */
  | "task:auto-archived-ghost-bug"
  | "task:auto-archived-duplicate"
  | "task:merge-worktree-reacquired"
  | "settings:updated"
  | "project:isolation-transition";

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  type: ActivityEventType;
  taskId?: string;
  taskTitle?: string;
  details: string;
  metadata?: Record<string, unknown>;
}

/** The set of agent roles that produce log entries. */
export type AgentRole = "triage" | "executor" | "reviewer" | "merger";

/*
FNXC:AgentLog-EntryTypes 2026-07-15-11:20:
`text` means a STREAMED DELTA FRAGMENT: renderers re-glue consecutive `text` rows with `join("")` and no separator, because that is the only way to reconstitute a streamed message (the FN-5787/5789/5803 streamed-spacing lineage). `AgentLogger` is the only producer of true deltas.

`status` means a COMPLETE, SELF-CONTAINED engine message (e.g. "Reviewer using model: x/y", "Deterministic merge verification passed") written directly by an engine lane rather than streamed from a model. It exists because engine lanes previously wrote these as `text`, so N consecutive standalone messages were glued edge-to-edge into one run-on string under an accurate-but-misleading "N entries" header.

Never emit `status` for model-streamed output, and never emit `text` for a whole standalone message. Renderers must render each `status` row as its own block and must never `join("")` them. Rows written before this type existed persist as `text`, so read paths that resolve engine markers out of the log must accept BOTH types (see dashboard effective-model-resolution.ts).
*/
export type AgentLogType = "text" | "status" | "tool" | "thinking" | "tool_result" | "tool_error";

/** A single chunk of agent output persisted to disk (JSONL in agent.log). */
export interface AgentLogEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** The task this log entry belongs to. */
  taskId: string;
  /** The text content (delta for "text"/"thinking", complete message for "status", tool name for "tool"/"tool_result"/"tool_error"). */
  text: string;
  /** The kind of entry — streamed text delta, standalone engine status message, tool invocation marker, thinking block, tool result, or tool error. */
  type: AgentLogType;
  /**
   * For `tool`: human-readable argument summary (for example a file path or command).
   * `tool` and successful `tool_result` detail are persisted only when `persistAgentToolOutput` is enabled;
   * failed `tool_error` detail is always persisted as bounded diagnostic signal.
   *
   * FNXC:AgentLogging 2026-07-15-16:05: FN-7995 requires failed tool-call errors to remain available
   * to task transcript renderers even when verbose successful tool output is disabled.
   */
  detail?: string;
  /** Which agent produced this entry. Absent in logs written before this field was added. */
  agent?: AgentRole;
  /** Request/tool processing duration in milliseconds. Absent for legacy rows and entries without bounded timing. */
  durationMs?: number;
  /** Time to first visible model output in milliseconds. Absent after the first visible output and on legacy rows. */
  timeToFirstTokenMs?: number;
}

/** How much of `.fusion/tasks/{ID}/agent.log` is copied into cold archive storage. */
export type ArchiveAgentLogMode = "none" | "compact" | "full";

export interface TaskAttachment {
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface SteeringComment {
  id: string;
  text: string;
  createdAt: string;
  author: "user" | "agent";
}

export interface TaskComment {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
  source?: "user" | "agent" | "github-review" | "github-review-comment";
  externalId?: string;
  reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
}

export interface TaskCommentInput {
  text: string;
  author: string;
}

