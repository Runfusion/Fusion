/*
FNXC:TaskDeleteAttribution 2026-07-26-14:30:
Four tasks were deleted inside one hour in a live project and the run-audit rows could not answer
"which one did the human delete?". Two concrete holes produced that: (1) `task:deleted` metadata
persisted `auditContext.sessionId` but never `auditContext.taskId`, so an AI agent's `fn_task_delete`
call recorded only the tool surface (`agentId:"pi-extension"`) and the CALLING task/agent was lost
forever; (2) the dashboard `DELETE /api/tasks/:id` handler hardcoded `agentId:"system"`, so an
operator clicking Delete in the UI and a script hitting the same endpoint produced byte-identical
rows. This module is the single closed vocabulary that fixes both: `callerKind` names the class of
actor and `callerTaskId` names the calling task.

TRUST MODEL — read before extending. `callerKind` is ATTRIBUTION, NOT AUTHENTICATION. The HTTP
variants are derived from a self-reported `x-fusion-client` request header, so all the row can
honestly claim is "the client identified itself as the dashboard UI" (`operator-ui`) versus
"nothing identified itself" (`api-unattributed`). Anything can send the header. Never gate a
permission, a delete, or any other decision on this value, and never describe it as proof of a
human. It exists so forensics has a starting hypothesis, not a verdict.

Scope note: this is observability only. No delete-blocking, gating, or permission logic is added or
implied here; whether agents should hold `fn_task_delete` at all is a separate operator policy call.
*/

/**
 * FNXC:TaskDeleteAttribution 2026-07-26-14:30:
 * Closed set of delete-caller classes, ordered from most to least attributable.
 *
 * - `operator-ui` — an HTTP client that identified itself as the dashboard UI (see trust model).
 * - `operator-cli` — the interactive `fn task delete` command, which prompts a human for
 *   confirmation at a terminal. Added beyond the original four because that surface is a real,
 *   distinct human actor already tagged `agentId:"cli"`; without its own member it would have to
 *   masquerade as `api-unattributed` and re-blur exactly the operator-vs-automation line this
 *   change exists to draw.
 * - `agent-tool` — an AI agent's tool call (`fn_task_delete`). Pair with `callerTaskId`.
 * - `engine` — an autonomous engine lane (triage split-close, duplicate resolution, self-healing).
 * - `api-unattributed` — an HTTP caller that sent no recognized client header. The deliberate
 *   default: unknown is recorded as unknown rather than guessed as operator.
 */
export const TASK_DELETE_CALLER_KINDS = [
  "operator-ui",
  "operator-cli",
  "agent-tool",
  "engine",
  "api-unattributed",
] as const;

export type TaskDeleteCallerKind = (typeof TASK_DELETE_CALLER_KINDS)[number];

/**
 * FNXC:TaskDeleteAttribution 2026-07-26-14:30:
 * Shared shape for every delete audit context. Previously this object literal was retyped inline at
 * ten call signatures across `store.ts` and both archive-lifecycle branches, which is how `taskId`
 * could exist on the type, be passed by `fn_task_delete`, be consumed by the self-delete guard, and
 * still never reach persisted metadata without anything flagging it.
 *
 * `taskId` is the CALLER's task (the task whose agent is asking for the delete), not the target.
 * It doubles as the self-delete guard input (`auditContext.taskId === id` is refused) and, from
 * this change on, is persisted as `callerTaskId`.
 */
export interface TaskDeleteAuditContext {
  agentId: string;
  runId: string;
  sessionId?: string;
  taskId?: string;
  callerKind?: TaskDeleteCallerKind;
}

/**
 * FNXC:TaskDeleteAttribution 2026-07-26-14:30:
 * Request header a Fusion first-party HTTP client sets to identify itself. Self-reported; see the
 * module trust-model note. Kept in core so the dashboard's browser client and the dashboard's
 * Express route cannot drift on the spelling.
 */
export const FUSION_CLIENT_HEADER = "x-fusion-client";

/** Value the dashboard web/desktop UI sends in {@link FUSION_CLIENT_HEADER}. */
export const FUSION_DASHBOARD_UI_CLIENT = "dashboard-ui";

/**
 * FNXC:TaskDeleteAttribution 2026-07-26-14:30:
 * Map a raw `x-fusion-client` header to a caller kind. Only the exact recognized dashboard-UI token
 * maps to `operator-ui`; absent, array-valued (duplicate header), or unrecognized values all fall
 * back to `api-unattributed` so an unknown caller is never upgraded into an operator claim.
 */
export function resolveHttpDeleteCallerKind(headerValue: unknown): TaskDeleteCallerKind {
  if (typeof headerValue !== "string") return "api-unattributed";
  return headerValue.trim().toLowerCase() === FUSION_DASHBOARD_UI_CLIENT
    ? "operator-ui"
    : "api-unattributed";
}

/**
 * FNXC:TaskDeleteAttribution 2026-07-26-14:30:
 * Persisted metadata fragment for a `task:deleted` run-audit row. Returns enum/id values only —
 * never prose, never a user-agent string — per the run-audit ids/counts/outcomes-only rule.
 * `callerKind` defaults to `api-unattributed` so every row from here on carries a value and an old
 * row's missing field is distinguishable from a new row's unknown caller.
 */
export function buildDeleteCallerAuditFields(
  auditContext: TaskDeleteAuditContext | undefined,
): { callerKind: TaskDeleteCallerKind; callerTaskId: string | null } {
  return {
    callerKind: auditContext?.callerKind ?? "api-unattributed",
    callerTaskId: auditContext?.taskId ?? null,
  };
}

/**
 * FNXC:GitHubSourceIssueSplitClose 2026-08-01-09:24:
 * A split-close audit row records the closed-vocabulary reason and child task ids, never the
 * explanatory GitHub comment prose. Omission deliberately returns no fields so ordinary deletes
 * retain their existing audit shape.
 */
export function buildDeleteClosureAuditFields(
  closureContext: import("./types.js").TaskDeleteClosureContext | undefined,
): Record<string, unknown> {
  if (!closureContext || closureContext.kind !== "split-into-subtasks") return {};
  return {
    closureKind: closureContext.kind,
    closureChildTaskIds: closureContext.childTaskIds,
  };
}
