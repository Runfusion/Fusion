import { THINKING_LEVELS, type Settings } from "./types.js";
import type { WorkflowSettingDefinition } from "./workflow-ir-types.js";

/**
 * Built-in workflow settings catalog.
 *
 * `BUILTIN_MOVED_WORKFLOW_SETTINGS` is the U4 moved-key catalog: keys that
 * formerly lived in `DEFAULT_PROJECT_SETTINGS` and are tombstoned by
 * `MOVED_SETTINGS_KEYS`. Defaults should stay aligned with engine fallback
 * literals; intentional product-default changes must update both together.
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
 *
 * `BUILTIN_OVERSIGHT_SETTINGS` is workflow-native planner oversight policy.
 * These keys never lived in project/global settings and must never be added to
 * `MOVED_SETTINGS_KEYS`.
 */

/**
 * The moved-key catalog declared as workflow settings (U1, R4).
 *
 * Single source of truth, imported by both built-in workflow IR files
 * (`builtin-coding-workflow-ir.ts`, `builtin-stepwise-coding-workflow-ir.ts`) so
 * the catalog has exactly one definition.
 *
 * Each `default` here must stay aligned with the corresponding engine read-site
 * fallback literal so projects without stored workflow values execute with the
 * same policy the Workflow Editor displays. Keys with `undefined` legacy
 * defaults (the per-phase model lanes) omit `default` entirely, which
 * round-trips to the same effective value.
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
    /*
     * FNXC:WorkflowReview 2026-07-01-08:09:
     * Code Review steps can exceed the old six-minute default on ordinary dashboard changes. Use a fifteen-minute workflow-step default so every project without an override gets enough reviewer time while keeping runaway sessions bounded.
     */
    default: 900_000,
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
  /*
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Workflow-declared primary model lanes may pin a thinking effort per (workflow, project). Empty values inherit through the lane/global/default chain, enum options are validated against THINKING_LEVELS.
   *
   * FNXC:Settings-ThinkingLevel 2026-07-10-11:13:
   * FN-7793: planning/validator fallback lanes now get their own companion thinking-level settings (`planningFallbackThinkingLevel`/`validatorFallbackThinkingLevel`, declared below), matching the global `fallbackThinkingLevel` and project `titleSummarizerFallbackThinkingLevel` keys — fallback lanes no longer merely reuse their primary lane's thinking level.
   */
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
    id: "executionThinkingLevel",
    name: "Execution thinking level",
    type: "enum",
    options: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
    description: "Thinking effort for the execution phase. Empty inherits from the task or default thinking level.",
  },
  /*
   * FNXC:Settings-ExecutorModel 2026-07-16-00:00:
   * FN-8098 makes executor recovery workflow-configurable; unset values deliberately
   * inherit the shared fallback pair so existing configurations continue to work.
   */
  {
    id: "executionFallbackProvider",
    name: "Executor fallback provider",
    type: "string",
    description: "Fallback provider for the execution phase.",
  },
  {
    id: "executionFallbackModelId",
    name: "Executor fallback model",
    type: "string",
    description: "Fallback model id for the execution phase.",
  },
  {
    id: "executionFallbackThinkingLevel",
    name: "Executor fallback thinking level",
    type: "enum",
    options: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
    description: "Thinking effort for the executor fallback model. Empty inherits from shared fallback or executor thinking.",
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
    id: "planningThinkingLevel",
    name: "Planning thinking level",
    type: "enum",
    options: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
    description: "Thinking effort for the planning phase. Empty inherits from the task or default thinking level.",
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
    /*
     * FNXC:Settings-ThinkingLevel 2026-07-10-11:13:
     * Planning and validator fallback thinking levels are workflow-declared companions to their fallback provider/model lanes, persisted per (workflow, project). Empty means inherit; FN-7793 only declares the storage surface.
     */
    id: "planningFallbackThinkingLevel",
    name: "Planning fallback thinking level",
    type: "enum",
    options: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
    description: "Thinking effort for the planning fallback model. Empty inherits from the task or default thinking level.",
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
    id: "validatorThinkingLevel",
    name: "Validator thinking level",
    type: "enum",
    options: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
    description: "Thinking effort for the validation/review phase. Empty inherits from the task or default thinking level.",
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
    id: "validatorFallbackThinkingLevel",
    name: "Validator fallback thinking level",
    type: "enum",
    options: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
    description: "Thinking effort for the validator fallback model. Empty inherits from the task or default thinking level.",
  },
];

export const BUILTIN_TRIAGE_POLICY_SETTINGS: WorkflowSettingDefinition[] = [
  {
    id: "triageProactiveSubtaskSplittingEnabled",
    name: "Triage proactive subtask splitting",
    type: "boolean",
    default: true,
    /*
     * FNXC:TriagePolicy 2026-07-04-00:00:
     * Operators need a workflow/project policy switch that disables automatic large-task splitting without weakening explicit `breakIntoSubtasks: true` requests. Keep the default enabled to preserve existing triage behavior for workflows that have no stored override.
     */
    description:
      "Enable automatic large-task splitting guidance during triage. Turn off to split only when breakIntoSubtasks is explicitly requested.",
  },
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
    type: "string",
    default: "builtin:quick-fix",
    description: "Preferred built-in or custom workflow id for decision-only or investigation tasks that expect no code changes.",
  },
  {
    id: "triageDefaultWorkflowId",
    name: "Triage default workflow",
    type: "string",
    default: "",
    description:
      "Optional built-in or custom workflow id override for triage. Empty inherits config.settings.defaultWorkflowId.",
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
    minimum: 0,
    integer: true,
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
    minimum: 0,
    integer: true,
    /*
     * FNXC:WorkflowRevisionBudget 2026-06-30-19:45:
     * Built-in Code Review remediation is unbounded when this workflow value is unset. Operators can store a non-negative integer per workflow to cap automatic code-fix passes, and `0` disables automatic Code Review remediation for that workflow.
     */
    description:
      "Maximum automatic Code Review remediation attempts for this workflow. Leave unset for unbounded; set 0 to disable automatic revision.",
  },
  {
    id: "planReviewReplanCap",
    name: "Plan Review replan cap",
    type: "number",
    minimum: 0,
    integer: true,
    /*
     * FNXC:WorkflowRevisionBudget 2026-07-15-12:00:
     * FN-7985 makes the triage Plan Review replan ceiling operator-configurable per workflow.
     * The write boundary rejects fractional and negative values so operators never save a
     * value triage would discard. Leave this declaration without a default so an unset value falls back to
     * PLAN_REVIEW_GATE_REPLAN_CAP; that preserves the source default while allowing its
     * coordinated value to change without baking a second default into workflow settings.
     */
    description:
      "Maximum automatic plan → REVISE → replan iterations before manual approval. Leave unset to use the built-in default; set 0 to require approval after the first REVISE.",
  },
];

/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Workflows declare a default planner oversight level before per-task override and engine reader support land in FN-7509/FN-7510. The workflow-native enum stays out of project settings and `MOVED_SETTINGS_KEYS`; its schema default is `autonomous` so built-in workflows preserve full steering/control until operators choose Off, Observe, or Steer.
 *
 * FNXC:PlannerOversight 2026-07-04-12:00:
 * FN-7518 adds `plannerOversightNotificationLevel`, a sibling workflow-native enum letting operators configure how noisy planner-overseer notifications are: Silent suppresses all, Errors only notifies on failures/escalations, Important (the default) notifies on interventions/recovery actions plus errors, and All notifies on every observation. Default is `important` (not `all`) to avoid noisy-by-default behavior. This setting stays workflow-native (out of project/global settings schemas and `MOVED_SETTINGS_KEYS`) and resolves through the generic `resolveEffectiveSettings` default path with no special-casing. This task only declares the setting — the emission gating that reads it lands downstream in FN-7519 (intervention timeline) and FN-7520 (run-audit/activity events).
 */
/**
 * FNXC:PlannerOversight 2026-07-09-00:00:
 * FN-7743 requirement: an ordinary in-progress task (FN-7732) sat stuck for hours
 * with no recovery action because the executor-stage overseer observation had no
 * staleness detection — it always reported `signal: "progressing"` regardless of
 * inactivity. `plannerOverseerExecutorStuckAfterMs` is the configurable inactivity
 * threshold: once a non-paused in-progress task's last execution activity
 * (`columnMovedAt ?? updatedAt`) is older than this, the executor stage reports
 * `signal: "stuck"` instead, which already flows through `decidePlannerRecovery`
 * into bounded `inject_guidance` recovery. Default 2 hours (7,200,000ms): long
 * enough that a healthy, actively-working step (the vast majority of which finish
 * well under 2h) is never nagged, short enough to actually recover a task that has
 * gone dark for "hours" (the FN-7732 symptom) — mirrors the existing 2-hour
 * convention `metaTaskStallAutoCloseMs` already uses for a comparable stall
 * judgment call elsewhere in this codebase.
 */
export const DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

export const PLANNER_HEARTBEAT_PATROL_ENABLED_SETTING_ID = "plannerHeartbeatPatrolEnabled";

export const BUILTIN_OVERSIGHT_SETTINGS: WorkflowSettingDefinition[] = [
  {
    id: "plannerOversightLevel",
    name: "Planner oversight level",
    type: "enum",
    default: "autonomous",
    options: [
      { value: "off", label: "Off" },
      { value: "observe", label: "Observe" },
      { value: "steer", label: "Steer" },
      { value: "autonomous", label: "Autonomous recovery" },
    ],
    description:
      "Workflow planner oversight mode: Off disables oversight; Observe watches only; Steer injects guidance or suggests revisions; Autonomous recovery enables bounded retry and targeted-fix recovery.",
  },
  {
    id: "plannerOversightNotificationLevel",
    name: "Planner oversight notification level",
    type: "enum",
    default: "important",
    options: [
      { value: "silent", label: "Silent" },
      { value: "errors", label: "Errors only" },
      { value: "important", label: "Important" },
      { value: "all", label: "All" },
    ],
    description:
      "Planner overseer notification verbosity: Silent suppresses overseer notifications; Errors only notifies on failures/escalations; Important notifies on interventions/recovery actions and errors; All notifies on every observation. Notification-emission gating that reads this value is follow-up work (FN-7519/FN-7520).",
  },
  {
    id: "plannerOverseerExecutorStuckAfterMs",
    name: "Executor stall threshold (ms)",
    type: "number",
    default: DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS,
    description:
      "Milliseconds of executor-stage inactivity (no progress since the task's last column move/update) before the planner overseer reports the in-progress task as stuck, triggering bounded autonomous recovery (Autonomous level only). Default 7200000 (2 hours). Set higher to avoid nagging long-running steps; set lower to recover hung executors faster.",
  },
  /*
  FNXC:PlannerOversight 2026-07-14-12:00:
  Session-advisor (OMP parity) is OFF by default. Operators must flip
  `plannerOverseerAdvisorEnabled` and set both provider + model id before any
  second-model transcript review runs — even when plannerOversightLevel is
  autonomous. Lifecycle supervisor (stall/retry/confirm) is unaffected.

  FNXC:PlannerOversight 2026-07-13-23:05:
  Session-advisor model gate. Both provider + model id must be set for live
  transcript advising when the feature is enabled.
  */
  {
    id: "plannerOverseerAdvisorEnabled",
    name: "Session advisor (LLM)",
    type: "boolean",
    default: false,
    description:
      "Workflow-level enable for the planner overseer session advisor (live LLM transcript review). Prefer project Settings → General → Session advisor (and per-task / Quick Add eye toggle) for day-to-day control; this workflow flag still enables when the project default is off (backward compatible). When enabled, also set Session advisor model provider and model id. Does not change lifecycle stage watching, stall recovery, or merge confirmation.",
  },
  {
    id: "plannerOverseerAdvisorProvider",
    name: "Session advisor model provider",
    type: "string",
    default: "",
    description:
      "Provider id for the planner overseer session advisor (live transcript review). Used only when Session advisor (LLM) is enabled. Must be set together with Session advisor model id.",
  },
  {
    id: "plannerOverseerAdvisorModelId",
    name: "Session advisor model id",
    type: "string",
    default: "",
    description:
      "Model id for the planner overseer session advisor. Used only when Session advisor (LLM) is enabled. Must be set together with Session advisor model provider.",
  },
  /*
   * FNXC:HeartbeatPatrol 2026-07-14-23:35:
   * Idle no-task heartbeat patrol creates net-new work while plannerOversightLevel recovers tasks already in flight. Keep patrol as its own workflow setting so operators can reduce autonomous task creation volume without disabling stuck-task observation, steering, or recovery.
   */
  {
    id: PLANNER_HEARTBEAT_PATROL_ENABLED_SETTING_ID,
    name: "Planner heartbeat patrol enabled",
    type: "boolean",
    default: true,
    description:
      "Enable idle/no-task heartbeat proactive patrol guidance that encourages agents to create or delegate new follow-up tasks. Disable to keep idle agents to assigned work, direct messages, explicit operator requests, and safe read-only/logging coordination without disabling planner overseer stuck-task recovery.",
  },
];

export const BUILTIN_WORKFLOW_SETTINGS: WorkflowSettingDefinition[] = [
  ...BUILTIN_MOVED_WORKFLOW_SETTINGS,
  ...BUILTIN_TRIAGE_POLICY_SETTINGS,
  ...BUILTIN_REVIEW_REVISION_SETTINGS,
  ...BUILTIN_OVERSIGHT_SETTINGS,
];

const TRIAGE_POLICY_DEFAULTS = new Map(
  BUILTIN_TRIAGE_POLICY_SETTINGS.map((setting) => [setting.id, setting.default]),
);

function formatTriagePolicyValue(id: string, value: unknown, settings: Partial<Settings>): string {
  /*
   * FNXC:WorkflowRouting 2026-07-15-00:00:
   * The triage prompt must name the operator's project default workflow when no
   * per-workflow override is configured. This keeps planning guidance aligned
   * with config.settings.defaultWorkflowId and accepts custom workflow IDs.
   */
  if (id === "triageDefaultWorkflowId") {
    const explicitValue = typeof value === "string" ? value.trim() : "";
    if (explicitValue && explicitValue !== "builtin:coding") return explicitValue;
    const projectDefault = typeof settings.defaultWorkflowId === "string" ? settings.defaultWorkflowId.trim() : "";
    return projectDefault || "builtin:coding";
  }
  if (id === "triageNoCommitsDecisionVerbs") {
    const verbs = Array.isArray(value) ? value : TRIAGE_POLICY_DEFAULTS.get(id);
    return (Array.isArray(verbs) ? verbs : []).map((verb) => String(verb)).join(", ");
  }
  if (id === "triageProactiveSubtaskSplittingEnabled") {
    const enabled = value !== false;
    if (!enabled) {
      return `Proactive oversized-task splitting is DISABLED for this workflow/project.

- Do NOT split solely because the task is Size M/L, has many planned implementation steps, touches many files/packages, or otherwise looks oversized.
- Only create child tasks when \`breakIntoSubtasks: true\` is explicitly present; in that case, follow the mandatory \`## Triage subtask breakdown\` flow above exactly.
- When proactive splitting is disabled and \`breakIntoSubtasks: true\` is absent, write a normal PROMPT.md for the original task even if it is large; document realistic scope, risks, and quality gates instead of replacing it with child tasks.`;
    }
    return `For tasks you assess as Size M or L, consider whether splitting into 2-5 child tasks would improve execution quality. Default to keeping the task whole; only split when the work is genuinely large or has clearly independent deliverables.

**Consider splitting when ANY of these apply:**
- The task will require MORE THAN {{triageSubtaskStepThreshold}} implementation steps
- The task affects MORE THAN {{triageSubtaskPackageThreshold}} different packages/modules with distinct concerns (a typed field change that naturally touches core types + store + UI + tests is NOT 4 distinct concerns — it's one coherent change)
- Any single step would take more than 1-2 hours to complete
- The task has multiple clearly independent deliverables that could be developed and shipped in parallel by different people

**Splitting guidance:**
- Even when \`breakIntoSubtasks\` is not set to \`true\`, apply these thresholds proactively
- Keep explicit user intent first: when \`breakIntoSubtasks: true\`, follow the mandatory breakdown flow above
- Size S tasks should NOT be split — the overhead outweighs the benefit
- A task with 7-10 focused steps within a coherent scope is fine as one unit; do not split it
- Coordination overhead (worktrees, dependency wiring, merge sequencing) is real — only split when the parallelism or scope-clarity benefit clearly outweighs it
- If you decide not to split an M/L task, proceed with a normal PROMPT.md specification

**Broad-scope decomposition signals:**
- Size L tasks, especially when the planned step count would reach {{triageSubtaskLargeStepSignal}} or more.
- Plans whose implementation-step count would reach {{triageSubtaskAdditiveStepSignal}} or more (additive signal — counts even when the surrounding step-count threshold above has not yet fired).
- Tasks whose declared \`## File Scope\` would list {{triageSubtaskFileScopeThreshold}} or more entries.
- Descriptions that quantify large remediation batches (for example "47 failing tests", "30+ broken files") at or above {{triageSubtaskRemediationBatchThreshold}} items — treat as a strong signal that the work should be partitioned by subsystem or file group before specifying.
- When two or more of the signals above fire together, default to splitting via \`fn_task_create\`. If you still choose to keep the task as a single unit, justify the decision explicitly in the PROMPT.md \`## Mission\` paragraph.`;
  }
  return String(value ?? TRIAGE_POLICY_DEFAULTS.get(id) ?? "");
}

export function renderTriagePolicyPlaceholders(prompt: string, settings: Partial<Settings>): string {
  let rendered = prompt;
  const values = settings as Record<string, unknown>;
  for (const setting of BUILTIN_TRIAGE_POLICY_SETTINGS) {
    const token = new RegExp(`\\{\\{${setting.id}\\}\\}`, "g");
    rendered = rendered.replace(token, formatTriagePolicyValue(setting.id, values[setting.id] ?? setting.default, settings));
  }
  const leftover = rendered.match(/\{\{[^}]+\}\}/);
  if (leftover) {
    throw new Error(`Unresolved triage policy placeholder: ${leftover[0]}`);
  }
  return rendered;
}
