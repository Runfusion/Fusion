import type { AgentStore, TaskStore } from "@fusion/core";

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
        if ((to === "todo" || to === "triage") && opts.hasActiveAgentExecution?.(agent.id) === true) {
          continue;
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
