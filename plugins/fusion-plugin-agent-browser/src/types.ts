export type SkillExposure = "none" | "selected" | "all";

export interface AgentBrowserSettings {
  enabled: boolean;
  installChannel: "stable" | "beta" | "nightly";
  commandTimeoutMs: number;
  headlessMode: boolean;
  allowedDomains: string[];
  promptExecutorSystem: string;
  promptExecutorTask: string;
  promptTriage: string;
  promptReviewer: string;
  promptHeartbeat: string;
  skillExposure: SkillExposure;
}

export const DEFAULT_SETTINGS: AgentBrowserSettings = {
  enabled: true,
  installChannel: "stable",
  commandTimeoutMs: 120000,
  headlessMode: true,
  allowedDomains: [],
  promptExecutorSystem: "When browsing, summarize evidence with URLs.",
  promptExecutorTask: "Use browser context only when needed for the task.",
  promptTriage: "Mark tasks requiring browser evidence explicitly.",
  promptReviewer: "Verify browser-derived claims are backed by cited pages.",
  promptHeartbeat: "Keep browser interactions bounded and report failures clearly.",
  skillExposure: "selected",
};

export function resolveSettings(input: Record<string, unknown> | undefined): AgentBrowserSettings {
  const src = input ?? {};
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_SETTINGS.enabled,
    installChannel:
      src.installChannel === "stable" || src.installChannel === "beta" || src.installChannel === "nightly"
        ? src.installChannel
        : DEFAULT_SETTINGS.installChannel,
    commandTimeoutMs:
      typeof src.commandTimeoutMs === "number" && Number.isFinite(src.commandTimeoutMs) && src.commandTimeoutMs > 0
        ? src.commandTimeoutMs
        : DEFAULT_SETTINGS.commandTimeoutMs,
    headlessMode: typeof src.headlessMode === "boolean" ? src.headlessMode : DEFAULT_SETTINGS.headlessMode,
    allowedDomains: Array.isArray(src.allowedDomains) ? src.allowedDomains.filter((v): v is string => typeof v === "string") : [],
    promptExecutorSystem:
      typeof src.promptExecutorSystem === "string" ? src.promptExecutorSystem : DEFAULT_SETTINGS.promptExecutorSystem,
    promptExecutorTask: typeof src.promptExecutorTask === "string" ? src.promptExecutorTask : DEFAULT_SETTINGS.promptExecutorTask,
    promptTriage: typeof src.promptTriage === "string" ? src.promptTriage : DEFAULT_SETTINGS.promptTriage,
    promptReviewer: typeof src.promptReviewer === "string" ? src.promptReviewer : DEFAULT_SETTINGS.promptReviewer,
    promptHeartbeat: typeof src.promptHeartbeat === "string" ? src.promptHeartbeat : DEFAULT_SETTINGS.promptHeartbeat,
    skillExposure:
      src.skillExposure === "none" || src.skillExposure === "selected" || src.skillExposure === "all"
        ? src.skillExposure
        : DEFAULT_SETTINGS.skillExposure,
  };
}
