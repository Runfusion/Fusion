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

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-13:20 (U11 census hygiene):
`"triage"` HERE IS AN AGENT LANE, NOT A BOARD COLUMN — the lane that writes specs,
which keeps its name whatever the board calls its planning column. It appeared in
the `=== "triage"` census purely because it is the same word, and trait-converting
it would be actively wrong: it would tie an agent's prompt to a workflow's column
vocabulary.

Named and table-driven so the distinction is legible and the literal no longer
reads as a lifecycle guard to the next auditor.
*/
export type AgentResearchSurface = "triage" | "executor";

const RESEARCH_GUIDANCE_BY_SURFACE: Record<AgentResearchSurface, string> = {
  triage: TRIAGE_RESEARCH_GUIDANCE,
  executor: EXECUTOR_RESEARCH_GUIDANCE,
};

export function getResearchGuidanceForSurface(surface: AgentResearchSurface): string {
  return RESEARCH_GUIDANCE_BY_SURFACE[surface];
}

export function getEnabledPluginTools(pluginRunner: PluginRunner | undefined): ToolDefinition[] {
  if (!pluginRunner) return [];
  return pluginRunner.getPluginTools();
}
