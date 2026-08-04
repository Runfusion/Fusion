/**
 * FNXC:CodeOrganization 2026-08-03-10:25:
 * resolveSeamColumnAgent peeled from TaskExecutor (U4).
 * Column-agent principal for graph seam nodes (best-effort R8 fallback when agent missing).
 *
 * FNXC:ColumnAgent 2026-07-19 (plan U4, R2/R3/R4/R8):
 * Resolve the effective COLUMN AGENT governing the coding/step session currently
 * being built for a task. Reads the governing node id stamped by the active seam
 * (graphSeamGoverningNodeId) and the per-run binding resolver (graphColumnAgentResolver),
 * both scoped to a graph-owned run. Feeds the task's OWN settings (`assignedAgentId` +
 * complete `modelProvider`/`modelId` pair) into the shared core resolver
 * (`resolveEffectiveAgent`, KTD-2/KTD-5) so defer/override precedence is never
 * reimplemented here. When the verdict is `column-agent`, fetches the full Agent
 * best-effort and audits the adoption; on a missing/deleted agent it logs and returns
 * undefined so the caller falls back to the `assignedAgentId` path (R8). Returns
 * undefined for the legacy/no-binding path so the session build is byte-identical.
 * Exposes the resolved Agent object (not just an id) so U5 can consume the same
 * effective principal for gating/heartbeat/restart without re-resolving.
 */
import type { Agent, AgentStore, Task, TaskDetail, TaskStore, WorkflowColumnAgent } from "@fusion/core";
import { resolveEffectiveAgent } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { extractOwnSettings } from "./agent-binding-pure.js";

export type ResolveSeamColumnAgentDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  agentStore?: AgentStore | null;
  graphSeamGoverningNodeId: Map<string, string>;
  graphColumnAgentResolver: Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>;
};

export async function resolveSeamColumnAgent(
  deps: ResolveSeamColumnAgentDeps,
  task: Task,
  detail: TaskDetail,
): Promise<{ agent: Agent; mode: WorkflowColumnAgent["mode"] | undefined } | undefined> {
  const governingNodeId = deps.graphSeamGoverningNodeId.get(task.id);
  const resolveBinding = deps.graphColumnAgentResolver.get(task.id);
  if (!governingNodeId || !resolveBinding) return undefined;

  const binding = resolveBinding(governingNodeId);
  if (!binding) return undefined;

  // The task's OWN settings: its assigned agent identity and a COMPLETE model
  // pair (an incomplete pair does not count — KTD-5, mirrors
  // resolveExecutorSessionModel's both-present rule).
  const effective = resolveEffectiveAgent({
    binding,
    ...extractOwnSettings(detail),
  });
  if (effective.source !== "column-agent") return undefined;

  // Column agent governs: fetch the full Agent (best-effort, R8 fallback).
  let agent: Agent | null = null;
  try {
    agent = (await deps.agentStore?.getAgent(effective.agentId)) ?? null;
  } catch {
    agent = null;
  }
  if (!agent) {
    // Best-effort audit: a logEntry failure (DB locked / mid-recovery) must NOT
    // escalate this graceful fallback into a hard session failure (R8).
    try {
      await deps.store.logEntry(
        task.id,
        `Workflow seam node '${governingNodeId}': column agent '${effective.agentId}' not found — falling back to assigned-agent resolution`,
        undefined,
        deps.getRunContextFor(task.id),
      );
    } catch (logErr: unknown) {
      executorLog.warn(`${task.id}: failed to log column-agent fallback: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
    return undefined;
  }
  try {
    await deps.store.logEntry(
      task.id,
      `Workflow seam node '${governingNodeId}': running as column agent '${effective.agentId}' (${binding.mode})`,
      undefined,
      deps.getRunContextFor(task.id),
    );
  } catch (logErr: unknown) {
    executorLog.warn(`${task.id}: failed to log column-agent adoption: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
  }
  return { agent, mode: binding.mode };
}
