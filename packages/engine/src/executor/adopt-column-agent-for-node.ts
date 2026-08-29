/**
 * FNXC:CodeOrganization 2026-08-03-11:30:
 * adoptColumnAgentForNode peeled from TaskExecutor (U4).
 * Resolve column-agent model/persona for a graph node (best-effort R8 fallback).
 */
import type { AgentStore, TaskDetail, TaskStore, WorkflowColumnAgent, WorkflowIrNode } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { buildAgentPersona } from "./agent-binding-pure.js";

export type AdoptColumnAgentForNodeDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  agentStore?: AgentStore | null;
};

export async function adoptColumnAgentForNode(
  deps: AdoptColumnAgentForNodeDeps,
  node: WorkflowIrNode,
  live: TaskDetail,
  columnAgentId: string,
  mode: WorkflowColumnAgent["mode"] | undefined,
): Promise<{ modelProvider?: string; modelId?: string; persona?: string } | undefined> {
  try {
    const agent = await deps.agentStore?.getAgent(columnAgentId);
    if (!agent) {
      await deps.store.logEntry(
        live.id,
        `Workflow node '${node.id}': column agent '${columnAgentId}' not found — falling back to node/default resolution`,
        undefined,
        deps.getRunContextFor(live.id),
      );
      return undefined;
    }
    const rc = (agent.runtimeConfig ?? {}) as { executorProvider?: string; executorModelId?: string };
    await deps.store.logEntry(
      live.id,
      `Workflow node '${node.id}': running as column agent '${columnAgentId}' (${mode})`,
      undefined,
      deps.getRunContextFor(live.id),
    );
    return {
      modelProvider: rc.executorProvider,
      modelId: rc.executorModelId,
      persona: buildAgentPersona(agent),
    };
  } catch {
    // Agent lookup is best-effort; fall back to node/default resolution (R8).
    // A secondary logEntry failure (DB locked / mid-recovery) must NOT propagate
    // out of this error handler and escalate the node to a hard failure.
    try {
      await deps.store.logEntry(
        live.id,
        `Workflow node '${node.id}': column agent '${columnAgentId}' lookup failed — falling back to node/default resolution`,
        undefined,
        deps.getRunContextFor(live.id),
      );
    } catch (logErr: unknown) {
      executorLog.warn(`${live.id}: failed to log column-agent lookup failure: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
    return undefined;
  }
}
