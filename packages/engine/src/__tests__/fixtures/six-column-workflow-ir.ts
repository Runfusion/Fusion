import type { WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowBenchmark 2026-07-19-20:10 (U11 / R11):
The operator's 6-column benchmark workflow, as an IR fixture.

This is the acceptance target of the IR-driven lifecycle cutover: a workflow a user could author
in the editor, whose COLUMNS AND TRAITS ALONE drive the card through its lifecycle. Nothing here
is a builtin — the point is that a custom workflow with custom column ids (`ideas`, `merging`)
gets the same lifecycle service as `builtin:coding`. Any engine code that still special-cases a
literal column id fails against this fixture, which is exactly what it is for. (It already caught
one: the merge seam hardcoded `column: "in-review"`, so a custom Merging column never received
the card — R1's motivating defect.)

Column contract (operator-specified, plan "Benchmark column contract"):
  Ideas       intake, no AI. Waits for a manual promote; nothing fires.
  Todo        triage writes PROMPT.md, an independent reviewer validates it. On REVISE triage
              rewrites and the reviewer re-checks EXACTLY ONCE, then parks.
  In-progress pure execution. No review, no summary.
  In-review   senior review of the whole diff; on pass, a completion summary. On REVISE the card
              goes visibly BACK to In-progress.
  Merging     clean-room merge. `autoMerge:false` waits here for a human.
  Done        terminal.

Two caps are expressed as WORKFLOW CONFIG rather than engine constants, per the plan:
  - replan cap 1  -> `plan-review.config.maxReworkCycles = 1`
  - code-review 3 -> `code-review.config.maxReworkCycles = 3`
Both are read by the graph's generic bounded-rework machinery
(`resolveMaxReworkCycles(head.config.maxReworkCycles)`), so changing a number here changes the
benchmark's behavior with no engine edit. That discharges "expressed as workflow config, not
engine constant" structurally rather than by assertion.

Note on `planReviewReplanCap` (builtin-workflow-settings.ts): that workflow SETTING covers the
same idea for builtin workflows, but ships with no default and falls back to an engine constant.
The rework-head budget is the purely workflow-owned expression, so the benchmark uses it.
*/

/** Column ids, exported so the test asserts against the fixture rather than string literals. */
export const BENCHMARK_COLUMNS = {
  ideas: "ideas",
  todo: "todo",
  inProgress: "in-progress",
  inReview: "in-review",
  merging: "merging",
  done: "done",
} as const;

/** The workflow id. Must NOT start with `builtin:` or the resolver routes to the catalog. */
export const BENCHMARK_WORKFLOW_ID = "benchmark:six-column";

/** Benchmark replan cap: one rewrite+re-review cycle inside Todo, then park. */
export const BENCHMARK_REPLAN_CAP = 1;
/** Benchmark code-review cap: three In-review -> In-progress round-trips, then park. */
export const BENCHMARK_CODE_REVIEW_CYCLES = 3;

/*
FNXC:WorkflowBenchmark 2026-07-19-22:40 (U11 / R5):
`plan-review` and `code-review` are the CANONICAL group ids, and that is load-bearing, not
cosmetic. The scheduler's pre-release hold (`isPlanReviewPreReleaseGateUnpassed`, hold-release.ts)
looks for a node literally named `plan-review` placed in a NON-wip column and refuses to release
the card until a PASSED `plan-review` step result exists. Authoring these as bare `gate` nodes
would record no step result at all, so the card would either deadlock in Todo (gate enabled) or
release into execution before any reviewer ran. Optional-group is the shape that participates.
*/
export const BENCHMARK_NODES = {
  triage: "triage",
  planReview: "plan-review",
  planReviewStep: "plan-review-step",
  planReplan: "plan-replan",
  planPark: "plan-park",
  parse: "parse",
  implement: "implement",
  codeReview: "code-review",
  codeReviewStep: "code-review-step",
  codeReviewRemediation: "code-review-remediation",
  completionSummary: "completion-summary",
  reviewPark: "review-park",
  merge: "merge-attempt",
  finalize: "finalize",
} as const;

export function sixColumnWorkflowIr(): WorkflowIr {
  return {
    version: "v2",
    name: BENCHMARK_WORKFLOW_ID,
    columns: [
      // Ideas: intake only. No node but `start` lives here, so no AI can fire.
      { id: BENCHMARK_COLUMNS.ideas, name: "Ideas", traits: [{ trait: "intake" }] },
      /*
      Todo is a HOLD column released by capacity. This is the KTD-2 seam: the graph parks at
      `todo -> in-progress` and the SCHEDULER performs that one move. Everything else is
      graph-moved.
      */
      {
        id: BENCHMARK_COLUMNS.todo,
        name: "Todo",
        traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
      },
      {
        id: BENCHMARK_COLUMNS.inProgress,
        name: "In-progress",
        traits: [
          { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } },
          { trait: "abort-on-exit" },
          { trait: "timing" },
        ],
      },
      {
        id: BENCHMARK_COLUMNS.inReview,
        name: "In-review",
        traits: [{ trait: "merge-blocker" }, { trait: "stall-detection" }],
      },
      /*
      Merging carries BOTH `merge` and `human-review`. The operator contract settles the
      human-review placement here rather than In-review: with `autoMerge:false` the card waits in
      Merging for manual approval, so that is where the human gate belongs.
      */
      {
        id: BENCHMARK_COLUMNS.merging,
        name: "Merging",
        traits: [{ trait: "merge" }, { trait: "human-review" }],
      },
      { id: BENCHMARK_COLUMNS.done, name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: BENCHMARK_COLUMNS.ideas },

      // ── Todo ────────────────────────────────────────────────────────────────
      {
        id: BENCHMARK_NODES.triage,
        kind: "prompt",
        column: BENCHMARK_COLUMNS.todo,
        config: { seam: "planning", name: "Triage / specify" },
      },
      /*
      Plan Review is the bounded-rework HEAD: a REVISE routes to `plan-replan`, which REWRITES the
      spec and loops back here. Budgeting the loop (rather than re-running the reviewer alone) is
      what makes the cycle "rewrite + re-check" instead of "re-read the same text".
      */
      {
        id: BENCHMARK_NODES.planReview,
        kind: "optional-group",
        column: BENCHMARK_COLUMNS.todo,
        config: {
          name: "Plan Review",
          defaultOn: true,
          reworkRegion: true,
          maxReworkCycles: BENCHMARK_REPLAN_CAP,
          template: {
            nodes: [
              {
                id: BENCHMARK_NODES.planReviewStep,
                kind: "prompt",
                config: {
                  name: "Plan Review",
                  prompt: "Validate PROMPT.md: mission, steps, files, tests, acceptance criteria.",
                  toolMode: "readonly",
                  gateMode: "gate",
                },
              },
            ],
            edges: [],
          },
        },
      },
      /*
      Deliberately NOT carrying `workflowAction: "plan-replan"`. That config diverts the node to
      the executor's `requestPreMergeOptionalStepFix` seam, which schedules remediation OUTSIDE
      the walk and stops traversal — so the authored rework edge is never taken and the loop is
      invisible to the graph. The benchmark's contract is a WORKFLOW-authored loop ("triage
      rewrites, the reviewer re-checks"), so the node stays an ordinary prompt and the cycle
      happens in the graph where it can be observed and bounded.
      */
      {
        id: BENCHMARK_NODES.planReplan,
        kind: "prompt",
        column: BENCHMARK_COLUMNS.todo,
        config: {
          name: "Plan Replan",
          prompt: "Rewrite PROMPT.md against the reviewer feedback.",
          toolMode: "readonly",
        },
      },
      /*
      The replan-cap park. `ask-user` rides the await-input park/resume path, which is the
      awaiting-approval semantics the operator asked for on a second REVISE.
      */
      {
        id: BENCHMARK_NODES.planPark,
        kind: "ask-user",
        column: BENCHMARK_COLUMNS.todo,
        config: { name: "Awaiting plan approval", question: "Plan Review revised twice — approve or rewrite?" },
      },

      // ── In-progress ─────────────────────────────────────────────────────────
      {
        id: BENCHMARK_NODES.parse,
        kind: "parse-steps",
        column: BENCHMARK_COLUMNS.inProgress,
        config: { artifact: "PROMPT.md", parser: "step-headings" },
      },
      {
        id: BENCHMARK_NODES.implement,
        kind: "prompt",
        column: BENCHMARK_COLUMNS.inProgress,
        config: { seam: "execute", name: "Implement" },
      },
      /*
      Code Review's remediation node lives in In-progress while the reviewer lives in In-review.
      That placement is the whole mechanism behind the "visible round-trip": each REVISE produces a
      REAL backward column crossing rather than a silent in-place retry.
      */
      {
        id: BENCHMARK_NODES.codeReviewRemediation,
        kind: "prompt",
        column: BENCHMARK_COLUMNS.inProgress,
        config: {
          name: "Code Review Remediation",
          prompt: "Address the reviewer feedback.",
          toolMode: "coding",
        },
      },

      // ── In-review ───────────────────────────────────────────────────────────
      {
        id: BENCHMARK_NODES.codeReview,
        kind: "optional-group",
        column: BENCHMARK_COLUMNS.inReview,
        config: {
          name: "Code Review",
          defaultOn: true,
          reworkRegion: true,
          maxReworkCycles: BENCHMARK_CODE_REVIEW_CYCLES,
          template: {
            nodes: [
              {
                id: BENCHMARK_NODES.codeReviewStep,
                kind: "prompt",
                config: {
                  name: "Code Review",
                  prompt: "Senior review of the entire diff.",
                  toolMode: "readonly",
                  gateMode: "gate",
                },
              },
            ],
            edges: [],
          },
        },
      },
      {
        id: BENCHMARK_NODES.completionSummary,
        kind: "prompt",
        column: BENCHMARK_COLUMNS.inReview,
        config: { name: "Completion summary", prompt: "Summarize the change in 2-4 sentences." },
      },
      {
        id: BENCHMARK_NODES.reviewPark,
        kind: "ask-user",
        column: BENCHMARK_COLUMNS.inReview,
        config: { name: "Awaiting review approval", question: "Code Review failed 3 cycles — take a look?" },
      },

      // ── Merging ─────────────────────────────────────────────────────────────
      /*
      A merge-region node placed in a CUSTOM column. The graph collapses the merge region into one
      seam invocation; the card must still land in `merging`, not in a hardcoded `in-review`.
      */
      {
        id: BENCHMARK_NODES.merge,
        kind: "merge-attempt",
        column: BENCHMARK_COLUMNS.merging,
        config: { capability: "task-merge", reworkRegion: true, maxReworkCycles: 3 },
      },

      // ── Done ────────────────────────────────────────────────────────────────
      /*
      `end` never moves the card (the executor returns before `onNodeEntry` for start/end), so a
      complete column needs one REAL node for the card to arrive in. `notify` is deliberate: a
      non-AI node kind, so Done stays session-free for the R12 purity assertion.
      */
      {
        id: BENCHMARK_NODES.finalize,
        kind: "notify",
        column: BENCHMARK_COLUMNS.done,
        /*
        FNXC:WorkflowBenchmark 2026-07-19-2c:30 (U12 / R11):
        `event` is REQUIRED by `parseWorkflowIr` for a notify node. Without it this fixture ran
        fine in U11's runner but could not be SAVED through the editor, so R11's "buildable in the
        workflow editor" half was not actually true. Caught by the U12 buildability test — which is
        the whole reason that test asserts against the real save-validation path.
        */
        config: { name: "Announce done", event: "task.completed" },
      },
      { id: "end", kind: "end", column: BENCHMARK_COLUMNS.done },
    ],
    edges: [
      { from: "start", to: BENCHMARK_NODES.triage },
      { from: BENCHMARK_NODES.triage, to: BENCHMARK_NODES.planReview, condition: "success" },
      { from: BENCHMARK_NODES.planReview, to: BENCHMARK_NODES.parse, condition: "success" },
      // Plan Review REVISE -> rewrite the spec -> re-review. Bounded by the group's budget.
      { from: BENCHMARK_NODES.planReview, to: BENCHMARK_NODES.planReplan, condition: "failure" },
      { from: BENCHMARK_NODES.planReplan, to: BENCHMARK_NODES.planReview, condition: "success", kind: "rework" },
      // Budget spent -> park awaiting approval, still inside Todo.
      { from: BENCHMARK_NODES.planReview, to: BENCHMARK_NODES.planPark, condition: "outcome:rework-exhausted" },

      { from: BENCHMARK_NODES.parse, to: BENCHMARK_NODES.implement, condition: "success" },
      { from: BENCHMARK_NODES.implement, to: BENCHMARK_NODES.codeReview, condition: "success" },

      { from: BENCHMARK_NODES.codeReview, to: BENCHMARK_NODES.completionSummary, condition: "success" },
      // Code Review REVISE -> remediation in In-progress -> re-review. Visible round-trip.
      { from: BENCHMARK_NODES.codeReview, to: BENCHMARK_NODES.codeReviewRemediation, condition: "failure" },
      { from: BENCHMARK_NODES.codeReviewRemediation, to: BENCHMARK_NODES.codeReview, condition: "success", kind: "rework" },
      { from: BENCHMARK_NODES.codeReview, to: BENCHMARK_NODES.reviewPark, condition: "outcome:rework-exhausted" },

      { from: BENCHMARK_NODES.completionSummary, to: BENCHMARK_NODES.merge, condition: "success" },
      { from: BENCHMARK_NODES.merge, to: BENCHMARK_NODES.finalize, condition: "success" },
      { from: BENCHMARK_NODES.finalize, to: "end", condition: "success" },
    ],
  };
}
