import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";

/**
 * The built-in **stepwise** coding workflow (KTD-9) — the demonstration of step
 * inversion and the parity-comparison subject for the engine's
 * `stepwise-workflow-parity.test.ts`.
 *
 * Unlike the default `builtin-coding-workflow-ir` (which keeps a single monolithic
 * `execute` seam and is the byte-identity parity oracle, KTD-1), this workflow
 * models per-step policy explicitly as graph structure:
 *
 *   plan seam
 *     → parse-steps(PROMPT.md, step-headings)        (KTD-12: graph-native parse)
 *     → foreach(task-steps, sequential, shared) {     (KTD-3: runtime expansion)
 *         step-execute                                 (KTD-2: run one step)
 *           → step-review(code):                       (KTD-4: verdicts as edges)
 *               approve  → step-done (template exit)    (APPROVE auto-completes)
 *               revise   → rework back to step-execute (revise in place, no reset)
 *               rethink  → rework back to step-execute (reset semantics handler-side)
 *               unavailable → (advisory) routes onward
 *       }
 *       rework-exhausted → hold(manual)                (KTD-5: bounded escalation)
 *     → review seam
 *     → merge seam
 *
 * The columns/traits are identical to the default builtin so the full lifecycle
 * (merge-blocker, capacity, hold, complete, archived) behaves exactly as it does
 * for the default workflow — only the in-progress step modeling differs.
 *
 * It declares its step-source artifact (KTD-12): PROMPT.md produced by the
 * planning seam. The IR is v2-only (foreach/step-review/parse-steps are v2 node
 * kinds), so `downgradeIrToV1IfPure` refuses it and the flag-OFF rollback contract
 * (KTD-8) is preserved automatically.
 */
const RAW_BUILTIN_STEPWISE_CODING_WORKFLOW_IR: WorkflowIr = {
  version: "v2",
  name: "builtin-stepwise-coding",
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
      traits: [{ trait: "wip" }, { trait: "abort-on-exit" }, { trait: "timing" }],
    },
    {
      id: "in-review",
      name: "In review",
      traits: [{ trait: "merge-blocker" }, { trait: "stall-detection" }, { trait: "merge" }],
    },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
  ],
  // KTD-12: PROMPT.md is the planning-produced step-source artifact this workflow
  // parses into task steps.
  artifacts: [{ key: "PROMPT.md", title: "Plan", producedBy: "planning", role: "step-source" }],
  nodes: [
    { id: "start", kind: "start", column: "triage" },
    // Planning seam: produces PROMPT.md (the declared step-source artifact).
    { id: "plan", kind: "prompt", column: "in-progress", config: { seam: "planning" } },
    // KTD-12: parse the planned PROMPT.md into the task step list. This node must
    // dominate the foreach (validator-enforced).
    {
      id: "parse",
      kind: "parse-steps",
      column: "in-progress",
      config: { artifact: "PROMPT.md", parser: "step-headings" },
    },
    // KTD-3: runtime-expanding per-step region. Sequential + shared isolation is
    // the default baseline physics (one step at a time in the task's worktree).
    {
      id: "steps",
      kind: "foreach",
      column: "in-progress",
      config: {
        source: "task-steps",
        mode: "sequential",
        isolation: "shared",
        maxReworkCycles: 3,
        template: {
          nodes: [
            // KTD-2: run exactly this step inside the task's session/worktree.
            { id: "step-execute", kind: "prompt", config: { seam: "step-execute" } },
            // KTD-4: per-step code review; verdicts become outcome edges.
            { id: "step-review", kind: "step-review", config: { type: "code" } },
            // Template exit (the single sink the validator requires): a config-less
            // gate is a pure pass-through (createGateHandler → success), so APPROVE
            // routes here and the instance exits. The step is already marked done by
            // the step-review APPROVE verdict (projection authority, KTD-4/KTD-7).
            { id: "step-done", kind: "gate", config: {} },
          ],
          edges: [
            { from: "step-execute", to: "step-review", condition: "success" },
            // APPROVE → template exit (step-done). The step-review verdict already
            // marked the step done through the projection.
            { from: "step-review", to: "step-done", condition: "outcome:approve" },
            // REVISE → rework back to step-execute, revise in place (no reset).
            {
              from: "step-review",
              to: "step-execute",
              condition: "outcome:revise",
              kind: "rework",
            },
            // RETHINK → rework back to step-execute; the traversal triggers
            // resetStepToBaseline (reset semantics are handler-side, KTD-4/U5).
            {
              from: "step-review",
              to: "step-execute",
              condition: "outcome:rethink",
              kind: "rework",
            },
          ],
        },
      },
    },
    // KTD-5: rework exhaustion escalates to a manual hold (a human releases it).
    { id: "rework-hold", kind: "hold", column: "in-progress", config: { release: "manual" } },
    { id: "review", kind: "prompt", column: "in-review", config: { seam: "review" } },
    { id: "merge", kind: "prompt", column: "in-review", config: { seam: "merge" } },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "parse", condition: "success" },
    { from: "plan", to: "end", condition: "failure" },
    { from: "parse", to: "steps", condition: "success" },
    // parse-steps no-steps defaults to success; route it explicitly to the foreach
    // (zero steps → foreach no-ops through its success edge, KTD-8/R8).
    { from: "parse", to: "steps", condition: "outcome:no-steps" },
    { from: "parse", to: "end", condition: "failure" },
    { from: "parse", to: "end", condition: "outcome:parse-error" },
    { from: "steps", to: "review", condition: "success" },
    // KTD-5: bounded rework exhaustion → manual hold; release re-enters review.
    { from: "steps", to: "rework-hold", condition: "outcome:rework-exhausted" },
    { from: "rework-hold", to: "review", condition: "success" },
    { from: "steps", to: "end", condition: "failure" },
    { from: "review", to: "merge", condition: "success" },
    { from: "review", to: "end", condition: "failure" },
    { from: "merge", to: "end", condition: "success" },
    { from: "merge", to: "end", condition: "failure" },
  ],
  // Workflow-settings (U1, R4): same moved-key catalog as the default builtin.
  settings: BUILTIN_WORKFLOW_SETTINGS,
};

export const BUILTIN_STEPWISE_CODING_WORKFLOW_IR = parseWorkflowIr(
  RAW_BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
);
