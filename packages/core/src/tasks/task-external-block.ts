import { redactSecrets } from "../secrets/redact-secrets.js";
import type { Task } from "../types.js";

export const EXTERNAL_BLOCK_STATUS = "blocked" as const;
export const EXTERNAL_BLOCK_PAUSE_REASON = "external-block" as const;

export type TaskExternalBlockOrigin =
  | "host-environment"
  | "model-provider"
  | "credentials"
  | "network"
  | "third-party-service";

/*
FNXC:ExternalBlock 2026-08-28-03:48:
An obstacle outside the worktree freezes the task at its exact durable resume point. The patch must
retain column, steps, current step, worktree, and branch, and must not write userPaused because an
external block is operator-recoverable lifecycle state rather than an operator-authored pause.
*/
export interface TaskExternalBlockReport {
  verifiedCondition: string;
  stopReason: string;
  unimplementedWork: string;
  unblockCondition: string;
}

export interface TaskExternalBlock {
  origin: TaskExternalBlockOrigin;
  code: string;
  message: string;
  source: "agent-declaration" | "session-failure";
  blockedAt: string;
  resume: {
    column: string;
    nodeId?: string;
    currentStep: number;
    worktree?: string;
    branch?: string;
  };
  /** Optional for legacy rows; consumers derive a conservative report when absent. */
  report?: TaskExternalBlockReport;
}

const REPORT_FIELD_MAX_LENGTH = 320;
const UNSAFE_REPORT_CONTENT = /\b(?:system prompt|tool (?:output|log)|stack trace|\bat \S+ \([^)]*:\d+:\d+\))/i;

function fallbackReport(block: Pick<TaskExternalBlock, "origin" | "code">): TaskExternalBlockReport {
  const condition = `${block.origin} limitation (${block.code || "UNCLASSIFIED"})`;
  return {
    verifiedCondition: `Fusion verified an external ${condition}.`,
    stopReason: "The task is safely paused to preserve its current execution state.",
    unimplementedWork: "Remaining implementation work was not performed.",
    unblockCondition: `Resolve the ${condition} and retry the task.`,
  };
}

function sanitizeReportField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const sanitized = redactSecrets(value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()).slice(0, REPORT_FIELD_MAX_LENGTH).trim();
  return sanitized.length > 0 && !UNSAFE_REPORT_CONTENT.test(sanitized) ? sanitized : fallback;
}

/**
 * FNXC:ExternalBlockMailbox 2026-09-22-02:24:
 * External-block reports are the only operator-facing evidence persisted with a freeze. Bound and
 * redact every field here so legacy and new delivery paths cannot serialize prompts, logs, stacks,
 * or credentials while lifecycle writers retain their existing freeze-only authority.
 */
export function buildTaskExternalBlockReport(
  block: Pick<TaskExternalBlock, "origin" | "code">,
  report?: Partial<TaskExternalBlockReport>,
): TaskExternalBlockReport {
  const fallback = fallbackReport(block);
  return {
    verifiedCondition: sanitizeReportField(report?.verifiedCondition, fallback.verifiedCondition),
    stopReason: sanitizeReportField(report?.stopReason, fallback.stopReason),
    unimplementedWork: sanitizeReportField(report?.unimplementedWork, fallback.unimplementedWork),
    unblockCondition: sanitizeReportField(report?.unblockCondition, fallback.unblockCondition),
  };
}

export function isTaskExternallyBlocked(task: Pick<Task, "status" | "externalBlock">): boolean {
  return task.status === EXTERNAL_BLOCK_STATUS && task.externalBlock !== undefined;
}

export function formatTaskExternalBlockReason(block: Pick<TaskExternalBlock, "origin" | "code" | "message">): string {
  const code = block.code.trim() || "UNCLASSIFIED";
  const message = block.message.trim() || "External obstacle requires operator action";
  return `BLOCKED: ${block.origin}/${code}: ${message}`;
}

export function buildTaskExternalBlockPatch(externalBlock: TaskExternalBlock): Partial<Task> {
  return {
    status: EXTERNAL_BLOCK_STATUS,
    error: formatTaskExternalBlockReason(externalBlock),
    paused: true,
    pausedReason: EXTERNAL_BLOCK_PAUSE_REASON,
    pausedByAgentId: null as unknown as Task["pausedByAgentId"],
    externalBlock,
  };
}

export function buildTaskExternalBlockClearPatch(): Partial<Task> {
  return {
    status: null as unknown as Task["status"],
    error: null as unknown as Task["error"],
    paused: false,
    pausedReason: null as unknown as Task["pausedReason"],
    pausedByAgentId: null as unknown as Task["pausedByAgentId"],
    externalBlock: null as unknown as Task["externalBlock"],
  };
}
