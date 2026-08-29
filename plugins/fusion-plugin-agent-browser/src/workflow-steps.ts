import type { PluginWorkflowStepContribution } from "@fusion/plugin-sdk";

export const AGENT_BROWSER_WORKFLOW_STEPS: PluginWorkflowStepContribution[] = [
  {
    stepId: "browser-evidence-review",
    name: "Browser Evidence Review",
    description: "Verify claims include browser-derived evidence and links.",
    mode: "prompt",
    phase: "pre-merge",
    prompt:
      "Review browser-derived claims in the diff for evidence traceability. Ensure each browser-derived statement is backed by captured artifacts and cite links when present.\n\nFast-bail: if the Diff Scope shows no files introducing or modifying browser-derived claims/evidence, output {\"verdict\":\"APPROVE\",\"notes\":\"out of scope: no browser-derived evidence in diff\"} immediately.\n\nUse verdicts:\n- APPROVE: every browser-derived claim is backed by captured evidence or cited links.\n- APPROVE_WITH_NOTES: claims are traceable but follow-up evidence improvements are advisable; include them in notes.\n- REVISE: at least one browser-derived claim lacks evidence or citation; list offending claims/files in notes.\n\nFinal output (final line only, exactly one JSON object, no markdown fences or extra prose):\n{\"verdict\":\"APPROVE|APPROVE_WITH_NOTES|REVISE\",\"notes\":\"...\"}",
    toolMode: "readonly",
    enabled: true,
    defaultOn: false,
  },
];
