import type { WorkflowIrNode } from "./workflow-ir-types.js";

export const VERIFICATION_GROUP_ID = "verification";

/**
 * FNXC:ReviewGatedCoding 2026-08-23-04:52:
 * Verification is a deterministic review-column measurement. The nested gate is deliberately not
 * a prompt: only command exit codes may decide whether it passes.
 */
export function verificationOptionalGroupNode(column: string): WorkflowIrNode {
  return {
    id: VERIFICATION_GROUP_ID,
    kind: "optional-group",
    column,
    config: {
      name: "Verification",
      defaultOn: true,
      reworkRegion: true,
      maxReworkCycles: 3,
      template: {
        nodes: [{ id: "verification-step", kind: "gate", config: { name: "Verification", workflowAction: "deterministic-verification" } }],
        edges: [],
      },
    },
  };
}
