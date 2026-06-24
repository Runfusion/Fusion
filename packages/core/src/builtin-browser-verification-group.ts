import type { WorkflowIrNode } from "./workflow-ir-types.js";
import { WORKFLOW_STEP_TEMPLATES } from "./types.js";

/*
FNXC:WorkflowOptionalGroup 2026-06-21-15:10:
Both the built-in coding and stepwise-coding workflows express the optional
`browser-verification` step as an `optional-group` container node on the pre-merge
path (default OFF), REPLACING the legacy `optionalSteps: [{ templateId:
"browser-verification" }]` declaration + the hidden `workflow-step` seam node (U6).
Enabled (task's `enabledWorkflowSteps` includes the group id) → the browser-
verification step runs ONCE pre-merge between implementation and review. Disabled →
the group passes through (byte-inert), exactly preserving the prior runtime behavior
where the step only ran when toggled on.

The group node id `browser-verification` is the STABLE per-task enable key (KTD-2):
keeping it identical to the prior `optionalSteps` templateId preserves any persisted
`enabledWorkflowSteps` entry. The inner template node carries a DISTINCT id
(`browser-verification-step`) because a template node id may not collide with the
group/top-level node id (U1 validation).

The inner node mirrors the dashboard's `stepTemplateToNode` projection of the
canonical `browser-verification` WORKFLOW_STEP_TEMPLATE: a `prompt` node carrying the
template's prompt, `toolMode` (coding), and `gateMode` (advisory default). Sourcing
prompt/toolMode from the catalog keeps the built-in byte-identical to the template a
human would insert from the palette (KTD-5).
*/

function resolveBrowserVerificationTemplate() {
  const tpl = WORKFLOW_STEP_TEMPLATES.find((t) => t.id === "browser-verification");
  if (!tpl) {
    throw new Error("browser-verification WORKFLOW_STEP_TEMPLATE is missing");
  }
  return tpl;
}

const BROWSER_VERIFICATION_TEMPLATE = resolveBrowserVerificationTemplate();

/** Stable per-task enable key + group node id (preserved from the prior templateId). */
export const BROWSER_VERIFICATION_GROUP_ID = "browser-verification";

/** Inner template node id — distinct from the group id (template-node-id collision rule, U1). */
export const BROWSER_VERIFICATION_STEP_NODE_ID = "browser-verification-step";

/**
 * Build the `browser-verification` optional-group node placed on a workflow's
 * pre-merge path. `column` matches where the legacy `workflow-step` seam sat
 * (in-progress) so the editor renders the group in the implementation column.
 *
 * Mirrors `stepTemplateToNode(browser-verification)`: a single `prompt` node whose
 * config carries the catalog prompt + `toolMode: "coding"` + `gateMode: "advisory"`.
 */
export function browserVerificationOptionalGroupNode(column: string): WorkflowIrNode {
  const tpl = BROWSER_VERIFICATION_TEMPLATE;
  return {
    id: BROWSER_VERIFICATION_GROUP_ID,
    kind: "optional-group",
    column,
    config: {
      name: tpl.name,
      defaultOn: false,
      template: {
        nodes: [
          {
            id: BROWSER_VERIFICATION_STEP_NODE_ID,
            kind: "prompt",
            config: {
              name: tpl.name,
              description: tpl.description,
              prompt: tpl.prompt ?? "",
              toolMode: tpl.toolMode === "coding" ? "coding" : "readonly",
              gateMode: tpl.gateMode ?? "advisory",
            },
          },
        ],
        edges: [],
      },
    },
  };
}
