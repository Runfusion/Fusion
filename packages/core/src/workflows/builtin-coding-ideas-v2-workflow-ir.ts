import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "./builtin-coding-ideas-workflow-ir.js";

import { documentationDeliveryOptionalGroupNode } from "./builtin-documentation-delivery-group.js";
import { stripDocumentationDeliveryStep } from "./builtin-workflow-prompts.js";
import { codeReviewRemediationStepsNode } from "./builtin-workflow-remediation-nodes.js";

const clone = (ir: WorkflowIr): WorkflowIr => JSON.parse(JSON.stringify(ir)) as WorkflowIr;

/*
FNXC:CodingIdeasV2Workflow 2026-08-26-05:56:
Operator intent: keep the Coding (Ideas) board exactly as it is (manual "Ideas" intake, autoTriage
false), and enforce ONE rule the inherited board does not — nothing in `in-review` writes code.

in-progress : steps (implementation + its tests) -> the executor's own final verification
in-review   : code-review -> documentation-delivery -> merge

Work and proof of work both finish in `in-progress`. The executor plans and runs its own tests, then
the FN-3345 gate re-runs the project's configured test/build commands as an independent measurement;
a red result appends NAMED fix steps to the card instead of letting it advance (see
bounce-verification-failure.ts). A card only crosses into review once that is green.

`in-review` is then three read-only milestones. Code Review judges the work — it is the only gate
that can hold the card. Documentation reports on it. The merge is the last thing that happens.

Ordering is still NOT cosmetic, for a stricter reason than the review seal: ANY node that runs
between the review and the merge changes the tree the review approved, so `canMergeTask` refuses
with "task has no provable approval for the content being merged" (FN-180's review-diff
fingerprint). Measured on pipeline-smoke S01, where a readonly completion-summary node placed after
the review failed exactly there — readonly was not enough, because it still acquired a worktree.
Documentation may follow the review ONLY because it writes nothing at all: no repository files, no
worktree-visible change. The write-capable seal (`workspace-review-seal-required`) is the second,
weaker constraint on this ordering.
*/
const RAW_BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR: WorkflowIr = (() => {
  const ir = clone(BUILTIN_CODING_IDEAS_WORKFLOW_IR);
  ir.name = "builtin-coding-ideas-v2";

  /*
  FNXC:CodingIdeasV2Workflow 2026-08-25-14:10:
  The planner emits "Testing & Verification" again — the DEFAULT triage prompt, unmodified.

  An earlier revision routed planning through `planning-implementation-only`, whose contract strips
  that step region and replaces it with "Do NOT emit a Testing & Verification step", on the theory
  that a review-column gate would run the checks instead. Two things were wrong with that. The gate
  never executed (its node kind was not routed, so it reported PASS in ~46ms without running
  anything), and even after that was fixed, a review node runs `toolMode: "readonly"` — `bash` is
  denied and `fn_run_verification` is not in the allowlist — so a reviewer CANNOT run lint, tests or
  build no matter what its prompt says.
  Meanwhile the stripped section was the mature contract: real automated tests only ("typechecks and
  builds are NOT tests"), per-step test authoring, a final lint/tests/typecheck/build pass ordered
  before delivery, an explicit duty to update tests that encode behaviour this task changes, and
  setting up a test framework when the project has none. Deleting it left the planner FORBIDDEN from
  planning tests while nothing else ran them.
  Testing belongs to the executor, which has the tools to write and run it. The reviewer judges
  CONFORMITY of that work; it does not perform it.
  */
  /* Plan Review no longer rejects a plan for containing test steps: they belong there again. */
  /*
  FNXC:PlanningDocumentationStep 2026-08-26-05:56:
  Testing is planned; documentation is NOT. The planner keeps the default prompt's
  `Testing & Verification` step and loses its `Documentation & Delivery` step, because this workflow
  runs a Documentation MILESTONE in review that writes the card summary, the delivery note, the
  artifacts, and the follow-up tasks. Keeping both had the executor perform those four actions and
  the milestone perform them again — three were the identical tool calls, and both wrote task
  document `docs`, so the review pass silently overwrote the executor's.
  Repository documentation survives as implementation work: the executor updates a doc its own change
  made wrong, inside the step that made it, so Code Review sees it in the diff.
  The strip is scoped to THIS workflow's copy of the prompt; `builtin:coding` keeps the
  shared template untouched, while the inherited Ideas IR remains a composition base only.
  */
  const plan = ir.nodes.find((node) => node.id === "plan");
  if (!plan?.config) throw new Error("coding-ideas-v2 requires the inherited planning node");
  plan.config.prompt = stripDocumentationDeliveryStep(String(plan.config.prompt ?? ""));
  /*
  FNXC:ReviewGatedRemediation 2026-08-24-22:10:
  Named remediation is enabled: `implementationOnlySteps` + `preserveRemediationSteps` select
  `review-remediation-steps`, so a rejected review derives NAMED work from the reviewer's findings,
  appends it to `task.steps` as a numbered wave, and widens the PROMPT.md File Scope to the files it
  touches — the operator sees exactly what must be fixed instead of a bounced card with an unchanged
  checklist. This depends on the foreach covering appended steps
  (`FNXC:WorkflowForeachGrowth` in workflow-graph-foreach.ts); before that, an appended step never
  received an instance and stayed `pending` forever.
  */
  const parse = ir.nodes.find((node) => node.id === "parse");
  if (parse) parse.config = { ...parse.config, implementationOnlySteps: true, preserveRemediationSteps: true };
  const codeReviewRemediation = ir.nodes.find((node) => node.id === "code-review-remediation");
  if (codeReviewRemediation) {
    codeReviewRemediation.config = {
      ...codeReviewRemediation.config,
      ...codeReviewRemediationStepsNode().config,
      name: "Code Review Remediation",
    };
  }
  /* Superseded note, kept for the reasoning it records:
  This workflow deliberately did NOT set the parse node's `implementationOnlySteps` +
  `preserveRemediationSteps`, so `resolveStepReopenPolicy` kept the inherited "reopen-trailing".
  That pair selects named remediation (`review-remediation-steps`), which cannot execute here: the
  parse node preserves the appended step and then answers `already-expanded`, because the foreach is
  PINNED to the step list it first expanded. A step appended afterwards never receives an instance,
  so it stays `pending` forever — measured on S05, where the card advanced to review with
  `steps=["done","pending"]` and the merge boundary refused with `merge-boundary-unproven`.
  Reopening trailing steps re-runs instances the foreach already owns, which is why the former
  standalone Ideas graph converged. Named remediation stays unavailable to foreach-executed workflows
  until the foreach can re-expand; builtin:review-gated-coding pairs them too and never reached a
  merge to expose it.
  The planner is still constrained — that is the SEAM PROMPT's job, not this flag, which only audits.
  */

  /*
  FNXC:CodingIdeasV2Workflow 2026-08-25-10:20:
  In-review is THREE milestones: Code Review -> Documentation -> Delivery (the merge).

  A separate deterministic `Verification` gate is deliberately GONE. It duplicated the executor's
  own verification, it produced a green badge on projects that had configured no command, and it
  split the merge evidence across two authorities that could disagree. Code Review now RUNS the
  commands itself and rules on their real output, so exit codes still decide and one node owns the
  verdict.

  `completion-summary` is gone as a milestone too: the card summary is written by Documentation in
  the same pass as the delivery note, which removes one model call per card.

  Documentation runs AFTER the review — the ordering the original documentation-delivery node always
  intended ("runs after passing verification and code review") and which the review seal previously
  forbade. It is legal now because Documentation no longer writes the repository: it records a
  Fusion-side delivery note, artifacts, follow-ups, and the card summary. Repository documentation
  is the EXECUTOR's call during implementation, where it is reviewed with the code it documents.
  */
  const codeReviewIndex = ir.nodes.findIndex((node) => node.id === "code-review");
  if (codeReviewIndex < 0) throw new Error("coding-ideas-v2 requires the inherited code-review gate");
  /*
  FNXC:CodingIdeasV2Workflow 2026-08-25-14:10:
  Code Review judges the TESTS, it does not run them. A review node runs `toolMode: "readonly"`,
  whose allowlist is read/grep/find/ls plus a few read-only task tools: `bash` is explicitly denied
  and `fn_run_verification` is absent. An earlier revision instructed this reviewer to run lint,
  tests and build; it never could, and measured review durations of 19s and 23s on real cards show
  it silently reviewed the diff alone. Telling a session to do what its tool policy forbids invites
  the one failure mode worse than a missing check: a fluent claim that the check passed.
  The shared prompt is AUGMENTED rather than edited, so `builtin:coding` and `builtin:coding-ideas`
  keep the reviewer they have always had.
  */
  const codeReviewStep = (ir.nodes[codeReviewIndex]?.config?.template as { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } | undefined)
    ?.nodes?.find((node) => node.id === "code-review-step");
  if (!codeReviewStep?.config) throw new Error("coding-ideas-v2 requires the inherited code-review-step template node");
  codeReviewStep.config.prompt = `${String(codeReviewStep.config.prompt ?? "")}

## Step 0: Judge the TESTS before you judge the code

You cannot run anything: this session is read-only, \`bash\` is denied and no verification tool is
available to you. Do not claim you ran lint, tests or a build, and do not ask for a command to be
run. The executor already wrote and ran the tests; your job is to rule on whether that work is
sound.

Read the test files in the diff and rule on FOUR things:

1. **They exist.** A behavioural change with no test is a REVISE. Say which change is uncovered.
2. **They are real tests.** Assertions executed by a test runner. A typecheck is not a test, a build
   is not a test, and manual verification is not a test.
3. **They assert BEHAVIOUR.** Never a comment, a date stamp, or prose lifted from source. Asserting
   that a comment exists tests nothing a user or caller can observe. Code-construct guards
   (call-site allowlists, architectural ratchets) are legitimate and stay.
4. **They cover the INVARIANT, not just the reported case.** For a bug fix, a test that only
   reproduces the single reported symptom is incomplete: require every known surface. If this task
   CHANGED, GATED or REMOVED behaviour, the tests that encoded the OLD behaviour must have been
   updated or deleted in the same change — they live outside the File Scope and targeted
   verification will not have surfaced them.

Then review the code itself for what tests do not catch: logic errors, broken edge cases, and
unhandled failure modes.`;

  ir.nodes.splice(codeReviewIndex + 1, 0, documentationDeliveryOptionalGroupNode("in-review"));
  const summaryIndex = ir.nodes.findIndex((node) => node.id === "completion-summary");
  if (summaryIndex >= 0) ir.nodes.splice(summaryIndex, 1);

  /* Every inherited edge touching `completion-summary` dies with the node; the lane is rebuilt below. */
  ir.edges = ir.edges.filter((edge) => edge.from !== "completion-summary" && edge.to !== "completion-summary");

  /*
  FNXC:CodingIdeasV2Workflow 2026-08-24-20:40:
  Push ONLY the genuinely new edges. `code-review -> merge-gate` and the code-review rework are
  inherited from Coding (Ideas) and were being re-pushed, so the graph carried each of them twice —
  a duplicated success edge out of a review gate is a second, competing traversal of the same lane.
  */
  /* `code-review -> merge-gate` is inherited and must not survive: Documentation now sits between them. */
  ir.edges = ir.edges.filter((edge) => !(edge.from === "code-review" && edge.to === "merge-gate"));
  ir.edges.push(
    { from: "steps", to: "code-review", condition: "success" },
    { from: "code-review", to: "documentation-delivery", condition: "success" },
    { from: "documentation-delivery", to: "merge-gate", condition: "success" },
    /*
    FNXC:CodingIdeasV2Workflow 2026-08-25-10:20:
    Documentation is ADVISORY: it reports, it never vetoes. Its failure edge reaches the merge gate
    exactly like its success edge, so a delivery note that could not be written cannot strand a
    card whose code is already approved. Measured why: as a blocking gate it bounced a task whose
    own plan said not to implement anything ("No task-specific implementation is present"), and the
    card looped through the review lane every five minutes indefinitely.
    */
    { from: "documentation-delivery", to: "merge-gate", condition: "failure" },
  );
  /*
  FNXC:ReviewGatedRemediation 2026-08-24-20:10:
  Code Review rework stays on the INHERITED `code-review-remediation -> code-review` edge. The
  remediation node is itself a coding session that fixes the findings and completes the trailing
  steps it reopened; routing that rework through `verification` walked the graph forward past the
  foreach, so the reopened step was never re-executed and the card terminalized with
  `merge-boundary-unproven`.
  Cost, stated: a Code Review REVISE does NOT replay Verification or Documentation & Delivery.
  Verification rework does replay the doc node, because it re-enters upstream of it.
  */
  return ir;
})();

export const BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR = parseWorkflowIr(RAW_BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR);
