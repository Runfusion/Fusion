import type { Settings } from "@fusion/core";
import { isResearchExperimentalEnabled } from "@fusion/core";
import type { PluginRunner } from "./plugin-runner.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function isResearchToolSurfaceEnabled(settings: Partial<Settings> | undefined): boolean {
  return isResearchExperimentalEnabled(settings);
}

export function getResearchToolSurfaceStatus(settings: Partial<Settings> | undefined): {
  enabled: boolean;
  reason: "experimental-disabled" | "enabled";
} {
  const enabled = isResearchToolSurfaceEnabled(settings);
  return {
    enabled,
    reason: enabled ? "enabled" : "experimental-disabled",
  };
}

const TRIAGE_RESEARCH_GUIDANCE = `## Research tools
When spec work needs missing domain context, you may use research tools (\`fn_research_run\`, \`fn_research_list\`, \`fn_research_get\`, \`fn_research_cancel\`, \`fn_research_retry\`). Keep research bounded to the task at hand, prefer concise queries, and write durable findings into task documents when useful.
If research is unavailable or unconfigured, continue planning with repository context and clearly note assumptions.`;

const EXECUTOR_RESEARCH_GUIDANCE = `## Research tools
When implementation needs external context, you may use research tools (
\`fn_research_run\`, \`fn_research_list\`, \`fn_research_get\`, \`fn_research_cancel\`, \`fn_research_retry\`) to run bounded research.
Keep runs focused and short, and persist durable conclusions into task documents (for example key="research").
If research is disabled or providers are not configured, use the actionable tool response and continue with available local context.`;

export function getResearchGuidanceForSurface(surface: "triage" | "executor"): string {
  return surface === "triage" ? TRIAGE_RESEARCH_GUIDANCE : EXECUTOR_RESEARCH_GUIDANCE;
}

export function getEnabledPluginTools(pluginRunner: PluginRunner | undefined): ToolDefinition[] {
  if (!pluginRunner) return [];
  return pluginRunner.getPluginTools();
}
