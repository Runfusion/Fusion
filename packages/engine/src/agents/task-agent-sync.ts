import type { Agent, AgentHeartbeatRun, AgentStore, Task, TaskStore } from "@fusion/core";

export const PARKED_AGENT_LINK_FRESH_RUN_MS = 5 * 60_000;

export interface AgentTaskLinkExecutionProof {
  hasFreshRun: boolean;
  hasActiveExecution: boolean;
  shouldPreserveParkedLink: boolean;
  runAgeMs: number;
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

export function isParkedTaskColumn(task: Pick<Task, "column"> | null | undefined): boolean {
  return task?.column === "todo" || task?.column === "triage";
}

export function evaluateParkedAgentTaskLink(options: {
  agent: Pick<Agent, "id" | "taskId">;
  linkedTask: Pick<Task, "column"> | null | undefined;
  activeRun?: AgentHeartbeatRun | null;
  hasActiveAgentExecution?: (agentId: string) => boolean;
  now?: number;
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
    shouldPreserveParkedLink: isParkedTaskColumn(options.linkedTask) && (hasFreshRun || hasActiveExecution),
    runAgeMs,
  };
}

type LoggerLike = { log: (msg: string) => void; warn: (msg: string) => void };

export interface AttachAgentLinkSyncOptions {
  store: TaskStore;
  agentStore: AgentStore;
  hasActiveAgentExecution?: (agentId: string) => boolean;
  logger?: LoggerLike;
}

const CLEAR_COLUMNS = new Set(["done", "archived", "todo", "triage"]);

export function attachAgentLinkSync(opts: AttachAgentLinkSyncOptions): () => void {
  const logger: LoggerLike = opts.logger ?? console;

  const handler = async ({ task, from, to }: { task: { id: string }; from: string; to: string }) => {
    if (!CLEAR_COLUMNS.has(to)) {
      return;
    }

    try {
      const agents = await opts.agentStore.listAgents({ includeEphemeral: false });
      const linkedAgents = agents.filter((agent) => agent.taskId === task.id);

      for (const agent of linkedAgents) {
        if (to === "todo" || to === "triage") {
          const activeRun = await opts.agentStore.getActiveHeartbeatRun?.(agent.id);
          const proof = evaluateParkedAgentTaskLink({
            agent,
            linkedTask: { column: to } as Pick<Task, "column">,
            activeRun,
            hasActiveAgentExecution: opts.hasActiveAgentExecution,
          });
          if (proof.shouldPreserveParkedLink) {
            continue;
          }
        }

        if (agent.state === "running") {
          await opts.agentStore.updateAgentState(agent.id, "active");
        }
        await opts.agentStore.syncExecutionTaskLink(agent.id, undefined);
        logger.log(`taskAgentLinkSync: cleared agent ${agent.id} taskId from ${task.id} after move ${from} → ${to}`);
      }
    } catch (error) {
      logger.warn(
        `taskAgentLinkSync: failed to sync agents for task ${task.id} after move ${from} → ${to}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  opts.store.on("task:moved", handler);
  return () => {
    opts.store.off("task:moved", handler);
  };
}
