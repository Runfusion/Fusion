import { isBuiltinWorkflowRoleAgent } from "@fusion/core";
import type { Agent } from "@fusion/core";

export const WORKFLOW_STEP_RUN_ATTRIBUTION_TIMEOUT_MS = 2_000;

export type WorkflowStepRunAgentStore = {
  getAgent?: (agentId: string) => Promise<Agent | null> | Agent | null;
  listAgents?: (filter?: { includeEphemeral?: boolean }) => Promise<Agent[]> | Agent[];
} | null | undefined;

/**
 * FNXC:CommandCenterActivity 2026-09-04-14:11:
 * `project.agent_runs.agent_id` has a composite foreign key to `project.agents`, so a role slug
 * or unproved string is a guaranteed constraint violation. This seam turns a candidate into a
 * proven roster id or an explicit unattributable verdict; it never invents an id. Built-in owners
 * win same-role pools because provisioning seeds one owner per role while operators may add pool
 * members. Proving attribution reads the store, so the read is bounded, swallowing, and called
 * once per executor: telemetry must never become a lifecycle dependency (FN-9175).
 */
export async function resolveWorkflowStepRunAgentId(
  store: WorkflowStepRunAgentStore,
  candidate: string | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  if (!candidate?.trim()) return null;

  const resolve = async (): Promise<string | null> => {
    if (typeof store?.getAgent === "function") {
      const agent = await store.getAgent(candidate);
      if (agent) return agent.id;
    }

    if (typeof store?.listAgents !== "function") return null;
    const matches = (await store.listAgents({ includeEphemeral: true })).filter(
      (agent) => agent.role === candidate || agent.roles?.includes(candidate as never),
    );
    const builtInOwners = matches.filter(
      (agent) => isBuiltinWorkflowRoleAgent(agent) && agent.metadata?.workflowRole === candidate,
    );
    if (builtInOwners.length === 1) return builtInOwners[0]!.id;
    return matches.length === 1 ? matches[0]!.id : null;
  };

  let lookup: Promise<string | null>;
  try {
    lookup = Promise.resolve(resolve());
  } catch {
    return null;
  }
  // Observe any late rejection after the bounded caller has returned.
  void lookup.catch(() => undefined);

  return await new Promise<string | null>((complete) => {
    const timer = setTimeout(() => complete(null), options.timeoutMs ?? WORKFLOW_STEP_RUN_ATTRIBUTION_TIMEOUT_MS);
    timer.unref?.();
    void lookup.then(
      (agentId) => {
        clearTimeout(timer);
        complete(agentId);
      },
      () => {
        clearTimeout(timer);
        complete(null);
      },
    );
  });
}
