import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";

/**
 * The built-in **PR** workflow (U9) — the unified PR-entity lifecycle wired end to
 * end as first-class workflow-graph nodes and edges (R3/R20). It is the headline
 * "wire it end to end" deliverable: a task/group routed through this workflow gets
 * the full create → await-review → respond → auto-merge gate → merge → end
 * lifecycle with no hand-authoring.
 *
 * It mirrors the way `builtin-stepwise-coding-workflow-ir` authors a v2 IR
 * directly (the `linear` helper in `builtin-workflows.ts` only builds simple
 * pipelines). Like every built-in it is read-only, and like the stepwise built-in
 * it is graph-runtime-only: the PR node kinds (`pr-create`/`pr-respond`/`pr-merge`),
 * the hold-based await columns, and the top-level rework loop are interpreter-owned
 * and run on the default workflow graph runtime.
 *
 *   start
 *     → pr-create (in-progress)
 *         outcome:open    → await-review  (hold, external-event release)
 *         outcome:failed  → failed        (hold, manual release) --retry--> pr-create
 *     → await-review  (hold; the bounded-rework REGION HEAD)
 *         event changes-requested → pr-respond
 *         event approved          → auto-merge gate
 *         event conflict          → await-rebase (hold) --conflict-cleared--> await-review
 *         manual force-merge      → pr-merge
 *         manual close            → end          (closed)
 *     → pr-respond
 *         --rework: pushed (bounded by maxReworkCycles)--> await-review
 *         outcome:rework-exhausted → await-review-hold (manual) --> await-review
 *     → gate (auto-merge?)
 *         outcome:auto-on  → pr-merge
 *         outcome:auto-off → await-review (park for manual merge)
 *     → pr-merge
 *         outcome:merged-requested → end   (reconcile corroborates `merged`)
 *         outcome:stale-head       → await-review (re-evaluate against new head)
 *     → end
 *
 * **Await states are hold columns with `external-event`/`manual` release (U4).**
 * The node handlers are fast/idempotent/fail-closed; the long waits (for review,
 * for merge readiness, for a cleared conflict) are the holds. The node-agnostic
 * GitHub reconcile (U4) fires the `github:pr-<event>` external-event releases that
 * advance whichever card is parked in an await hold — the scheduler has zero PR
 * knowledge (R20).
 *
 * **The review→respond loop is the bounded rework cycle (U6).** `await-review` is
 * the top-level rework region head (`config.reworkRegion: true`,
 * `config.maxReworkCycles`); the `pr-respond --rework--> await-review` edge loops
 * up to the cap and then routes `outcome:rework-exhausted` to a manual hold so the
 * card parks instead of looping forever (R8).
 *
 * NOTE (cutover deferral): this is shipped ADDITIVELY — a NEW built-in alongside
 * the default `builtin-coding-workflow`, which is unchanged. Full retirement of
 * the legacy comment/monitor PR path (`PrCommentHandler`, `PrMonitor`,
 * `pr-monitor-gh.ts`) is deferred until the graph executor is the default; the
 * flag-OFF path keeps the current working branch-group/per-task PR flow unchanged.
 * See the plan's "Deferred to follow-up work" note.
 */
const RAW_BUILTIN_PR_WORKFLOW_IR: WorkflowIr = {
  version: "v2",
  name: "builtin-pr",
  columns: [
    { id: "triage", name: "Planning", traits: [{ trait: "intake" }] },
    {
      id: "in-progress",
      name: "In progress",
      traits: [{ trait: "wip" }, { trait: "timing" }],
    },
    {
      id: "await-review",
      name: "Awaiting review",
      // The PR-await dwell column. The reconcile fires external-event releases that
      // move whatever card is parked here; the generic hold-release sweep does the
      // move (no PR knowledge in the substrate).
      traits: [{ trait: "merge-blocker" }, { trait: "stall-detection" }],
    },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "triage" },
    // pr-create: open (or reuse) the PR and write the entity (creating → open),
    // or record `failed` (routable, never thrown). It is also a (bounded) rework
    // region head so the manual retry edge from the failed hold is a legal
    // loop-back (the only other top-level cycle besides the review loop).
    { id: "pr-create", kind: "pr-create", column: "in-progress", config: { reworkRegion: true, maxReworkCycles: 5 } },
    // Failed-creation hold: a human releases it (manual) to retry pr-create.
    { id: "failed", kind: "hold", column: "in-progress", config: { release: "manual" } },
    // await-review: the long wait for a review event. ALSO the bounded-rework
    // region head — the pr-respond rework edge loops back here up to the cap.
    // External-event release is fired by the U4 reconcile (github:pr-<event>);
    // manual release covers user-controlled approve/force-merge/close edges.
    {
      id: "await-review",
      kind: "hold",
      column: "await-review",
      config: { release: "external-event", reworkRegion: true, maxReworkCycles: 5 },
    },
    // pr-respond: the review-response run body (U5). Loops back to await-review on
    // a push (the bounded rework edge).
    { id: "pr-respond", kind: "pr-respond", column: "in-progress" },
    // Rework-exhaustion escalation: at the cap, park on a manual hold (a human
    // releases it back to await-review) instead of looping forever (R8).
    {
      id: "await-review-hold",
      kind: "hold",
      column: "await-review",
      config: { release: "manual" },
    },
    // Auto-merge gate (U6, R10): routes outcome:auto-on → pr-merge,
    // outcome:auto-off → park back on await-review for a manual merge.
    { id: "gate", kind: "gate", column: "await-review", config: { gate: "auto-merge" } },
    { id: "manual-merge-hold", kind: "manual-merge-hold", column: "await-review", config: { release: "manual" } },
    // await-rebase: the conflict dwell column. The reconcile fires
    // github:pr-conflict-cleared to release it back to await-review.
    {
      id: "await-rebase",
      kind: "hold",
      column: "await-review",
      config: { release: "external-event" },
    },
    // pr-merge: tool-side merge with expectedHeadOid. Does NOT write `merged` —
    // the reconcile corroborates the terminal state.
    { id: "pr-merge", kind: "pr-merge", column: "await-review" },
    { id: "end", kind: "end", column: "done" },
  ],
  // Edge note: every loop-back to a region head (`await-review` or `pr-create`)
  // is a `kind: "rework"` edge — the only legal top-level cycle (U6). Forward
  // edges leaving a region head (changes-requested, approved, conflict,
  // rework-exhausted, …) are plain. The executor re-runs the head under its
  // bounded budget when a rework edge fires; at the cap it routes
  // `outcome:rework-exhausted` out of the loop.
  edges: [
    { from: "start", to: "pr-create" },
    // pr-create outcomes.
    { from: "pr-create", to: "await-review", condition: "outcome:open" },
    { from: "pr-create", to: "failed", condition: "outcome:failed" },
    // pr-create node-level hard failure (source resolution) also parks on failed.
    { from: "pr-create", to: "failed", condition: "failure" },
    // Manual retry from the failed hold loops back to pr-create (rework region:
    // pr-create), bounded by pr-create's maxReworkCycles.
    { from: "failed", to: "pr-create", condition: "success", kind: "rework" },
    // await-review release events (fired by the U4 reconcile / user controls).
    // These LEAVE the region head, so they are plain forward edges.
    { from: "await-review", to: "pr-respond", condition: "outcome:changes-requested" },
    { from: "await-review", to: "gate", condition: "outcome:approved" },
    { from: "await-review", to: "await-rebase", condition: "outcome:conflict" },
    { from: "await-review", to: "pr-merge", condition: "outcome:force-merge" },
    { from: "await-review", to: "end", condition: "outcome:close" },
    // Rework exhaustion (await-review is the region head): park on a manual hold.
    { from: "await-review", to: "await-review-hold", condition: "outcome:rework-exhausted" },
    // pr-respond → bounded rework back to await-review (the review loop). Bounded
    // by await-review's maxReworkCycles; at the cap the head routes rework-exhausted.
    { from: "pr-respond", to: "await-review", condition: "outcome:fixed", kind: "rework" },
    { from: "pr-respond", to: "await-review", condition: "outcome:disagreed-only", kind: "rework" },
    // await-review-hold manual release → back to await-review (rework loop-back).
    { from: "await-review-hold", to: "await-review", condition: "success", kind: "rework" },
    // Conflict cleared → back to await-review (rework loop-back).
    { from: "await-rebase", to: "await-review", condition: "outcome:conflict-cleared", kind: "rework" },
    // auto-merge gate routing. auto-on goes forward to pr-merge; auto-off parks
    // back on await-review for a manual merge (rework loop-back).
    { from: "gate", to: "pr-merge", condition: "outcome:auto-on" },
    { from: "gate", to: "manual-merge-hold", condition: "outcome:auto-off" },
    { from: "manual-merge-hold", to: "pr-merge", condition: "success" },
    // pr-merge outcomes: merged-requested ends (reconcile corroborates `merged`);
    // a stale-head race re-evaluates against the new head via await-review.
    { from: "pr-merge", to: "end", condition: "outcome:merged-requested" },
    { from: "pr-merge", to: "await-review", condition: "outcome:stale-head", kind: "rework" },
    // Defensive: a non-actionable / no-entity merge parks rather than dead-ends.
    { from: "pr-merge", to: "await-review", condition: "outcome:not-actionable", kind: "rework" },
    { from: "pr-merge", to: "await-review", condition: "failure", kind: "rework" },
  ],
};

export const BUILTIN_PR_WORKFLOW_IR = parseWorkflowIr(RAW_BUILTIN_PR_WORKFLOW_IR);
