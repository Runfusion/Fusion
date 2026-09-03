import { describe, expect, it } from "vitest";
import {
  CODE_REVIEW_GROUP_ID,
  CODE_REVIEW_STEP_NODE_ID,
  DEFAULT_CODE_REVIEW_MAX_REVISIONS,
  codeReviewOptionalGroupNode,
} from "../workflows/builtin-code-review-group.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "../workflows/builtin-stepwise-coding-workflow-ir.js";
import { parseWorkflowIr, serializeWorkflowIr } from "../workflows/workflow-ir.js";
import {
  resolveDefaultOnOptionalGroupIds,
  resolveWorkflowOptionalSteps,
} from "../workflows/workflow-optional-steps.js";

/*
FNXC:CodeReviewStep 2026-06-25-15:00:
Coverage for the DEFAULT-ON but TOGGLEABLE "Code Review" pre-merge step: the
`optional-group` node (defaultOn:true) and its wiring into the coding + stepwise
built-ins as a default-on optional group. Code review is a WORKFLOW prompt-gate (shared
verdict machinery), not engine verification code.

FNXC:WorkflowStepTemplate 2026-06-25-00:00:
U6 deleted the `WORKFLOW_STEP_TEMPLATES` catalog. The former "code-review catalog
fields" assertions are gone; the inlined literal values (name/toolMode/gateMode/prompt
verdict convention) are now asserted directly on the built group node below, which is the
parity oracle.

FNXC:WorkflowRemediationBudget 2026-09-03-05:40:
Built-in Code Review uses a finite default so repeated REVISE feedback eventually reaches the
convergence ladder instead of consuming review sessions indefinitely.
*/

describe("codeReviewOptionalGroupNode", () => {
  it("carries the inlined catalog literals (name/toolMode/gateMode/prompt)", () => {
    const node = codeReviewOptionalGroupNode("in-progress");
    expect(node.config?.name).toBe("Code Review");
    const inner = (node.config?.template as { nodes: { config?: Record<string, unknown> }[] }).nodes[0];
    expect(inner.config?.toolMode).toBe("readonly");
    expect(inner.config?.gateMode).toBe("gate");
    const prompt = String(inner.config?.prompt);
    expect(prompt).toMatch(/"verdict":"APPROVE\|APPROVE_WITH_NOTES\|REVISE"/);
    expect(prompt).not.toContain('"verdict":"PASS"');
    expect(prompt).not.toContain('"verdict":"FAIL"');
    expect(prompt).toMatch(/git diff/);
    expect(prompt).toMatch(/out of scope/i);
    /*
     * FNXC:CodeReviewSurfaceCoverage 2026-08-04-06:35:
     * The built-in gate must trace requirements through production entry points,
     * temporal state, and every UI/API/CLI/agent consumer rather than diff only.
     */
    expect(prompt).toContain("requirements ledger");
    expect(prompt).toContain("real production entry point");
    expect(prompt).toContain("## Symptom Verification");
    expect(prompt).toContain("## Surface Enumeration");
    expect(prompt).toContain("current state, version, or planning episode");
    expect(prompt).toContain("bounded");
    expect(prompt).toContain("UI, API, CLI, and agent consumers");
  });

  it("builds a DEFAULT-ON optional-group with the stable group id and distinct inner id", () => {
    const node = codeReviewOptionalGroupNode("in-progress");
    expect(node.id).toBe(CODE_REVIEW_GROUP_ID);
    expect(CODE_REVIEW_GROUP_ID).toBe("code-review");
    expect(CODE_REVIEW_STEP_NODE_ID).toBe("code-review-step");
    expect(node.id).not.toBe(CODE_REVIEW_STEP_NODE_ID); // U1: inner id ≠ group id.
    expect(node.kind).toBe("optional-group");
    expect(node.column).toBe("in-progress");
    expect(node.config?.name).toBe("Code Review");
    // Default-ON (runs by default), but still an optional-group → toggleable per task.
    expect(node.config?.defaultOn).toBe(true);
    expect(DEFAULT_CODE_REVIEW_MAX_REVISIONS).toBe(3);
    expect(node.config?.maxRevisions).toBe(DEFAULT_CODE_REVIEW_MAX_REVISIONS);

    const template = node.config?.template as { nodes: { id: string; kind: string; config?: Record<string, unknown> }[] };
    expect(template.nodes).toHaveLength(1);
    const inner = template.nodes[0];
    expect(inner.id).toBe(CODE_REVIEW_STEP_NODE_ID);
    expect(inner.kind).toBe("prompt");
    expect(inner.config?.toolMode).toBe("readonly");
    expect(inner.config?.gateMode).toBe("gate");
    expect(String(inner.config?.prompt)).toMatch(/"verdict":"APPROVE\|APPROVE_WITH_NOTES\|REVISE"/);
  });

  it("lets workflows override the default remediation attempt budget", () => {
    expect(codeReviewOptionalGroupNode("in-progress", { maxRevisions: 1 }).config?.maxRevisions).toBe(1);
    expect(codeReviewOptionalGroupNode("in-progress", { maxRevisions: "unbounded" }).config?.maxRevisions).toBe("unbounded");
  });
});

describe("built-in coding + stepwise workflows wire code-review as a default-ON optional group", () => {
  /*
  FNXC:WorkflowReviewGates 2026-07-26-11:40:
  The column is parametrized because the two built-ins deliberately disagree: the stepwise graph
  (and everything cloned from it, incl. the default `builtin:coding`) runs Code Review in
  "in-review" so the card shows the running gate as a badge, while the frozen legacy coding IR
  keeps its historical "in-progress" placement. The paired remediation node stays "in-progress"
  in BOTH — a gate that requests changes must send the card back to implementation.
  */
  it.each([
    ["builtin coding", BUILTIN_CODING_WORKFLOW_IR, "in-progress"],
    ["builtin stepwise", BUILTIN_STEPWISE_CODING_WORKFLOW_IR, "in-review"],
  ] as const)("%s includes the default-ON code-review optional-group and still parses/round-trips", (_name, ir, expectedColumn) => {
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const group = byId.get("code-review");
    expect(group?.kind).toBe("optional-group");
    expect(group?.config?.name).toBe("Code Review");
    expect(group?.config?.defaultOn).toBe(true);
    expect(group?.column).toBe(expectedColumn);
    // Changes-requested always routes back to implementation.
    expect(byId.get("code-review-remediation")?.column).toBe("in-progress");

    /*
    FNXC:WorkflowBuiltins 2026-08-23-22:55:
    Pre-merge wiring: ... → browser-verification → completion-summary → code-review; failure → remediation node.
    FN-120 (10c399d01e) moved completion-summary AHEAD of code-review because a completion-summary agent
    can acquire the task worktree; running it after review would reopen the reviewed tree.
    */
    expect(ir.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "browser-verification", to: "completion-summary", condition: "success" }),
        expect.objectContaining({ from: "completion-summary", to: "code-review", condition: "success" }),
        expect.objectContaining({ from: "code-review", to: "code-review-remediation", condition: "failure" }),
      ]),
    );

    // The built-in still compiles/validates with the new node (parse round-trips).
    const reparsed = parseWorkflowIr(serializeWorkflowIr(ir));
    expect(reparsed).toEqual(parseWorkflowIr(ir));
  });

  it.each([
    ["builtin coding", BUILTIN_CODING_WORKFLOW_IR],
    ["builtin stepwise", BUILTIN_STEPWISE_CODING_WORKFLOW_IR],
  ])("%s: code-review is advertised as a toggle AND seeded into the default-on set", (_name, ir) => {
    // Advertised as a toggleable optional step (so operators can turn it off per task)…
    const advertised = resolveWorkflowOptionalSteps(ir).find((s) => s.templateId === "code-review");
    expect(advertised).toMatchObject({
      templateId: "code-review",
      name: "Code Review",
      description: "",
      phase: "pre-merge",
      defaultOn: true,
    });
    // …and in the default-on set, so default-on actually takes effect (new tasks seed it).
    expect(resolveDefaultOnOptionalGroupIds(ir)).toContain("code-review");
  });
});
