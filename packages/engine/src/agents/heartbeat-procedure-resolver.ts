import type { Agent, HeartbeatPromptTemplate, HeartbeatScopeDisciplineMode, ProjectSettings } from "@fusion/core";

const VALID_MODES: readonly HeartbeatScopeDisciplineMode[] = ["strict", "lite", "off"] as const;
const VALID_TEMPLATES: readonly HeartbeatPromptTemplate[] = ["default", "compact"] as const;

function isHeartbeatScopeDisciplineMode(value: unknown): value is HeartbeatScopeDisciplineMode {
  return typeof value === "string" && (VALID_MODES as readonly string[]).includes(value);
}

function isHeartbeatPromptTemplate(value: unknown): value is HeartbeatPromptTemplate {
  return typeof value === "string" && (VALID_TEMPLATES as readonly string[]).includes(value);
}

export function resolveHeartbeatScopeDisciplineMode(
  projectSettings: Pick<ProjectSettings, "heartbeatScopeDiscipline"> | undefined,
  agent: Pick<Agent, "runtimeConfig"> | undefined,
): HeartbeatScopeDisciplineMode {
  const runtimeConfig = agent?.runtimeConfig as Record<string, unknown> | undefined;
  const agentMode = runtimeConfig?.heartbeatScopeDiscipline;
  if (isHeartbeatScopeDisciplineMode(agentMode)) {
    return agentMode;
  }

  const projectMode = projectSettings?.heartbeatScopeDiscipline;
  if (isHeartbeatScopeDisciplineMode(projectMode)) {
    return projectMode;
  }

  return "strict";
}

export function resolveHeartbeatPromptTemplate(
  projectSettings: Pick<ProjectSettings, "heartbeatPromptTemplate"> | undefined,
  agent: Pick<Agent, "runtimeConfig" | "role"> | undefined,
): HeartbeatPromptTemplate {
  const runtimeConfig = agent?.runtimeConfig as Record<string, unknown> | undefined;
  const agentTemplate = runtimeConfig?.heartbeatPromptTemplate;
  if (isHeartbeatPromptTemplate(agentTemplate)) {
    return agentTemplate;
  }

  const projectTemplate = projectSettings?.heartbeatPromptTemplate;
  if (isHeartbeatPromptTemplate(projectTemplate)) {
    return projectTemplate;
  }

  if (!agent) {
    return "default";
  }

  return agent.role === "executor" ? "default" : "compact";
}

export function selectHeartbeatProcedure<T>(
  mode: HeartbeatScopeDisciplineMode,
  isNoTaskRun: boolean,
  procedures: {
    task: Record<HeartbeatScopeDisciplineMode, T>;
    noTask: Record<HeartbeatScopeDisciplineMode, T>;
  },
): T {
  return isNoTaskRun ? procedures.noTask[mode] : procedures.task[mode];
}
