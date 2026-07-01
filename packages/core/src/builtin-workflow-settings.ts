import type { Settings } from "./types.js";
import type { WorkflowSettingDefinition } from "./workflow-ir-types.js";

/**
 * Built-in workflow settings catalog.
 *
 * `BUILTIN_MOVED_WORKFLOW_SETTINGS` is the U4 moved-key catalog: keys that
 * formerly lived in `DEFAULT_PROJECT_SETTINGS` and are tombstoned by
 * `MOVED_SETTINGS_KEYS`. Keep those defaults byte-equal to the legacy literals.
 *
 * `BUILTIN_TRIAGE_POLICY_SETTINGS` is workflow-native triage/spec policy. These
 * keys never lived in `DEFAULT_PROJECT_SETTINGS`, are NOT part of the U4
 * hard-move migration, must never be added to `MOVED_SETTINGS_KEYS`, and must
 * not appear in project/global settings schemas. Canonical values are inherited
 * from the post-FN-6232 planning prompt: subtask step threshold `7` (not the
 * older engine copy) and packages/modules threshold `3`. Fast-mode policy is
 * workflow-native here too: `leanPlanning` selects the lean planning variant,
 * and `autoApproveSpec` skips the independent spec reviewer.
 *
 * `BUILTIN_REVIEW_REVISION_SETTINGS` is workflow-native review-loop policy.
 * These keys also never lived in project/global settings and intentionally omit
 * declaration defaults: an unset workflow value means unbounded remediation.
 */

/**
 * The moved-key catalog declared as workflow settings (U1, R4).
 *
 * Single source of truth, imported by both built-in workflow IR files
 * (`builtin-coding-workflow-ir.ts`, `builtin-stepwise-coding-workflow-ir.ts`) so
 * the catalog has exactly one definition.
 *
 * Each `default` here MUST be byte-equal to the corresponding literal in
 * `DEFAULT_PROJECT_SETTINGS` (`settings-schema.ts`) — this is the parity anchor
 * for the U4 hard-move migration. The U1 test
 * (`workflow-ir-settings.test.ts`) asserts strict equality against the legacy
 * literals. Keys with `undefined` legacy defaults (the per-phase model lanes)
 * omit `default` entirely, which round-trips to the same effective value.
 *
 * NOTE: these declarations are inert in U1 — nothing reads them until the
 * effective-settings resolver and engine integration land (U3). Adding them does
 * not change any built-in workflow's behavior.
 *
 * Keys deliberately NOT in this catalog (per KTD-4 / the catalog-shrink rule):
 *   - `completionDocumentationMode` — read outside per-task scope (triage), stays
 *     in project settings.
 *   - merge-cluster keys + `maxConcurrent` — owned by the columns/traits track.
 */
export const BUILTIN_MOVED_WORKFLOW_SETTINGS: WorkflowSettingDefinition[] = [
  // ── Step execution ─────────────────────────────────────────────────────
  {
    id: "workflowStepTimeoutMs",
    name: "Step timeout (ms)",
    type: "number",
    default: 360_000,
    description: "Maximum time a single workflow step may run before it is timed out.",
  },
  {
    id: "workflowStepScopeEnforcement",
    name: "Step scope enforcement",
    type: "enum",
    default: "block",
    options: [
      { value: "block", label: "Block" },
      { value: "warn", label: "Warn" },
      { value: "off", label: "Off" },
    ],
    description: "How to handle a step that writes outside its declared file scope.",
  },
  {
    id: "planOnlyScopeLeakEnforcement",
    name: "Plan-only scope leak enforcement",
    type: "enum",
    default: "warn",
    options: [
      { value: "off", label: "Off" },
      { value: "warn", label: "Warn" },
      { value: "block", label: "Block" },
    ],
    description: "How to handle code changes during a plan-only step.",
  },
  {
    id: "workflowRevisionForkOnScopeMismatch",
    name: "Fork workflow revision on scope mismatch",
    type: "boolean",
    default: true,
    description: "Fork a new workflow revision when a step's actual scope diverges from its plan.",
  },
  {
    id: "strictScopeEnforcement",
    name: "Strict scope enforcement",
    type: "boolean",
    default: false,
    description: "Enforce declared step scope strictly, rejecting any out-of-scope change.",
  },
  {
    id: "runStepsInNewSessions",
    name: "Run steps in new sessions",
    type: "boolean",
    default: false,
    description: "Run each workflow step in its own agent session instead of a shared one.",
  },
  {
    id: "maxParallelSteps",
    name: "Max parallel steps",
    type: "number",
    default: 2,
    description: "Maximum number of steps to run in parallel when running steps in new sessions.",
  },
  {
    id: "buildRetryCount",
    name: "Build retry count",
    type: "number",
    default: 0,
    description: "Number of times to retry a failing build before giving up.",
  },
  // NOTE (U4 catalog-shrink): `buildTimeoutMs` was REMOVED from this catalog —
  // it has NO reader anywhere in the engine, so per the per-task-reader rule
  // (KTD-5) it stays a plain project setting and is NOT moved to workflow
  // settings. It is therefore absent from `MOVED_SETTINGS_KEYS` and remains in
  // `DEFAULT_PROJECT_SETTINGS`.
  {
    id: "verificationFixRetries",
    name: "Verification fix retries",
    type: "number",
    default: 3,
    description: "Number of automatic fix attempts after a failed verification.",
  },
  {
    id: "maxPostReviewFixes",
    name: "Max post-review fixes",
    type: "number",
    /*
     * FNXC:WorkflowOptionalStepCycle 2026-06-29-17:55:
     * This global budget remains the fallback for custom optional gates and explicitly capped built-in gates. Built-in Code Review now sets `maxRevisions: "unbounded"` so ordinary reviewer feedback keeps recovering instead of terminal-failing after three passes.
     */
    default: 3,
    description: "Maximum automatic fix passes after review/optional-step feedback; the step re-runs each pass until it passes or this budget is exhausted.",
  },

  // ── Review / approval ──────────────────────────────────────────────────
  {
    id: "requirePrApproval",
    name: "Require PR approval",
    type: "boolean",
    default: false,
    description: "Require explicit approval before a pull request can be merged.",
  },
  {
    id: "requirePlanApproval",
    name: "Require plan approval",
    type: "boolean",
    default: false,
    description: "Require explicit approval of the plan before execution begins.",
  },
  {
    id: "reviewHandoffPolicy",
    name: "Review handoff policy",
    type: "enum",
    default: "disabled",
    options: [
      { value: "disabled", label: "Disabled" },
      { value: "comment-triggered", label: "Comment-triggered" },
      { value: "always", label: "Always" },
    ],
    description: "When to hand off a task to a human reviewer.",
  },
  {
    id: "maxReviewerContextRetries",
    name: "Max reviewer context retries",
    type: "number",
    default: 2,
    description: "Maximum reviewer retries due to insufficient context before falling back.",
  },
  {
    id: "maxReviewerFallbackRetries",
    name: "Max reviewer fallback retries",
    type: "number",
    default: 2,
    description: "Maximum reviewer retries on the fallback model before failing.",
  },
  {
    id: "reflectionEnabled",
    name: "Reflection enabled",
    type: "boolean",
    default: false,
    description: "Enable periodic reflection passes over completed work.",
  },
  // NOTE (U3 catalog-shrink, item 5): `reflectionIntervalMs` and
  // `reflectionAfterTask` were REMOVED from this catalog — neither has any engine
  // read site (verified by grep across packages/engine/src), so per the plan's
  // catalog-shrink rule they stay plain project settings and are NOT moved to
  // workflow settings. `reflectionEnabled` is kept because executor.ts reads it
  // (gate for reflection tools).

  // ── Per-phase model lanes ──────────────────────────────────────────────
  // Legacy defaults are all `undefined`; `default` is omitted so resolution
  // falls through to the global lane / project default (KTD-7).
  {
    id: "executionProvider",
    name: "Execution provider",
    type: "string",
    description: "Provider for the execution phase. Empty falls through to the global lane.",
  },
  {
    id: "executionModelId",
    name: "Execution model",
    type: "string",
    description: "Model id for the execution phase. Empty falls through to the global lane.",
  },
  {
    id: "planningProvider",
    name: "Planning provider",
    type: "string",
    description: "Provider for the planning phase. Empty falls through to the global lane.",
  },
  {
    id: "planningModelId",
    name: "Planning model",
    type: "string",
    description: "Model id for the planning phase. Empty falls through to the global lane.",
  },
  {
    id: "planningFallbackProvider",
    name: "Planning fallback provider",
    type: "string",
    description: "Fallback provider for the planning phase.",
  },
  {
    id: "planningFallbackModelId",
    name: "Planning fallback model",
    type: "string",
    description: "Fallback model id for the planning phase.",
  },
  {
    id: "validatorProvider",
    name: "Validator provider",
    type: "string",
    description: "Provider for the validation phase. Empty falls through to the global lane.",
  },
  {
    id: "validatorModelId",
    name: "Validator model",
    type: "string",
    description: "Model id for the validation phase. Empty falls through to the global lane.",
  },
  {
    id: "validatorFallbackProvider",
    name: "Validator fallback provider",
    type: "string",
    description: "Fallback provider for the validation phase.",
  },
  {
    id: "validatorFallbackModelId",
    name: "Validator fallback model",
    type: "string",
    description: "Fallback model id for the validation phase.",
  },
];

export const BUILTIN_TRIAGE_POLICY_SETTINGS: WorkflowSettingDefinition[] = [
  {
    id: "triageSizeSmallMaxHours",
    name: "Triage size S max hours",
    type: "number",
    default: 2,
    description: "Upper hour boundary for Size S triage guidance (S is below this value).",
  },
  {
    id: "triageSizeMediumMaxHours",
    name: "Triage size M max hours",
    type: "number",
    default: 4,
    description: "Upper hour boundary for Size M triage guidance.",
  },
  {
    id: "triageSizeLargeMaxHours",
    name: "Triage size L max hours",
    type: "number",
    default: 8,
    description: "Upper hour boundary for Size L triage guidance; larger work should split as XL.",
  },
  {
    id: "triageSubtaskStepThreshold",
    name: "Triage subtask step threshold",
    type: "number",
    default: 7,
    description: "Implementation-step count above which triage should consider splitting an M/L task.",
  },
  {
    id: "triageSubtaskLargeStepSignal",
    name: "Triage large-step signal",
    type: "number",
    default: 9,
    description: "Planned step count that is a broad-scope decomposition signal for Size L tasks.",
  },
  {
    id: "triageSubtaskAdditiveStepSignal",
    name: "Triage additive step signal",
    type: "number",
    default: 12,
    description: "Implementation-step count that independently signals possible partitioning.",
  },
  {
    id: "triageSubtaskPackageThreshold",
    name: "Triage package/module threshold",
    type: "number",
    default: 3,
    description: "Distinct package/module count above which triage should consider splitting coherent M/L work.",
  },
  {
    id: "triageSubtaskFileScopeThreshold",
    name: "Triage file-scope threshold",
    type: "number",
    default: 20,
    description: "File Scope entry count that signals broad work likely needing partitioning.",
  },
  {
    id: "triageSubtaskRemediationBatchThreshold",
    name: "Triage remediation batch threshold",
    type: "number",
    default: 30,
    description: "Quantified remediation batch size that strongly signals subsystem partitioning.",
  },
  {
    id: "triageNoCommitsDecisionVerbs",
    name: "Triage no-commits decision verbs",
    type: "multi-enum",
    default: ["Decide", "Evaluate", "Verify", "Confirm", "Audit", "Review whether", "Investigate and report"],
    options: [
      { value: "Decide", label: "Decide" },
      { value: "Evaluate", label: "Evaluate" },
      { value: "Verify", label: "Verify" },
      { value: "Confirm", label: "Confirm" },
      { value: "Audit", label: "Audit" },
      { value: "Review whether", label: "Review whether" },
      { value: "Investigate and report", label: "Investigate and report" },
    ],
    description: "Decision-only title/mission verbs used when deciding whether a task expects no commits.",
  },
  {
    id: "triageDecisionOnlyWorkflowId",
    name: "Triage decision-only workflow",
    type: "enum",
    default: "builtin:quick-fix",
    options: [
      { value: "builtin:quick-fix", label: "Quick fix" },
      { value: "builtin:coding", label: "Coding" },
    ],
    description: "Preferred workflow id for decision-only or investigation tasks that expect no code changes.",
  },
  {
    id: "triageDefaultWorkflowId",
    name: "Triage default workflow",
    type: "enum",
    default: "builtin:coding",
    options: [
      { value: "builtin:coding", label: "Coding" },
      { value: "builtin:quick-fix", label: "Quick fix" },
    ],
    description: "Default workflow id for standard coding tasks.",
  },
  {
    id: "leanPlanning",
    name: "Lean planning",
    type: "boolean",
    default: false,
    description: "Use the lean fast-path planning prompt variant instead of the full triage spec prompt.",
  },
  {
    id: "autoApproveSpec",
    name: "Auto-approve spec",
    type: "boolean",
    default: false,
    description: "Auto-approve the generated PROMPT.md and skip the independent spec reviewer.",
  },
];

export const BUILTIN_REVIEW_REVISION_SETTINGS: WorkflowSettingDefinition[] = [
  {
    id: "reviewerInlineFixes",
    name: "Reviewer inline fixes",
    type: "boolean",
    default: true,
    /*
     * FNXC:WorkflowReviewers 2026-07-01-12:33:
     * Default Coding reviewers should fix issues in the same review session when possible instead of always returning REVISE and bouncing the task back through executor remediation. Operators can turn this off per workflow to restore the old review-only behavior.
     */
    description:
      "Allow review-type workflow nodes to fix issues in their own reviewer session before returning a final verdict. Turn off to route findings back to executor remediation.",
  },
  {
    id: "planReviewMaxRevisions",
    name: "Plan Review revision cap",
    type: "number",
    /*
     * FNXC:WorkflowRevisionBudget 2026-06-30-19:45:
     * Built-in Plan Review/spec remediation is unbounded when this workflow value is unset. Operators can store a non-negative integer per workflow to cap automatic replans, and `0` disables automatic Plan Review revision entirely without duplicating a read-only built-in workflow.
     */
    description:
      "Maximum automatic Plan Review/spec revision attempts for this workflow. Leave unset for unbounded; set 0 to disable automatic revision.",
  },
  {
    id: "codeReviewMaxRevisions",
    name: "Code Review revision cap",
    type: "number",
    /*
     * FNXC:WorkflowRevisionBudget 2026-06-30-19:45:
     * Built-in Code Review remediation is unbounded when this workflow value is unset. Operators can store a non-negative integer per workflow to cap automatic code-fix passes, and `0` disables automatic Code Review remediation for that workflow.
     */
    description:
      "Maximum automatic Code Review remediation attempts for this workflow. Leave unset for unbounded; set 0 to disable automatic revision.",
  },
];

export const BUILTIN_WORKFLOW_SETTINGS: WorkflowSettingDefinition[] = [
  ...BUILTIN_MOVED_WORKFLOW_SETTINGS,
  ...BUILTIN_TRIAGE_POLICY_SETTINGS,
  ...BUILTIN_REVIEW_REVISION_SETTINGS,
];

const TRIAGE_POLICY_DEFAULTS = new Map(
  BUILTIN_TRIAGE_POLICY_SETTINGS.map((setting) => [setting.id, setting.default]),
);

function formatTriagePolicyValue(id: string, value: unknown): string {
  if (id === "triageNoCommitsDecisionVerbs") {
    const verbs = Array.isArray(value) ? value : TRIAGE_POLICY_DEFAULTS.get(id);
    return (Array.isArray(verbs) ? verbs : []).map((verb) => String(verb)).join(", ");
  }
  return String(value ?? TRIAGE_POLICY_DEFAULTS.get(id) ?? "");
}

export function renderTriagePolicyPlaceholders(prompt: string, settings: Partial<Settings>): string {
  let rendered = prompt;
  const values = settings as Record<string, unknown>;
  for (const setting of BUILTIN_TRIAGE_POLICY_SETTINGS) {
    const token = new RegExp(`\\{\\{${setting.id}\\}\\}`, "g");
    rendered = rendered.replace(token, formatTriagePolicyValue(setting.id, values[setting.id] ?? setting.default));
  }
  const leftover = rendered.match(/\{\{[^}]+\}\}/);
  if (leftover) {
    throw new Error(`Unresolved triage policy placeholder: ${leftover[0]}`);
  }
  return rendered;
}
