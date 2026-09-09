import { resolveWorkflowIrForTask, columnsWithFlag } from "@fusion/core";
import type { Agent, AgentHeartbeatRun, AgentStore, Task, TaskStore, WorkflowIr } from "@fusion/core";

export const PARKED_AGENT_LINK_FRESH_RUN_MS = 5 * 60_000;

export interface AgentTaskLinkExecutionProof {
  hasFreshRun: boolean;
  hasActiveExecution: boolean;
  shouldPreserveParkedLink: boolean;
  runAgeMs: number;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-27-22:55 (Phase B / U5):
The roles at which an agent's task link is CLEARED: terminal (`complete`) plus
parked (`hold`, `intake`). Legacy default = the ids the builtin coding workflow
gives those roles, used when the workflow cannot be
resolved — the conservative choice, since it preserves today's behavior exactly
rather than guessing a role for an unknown column.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-27-22:55 (Phase B / U5):
The legacy PARKED ids — the builtin coding workflow's `hold` and `intake`
columns. Exported because `isParkedTaskColumn` defaults to it for callers that
cannot resolve a workflow.
*/
export const LEGACY_PARKED_COLUMNS: readonly string[] = ["todo", "triage"];

/* Complete plus parked. Derived from the parked list rather than restated so the
   two legacy sets cannot drift apart. */
const LEGACY_CLEAR_COLUMNS: readonly string[] = ["done", ...LEGACY_PARKED_COLUMNS];

interface LinkSyncColumnRoles {
  /** Columns whose arrival clears the link (terminal + parked). */
  clear: readonly string[];
  /** The subset that is merely parked, where live execution proof preserves it. */
  parked: readonly string[];
}

const LEGACY_COLUMN_ROLES: LinkSyncColumnRoles = {
  clear: LEGACY_CLEAR_COLUMNS,
  parked: LEGACY_PARKED_COLUMNS,
};

/**
 * Resolve the clearing/parked column roles for a task's own workflow, falling
 * back to the legacy literal sets when the workflow has no column vocabulary.
 *
 * Fail-soft on purpose: this handler runs off a `task:moved` event and its only
 * job is link hygiene. A resolution failure must not throw into the emitter, and
 * degrading to the legacy sets keeps the builtin workflow correct while leaving
 * a renamed workflow no worse off than before this conversion.
 */
async function resolveLinkSyncColumnRoles(
  store: TaskStore,
  taskId: string,
  cache?: Map<string, WorkflowIr>,
): Promise<LinkSyncColumnRoles> {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-15:40 (the arity trap, sixth site):
  MEMBERSHIP, not first-per-role. These two sets are consumed by `roles.parked.includes(to)` and
  `roles.clear.includes(to)` — membership tests — but were built from `resolveTaskLifecycleColumns`,
  which returns the FIRST column carrying each trait. A workflow declaring two hold or Complete
  lanes had link hygiene applied to only one of them.

  `resolveLifecycleColumns` answers "which column is THE hold lane?"; a membership test asks "is this
  column ANY hold lane". Nothing in the types distinguishes them, which is why this program has now hit
  it six times. `columnsWithFlag` returns every column carrying the trait.
  */
  const ir = await resolveWorkflowIrForTask(store, taskId, cache).catch(() => undefined);
  if (!ir) return LEGACY_COLUMN_ROLES;

  const parked = [...new Set([...columnsWithFlag(ir, "hold"), ...columnsWithFlag(ir, "intake")])];
  const terminal = [...new Set(columnsWithFlag(ir, "complete"))];
  const clear = [...terminal, ...parked];

  // A v2 workflow declaring none of the clearing roles yields an empty clear set,
  // which would silently disable link hygiene entirely. Prefer the legacy sets.
  if (clear.length === 0) return LEGACY_COLUMN_ROLES;
  return { clear, parked };
}

export function hasFreshActiveHeartbeatRun(
  activeRun: AgentHeartbeatRun | null | undefined,
  now = Date.now(),
  freshRunMs = PARKED_AGENT_LINK_FRESH_RUN_MS,
): { hasFreshRun: boolean; runAgeMs: number } {
  const runStartedAt = activeRun?.startedAt;
  const runAgeMs = runStartedAt ? now - Date.parse(runStartedAt) : Number.POSITIVE_INFINITY;
  return {
    hasFreshRun: Boolean(activeRun) && Number.isFinite(runAgeMs) && runAgeMs <= freshRunMs,
    runAgeMs,
  };
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-27-22:55 (Phase B / U5):
"Parked" is the HOLD and INTAKE roles — a card resting before or between work,
not a card at the literal ids `todo`/`triage` (those are merely what the builtin
coding workflow calls those two columns). Under a renamed workflow the literal
check silently returned false for every card, which disabled the parked-link
preservation branch below rather than erroring.

`parkedColumns` defaults to the legacy pair so every caller that cannot resolve
a workflow is byte-identical (R11 keeps `todo`/`triage` legal column ids).
Callers that can resolve pass the task's `hold` and `intake` roles.
*/
export function isParkedTaskColumn(
  task: Pick<Task, "column"> | null | undefined,
  parkedColumns: readonly string[] = LEGACY_PARKED_COLUMNS,
): boolean {
  if (!task?.column) return false;
  return parkedColumns.includes(task.column);
}

export function evaluateParkedAgentTaskLink(options: {
  agent: Pick<Agent, "id" | "taskId">;
  linkedTask: Pick<Task, "column"> | null | undefined;
  activeRun?: AgentHeartbeatRun | null;
  hasActiveAgentExecution?: (agentId: string) => boolean;
  now?: number;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-22:55 (Phase B / U5):
  The task's resolved parked (`hold` + `intake`) columns. Defaults to the legacy
  pair so existing callers are byte-identical. Without this the preservation
  branch consulted the legacy ids even when the CALLER had already resolved a
  renamed workflow — turning a stale-link bug into a dropped-link bug, since the
  card would be treated as unparked and its live agent link cleared.
  */
  parkedColumns?: readonly string[];
}): AgentTaskLinkExecutionProof {
  const { hasFreshRun, runAgeMs } = hasFreshActiveHeartbeatRun(options.activeRun, options.now);
  const hasActiveExecution = options.hasActiveAgentExecution?.(options.agent.id) === true;
  /*
  FNXC:AgentTaskStateDrift 2026-06-23-08:33:
  Agent.taskId is a running assignment for parked todo/triage tasks only when the agent has live execution proof: a fresh active heartbeat run or an executor-active signal. File-scope overlapBlockedBy keeps the task queued but never proves the blocked task itself is executing.
  */
  return {
    hasFreshRun,
    hasActiveExecution,
    shouldPreserveParkedLink:
      isParkedTaskColumn(options.linkedTask, options.parkedColumns ?? LEGACY_PARKED_COLUMNS) &&
      (hasFreshRun || hasActiveExecution),
    runAgeMs,
  };
}

type LoggerLike = { log: (msg: string) => void; warn: (msg: string) => void };

/*
FNXC:WorkflowLifecycleColumns 2026-07-28-14:20 (PR #2514 review):
THE COMPLETION SIGNAL for an otherwise unobservable listener.

`task:moved` is a plain EventEmitter event and this handler is `async`, so
`store.emit` returns the moment the handler hits its first `await` and NOTHING
awaits the rest. That is fine in production — link hygiene is best-effort — but it
means the handler has no completion signal at all, and a caller cannot distinguish
"the handler ran and correctly did nothing" from "the handler has not run yet".

That distinction is not merely a testing inconvenience. The negative case of this
handler — a move that must NOT release the agent — has no observable effect by
construction, so without this hook the only way to check it is to wait a while and
look, which cannot fail: a handler that never ran looks exactly like a handler that
correctly declined. An unobservable async listener in an event-driven lifecycle is
a design gap, and this closes it with the narrowest thing that does: one optional
callback, fired on EVERY exit path including the early return and the error path.

Production passes nothing and is byte-identical.
*/
export interface AgentLinkSyncOutcome {
  taskId: string;
  from: string;
  to: string;
  /** False when `to` is not one of the workflow's clear columns — the handler
   *  intentionally did nothing. This is what makes "declined" observable. */
  matchedClearColumn: boolean;
  /** Agents whose task link was cleared by this move. */
  clearedAgentIds: string[];
  /** Linked agents deliberately left alone by the parked-link preservation proof. */
  preservedAgentIds: string[];
  /** Set when the agent listing/mutation threw; the handler swallows it as before. */
  error?: string;
}

export interface AttachAgentLinkSyncOptions {
  store: TaskStore;
  agentStore: AgentStore;
  hasActiveAgentExecution?: (agentId: string) => boolean;
  logger?: LoggerLike;
  /** Fired after the handler settles for one move, on every exit path. Optional;
   *  absent in production. Must never throw into the handler. */
  onHandled?: (outcome: AgentLinkSyncOutcome) => void;
}

export function attachAgentLinkSync(opts: AttachAgentLinkSyncOptions): () => void {
  const logger: LoggerLike = opts.logger ?? console;

  const handler = async ({ task, from, to }: { task: { id: string }; from: string; to: string }) => {
    const outcome: AgentLinkSyncOutcome = {
      taskId: task.id,
      from,
      to,
      matchedClearColumn: false,
      clearedAgentIds: [],
      preservedAgentIds: [],
    };
    const settle = (): void => {
      try {
        opts.onHandled?.(outcome);
      } catch {
        // A diagnostics hook must never affect link hygiene.
      }
    };
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-27-22:55 (Phase B / U5):
    Resolve the roles from the moved task's OWN workflow rather than matching
    `to` against a fixed id set. Previously a move into a renamed terminal
    column matched nothing and this handler returned early — so the agent kept a
    `taskId` pointing at a finished card and stayed `running`, with no error and
    no failing test. The IR read happens before the agent listing so an
    unresolvable workflow still degrades to the legacy sets rather than throwing.
    */
    let roles: LinkSyncColumnRoles;
    try {
      roles = await resolveLinkSyncColumnRoles(opts.store, task.id);
    } catch {
      roles = LEGACY_COLUMN_ROLES;
    }

    if (!roles.clear.includes(to)) {
      settle();
      return;
    }
    outcome.matchedClearColumn = true;

    try {
      const agents = await opts.agentStore.listAgents({ includeEphemeral: false });
      const linkedAgents = agents.filter((agent) => agent.taskId === task.id);

      for (const agent of linkedAgents) {
        if (roles.parked.includes(to)) {
          const activeRun = await opts.agentStore.getActiveHeartbeatRun?.(agent.id);
          const proof = evaluateParkedAgentTaskLink({
            agent,
            linkedTask: { column: to } as Pick<Task, "column">,
            activeRun,
            hasActiveAgentExecution: opts.hasActiveAgentExecution,
            parkedColumns: roles.parked,
          });
          if (proof.shouldPreserveParkedLink) {
            outcome.preservedAgentIds.push(agent.id);
            continue;
          }
        }

        if (agent.state === "running") {
          await opts.agentStore.updateAgentState(agent.id, "active");
        }
        await opts.agentStore.syncExecutionTaskLink(agent.id, undefined);
        outcome.clearedAgentIds.push(agent.id);
        logger.log(`taskAgentLinkSync: cleared agent ${agent.id} taskId from ${task.id} after move ${from} → ${to}`);
      }
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      logger.warn(
        `taskAgentLinkSync: failed to sync agents for task ${task.id} after move ${from} → ${to}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      settle();
    }
  };

  opts.store.on("task:moved", handler);
  return () => {
    opts.store.off("task:moved", handler);
  };
}
