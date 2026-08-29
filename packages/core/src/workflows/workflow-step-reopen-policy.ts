import type { WorkflowIr } from "./workflow-ir-types.js";

export type StepReopenPolicy = "reopen-trailing" | "none";

/*
FNXC:WorkflowStepReopenPolicy 2026-08-23-07:26:
FN-180 removes lexical step-name reopening because it reopened completed Testing
and Documentation work during Code Review remediation. Review-gated workflows
express their intent in the parse-node configuration, so policy follows the IR
rather than a brittle selected-workflow id.
*/
export function resolveStepReopenPolicy(ir: WorkflowIr | undefined): StepReopenPolicy {
  const parse = ir?.nodes.find((node) => node.id === "parse");
  const config = parse?.config;
  return config?.implementationOnlySteps === true && config?.preserveRemediationSteps === true
    ? "none"
    : "reopen-trailing";
}
