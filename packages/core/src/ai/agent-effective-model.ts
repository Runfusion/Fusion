import type { Settings } from "../types.js";
import {
  resolveExecutionSettingsModel,
  resolveMergerPhaseThinkingLevel,
  resolveMergerSettingsModel,
  resolvePhaseThinkingLevel,
  resolvePlanningSettingsModel,
  resolveValidatorSettingsModel,
  type ResolvedModelSelection,
} from "./model-resolution.js";

export type PermanentAgentModelLike = {
  roles?: string[];
  role?: string | null;
  runtimeConfig?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

export type PrimaryWorkflowRole = "triage" | "executor" | "reviewer" | "merger";

function completeRuntimeModel(runtimeConfig?: Record<string, unknown> | null): ResolvedModelSelection | undefined {
  if (!runtimeConfig) return undefined;
  const provider = typeof runtimeConfig.modelProvider === "string" ? runtimeConfig.modelProvider.trim() : "";
  const modelId = typeof runtimeConfig.modelId === "string" ? runtimeConfig.modelId.trim() : "";
  if (provider && modelId) return { provider, modelId };
  const legacy = typeof runtimeConfig.model === "string" ? runtimeConfig.model.trim() : "";
  const slash = legacy.indexOf("/");
  if (slash > 0 && slash < legacy.length - 1) {
    return { provider: legacy.slice(0, slash), modelId: legacy.slice(slash + 1) };
  }
  return undefined;
}

/** Return the built-in workflow role, favoring provisioned role metadata when present. */
export function getPrimaryWorkflowRole(agent: PermanentAgentModelLike): PrimaryWorkflowRole | undefined {
  const metadataRole = agent.metadata?.builtInWorkflowRole === true && typeof agent.metadata.workflowRole === "string"
    ? agent.metadata.workflowRole
    : undefined;
  if (metadataRole === "triage" || metadataRole === "executor" || metadataRole === "reviewer" || metadataRole === "merger") return metadataRole;
  const roles = Array.isArray(agent.roles) ? agent.roles : [];
  for (const role of ["triage", "executor", "reviewer", "merger"] as const) if (roles.includes(role)) return role;
  return agent.role === "triage" || agent.role === "executor" || agent.role === "reviewer" || agent.role === "merger" ? agent.role : undefined;
}

/*
FNXC:AgentModelInheritance 2026-08-09-22:38:
Permanent agent identity sessions preserve a complete per-agent runtime model, but an empty or
partial runtime model inherits the matching workflow role lane. Each lane reaches the project
default override before globals, keeping Agents, Chat, and heartbeats consistent without writing
an inherited pair onto the agent row.
*/
export function resolvePermanentAgentEffectiveModel(
  agent: PermanentAgentModelLike,
  settings?: Partial<Settings>,
): ResolvedModelSelection {
  const runtimeModel = completeRuntimeModel(agent.runtimeConfig);
  if (runtimeModel) return runtimeModel;
  switch (getPrimaryWorkflowRole(agent)) {
    case "triage": return resolvePlanningSettingsModel(settings);
    case "reviewer": return resolveValidatorSettingsModel(settings);
    case "merger": return resolveMergerSettingsModel(settings);
    default: return resolveExecutionSettingsModel(settings);
  }
}

export function resolvePermanentAgentEffectiveThinkingLevel(
  agent: PermanentAgentModelLike,
  settings?: Partial<Settings>,
  explicitThinkingLevel?: string,
): string | undefined {
  const explicit = typeof explicitThinkingLevel === "string" && explicitThinkingLevel.trim() ? explicitThinkingLevel.trim() : undefined;
  const runtime = typeof agent.runtimeConfig?.thinkingLevel === "string" && agent.runtimeConfig.thinkingLevel.trim()
    ? agent.runtimeConfig.thinkingLevel.trim()
    : undefined;
  if (explicit ?? runtime) return explicit ?? runtime;
  switch (getPrimaryWorkflowRole(agent)) {
    case "triage": return resolvePhaseThinkingLevel("planning", settings);
    case "reviewer": return resolvePhaseThinkingLevel("validation", settings);
    case "merger": return resolveMergerPhaseThinkingLevel(settings);
    default: return resolvePhaseThinkingLevel("execution", settings);
  }
}
