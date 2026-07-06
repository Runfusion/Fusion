import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";
import { builtinPromptConfig } from "./builtin-workflow-prompts.js";
import { browserVerificationOptionalGroupNode } from "./builtin-browser-verification-group.js";
import { codeReviewOptionalGroupNode } from "./builtin-code-review-group.js";
import { completionSummaryNode } from "./builtin-completion-summary-node.js";
import { postMergeVerificationOptionalGroupNode } from "./builtin-post-merge-group.js";
import { planReviewOptionalGroupNode } from "./builtin-plan-review-group.js";
import {
  browserVerificationRemediationNode,
  codeReviewRemediationNode,
  planReplanNode,
} from "./builtin-workflow-remediation-nodes.js";

/**
 * The built-in default workflow as a v2 IR. Its six columns have ids that are
 * EXACTLY the legacy enum values in legacy order (KTD-1), so a task with no
 * workflow selection resolves here and its stored `column` value is already a
 * valid column id — migration rewrites zero task rows.
 *
 * Trait ids are plain strings (the trait registry ships in U2); the mapping
 * reproduces legacy behavior verbatim (R12):
 *   triage      = intake
 *   todo        = hold(capacity) + reset-on-entry
 *   in-progress = wip + abort-on-exit + timing
 *   in-review   = merge-blocker + human-review + stall-detection + merge
 *   done        = complete
 *   archived    = archived
 *
 * The lifecycle seam nodes are placed in their columns. Planning is explicit so
 * the built-in workflow owns the specification phase rather than relying on
 * triage code that runs outside the graph; execute/review/merge keep the same
 * observable pipeline and failure routing.
 *
 * FNXC:WorkflowOptionalGroup 2026-06-21-15:10:
 * The pre-merge optional `browser-verification` step is now an `optional-group`
 * container node (default OFF) sitting on the success path between execute and
 * review — REPLACING the legacy `workflow-step` seam node + the execution-inert
 * `optionalSteps: [{ templateId: "browser-verification" }]` declaration (U6). A
 * task whose `enabledWorkflowSteps` includes the group id runs browser
 * verification pre-merge exactly as before; a task with it off bypasses it.
 */
const RAW_BUILTIN_CODING_WORKFLOW_IR: WorkflowIr = {
  version: "v2",
  name: "builtin-coding-workflow",
  columns: [
    // FNXC:Workflows 2026-07-05-00:00: Default-workflow intake column now displays as "Planning" while keeping the `triage` id for lifecycle/DB/type stability (FN-7599).
    { id: "triage", name: "Planning", traits: [{ trait: "intake" }] },
    {
      id: "todo",
      name: "Todo",
      traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
    },
    {
      id: "in-progress",
      name: "In progress",
      traits: [
        { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } },
        { trait: "abort-on-exit" },
        { trait: "timing" },
      ],
    },
    {
      id: "in-review",
      name: "In review",
      traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "stall-detection" }, { trait: "merge" }],
    },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "triage" },
    {
      id: "planning",
      kind: "prompt",
      column: "triage",
      config: builtinPromptConfig("planning", "Plan / specify"),
    },
    planReviewOptionalGroupNode("in-progress"),
    planReplanNode("triage"),
    {
      id: "execute",
      kind: "prompt",
      column: "in-progress",
      config: { ...builtinPromptConfig("execute", "Execute"), maxRetries: 2 },
    },
    // Pre-merge optional browser-verification (optional-group, default OFF).
    browserVerificationOptionalGroupNode("in-progress"),
    browserVerificationRemediationNode("in-progress"),
    // FNXC:CodeReviewStep 2026-06-25-15:00:
    // Pre-merge Code Review as a DEFAULT-ON optional-group (blocking gate), on the success path
    // between browser-verification and review (execute → browser-verification →
    // code-review → review). Runs for every coding task by default (defaultOn:true) but is
    // toggleable off per task; disabled → byte-inert pass-through.
    codeReviewOptionalGroupNode("in-progress"),
    codeReviewRemediationNode("in-progress"),
    completionSummaryNode("in-review"),
    { id: "review", kind: "prompt", column: "in-review", config: builtinPromptConfig("review", "Review") },
    { id: "merge-gate", kind: "merge-gate", column: "in-review", config: { gate: "auto-merge" } },
    { id: "merge-retry", kind: "retry-backoff", column: "in-review", config: { policy: "merge", maxAttempts: 3 } },
    { id: "merge-manual-hold", kind: "manual-merge-hold", column: "in-review", config: { release: "manual" } },
    {
      id: "branch-group-member-integration",
      kind: "branch-group-member-integration",
      column: "in-review",
      config: { reworkRegion: true, maxReworkCycles: 3 },
    },
    { id: "branch-group-promotion", kind: "branch-group-promotion", column: "in-review" },
    {
      id: "merge-attempt",
      kind: "merge-attempt",
      column: "in-review",
      config: { capability: "task-merge", reworkRegion: true, maxReworkCycles: 3 },
    },
    { id: "recovery-router", kind: "recovery-router", column: "in-review", config: { surfaces: ["merge", "retry"] } },
    postMergeVerificationOptionalGroupNode("done"),
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "planning" },
    { from: "planning", to: "plan-review", condition: "success" },
    { from: "plan-review", to: "execute", condition: "success" },
    // execute → browser-verification (optional-group) → review. When the group is
    // disabled it passes through with outcome=success and routes straight to review.
    { from: "execute", to: "browser-verification", condition: "success" },
    // browser-verification → code-review → review. Each optional-group passes through with
    // outcome=success when disabled, so a task with both off routes straight to review.
    { from: "browser-verification", to: "code-review", condition: "success" },
    { from: "code-review", to: "completion-summary", condition: "success" },
    { from: "completion-summary", to: "review", condition: "success" },
    { from: "review", to: "merge-gate", condition: "success" },
    { from: "merge-gate", to: "branch-group-member-integration", condition: "outcome:auto-on" },
    { from: "merge-gate", to: "merge-manual-hold", condition: "outcome:auto-off" },
    { from: "merge-retry", to: "merge-attempt", condition: "success", kind: "rework" },
    { from: "merge-manual-hold", to: "branch-group-member-integration", condition: "success", kind: "rework" },
    { from: "branch-group-member-integration", to: "branch-group-promotion", condition: "success" },
    { from: "branch-group-member-integration", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "branch-group-promotion", to: "merge-attempt", condition: "success" },
    { from: "branch-group-promotion", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "merge-attempt", to: "post-merge-verification", condition: "success" },
    { from: "post-merge-verification", to: "end", condition: "success" },
    { from: "merge-attempt", to: "merge-retry", condition: "outcome:transient-failure" },
    { from: "merge-attempt", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "recovery-router", to: "merge-attempt", condition: "outcome:wake-merge", kind: "rework" },
    { from: "planning", to: "end", condition: "failure" },
    { from: "plan-review", to: "plan-replan", condition: "failure" },
    { from: "plan-replan", to: "plan-review", condition: "success", kind: "rework" },
    { from: "execute", to: "end", condition: "failure" },
    { from: "browser-verification", to: "browser-verification-remediation", condition: "failure" },
    { from: "browser-verification-remediation", to: "browser-verification", condition: "success", kind: "rework" },
    { from: "code-review", to: "code-review-remediation", condition: "failure" },
    { from: "code-review-remediation", to: "code-review", condition: "success", kind: "rework" },
    { from: "review", to: "end", condition: "failure" },
    { from: "merge-attempt", to: "end", condition: "failure" },
  ],
  // Workflow-settings (U1, R4): declare the full moved-key catalog with defaults
  // byte-equal to today's DEFAULT_PROJECT_SETTINGS literals. Inert until U3.
  settings: BUILTIN_WORKFLOW_SETTINGS,
};

export const BUILTIN_CODING_WORKFLOW_IR = parseWorkflowIr(RAW_BUILTIN_CODING_WORKFLOW_IR);
