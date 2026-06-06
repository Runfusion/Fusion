import type { WorkflowSettingDefinition } from "./workflow-ir-types.js";

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
export const BUILTIN_WORKFLOW_SETTINGS: WorkflowSettingDefinition[] = [
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
    default: 1,
    description: "Maximum number of automatic fix passes after review feedback.",
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
  {
    id: "titleSummarizerProvider",
    name: "Title summarizer provider",
    type: "string",
    description: "Provider for summarizing task titles.",
  },
  {
    id: "titleSummarizerModelId",
    name: "Title summarizer model",
    type: "string",
    description: "Model id for summarizing task titles.",
  },
  {
    id: "titleSummarizerFallbackProvider",
    name: "Title summarizer fallback provider",
    type: "string",
    description: "Fallback provider for summarizing task titles.",
  },
  {
    id: "titleSummarizerFallbackModelId",
    name: "Title summarizer fallback model",
    type: "string",
    description: "Fallback model id for summarizing task titles.",
  },
];
