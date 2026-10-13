import { describe, expect, it } from "vitest";
import {
  CompleteColumnGateEvidenceRejectionError,
  classifyEmptyRequiredPreMergeSet,
  classifyPreMergeGateEvidence,
  describeCompleteColumnGateFindings,
  findLatestWorkflowStepResult,
  resolveCompleteColumnGateEvidence,
  type CompleteColumnGateEvidenceState,
} from "../complete-column-gate-evidence.js";
import { isOperatorInitiatedMoveSource } from "../workflow-transition-policy.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { evaluatePreMergeApprovals } from "../../merge/pre-merge-approval.js";
import { TransitionRejectionError } from "../../task-store/errors.js";
import type { WorkflowStepResult } from "../../types.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

/*
FNXC:CompleteColumnGateEvidence 2026-10-11-19:20 (RUFU-406):
Characterization for the complete-column gate-evidence classifier. The motivating measurement is
RUFU-389: a card whose only `workflowStepResults` row was `plan-review / APPROVE_WITH_NOTES`, moved
`todo -> in-progress -> done` from an agent's `fn task move`, landing with zero Code Review evidence
and no merge. Every refusing case below is a shape a completion move must now refuse; every accepting
case is a shape that must keep working, because a guard that also refuses honest evidence just trains
operators and agents to reach for `--move-source engine`.
*/

const BOTH_GATES = ["plan-review", "code-review"];

function row(partial: Partial<WorkflowStepResult> & { workflowStepId: string }): WorkflowStepResult {
  return { status: "passed", completedAt: "2026-10-11T10:00:00.000Z", ...partial } as WorkflowStepResult;
}

function taskWith(results: WorkflowStepResult[], enabled: readonly string[] = BOTH_GATES) {
  return {
    enabledWorkflowSteps: [...enabled],
    workflowStepResults: results,
    executionMode: undefined,
    humanPlanApproval: undefined,
    workspaceWorktrees: undefined,
  };
}

const approvedPreMerge = [
  row({ workflowStepId: "plan-review", verdict: "APPROVE_WITH_NOTES" }),
  row({ workflowStepId: "code-review", verdict: "APPROVE" }),
];

/** Minimal v2 IR holding optional-group nodes, for the empty-required-set vocabulary. */
function irWithGroups(groups: Array<Record<string, unknown>>): WorkflowIr {
  return {
    version: "v2",
    nodes: groups.map((config, index) => ({ id: `gate-${index}`, kind: "optional-group", config })),
    edges: [],
    artifacts: [],
  } as unknown as WorkflowIr;
}

const EMPTY_SET_TASK = taskWith([], []);

describe("findLatestWorkflowStepResult", () => {
  it("reads the newest row per gate and ignores other gates", () => {
    const results = [
      row({ workflowStepId: "code-review", status: "failed" }),
      row({ workflowStepId: "code-review", verdict: "APPROVE" }),
      row({ workflowStepId: "plan-review", status: "failed" }),
    ];

    expect(findLatestWorkflowStepResult(results, "code-review")?.status).toBe("passed");
    expect(findLatestWorkflowStepResult(results, "browser-verification")).toBeUndefined();
    expect(findLatestWorkflowStepResult(undefined, "code-review")).toBeUndefined();
  });
});

describe("classifyPreMergeGateEvidence", () => {
  const refusing: Array<[string, WorkflowStepResult | undefined, CompleteColumnGateEvidenceState]> = [
    ["zero rows — the RUFU-389 shape", undefined, "missing"],
    ["a pending row", row({ workflowStepId: "code-review", status: "pending" }), "in-flight"],
    ["a failed row", row({ workflowStepId: "code-review", status: "failed" }), "not-approved"],
    ["passed with REVISE", row({ workflowStepId: "code-review", verdict: "REVISE" }), "not-approved"],
    ["passed with RETHINK", row({ workflowStepId: "code-review", verdict: "RETHINK" }), "not-approved"],
    ["passed with UNAVAILABLE", row({ workflowStepId: "code-review", verdict: "UNAVAILABLE" }), "not-approved"],
    ["status-only passed on a gate owing an authored verdict", row({ workflowStepId: "code-review" }), "not-approved"],
    ["a bare skipped row", row({ workflowStepId: "code-review", status: "skipped" }), "unwaived-skip"],
    [
      "a skipped-for-honest-tooling row on a gate owing an authored verdict",
      row({ workflowStepId: "code-review", status: "skipped", notRunReason: "tooling-unavailable" }),
      "unwaived-skip",
    ],
    [
      "a skipped row carried by a machine bypass actor",
      row({
        workflowStepId: "code-review",
        status: "skipped",
        bypassedBy: "fast-mode",
        bypassedAt: "2026-10-11T10:00:00.000Z",
        bypassReason: "fast lane",
      }),
      "unwaived-skip",
    ],
    ["an unknown status fails closed", row({ workflowStepId: "code-review", status: "done" as never }), "not-approved"],
  ];
  for (const [label, gateRow, state] of refusing) {
    it(`refuses ${label}`, () => {
      expect(classifyPreMergeGateEvidence("code-review", gateRow)).toBe(state);
    });
  }

  const accepting: Array<[string, WorkflowStepResult, CompleteColumnGateEvidenceState]> = [
    ["passed + APPROVE", row({ workflowStepId: "code-review", verdict: "APPROVE" }), "satisfied"],
    ["passed + APPROVE_WITH_NOTES", row({ workflowStepId: "code-review", verdict: "APPROVE_WITH_NOTES" }), "satisfied"],
    ["an advisory failure", row({ workflowStepId: "code-review", status: "advisory_failure" }), "advisory"],
    [
      "an audited operator bypass",
      row({
        workflowStepId: "code-review",
        status: "skipped",
        bypassedBy: "operator@digitalsystems.eu",
        bypassedAt: "2026-10-11T10:00:00.000Z",
        bypassReason: "hotfix, reviewed offline",
      }),
      "waived",
    ],
    ["a status-only passed row on a gate owing no verdict", row({ workflowStepId: "plan-review" }), "satisfied"],
    [
      "an honest not-run carrier on a non-review gate",
      row({ workflowStepId: "browser-verification", status: "skipped", notRunReason: "tooling-unavailable" }),
      "not-run",
    ],
  ];
  for (const [label, gateRow, state] of accepting) {
    it(`accepts ${label}`, () => {
      expect(classifyPreMergeGateEvidence(gateRow.workflowStepId, gateRow)).toBe(state);
    });
  }
});

describe("resolveCompleteColumnGateEvidence", () => {
  it("refuses the RUFU-389 shape: a required gate with zero rows while another gate approved", () => {
    const evidence = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: taskWith([row({ workflowStepId: "plan-review", verdict: "APPROVE_WITH_NOTES" })]),
    });

    expect(evidence.refuse).toBe(true);
    expect(evidence.findings).toEqual([{ gateId: "code-review", lane: "pre-merge", state: "missing" }]);
    expect(evidence.emptyReason).toBeUndefined();
    expect(evidence.requiredPreMergeGateCount).toBe(2);
  });

  it("accepts a card whose required gates all approved", () => {
    const evidence = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: taskWith(approvedPreMerge),
    });

    expect(evidence).toMatchObject({ refuse: false, findings: [], requiredPreMergeGateCount: 2 });
  });

  it("orders findings pre-merge-first and by gate id so the refusal sentence is byte-stable", () => {
    const evidence = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: taskWith([row({ workflowStepId: "plan-review", status: "failed" })], [...BOTH_GATES, "post-merge-verification"]),
    });

    expect(evidence.findings.map((finding) => finding.gateId)).toEqual(["code-review", "plan-review"]);
    expect(
      describeCompleteColumnGateFindings(evidence.findings, { taskId: "RUFU-406", toColumn: "done" }),
    ).toBe(
      "Required workflow gate evidence is missing for: code-review (pre-merge) has no result recorded, " +
        "plan-review (pre-merge) did not approve. A card may not enter 'done' until every required gate reports " +
        "— run the gate, or have an operator record the audited bypass with its reason (fn_task_bypass_review, or POST /tasks/RUFU-406/bypass-review).",
    );
  });

  it("names each silent gate and the audited remedy in the refusal sentence", () => {
    const sentence = describeCompleteColumnGateFindings(
      [
        { gateId: "code-review", lane: "pre-merge", state: "missing" },
        { gateId: "post-merge-verification", lane: "post-merge", state: "not-approved" },
      ],
      { taskId: "RUFU-389", toColumn: "done" },
    );

    expect(sentence).toContain("code-review (pre-merge) has no result recorded");
    expect(sentence).toContain("post-merge-verification (post-merge) did not approve");
    expect(sentence).toContain("fn_task_bypass_review");
    expect(sentence).toContain("POST /tasks/RUFU-389/bypass-review");
    // A remedy that does not exist is worse than none: there is no `fn task bypass-review` subcommand,
    // so a sentence naming one would leave the agent retrying the move instead of fetching a waiver.
    expect(sentence).not.toContain("fn task bypass-review");
  });

  it("reports an empty required set by its cause instead of guessing a verdict", () => {
    const fast = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: { ...EMPTY_SET_TASK, executionMode: "fast" },
    });
    const disabled = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: EMPTY_SET_TASK,
    });
    const noGroups = resolveCompleteColumnGateEvidence({
      ir: irWithGroups([]),
      task: EMPTY_SET_TASK,
    });

    expect(fast).toMatchObject({ refuse: false, requiredPreMergeGateCount: 0, emptyReason: "fast-lane-route" });
    expect(disabled).toMatchObject({ refuse: false, requiredPreMergeGateCount: 0, emptyReason: "all-pre-merge-gates-disabled" });
    expect(noGroups).toMatchObject({ refuse: false, requiredPreMergeGateCount: 0, emptyReason: "no-pre-merge-gates-declared" });
  });

  it("classifies a reporting-only pre-merge IR as owing nothing", () => {
    const ir = irWithGroups([{ name: "Docs report", defaultOn: true, reportingOnly: true, template: { nodes: [] } }]);

    expect(classifyEmptyRequiredPreMergeSet(ir, EMPTY_SET_TASK)).toBe("reporting-only-pre-merge-gates");
  });

  it("refuses only a durable negative post-merge report, never an absent one", () => {
    const enabled = [...BOTH_GATES, "post-merge-verification"];

    const notMergedYet = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: taskWith(approvedPreMerge, enabled),
    });
    expect(notMergedYet.requiredPostMergeGateCount).toBeGreaterThan(0);
    expect(notMergedYet.refuse).toBe(false);

    const negative = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: taskWith(
        [...approvedPreMerge, row({ workflowStepId: "post-merge-verification", status: "failed", verdict: "REVISE" })],
        enabled,
      ),
    });
    expect(negative.findings).toEqual([{ gateId: "post-merge-verification", lane: "post-merge", state: "not-approved" }]);
    expect(negative.refuse).toBe(true);
  });

  it("lets an audited operator waiver satisfy a gate that never approved", () => {
    const evidence = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: taskWith([
        row({ workflowStepId: "plan-review", verdict: "APPROVE" }),
        row({
          workflowStepId: "code-review",
          status: "skipped",
          bypassedBy: "operator@digitalsystems.eu",
          bypassedAt: "2026-10-11T10:00:00.000Z",
          bypassReason: "operator reviewed the diff in person",
        }),
      ]),
    });

    expect(evidence.refuse).toBe(false);
  });
});

describe("parity with the merge door", () => {
  /**
   * Whether the merge door refuses the same card. `evaluatePreMergeApprovals` returns one STATUS per
   * required gate — `approved` rows included — so a non-empty list is not a refusal; the refusal is any
   * status whose state is not `approved` (`missing`, `not-approved`, `stale-content`,
   * `unprovable-content`). Measured 2026-10-11 while writing this parity group: asserting on
   * `length > 0` reads as "the door refuses whenever gates exist", which is the same misreading that
   * makes a gate-status helper look like a blocker list.
   */
  const doorRefuses = (results: WorkflowStepResult[]) =>
    evaluatePreMergeApprovals(
      { id: "RUFU-406", enabledWorkflowSteps: [...BOTH_GATES], workflowStepResults: results } as never,
      { requiredPreMergeStepIds: new Set(BOTH_GATES), singularScope: true },
    ).some((approval) => approval.state !== "approved");

  const agreeing: Array<[string, WorkflowStepResult[], boolean]> = [
    ["a gate that never ran", [], true],
    ["a failed gate", [row({ workflowStepId: "code-review", status: "failed" })], true],
    ["a REVISE verdict", [row({ workflowStepId: "code-review", verdict: "REVISE" })], true],
    ["a bare skipped gate", [row({ workflowStepId: "code-review", status: "skipped" })], true],
    ["all gates approving", approvedPreMerge, false],
    [
      "an audited operator waiver",
      [
        row({ workflowStepId: "plan-review", verdict: "APPROVE" }),
        row({
          workflowStepId: "code-review",
          status: "skipped",
          bypassedBy: "operator@digitalsystems.eu",
          bypassedAt: "2026-10-11T10:00:00.000Z",
          bypassReason: "reviewed offline",
        }),
      ],
      false,
    ],
  ];
  for (const [label, results, refuses] of agreeing) {
    it(`agrees with the merge door on ${label}`, () => {
      expect(doorRefuses(results)).toBe(refuses);
      expect(
        resolveCompleteColumnGateEvidence({ ir: BUILTIN_CODING_WORKFLOW_IR, task: taskWith(results) }).refuse,
      ).toBe(refuses);
    });
  }

  it("diverges on advisory_failure only, and says so in both directions", () => {
    const results = [
      row({ workflowStepId: "plan-review", verdict: "APPROVE" }),
      row({ workflowStepId: "code-review", status: "advisory_failure" }),
    ];

    // Registered divergence: the move guard accepts an advisory outcome, the merge door will not
    // publish over one. The stricter authority stays the merge door, which owns content staleness.
    expect(doorRefuses(results)).toBe(true);
    expect(resolveCompleteColumnGateEvidence({ ir: BUILTIN_CODING_WORKFLOW_IR, task: taskWith(results) }).refuse).toBe(false);
  });

  it("refuses an enabled non-review gate that stayed silent and accepts its honest not-run carrier", () => {
    const enabled = [...BOTH_GATES, "browser-verification"];
    const silent = resolveCompleteColumnGateEvidence({ ir: BUILTIN_CODING_WORKFLOW_IR, task: taskWith(approvedPreMerge, enabled) });
    const honest = resolveCompleteColumnGateEvidence({
      ir: BUILTIN_CODING_WORKFLOW_IR,
      task: taskWith(
        [...approvedPreMerge, row({ workflowStepId: "browser-verification", status: "skipped", notRunReason: "tooling-unavailable" })],
        enabled,
      ),
    });

    expect(silent.findings).toEqual([{ gateId: "browser-verification", lane: "pre-merge", state: "missing" }]);
    expect(honest.refuse).toBe(false);
  });
});

describe("isOperatorInitiatedMoveSource — the one binding the guard depends on", () => {
  /*
   * The refusal exists to close an AGENT-reachable path, so this predicate's edges ARE the fix's blast
   * radius. Measured on the shipped vocabulary (`moveSource` has exactly three values, and the move seam
   * resolves an option-less call to the emitted `"engine"` default in `moves.ts`):
   * - `"user"` MUST refuse: it is what `fn task move` and the dashboard drag both send, and the shape
   *   RUFU-389 arrived in. Narrowing this to a hypothetical `"cli"` source would leave the real hole open.
   * - `"engine"` MUST stay exempt: the CLI merge finalizer (`task-lifecycle.ts`) moves to the complete
   *   target with NO options and resolves to `"engine"`; refusing it would strand a card whose merge
   *   already landed in the review lane with no remaining move that can finish it.
   */
  it("refuses the operator intent that every interactive surface sends", () => {
    expect(isOperatorInitiatedMoveSource("user")).toBe(true);
  });

  it("exempts engine and scheduler intent, including the option-less finalizer's resolved default", () => {
    expect(isOperatorInitiatedMoveSource("engine")).toBe(false);
    expect(isOperatorInitiatedMoveSource("scheduler")).toBe(false);
  });
});

describe("CompleteColumnGateEvidenceRejectionError", () => {
  it("is a TransitionRejectionError so every existing catcher keeps working", () => {
    const error = new CompleteColumnGateEvidenceRejectionError(
      { code: "gate-evidence-missing", messageKey: "transition.rejected.gateEvidenceMissing", retryable: true },
      "refused",
      [{ gateId: "code-review", lane: "pre-merge", state: "missing" }],
    );

    expect(error).toBeInstanceOf(TransitionRejectionError);
    expect(error.rejection.code).toBe("gate-evidence-missing");
    expect(error.gateFindings).toHaveLength(1);
    expect(error.message).toBe("refused");
  });
});
