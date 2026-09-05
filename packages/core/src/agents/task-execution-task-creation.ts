import type { FusionSessionPrincipal } from "../session-identity-registry.js";

/*
FNXC:TaskExecutionTaskCreation 2026-08-21-23:16:
FN-125 forbids sessions executing a board task from creating or delegating board
work. Ephemerality was insufficient because the durable Workflow Executor bypassed
that policy; this shared contract makes the restriction lane-based and fail-closed.
*/
export const TASK_EXECUTION_WITHHELD_TASK_CREATION_TOOLS = ["fn_task_create", "fn_delegate_task"] as const;

export function isTaskExecutionSessionPrincipal(principal: FusionSessionPrincipal): boolean {
  if (principal.kind === "operator") return false;
  /*
  FNXC:Identity 2026-08-23-22:49:
  KTD16 added `unresolved` (identity ON + unregistered cwd). FN-125 withholds task-creation from
  known task-execution sessions; absence of identity is not evidence that a board task is running.
  Authorization of unknown callers is a later identity slice, not this lane-based withhold.
  */
  if (principal.kind === "unresolved") return false;
  if (principal.kind === "agent") return principal.identity.taskExecutionSession === true;
  return principal.identities.some((identity) => identity.taskExecutionSession === true);
}

export function taskExecutionTaskCreationRefusalText(toolName: string): string {
  return `${toolName} is unavailable while executing a board task. Record out-of-scope findings as completion recommendations, and implement in-scope work directly in this task.`;
}
