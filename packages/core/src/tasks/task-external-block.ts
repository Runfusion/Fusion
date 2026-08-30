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
