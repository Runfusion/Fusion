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
 * (merge-blocker, human review, capacity, hold, complete) behaves
 * exactly as it does for the default workflow — only the in-progress step
 * modeling differs.
 *
 * It declares its step-source artifact (KTD-12): PROMPT.md produced by the
 * planning seam. The IR is v2-only (foreach/step-review/parse-steps are v2 node
 * kinds), so `downgradeIrToV1IfPure` refuses it and the flag-OFF rollback contract
 * (KTD-8) is preserved automatically.
 *
 * FNXC:PlanReviewStep 2026-06-28-23:29:
 * Coding (per-step review) also needs the default-on optional Plan Review gate before
 * execution. The group sits between `plan` and `parse` so operators can toggle plan
 * review independently while preserving the per-step code review/rework loop.
 *
 * FNXC:WorkflowReviewGates 2026-06-29-23:27:
 * Per-step review should inherit the regular Coding workflow's graph-native suffix:
 * completion summary flows directly to the merge gate, with the final optional Code
 * Review group providing the only end-of-task automated review gate.
 */
const RAW_BUILTIN_STEPWISE_CODING_WORKFLOW_IR: WorkflowIr = {
  version: "v2",
  name: "builtin-stepwise-coding",
  columns: [
    /*
    FNXC:MergedPlanningColumn 2026-07-28-17:20 (U11 / R1, R2):
    ONE pre-implementation column. Specification, Plan Review and the replan loop all run here, and
    the card leaves only when the scheduler releases it against implementation capacity — so a card
    being planned never holds an implementation slot. This is the DEFAULT lineage: `builtin:coding`
    resolves to the final-review variant, which clones this IR.

    The id stays `todo`; the DISPLAY name becomes "Planning". Deliberate, and the cheaper half of
    the merge: `todo` was already the hold column, so every trait lookup, task row, stored
    selection and the 121 `column === "todo"` guards still in the engine keep meaning exactly what
    they meant, and no stored row needs re-homing. Promoting `triage` instead would have produced
    the same board while making each of those guards workflow-DEPENDENT — still live for Coding
    (Ideas), which keeps `todo` per R11, and silently dead for Coding. Harder to detect than dead.
    `builtin:coding-ideas` already ships this same id-keeping merge.

    `intake` must sit on THIS column rather than a separate one upstream: an intake-only column has
    no releaser — the capacity sweep only releases from a `hold` column — so a card parked there
    waits for a human forever. That is what reverted the earlier attempts (see
    docs/solutions/architecture-patterns/workflow-node-column-placement-and-graph-entry-contract.md).

    NOT applied to `builtin:legacy-coding` (BUILTIN_CODING_WORKFLOW_IR), which keeps the six-column
    split shape on purpose: a workflow whose stated purpose is preserving the original pipeline
    must not be silently reshaped, and R11 commits to legacy shapes continuing to work.

    `todo` stays a legal column id for stored rows and user-authored workflows (R11, KTD-8). What
    is deleted is Todo the STAGE, not the string.
    */
    {
      id: "todo",
      name: "Planning",
      traits: [
        { trait: "intake" },
        { trait: "hold", config: { release: "capacity" } },
        { trait: "reset-on-entry" },
      ],
    },
    {
      id: "in-progress",
      name: "In progress",
      /*
      FNXC:WorkflowColumns 2026-07-26-18:30:
      `limitSetting` is now DECLARED rather than inferred. It used to be implicit: a 6-column IR whose
      ids matched the legacy enum was detected as "the default workflow" and read `maxConcurrent`
      through a special case. Merging Todo into Planning changes the column set, so the capacity policy
      has to say what it means — which is what every custom workflow already has to do.
      */
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
  ],
  // KTD-12: PROMPT.md is the planning-produced step-source artifact this workflow
  // parses into task steps.
  artifacts: [{ key: "PROMPT.md", title: "Plan", producedBy: "planning", role: "step-source" }],
  nodes: [
    /*
    FNXC:MergedPlanningColumn 2026-07-28-17:20 (U11):
    `start` moves into the merged planning column with the rest of the specification phase. Its
    column is load-bearing: the graph entry contract resumes a continuation-less run at the first
    node whose column is not BEHIND the card's, so a `start` left in an undeclared column would be
    unplaceable.
    */
    { id: "start", kind: "start", column: "todo" },
    /*
    FNXC:PlanReviewStep 2026-07-26-17:10:
    PLAN-IN-PLACE: the whole specification phase — `plan`, `plan-review`, `plan-replan` — runs in the
    planning lane (`todo`), before the card ever takes an implementation slot. The card crosses into
    `in-progress` exactly once, at `parse`, and the scheduler owns that crossing.

    `todo` is the planning-lane column the card actually rests in: triage writes PROMPT.md and its
    finalize moves the card `triage -> todo`, then `onSpecifyComplete` seeds a plan-review continuation
    (only when the plan-review node's column equals the card's column) and the continuation drain
    resumes the graph AT plan-review. On success the boundary suspends at the `in-progress` crossing
    with a `capacity` continuation, the hold sweep releases, and the executor resumes at `parse`.
    `triage` cannot host this: it is an intake column with no releaser, so a card parked there waits
    for a human.

    This placement depends on the graph ENTRY CONTRACT (`resolveColumnResumeNode`): a run with no
    continuation resumes at the card's own column, so a card already in `in-progress` re-enters at
    `parse` instead of replaying the planning prologue and dragging itself backward out of wip.
    */
    { id: "plan", kind: "prompt", column: "todo", config: builtinPromptConfig("planning", "Plan") },
    planReviewOptionalGroupNode("todo", { requireExternalIntegrationEvidence: true }),
    planReplanNode("todo"),
    { id: "plan-review-no-op", kind: "gate", column: "todo", config: { workflowAction: "plan-review-no-op" } },
    // KTD-12: parse the planned PROMPT.md into the task step list. This node must
    // dominate the foreach (validator-enforced).
    {
      id: "parse",
      kind: "parse-steps",
      column: "in-progress",
      config: {
        artifact: "PROMPT.md",
        parser: "step-headings",
        requireStepsUnlessNoCommits: true,
      },
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
            { id: "step-execute", kind: "prompt", config: builtinPromptConfig("step-execute", "Step execute") },
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
    // FNXC:WorkflowOptionalGroup 2026-06-21-15:10:
    // Pre-merge optional browser-verification as an `optional-group` container
    // (default OFF), parity with builtin-coding-workflow-ir (U6). It REPLACES the
    // prior `workflow-step` seam + `optionalSteps` declaration. R-3 run-once
    // guarantee: the group sits on the post-foreach success path (steps → here →
    // review), so when enabled the browser-verification step runs EXACTLY ONCE
    // after every step-instance completes — never per step-instance — and when
    // disabled the group passes through inert. Both the normal foreach-success path
    // and the rework-exhausted manual-release path flow through this node.
    /*
    FNXC:WorkflowReviewGates 2026-07-26-11:05:
    Review gates belong in the "In review" column, not "In progress". Browser Verification and
    Code Review are review surfaces: while one runs the operator should see the card sitting in
    In review with the running step name as a card badge (the badge is lane-gated on
    `column === "in-review"` in dashboard `taskProgress.getRunningOptionalGateBadge`, so the
    column IS the badge switch). This mirrors the Coding (Ideas) preset, which already re-homed
    `code-review` to in-review. The paired remediation nodes stay in "In progress": a gate that
    requests changes must visibly send the card back to implementation.

    Capacity consequence: `in-review` carries no `wip` trait, so a card under review releases its
    concurrency/worktree slot even though its agent and checkout are still live. The pool can
    therefore be full when the remediation node tries to cross back into `in-progress`, and
    capacity is enforced in-transaction and is never bypassable — that move CAN be rejected. The
    boundary controller handles it by PARKING the run on a capacity rejection rather than failing
    it (`workflow-column-boundary.ts` onNodeEntry), so the card keeps its failed gate result and
    the next graph run retries the crossing once a slot frees. Holding the slot through review via
    occupancy accounting was tried and rejected: it cannot cover the failure -> remediation window
    (occupancy keys on a `pending` lease that is already terminal by then) and it mis-assigns slots
    on operator moves out of the review lane.
    */
    browserVerificationOptionalGroupNode("in-review"),
    browserVerificationRemediationNode("in-progress"),
    // FNXC:CodeReviewStep 2026-06-25-15:00:
    // Pre-merge Code Review as a DEFAULT-ON optional-group (blocking gate), on the post-foreach
    // success path between browser-verification and review (steps → browser-verification →
    // code-review → review). It sits after the foreach so it runs EXACTLY ONCE pre-merge
    // (never per step-instance); both the foreach-success and rework-exhausted manual-
    // release paths flow through it. Runs for every task by default (defaultOn:true) but is
    // toggleable off per task; disabled → byte-inert pass-through.
    // FNXC:WorkflowReviewGates 2026-07-26-11:05: in-review placement — see the note on
    // browser-verification above.
    codeReviewOptionalGroupNode("in-review"),
    codeReviewRemediationNode("in-progress"),
    /*
    FNXC:WorkflowExecutionOwnership 2026-07-29-11:40 (U8 / R4 — workflow-owned lifecycle):
    THE PENDING-REVIEW PARK. An implementation pass can stop because a step is blocked on a
    pending review: the agent cannot continue, and the card belongs in review rather than in an
    error bucket (`status: failed` on an `in-review` row deadlocks the merge queue). The executor
    used to perform that transition inline, mid-session, and the graph found out afterwards.

    A `review-handoff` seam (pure lifecycle handoff, no reviewer invocation) whose ONLY edge is to
    `end` — hand off and STOP, which is what the inline handoff did. Routing to the merge path
    instead would carry work whose steps are incomplete into merge-gate.

    Inherited by the final-review and Ideas variants, which clone this IR.
    */
    {
      id: "review-pending-handoff",
      kind: "prompt",
      column: "in-review",
      config: builtinPromptConfig("review-handoff", "Park for pending review"),
    },
    completionSummaryNode("in-review"),
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
    { from: "start", to: "plan" },
    { from: "plan", to: "plan-review", condition: "success" },
    { from: "plan", to: "end", condition: "failure" },
    { from: "plan-review", to: "parse", condition: "success" },
    { from: "plan-review", to: "plan-review-no-op", condition: "outcome:close-no-op" },
    { from: "plan-review-no-op", to: "end", condition: "success" },
    { from: "plan-review", to: "plan-replan", condition: "failure" },
    { from: "plan-replan", to: "plan-review", condition: "success", kind: "rework" },
    { from: "parse", to: "steps", condition: "success" },
    // Only explicitly authorized no-commit tasks return no-steps; they may no-op
    // through foreach. Missing implementation steps fail before execution/review.
    { from: "parse", to: "steps", condition: "outcome:no-steps" },
    { from: "parse", to: "end", condition: "failure" },
    { from: "parse", to: "end", condition: "outcome:parse-error" },
    { from: "parse", to: "end", condition: "outcome:missing-implementation-steps" },
    // Implementation complete → pre-merge browser-verification optional-group →
    // review. Both the normal foreach-success path and the rework-exhausted
    // manual-release path flow through the group so an enabled task runs the step
    // ONCE after the foreach (R-3), and a disabled task passes through to review.
    { from: "steps", to: "browser-verification", condition: "success" },
    // KTD-5: bounded rework exhaustion → manual hold; release re-enters the group.
    { from: "steps", to: "rework-hold", condition: "outcome:rework-exhausted" },
    { from: "rework-hold", to: "browser-verification", condition: "success" },
    /*
    FNXC:WorkspaceReviewSeal 2026-08-21-19:36:
    A completion-summary agent can acquire the task worktree. It therefore precedes Code Review;
    the approval becomes the final write-sensitive pre-merge gate and cannot be invalidated by the
    built-in workflow after it is recorded.
    */
    { from: "browser-verification", to: "completion-summary", condition: "success" },
    { from: "completion-summary", to: "code-review", condition: "success" },
    { from: "code-review", to: "merge-gate", condition: "success" },
    { from: "browser-verification", to: "browser-verification-remediation", condition: "failure" },
    { from: "browser-verification-remediation", to: "browser-verification", condition: "success", kind: "rework" },
    { from: "code-review", to: "code-review-remediation", condition: "failure" },
    { from: "code-review-remediation", to: "code-review", condition: "success", kind: "rework" },
    /*
    FNXC:WorkflowExecutionOwnership 2026-07-29-11:45 (U8 / R4):
    `outcome:` edges match on the node's VALUE and take priority over the generic failure edge
    below, so this claims ONLY the pending-review ending. `runForeach` returns a failing
    instance's value as the foreach node's own, which is what carries `review-pending` from the
    `step-execute` seam up to this edge.
    */
    { from: "steps", to: "review-pending-handoff", condition: "outcome:review-pending" },
    { from: "review-pending-handoff", to: "end", condition: "success" },
    { from: "steps", to: "end", condition: "failure" },
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
    /*
    FNXC:WorkspaceReviewReroute 2026-08-21-20:11:
    A stale workspace approval returns to the final Code Review gate through a bounded rework
    edge, preserving the existing graph owner instead of burning a merge retry.
    */
    { from: "merge-attempt", to: "code-review", condition: "outcome:workspace-review-required", kind: "rework" },
    { from: "merge-attempt", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "recovery-router", to: "merge-attempt", condition: "outcome:wake-merge", kind: "rework" },
    { from: "merge-attempt", to: "end", condition: "failure" },
  ],
  // Workflow-settings (U1, R4): same moved-key catalog as the default builtin.
  settings: BUILTIN_WORKFLOW_SETTINGS,
};

export const BUILTIN_STEPWISE_CODING_WORKFLOW_IR = parseWorkflowIr(
  RAW_BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
);
