import { AlertTriangle, ArrowRightLeft, CheckCircle, CircleDot, Clock, Play, type LucideIcon } from "lucide-react";
import type { AgentActivityEventType } from "../../api";

/* FNXC:CommandCenterAgentActivity 2026-08-10-01:13: Agent activity uses the same compact icon/semantic-color vocabulary as ActivityFeed rather than introducing a competing feed style. */
export const AGENT_ACTIVITY_TYPE_CONFIG: Record<AgentActivityEventType, { label: string; icon: LucideIcon; color: string }> = {
  "task:started": { label: "Task started", icon: Play, color: "var(--in-progress)" }, "task:handed-off": { label: "Task handed off", icon: ArrowRightLeft, color: "var(--in-progress)" }, "task:completed": { label: "Task completed", icon: CheckCircle, color: "var(--color-success)" }, "agent:state-changed": { label: "Agent state changed", icon: CircleDot, color: "var(--text-muted)" }, "workflow:gate-passed": { label: "Workflow gate passed", icon: CheckCircle, color: "var(--color-success)" }, "workflow:gate-failed": { label: "Workflow gate failed", icon: AlertTriangle, color: "var(--color-error)" }, "approval:requested": { label: "Approval requested", icon: Clock, color: "var(--color-warning)" },
};
export const DEFAULT_AGENT_ACTIVITY_CONFIG = { label: "Activity", icon: CircleDot, color: "var(--text-muted)" };

export interface ResolvedAgentActivityPresentation {
  labelKey: string;
  fallbackLabel: string;
  icon: LucideIcon;
  color: string;
}

/*
FNXC:WorkflowStepNotRun 2026-08-28-14:13:
A terminal non-blocking gate that never executed stays on the existing passed event channel, but its
metadata resolves neutral not-executed presentation. Filter labels keep using the unchanged type
configuration, while event rows translate this resolved key instead of overwriting it by event type.
*/
export function resolveAgentActivityPresentation(
  type: AgentActivityEventType,
  metadata: Record<string, unknown> | null,
): ResolvedAgentActivityPresentation {
  if (type === "workflow:gate-passed" && metadata?.notRun === true) {
    return {
      labelKey: "commandCenter.agentActivity.workflowGateNotRun",
      fallbackLabel: "Workflow gate not executed",
      icon: CircleDot,
      color: "var(--text-muted)",
    };
  }
  const config = AGENT_ACTIVITY_TYPE_CONFIG[type] ?? DEFAULT_AGENT_ACTIVITY_CONFIG;
  return {
    labelKey: `commandCenter.agentActivity.eventTypes.${type}`,
    fallbackLabel: config.label,
    icon: config.icon,
    color: config.color,
  };
}
