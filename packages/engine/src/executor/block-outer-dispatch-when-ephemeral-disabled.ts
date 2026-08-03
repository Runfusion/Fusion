/**
 * FNXC:CodeOrganization 2026-08-03-13:50:
 * blockOuterDispatchWhenEphemeralDisabled peeled from TaskExecutor (U4).
 *
 * FNXC:EphemeralAgents 2026-07-01-00:00:
 * When ephemeralAgentsEnabled is false, block workflow/authoritative execution unless a permanent agent is assigned; requeue for scheduler permanent assignment.
 */
import type { Task, TaskStore, AgentStore } from "@fusion/core";
import { isEphemeralAgent } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

export type BlockOuterDispatchWhenEphemeralDisabledDeps = {
  store: TaskStore;
  agentStore?: AgentStore | null;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function blockOuterDispatchWhenEphemeralDisabled(
  deps: BlockOuterDispatchWhenEphemeralDisabledDeps,
  task: Task,
): Promise<boolean> {
    const settings = await deps.store.getSettings();
    if (settings.ephemeralAgentsEnabled !== false) return false;

    // A permanent (non-ephemeral) assignment is the sanctioned executor when
    // ephemeral workers are off. `assignedAgentId` is only ever set by permanent
    // assignment — default ephemeral mode never sets it — so when we cannot
    // resolve the agent (no agentStore) we trust the presence of the id and allow
    // the run rather than starving a legitimately-assigned task.
    const assignedId = task.assignedAgentId?.trim();
    if (assignedId) {
      if (!deps.agentStore) return false;
      const agent = await deps.agentStore.getAgent(assignedId).catch(() => null);
      if (agent && !isEphemeralAgent(agent)) return false;
    }

    const liveTask = (await deps.store.getTask(task.id).catch(() => null)) ?? task;
    const reboundColumn = await resolveReboundColumnFor(deps.store, liveTask.id);
    if (liveTask.column !== reboundColumn) {
      await deps.store.moveTask(liveTask.id, reboundColumn, {
        preserveProgress: true,
        preserveWorktree: true,
        preserveResumeState: true,
        moveSource: "engine",
        recoveryRehome: true,
      });
    }
    await deps.store.updateTask(liveTask.id, { status: "queued" }, deps.getRunContextFor(liveTask.id));
    await deps.store.logEntry(
      liveTask.id,
      "queued — ephemeral agents disabled; no permanent executor assigned",
      "Executor pre-dispatch ephemeral gate blocked workflow/authoritative execution.",
      deps.getRunContextFor(liveTask.id),
    );
    executorLog.log(`${liveTask.id}: executor dispatch blocked — ephemeralAgentsEnabled=false and no permanent agent assigned`);
    return true;
}
