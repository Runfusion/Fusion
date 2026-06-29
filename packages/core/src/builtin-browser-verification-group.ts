import type { WorkflowIrNode } from "./workflow-ir-types.js";

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

FNXC:WorkflowOptionalGroup 2026-06-25-00:00:
U6 deleted the built-in step-template catalog; the inner node's literal
name/description/prompt/toolMode/gateMode are now inlined here directly (byte-identical
to the former `browser-verification` catalog entry). These built-ins are the parity
oracle, so the produced node bytes must NOT change. Plugin-contributed templates still
use the `WorkflowStepTemplate` shape via the editor palette, but built-ins no longer
read from a shared array.

FNXC:WorkflowBrowserVerification 2026-06-27-13:20:
The Browser Verification step must actually use the `agent-browser` workflow surface, not only mention it in the prompt. `requiresBrowser` tells the engine to load the agent-browser navigation skill when available, preflight CLI availability, and surface start/probe/tool activity in the task agent log while keeping the step's coding tool mode intact.
*/

/** Stable per-task enable key + group node id (preserved from the prior templateId). */
export const BROWSER_VERIFICATION_GROUP_ID = "browser-verification";

/** Inner template node id — distinct from the group id (template-node-id collision rule, U1). */
export const BROWSER_VERIFICATION_STEP_NODE_ID = "browser-verification-step";

/** Display name (inlined from the former `browser-verification` catalog template). */
const BROWSER_VERIFICATION_NAME = "Browser Verification";

/** Short description (inlined from the former catalog template). */
const BROWSER_VERIFICATION_DESCRIPTION = "Verify web application functionality using browser automation";

/** Agent prompt (inlined verbatim from the former catalog template — parity oracle). */
const BROWSER_VERIFICATION_PROMPT = `You are a browser verification specialist. Verify web application functionality after task implementation using the agent-browser CLI tool.

## Prerequisites
First, determine the URL to verify. Check the task PROMPT.md for any URLs mentioned, or look at the code changes to identify the local development server URL (typically http://localhost:3000, http://localhost:5173, http://localhost:8080, etc.).

## Verification Commands
Use these agent-browser commands for verification:
- \`agent-browser open <url>\` — Navigate to the page
- \`agent-browser snapshot -i\` — Get interactive elements with refs (@e1, @e2, etc.)
- \`agent-browser click @e1\` — Click an element
- \`agent-browser fill @e1 "text"\` — Fill an input field
- \`agent-browser get text @e1\` — Get element text content
- \`agent-browser screenshot\` — Capture screenshot to file
- \`agent-browser wait --load networkidle\` — Wait for page to fully load

## Verification Checklist
1. Page loads without JavaScript errors or blank screens
2. Navigation between pages/sections works
3. Forms accept input and submit correctly
4. Interactive elements (buttons, links) respond to clicks
5. Error states are handled gracefully
6. Screenshots capture expected content

## Output Requirements
- Fast-bail: if Diff Scope contains no browser-verification-relevant UI files, output {"verdict":"APPROVE","notes":"out of scope: browser verification"} immediately.
- APPROVE: verification succeeds.
- APPROVE_WITH_NOTES: verification succeeds with non-blocking advisory findings; include evidence references in notes.
- REVISE: verification failures or regressions require changes; include failing behavior and actionable file paths in notes.
- Screenshots/artifacts referenced in notes are evidence only; verdict must be conveyed by the final JSON line.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}

Note: Refs (@e1, @e2) are invalidated after page navigation. Re-snapshot after clicking links or form submissions.`;

/**
 * Build the `browser-verification` optional-group node placed on a workflow's
 * pre-merge path. `column` matches where the legacy `workflow-step` seam sat
 * (in-progress) so the editor renders the group in the implementation column.
 *
 * Mirrors `stepTemplateToNode(browser-verification)`: a single `prompt` node whose
 * config carries the inlined prompt + `toolMode: "coding"` + `gateMode: "advisory"`.
 */
export function browserVerificationOptionalGroupNode(
  column: string,
  options: { defaultOn?: boolean } = {},
): WorkflowIrNode {
  return {
    id: BROWSER_VERIFICATION_GROUP_ID,
    kind: "optional-group",
    column,
    config: {
      name: BROWSER_VERIFICATION_NAME,
      defaultOn: options.defaultOn ?? false,
      reworkRegion: true,
      maxReworkCycles: 3,
      template: {
        nodes: [
          {
            id: BROWSER_VERIFICATION_STEP_NODE_ID,
            kind: "prompt",
            config: {
              name: BROWSER_VERIFICATION_NAME,
              description: BROWSER_VERIFICATION_DESCRIPTION,
              prompt: BROWSER_VERIFICATION_PROMPT,
              toolMode: "coding",
              gateMode: "advisory",
              requiresBrowser: true,
            },
          },
        ],
        edges: [],
      },
    },
  };
}
