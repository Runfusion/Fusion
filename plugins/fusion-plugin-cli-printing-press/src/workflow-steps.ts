import type { PluginWorkflowStepContribution } from "@fusion/plugin-sdk";

export const CLI_PRINTING_PRESS_WORKFLOW_STEPS: PluginWorkflowStepContribution[] = [
  {
    stepId: "run-service-cli",
    name: "Run Service CLI",
    description: "Run generated service CLI checks before merge using the task project script map.",
    mode: "script",
    phase: "pre-merge",
    scriptName: "cli-printing-press:run-service-cli",
    enabled: true,
    defaultOn: false,
  },
];
