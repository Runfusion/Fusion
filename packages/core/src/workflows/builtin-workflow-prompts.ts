import { BUILTIN_AGENT_PROMPTS } from "../agents/agent-prompts.js";

const DEFAULT_EXECUTOR_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.role === "executor")?.prompt ?? "";
const DEFAULT_TRIAGE_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.id === "default-triage")?.prompt ?? "";
const DEFAULT_TRIAGE_FAST_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.id === "default-triage-fast")?.prompt ?? "";
const DEFAULT_REVIEWER_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.role === "reviewer")?.prompt ?? "";
const DEFAULT_MERGER_PROMPT = BUILTIN_AGENT_PROMPTS.find((prompt) => prompt.role === "merger")?.prompt ?? "";

/*
FNXC:ReviewGatedPlanning 2026-08-24-06:30:
The review-gated seam used to be `DEFAULT_TRIAGE_PROMPT` plus one appended sentence. That does not
work and was measured not working: the base prompt's PROMPT.md template MANDATES
`### Step {N-1}: Testing & Verification` and `### Step {N}: Documentation & Delivery`, with full
checklists, so a trailing line telling the planner to omit them is a self-contradicting prompt and
the detailed template wins. Tasks kept emitting both steps, the executor ran them in in-progress,
and the review-column gates then redid the same work under the same names.
The parse node's `implementationOnlySteps` is NOT a backstop — it only audits, by design
("Detection is deliberately non-destructive"), because a legitimate implementation step name can
contain these words.
So the template region is REMOVED and replaced by an explicit prohibition. If the base prompt is
reworded and the anchors stop matching, the strip degrades to the old append rather than breaking
planning at runtime; `builtin-workflow-prompts.test.ts` fails loudly on that drift.
*/
const REVIEW_GATE_STEP_TEMPLATE_START = "### Step {N-1}: Testing & Verification";
const REVIEW_GATE_STEP_TEMPLATE_END = "## Documentation Requirements";

const REVIEW_GATED_STEP_CONTRACT = `## Review-gated step contract (OVERRIDES the step template above)

This workflow runs testing, verification, documentation, and delivery as REVIEW-COLUMN GATES after
implementation. They are not task steps here.

- Do NOT emit a "Testing & Verification" step.
- Do NOT emit a "Documentation & Delivery" step.
- Emit implementation steps only, ending with the last implementation step.
- Per-step verification bullets stay: each implementation step still runs its own targeted tests.

`;

export function applyReviewGatedStepContract(prompt: string): string {
  const start = prompt.indexOf(REVIEW_GATE_STEP_TEMPLATE_START);
  const end = prompt.indexOf(REVIEW_GATE_STEP_TEMPLATE_END);
  if (start < 0 || end < 0 || end <= start) {
    return `${prompt}\n\n${REVIEW_GATED_STEP_CONTRACT}`;
  }
  return `${prompt.slice(0, start)}${REVIEW_GATED_STEP_CONTRACT}${prompt.slice(end)}`;
}

/*
FNXC:PlanningDocumentationStep 2026-08-26-05:56:
Operator decision: documentation is NOT a task step.

Repository documentation is part of the change itself — when an edit makes an existing doc wrong, the
executor fixes that doc inside the step that broke it, so it lands in the same diff Code Review
approves. Whether a change warrants a docs edit is the executor's judgement, not a mandatory stage.
Fusion-side delivery — card summary, delivery note, artifact registration, follow-up tasks — belongs
to the in-review Documentation milestone, which runs AFTER the review and writes no repository files.

Before this, a workflow carrying both got each of those four actions planned as executor work AND
performed again by the review milestone: three of the four were the identical tool calls, and both
wrote task document `docs`, so the second silently overwrote the first.

Why a STRIP and not an appended sentence: the base template MANDATES
`### Step {N}: Documentation & Delivery` with a full checklist, and a trailing "do not emit it" line
loses to the detailed template — measured on the abandoned `planning-implementation-only` seam, where
planners kept emitting the steps anyway.

Why this is NOT that seam: it removes ONLY the documentation block. `### Step {N-1}: Testing &
Verification` deliberately stays, because the executor owns testing and must keep planning it.
*/
const DOCUMENTATION_STEP_TEMPLATE_START = "### Step {N}: Documentation & Delivery";
const DOCUMENTATION_STEP_TEMPLATE_END = "## Documentation Requirements";

const NO_DOCUMENTATION_STEP_CONTRACT = `## Documentation is not a step (OVERRIDES the step template above)

Do NOT emit a "Documentation & Delivery" step. "Testing & Verification" is the LAST step.

- **Repository documentation is implementation work.** When a change makes an existing doc wrong,
  update that doc inside the step that made the change, so it is reviewed together with the code.
  Never plan it as its own step, and never gate completion on it when the change documents nothing.
- **Fusion-side delivery is not yours to plan.** The card summary, the delivery note, artifact
  registration, and out-of-scope follow-up tasks are produced by a review-column milestone after the
  review passes. Do not emit steps or checklist items for any of them.

`;

/**
 * Remove the mandated `Documentation & Delivery` step from a planning prompt, keeping the rest of the
 * step template — above all `Testing & Verification` — intact.
 *
 * Degrades to appending the contract when the template anchors stop matching, so a reworded base
 * prompt weakens the instruction instead of breaking planning at runtime.
 */
export function stripDocumentationDeliveryStep(prompt: string): string {
  const start = prompt.indexOf(DOCUMENTATION_STEP_TEMPLATE_START);
  const end = prompt.indexOf(DOCUMENTATION_STEP_TEMPLATE_END);
  if (start < 0 || end < 0 || end <= start) {
    return `${prompt}\n\n${NO_DOCUMENTATION_STEP_CONTRACT}`;
  }
  return `${prompt.slice(0, start)}${NO_DOCUMENTATION_STEP_CONTRACT}${prompt.slice(end)}`;
}

export const BUILTIN_SEAM_PROMPTS: Record<string, string> = {
  execute: DEFAULT_EXECUTOR_PROMPT,
  planning: DEFAULT_TRIAGE_PROMPT,
  "planning-fast": DEFAULT_TRIAGE_FAST_PROMPT,
  /* Review-gated tasks keep test and delivery work in review-column gates. */
  "planning-implementation-only": applyReviewGatedStepContract(DEFAULT_TRIAGE_PROMPT),
  "step-execute": DEFAULT_EXECUTOR_PROMPT,
  review: DEFAULT_REVIEWER_PROMPT,
  merge: DEFAULT_MERGER_PROMPT,
};

export function builtinSeamPrompt(seam: string): string {
  return BUILTIN_SEAM_PROMPTS[seam] ?? "";
}

export function builtinPromptConfig(seam: string, name: string): Record<string, unknown> {
  return { seam, name, prompt: builtinSeamPrompt(seam) };
}
