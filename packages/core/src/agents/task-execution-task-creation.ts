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
  if (principal.kind === "agent") return principal.identity.taskExecutionSession === true;
  /*
  FNXC:Identity 2026-08-23-06:40:
  This gate arrived from main against a principal union that had no `unresolved` kind; U3's KTD16
  inversion added one, so the trailing `.identities` access no longer narrows.

  `unresolved` answers FALSE deliberately. This predicate WITHHOLDS task-creation tools, and an
  unresolved principal is the human-CLI pass-through case that U3 kept working until U11 ships the
  CLI credential — treating "we cannot tell who this is" as "this is a board task executing" would
  withhold `fn_task_create` from ordinary operators at a terminal. Only a principal that positively
  reports a task-execution session is withheld.
  */
  if (principal.kind === "unresolved") return false;
  return principal.identities.some((identity) => identity.taskExecutionSession === true);
}

export function taskExecutionTaskCreationRefusalText(toolName: string): string {
  return `${toolName} is unavailable while executing a board task. Record out-of-scope findings as completion recommendations, and implement in-scope work directly in this task.`;
}
