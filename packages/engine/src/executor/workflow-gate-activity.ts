/**
 * FNXC:AgentActivityStream 2026-08-15-22:15:
 * FN-8864 gate-attribution claim helper, restored after the wave-18 executor.ts
 * shell-ification (#3317) dropped it: FN-8864 landed hours before wave 18 the same
 * day, and the squashed shell rewrite was built from a pre-FN-8864 base, silently
 * deleting the executor's agent-activity writers. Keep this module the single home
 * for the pure claim logic; the writers live at their lifecycle seams
 * (run-implementation, handoff-task-to-review, execute-workflow-graph).
 *
 * FNXC:AgentActivityStream 2026-08-09-13:30:
 * Workflow-gate activity must credit the routed node principal, because that route carries a
 * reviewer override or column binding that task assignment alone cannot express. The outbox
 * boundary still roster-proves this claim before it can become an org-map agent attribution.
 */
import { resolveAgentActivityAttribution } from "@fusion/core";

export function resolveWorkflowGateActivityClaim(routedPrincipalAgentId: string | undefined, assignedAgentId: string | undefined) {
  const agentId = routedPrincipalAgentId ?? assignedAgentId ?? "executor";
  return resolveAgentActivityAttribution([
    { id: agentId, provenance: routedPrincipalAgentId || assignedAgentId ? "roster" : "lane" },
  ], "executor");
}
