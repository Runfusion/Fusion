import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";
import { builtinPromptConfig } from "./builtin-workflow-prompts.js";

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
 * triage code that runs outside the graph; workflow-step keeps the legacy
 * pre-merge quality gate between implementation and review; execute/review/
 * merge keep the same observable pipeline and failure routing.
 */
const RAW_BUILTIN_CODING_WORKFLOW_IR: WorkflowIr = {
  version: "v2",
  name: "builtin-coding-workflow",
  columns: [
    { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
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
    {
      id: "execute",
      kind: "prompt",
      column: "in-progress",
      config: { ...builtinPromptConfig("execute", "Execute"), maxRetries: 2 },
    },
    {
      id: "workflow-step",
      kind: "prompt",
      column: "in-progress",
      config: builtinPromptConfig("workflow-step", "Pre-merge workflow steps"),
    },
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
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "planning" },
    { from: "planning", to: "execute", condition: "success" },
    { from: "execute", to: "workflow-step", condition: "success" },
    { from: "workflow-step", to: "review", condition: "success" },
    { from: "workflow-step", to: "end", condition: "outcome:remediation-scheduled" },
    { from: "workflow-step", to: "end", condition: "outcome:deferred-paused" },
    { from: "review", to: "merge-gate", condition: "success" },
    { from: "merge-gate", to: "branch-group-member-integration", condition: "outcome:auto-on" },
    { from: "merge-gate", to: "merge-manual-hold", condition: "outcome:auto-off" },
    { from: "merge-retry", to: "merge-attempt", condition: "success", kind: "rework" },
    { from: "merge-manual-hold", to: "branch-group-member-integration", condition: "success", kind: "rework" },
    { from: "branch-group-member-integration", to: "branch-group-promotion", condition: "success" },
    { from: "branch-group-member-integration", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "branch-group-promotion", to: "merge-attempt", condition: "success" },
    { from: "branch-group-promotion", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "merge-attempt", to: "end", condition: "success" },
    { from: "merge-attempt", to: "merge-retry", condition: "outcome:transient-failure" },
    { from: "merge-attempt", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "recovery-router", to: "merge-attempt", condition: "outcome:wake-merge", kind: "rework" },
    { from: "planning", to: "end", condition: "failure" },
    { from: "execute", to: "end", condition: "failure" },
    { from: "workflow-step", to: "end", condition: "failure" },
    { from: "review", to: "end", condition: "failure" },
    { from: "merge-attempt", to: "end", condition: "failure" },
  ],
  // Workflow-settings (U1, R4): declare the full moved-key catalog with defaults
  // byte-equal to today's DEFAULT_PROJECT_SETTINGS literals. Inert until U3.
  settings: BUILTIN_WORKFLOW_SETTINGS,
  optionalSteps: [{ templateId: "browser-verification" }],
};

export const BUILTIN_CODING_WORKFLOW_IR = parseWorkflowIr(RAW_BUILTIN_CODING_WORKFLOW_IR);
