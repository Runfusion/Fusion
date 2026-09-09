import { describe, expect, it } from "vitest";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";
import { BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR } from "../workflows/builtin-coding-ideas-v2-workflow-ir.js";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "../workflows/builtin-coding-ideas-workflow-ir.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { getBuiltinWorkflow } from "../workflows/builtin-workflows.js";
import { parseWorkflowIr, serializeWorkflowIr } from "../workflows/workflow-ir.js";
import { builtinSeamPrompt, stripDocumentationDeliveryStep } from "../workflows/builtin-workflow-prompts.js";
import { resolveWorkflowOptionalSteps } from "../workflows/workflow-optional-steps.js";

/** The planning seam prompt a task on this workflow actually receives. */
function planningPrompt(ir: { nodes: Array<{ kind: string; config?: Record<string, unknown> }> }): string {
  const node = ir.nodes.find((candidate) => candidate.kind === "prompt" && candidate.config?.seam === "planning");
  return String(node?.config?.prompt ?? "");
}

/** The single-success-edge walk an executing task actually follows from a node. */
function successChainFrom(start: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start;
  while (current && !seen.has(current)) {
    seen.add(current);
    const edge = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.edges
      .find((candidate) => candidate.from === current && candidate.condition === "success");
    if (!edge) break;
    chain.push(edge.to);
    current = edge.to;
  }
  return chain;
}

describe("builtin:coding-ideas-v2", () => {
  it("is the offered validated Ideas workflow and keeps the intake untouched", () => {
    const workflow = getBuiltinWorkflow("builtin:coding-ideas-v2");
    expect(workflow?.name).toBe("Coding (Ideas)");
    expect(parseWorkflowIr(serializeWorkflowIr(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR)))
      .toEqual(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR);

    // The whole point of the Ideas board: cards park in a manual intake and the
    // engine must not plan them until an operator promotes them.
    expect(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.columns)
      .toEqual(BUILTIN_CODING_IDEAS_WORKFLOW_IR.columns);
    const intake = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.columns.find((column) => column.id === "ideas");
    expect(intake?.traits).toEqual([{ trait: "intake", config: { autoTriage: false } }]);
  });

  /*
  FNXC:CodingIdeasV2Workflow 2026-08-24-06:45:
  `completion-summary` sits BEFORE `code-review`, like the inherited graph. Putting it after looks
  better (the blurb could describe the approved state) and passes the review seal, because a
  readonly node is not write-capable — but it still acquires a worktree, and anything running
  between the review and the merge invalidates FN-180's review-diff fingerprint:
  "task has no provable approval for the content being merged". Measured in pipeline-smoke S01.
  */
  /*
  FNXC:CodingIdeasV2Workflow 2026-08-25-10:20:
  In-review is THREE milestones: Code Review -> Documentation -> Delivery (the merge nodes).
  The previous shape ran a separate deterministic `verification` gate and a `completion-summary`
  node. Both are gone: Code Review runs the commands itself so one node owns the verdict, and
  Documentation writes the card summary in the same pass as the delivery note.
  */
  it("runs review -> document -> merge in review", () => {
    expect(successChainFrom("steps")).toEqual([
      "code-review",
      "documentation-delivery",
      "merge-gate",
    ]);

    for (const nodeId of ["code-review", "documentation-delivery"]) {
      expect(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === nodeId)?.column)
        .toBe("in-review");
    }
    for (const removed of ["verification", "verification-remediation", "completion-summary"]) {
      expect(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.some((node) => node.id === removed), `${removed} must be gone`).toBe(false);
      expect(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.edges.some((edge) => edge.from === removed || edge.to === removed)).toBe(false);
    }

    expect(resolveWorkflowOptionalSteps(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR).map((step) => step.templateId))
      .toEqual(["plan-review", "code-review", "documentation-delivery"]);
  });

  /*
  FNXC:CodingIdeasV2Workflow 2026-08-25-10:20:
  Code Review is the ONLY gate that can hold a card, so its verdict must rest on commands it ran
  itself. The prompt is augmented rather than edited so the shared reviewer used by builtin:coding
  and builtin:coding-ideas is untouched; the evidence rule is what stops a reviewer asserting "tests
  pass" in prose, which is the same false green a silently-passing gate produced mechanically.
  */
  it("makes Code Review judge the tests without pretending it can run them", () => {
    const template = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === "code-review")?.config?.template as
      { nodes?: Array<{ id: string; config?: { prompt?: string; toolMode?: string } }> } | undefined;
    const step = template?.nodes?.find((node) => node.id === "code-review-step");
    const prompt = step?.config?.prompt ?? "";

    /*
    FNXC:CodingIdeasV2Workflow 2026-08-25-14:10:
    A review node is `toolMode: "readonly"`, whose allowlist is read/grep/find/ls plus a few
    read-only task tools: `bash` is denied and `fn_run_verification` is absent. An earlier revision
    instructed this reviewer to run lint/tests/build; it never could, and real cards showed 19s and
    23s reviews that silently read the diff alone. Instructing a session to do what its tool policy
    forbids invites the worst failure mode: a fluent claim that the check passed.
    */
    expect(step?.config?.toolMode).toBe("readonly");
    expect(prompt, "a readonly reviewer must not be told to run a verification tool").not.toContain("fn_run_verification");
    expect(prompt).toContain("You cannot run anything");

    // It rules on the tests the EXECUTOR wrote: existence, realness, behaviour, invariant coverage.
    expect(prompt).toContain("A behavioural change with no test is a REVISE");
    expect(prompt).toContain("A typecheck is not a test");
    expect(prompt).toContain("They assert BEHAVIOUR");
    expect(prompt).toContain("not just the reported case");
  });

  /*
  FNXC:DocumentationMilestone 2026-08-25-10:20:
  Documentation REPORTS: it never vetoes and never writes the repository. Both properties are load
  bearing. As a blocking gate it bounced a task whose own plan forbade implementing anything, and the
  card then looped through the review lane every five minutes indefinitely. As a repository writer it
  had to be forced ahead of the review, because content changing after approval is exactly what the
  review seal refuses.
  */
  it("makes Documentation advisory and repository-read-only, after the review", () => {
    const template = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === "documentation-delivery")?.config?.template as
      { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } | undefined;
    const config = template?.nodes?.find((node) => node.id === "documentation-delivery-step")?.config ?? {};

    expect(config.gateMode).toBe("advisory");
    expect(config.toolMode).toBe("readonly");
    expect(String(config.prompt)).toContain("do not modify repository files");
    /*
    FNXC:DocumentationMilestone 2026-08-26-07:34:
    This assertion USED to require the prompt to say `fn_task_done(summary=` — a call this session
    cannot make, since a readonly workflow step has no writer at all. It proved the milestone had
    been told to write a summary, not that one could be written, and the card silently lost its
    agent-authored summary. Assert the projection contracts that actually persist output instead.
    */
    expect(config.summaryTarget).toBe("task");
    expect(config.recommendationsTarget).toBe("task");
    for (const tool of ["fn_task_done", "fn_task_document_write", "fn_artifact_register", "fn_task_create"]) {
      expect(String(config.prompt), `${tool} is denied to a readonly workflow step`).not.toContain(tool);
    }

    // Failure reaches the merge exactly like success: a delivery note cannot strand approved code.
    for (const condition of ["success", "failure"]) {
      expect(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.edges).toContainEqual(
        { from: "documentation-delivery", to: "merge-gate", condition },
      );
    }
  });

  /*
  FNXC:ReportingOnlyGroup 2026-08-26-06:56:
  The advisory failure edge above was NOT enough, measured on a real card: Documentation's REVISE
  recorded `advisory_failure`, which the required-approval set read as "no current approval" — so the
  reporter held the merge door shut — while the same REVISE also bounced the card to implementation.
  `reportingOnly` states the contract once, and BOTH doors read it.
  */
  it("cannot hold the merge: Documentation carries no approval", () => {
    const documentation = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === "documentation-delivery");
    expect(documentation?.config?.reportingOnly).toBe(true);

    const required = resolveRequiredPreMergeStepIds(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR, undefined);
    expect([...required].sort()).toEqual(["code-review", "plan-review"]);
    expect(required.has("documentation-delivery"), "a reporter must never gate the merge").toBe(false);

    // Enabling it explicitly must not turn it into a gate either.
    expect(resolveRequiredPreMergeStepIds(
      BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR,
      ["plan-review", "code-review", "documentation-delivery"],
    ).has("documentation-delivery")).toBe(false);

    // The gates that DO carry approval are untouched, here and on the inherited board.
    expect([...resolveRequiredPreMergeStepIds(BUILTIN_CODING_IDEAS_WORKFLOW_IR, undefined)].sort())
      .toEqual(["code-review", "plan-review"]);
    for (const groupId of ["plan-review", "code-review"]) {
      expect(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === groupId)?.config?.reportingOnly)
        .toBeUndefined();
    }
  });

  it("returns a rejected review to in-progress as named work", () => {
    expect(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.edges).toEqual(expect.arrayContaining([
      { from: "code-review", to: "code-review-remediation", condition: "failure" },
      { from: "code-review-remediation", to: "code-review", condition: "success", kind: "rework" },
    ]));
    expect(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === "code-review-remediation")?.column)
      .toBe("in-progress");

    const parse = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === "parse")?.config;
    expect(parse?.preserveRemediationSteps).toBe(true);
    expect(parse?.implementationOnlySteps).toBe(true);

    const config = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === "code-review-remediation")?.config;
    expect(config?.workflowAction, "code-review-remediation must append named steps").toBe("review-remediation-steps");
    expect(config?.forWorkflowStepId).toBe("code-review");

    // The inherited workflow reopens trailing steps instead, and must stay that way.
    expect(BUILTIN_CODING_IDEAS_WORKFLOW_IR.nodes.find((node) => node.id === "code-review-remediation")?.config?.workflowAction)
      .toBe("pre-merge-remediation");
  });

  /*
  FNXC:CodingIdeasV2Workflow 2026-08-25-14:10:
  This asserts the REVERSAL of what it used to. Plan Review previously carried an
  "implementation-only steps" criterion that REJECTED any plan containing testing or verification
  work, because review-column gates were supposed to run those checks. None ever did — the
  deterministic gate was not routed and reported PASS in ~46ms without running anything, and a
  readonly reviewer cannot run commands at all. Measured on a real card: a plan was bounced for
  "implementation steps include testing and verification work that must be handled as review-column
  gates", after the gate it named had already been deleted.
  Testing belongs in the plan and is executed by the executor, so this criterion must stay gone.
  */
  it("no longer rejects a plan for containing testing steps", () => {
    const planReview = BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR.nodes.find((node) => node.id === "plan-review");
    const reviewConfig = (planReview?.config.template as { nodes?: Array<{ config?: Record<string, unknown> }> })
      .nodes?.[0]?.config;

    expect(reviewConfig?.requireImplementationOnlySteps).not.toBe(true);
    expect(reviewConfig?.prompt).not.toContain("## Review-gated implementation steps");

    // The inherited workflow's reviewer never carried it and must stay untouched.
    const baseReview = BUILTIN_CODING_IDEAS_WORKFLOW_IR.nodes.find((node) => node.id === "plan-review");
    const baseConfig = (baseReview?.config.template as { nodes?: Array<{ config?: Record<string, unknown> }> })
      .nodes?.[0]?.config;
    expect(baseConfig?.requireImplementationOnlySteps).toBeUndefined();
    expect(baseConfig?.prompt).not.toContain("## Review-gated implementation steps");
  });

  /*
  FNXC:PlanningDocumentationStep 2026-08-26-05:56:
  Testing is planned, documentation is not. Keeping both had the executor perform the delivery note,
  artifact registration and follow-up tasks, and the in-review Documentation milestone perform the
  same three tool calls again — both writing task document `docs`, so the review pass overwrote the
  executor's. Repository documentation stays implementation work, done inside the step that made a
  doc wrong so Code Review sees it in the diff.
  */
  it("plans testing but not documentation", () => {
    const prompt = planningPrompt(BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR);

    expect(prompt, "the executor owns testing and must keep planning it")
      .toContain("### Step {N-1}: Testing & Verification");
    expect(prompt, "documentation is a review milestone, not a task step")
      .not.toContain("### Step {N}: Documentation & Delivery");
    expect(prompt).toContain("Documentation is not a step");

    // Testing & Verification is now the LAST step the template mandates.
    const mandatedSteps = [...prompt.matchAll(/^### Step \{[^}]+\}: (.+)$/gm)].map((match) => match[1]);
    expect(mandatedSteps.at(-1)).toBe("Testing & Verification");

    // The strip removes one block, not the remainder of the template.
    for (const survivor of ["## Documentation Requirements", "## Completion Criteria", "## Git Commit Convention"]) {
      expect(prompt, `${survivor} must survive the strip`).toContain(survivor);
    }

    // The shared template every other coding workflow uses is untouched.
    for (const ir of [BUILTIN_CODING_IDEAS_WORKFLOW_IR, BUILTIN_CODING_WORKFLOW_IR]) {
      expect(planningPrompt(ir)).toContain("### Step {N}: Documentation & Delivery");
      expect(planningPrompt(ir)).not.toContain("Documentation is not a step");
    }
    expect(builtinSeamPrompt("planning")).toContain("### Step {N}: Documentation & Delivery");
  });

  /*
  A reworded base prompt must WEAKEN the instruction, never break planning: the abandoned
  `planning-implementation-only` seam proved a trailing sentence loses to the detailed template, so
  the strip is preferred — but an append still beats emitting nothing at all.
  */
  it("degrades to an appended prohibition when the template anchors stop matching", () => {
    const reworded = "# Task template\n\n### Phase 9: Docs and handover\n\n- [ ] write docs\n";
    const result = stripDocumentationDeliveryStep(reworded);
    expect(result.startsWith(reworded)).toBe(true);
    expect(result).toContain("Documentation is not a step");
  });

  it("never mutates the inherited Coding (Ideas) graph", () => {
    expect(BUILTIN_CODING_IDEAS_WORKFLOW_IR.nodes.some((node) => node.id === "verification")).toBe(false);
    expect(BUILTIN_CODING_IDEAS_WORKFLOW_IR.nodes.some((node) => node.id === "documentation-delivery")).toBe(false);
    expect(BUILTIN_CODING_IDEAS_WORKFLOW_IR.edges).toEqual(expect.arrayContaining([
      { from: "steps", to: "completion-summary", condition: "success" },
    ]));
  });
});
