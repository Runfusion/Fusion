import type { PluginWorkflowStepContribution } from "@fusion/plugin-sdk";

export const AGENT_BROWSER_WORKFLOW_STEPS: PluginWorkflowStepContribution[] = [
  {
    stepId: "browser-evidence-review",
    name: "Browser Evidence Review",
    description: "Verify claims include browser-derived evidence and links.",
    mode: "prompt",
    phase: "pre-merge",
    prompt: "Confirm browser-derived statements are traceable to captured evidence and cite links when present.",
    toolMode: "readonly",
    enabled: true,
    defaultOn: false,
  },
];
