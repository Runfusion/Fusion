import type { AgentCapability, AgentCreateInput, AgentOnboardingSummary } from "../../api";
import type { AgentPreset } from "./index";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const VALID_AGENT_CAPABILITIES = new Set<string>(["triage", "executor", "reviewer", "merger", "scheduler", "engineer", "custom"]);

export interface AgentDraftValues {
  name: string;
  role: AgentCapability;
  /** Canonical multi-role tags; `role` remains the compatibility primary. */
  roles?: AgentCapability[];
  title?: string;
  icon?: string;
  reportsTo?: string;
  instructionsPath?: string;
  instructionsText?: string;
  heartbeatProcedurePath?: string;
  soul?: string;
  memory?: string;
  model?: string;
  runtimeHint?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  skills?: string[];
}

export function mapPresetToAgentDraft(preset: AgentPreset): AgentDraftValues {
  return {
    name: preset.name,
    role: preset.role,
    title: preset.description ?? preset.title,
    icon: preset.icon,
    soul: preset.soul ?? "",
    instructionsText: preset.instructionsText ?? "",
  };
}

export function mapOnboardingSummaryToAgentDraft(draft: AgentOnboardingSummary): AgentDraftValues {
  const runtimeHint = draft.runtimeHint?.trim() ?? "";
  const modelSelection = draft.model?.trim() || draft.modelHint?.trim() || "";

  return {
    name: draft.name ?? "",
    title: draft.title ?? "",
    icon: draft.icon ?? "",
    role: (VALID_AGENT_CAPABILITIES.has(draft.role) ? draft.role : "custom") as AgentCapability,
    reportsTo: draft.reportsTo ?? "",
    instructionsText: draft.instructionsText ?? "",
    heartbeatProcedurePath: draft.heartbeatProcedurePath ?? "",
    soul: draft.soul ?? "",
    memory: draft.memory ?? "",
    skills: Array.isArray(draft.skills) ? draft.skills : [],
    model: runtimeHint ? "" : modelSelection,
    runtimeHint,
    thinkingLevel: draft.thinkingLevel ?? undefined,
    maxTurns: draft.maxTurns ?? undefined,
  };
}

export function buildAgentCreatePayload(values: AgentDraftValues): AgentCreateInput {
  const runtimeCfg: Record<string, unknown> = {};
  if (values.runtimeHint?.trim()) {
    runtimeCfg.runtimeHint = values.runtimeHint.trim();
  } else if (values.model?.trim()) {
    runtimeCfg.model = values.model.trim();
  }
  if (values.thinkingLevel && values.thinkingLevel !== "off") runtimeCfg.thinkingLevel = values.thinkingLevel;
  if (values.maxTurns !== undefined && values.maxTurns !== 1000) runtimeCfg.maxTurns = values.maxTurns;

  return {
    name: values.name.trim(),
    /*
     * FNXC:WorkflowAgentRouting 2026-08-07-03:46:
     * New permanent agents submit canonical role tags. The deprecated singular
     * field remains an API compatibility seam, never the source of new data.
     */
    roles: values.roles?.length ? values.roles : [values.role],
    ...(values.title?.trim() ? { title: values.title.trim() } : {}),
    ...(values.icon?.trim() ? { icon: values.icon.trim() } : {}),
    ...(values.reportsTo?.trim() ? { reportsTo: values.reportsTo.trim() } : {}),
    ...(values.instructionsPath?.trim() ? { instructionsPath: values.instructionsPath.trim() } : {}),
    ...(values.instructionsText?.trim() ? { instructionsText: values.instructionsText.trim() } : {}),
    ...(values.heartbeatProcedurePath?.trim() ? { heartbeatProcedurePath: values.heartbeatProcedurePath.trim() } : {}),
    ...(values.soul?.trim() ? { soul: values.soul.trim() } : {}),
    ...(values.memory?.trim() ? { memory: values.memory.trim() } : {}),
    ...(Object.keys(runtimeCfg).length > 0 ? { runtimeConfig: runtimeCfg } : {}),
    ...(values.skills && values.skills.length > 0 ? { metadata: { skills: values.skills } } : {}),
  };
}
