import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

import {
  BUILTIN_WORKFLOWS,
  defaultEnabledBuiltinWorkflowIds,
  getBuiltinWorkflow,
  getRequiredPluginIdForBuiltinWorkflow,
  isBuiltinWorkflowId,
  isBuiltinWorkflowPluginGated,
  isBuiltinWorkflowDeprecated,
} from "../builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "../builtin-stepwise-coding-workflow-ir.js";
import { BUILTIN_PR_WORKFLOW_IR } from "../builtin-pr-workflow-ir.js";
import { BROWSER_VERIFICATION_GROUP_ID, BROWSER_VERIFICATION_STEP_NODE_ID } from "../builtin-browser-verification-group.js";
import { CODE_REVIEW_STEP_NODE_ID } from "../builtin-code-review-group.js";
import { PLAN_REVIEW_GROUP_ID, PLAN_REVIEW_STEP_NODE_ID } from "../builtin-plan-review-group.js";
import { builtinPromptConfig, BUILTIN_SEAM_PROMPTS } from "../builtin-workflow-prompts.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";
import { resolveColumnFlags } from "../trait-registry.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS, parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../__test-utils__/pg-test-harness.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "../builtin-stepwise-final-review-coding-workflow-ir.js";

const EXECUTE_NODE_MAX_RETRIES = 2;
const LINEAR_BUILTIN_IDS = [
  "builtin:quick-fix",
  "builtin:review-heavy",
  "builtin:design",
  "builtin:compound-engineering",
] as const;

function browserVerificationInnerConfig(ir: { nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }> }): Record<string, unknown> {
  const group = ir.nodes.find((node) => node.id === BROWSER_VERIFICATION_GROUP_ID);
  const template = group?.config?.template as { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } | undefined;
  return template?.nodes?.find((node) => node.id === BROWSER_VERIFICATION_STEP_NODE_ID)?.config ?? {};
}

function planReviewInnerConfig(ir: { nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }> }): Record<string, unknown> {
  const group = ir.nodes.find((node) => node.id === PLAN_REVIEW_GROUP_ID);
  const template = group?.config?.template as { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } | undefined;
  return template?.nodes?.find((node) => node.id === PLAN_REVIEW_STEP_NODE_ID)?.config ?? {};
}

function columnTraitMatrix(ir: { columns: Array<{ id: string; traits: Array<{ trait: string; config?: unknown }> }> }): Array<{
  id: string;
  traits: Array<{ trait: string; config?: unknown }>;
}> {
  return ir.columns.map((column) => ({ id: column.id, traits: column.traits }));
}

describe("built-in workflows", () => {
  // FNXC:WorkflowStepCRUD 2026-07-01-00:00: the linear WorkflowStep compiler was
  // removed; the graph interpreter runs every built-in (including branching ones)
  // directly. `parseWorkflowIr` is now the sole validity gate for all built-ins.
  it("every built-in has a valid IR", () => {
    expect(BUILTIN_WORKFLOWS.length).toBeGreaterThanOrEqual(4);
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(isBuiltinWorkflowId(wf.id)).toBe(true);
      expect(() => parseWorkflowIr(wf.ir)).not.toThrow();
    }
  });

  it("all built-ins expose workflow-native review revision cap settings", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      if (workflow.kind === "fragment") continue;
      const ir = parseWorkflowIr(workflow.ir);
      expect(ir.version, workflow.id).toBe("v2");
      if (ir.version !== "v2") throw new Error(`expected ${workflow.id} v2`);
      expect(ir.settings?.map((setting) => setting.id), workflow.id).toEqual(
        expect.arrayContaining(["planReviewMaxRevisions", "codeReviewMaxRevisions"]),
      );
      expect(ir.settings?.find((setting) => setting.id === "planReviewMaxRevisions"), workflow.id).not.toHaveProperty(
        "default",
      );
      const codeReviewCap = ir.settings?.find((setting) => setting.id === "codeReviewMaxRevisions");
      expect(codeReviewCap, workflow.id).not.toHaveProperty("default");
      // Empty is the canonical unlimited policy; stored numeric values must be
      // non-negative whole numbers so `0` has the documented disable semantics.
      expect(codeReviewCap, workflow.id).toMatchObject({ type: "number", minimum: 0, integer: true });
    }
  });

  it("engineering built-ins expose plan, code, and browser optional groups with expected defaults", () => {
    const expectedDefaults: Record<string, Record<string, boolean>> = {
      "builtin:coding": { "plan-review": true, "code-review": true, "browser-verification": false },
      "builtin:legacy-coding": { "plan-review": true, "code-review": true, "browser-verification": false },
      "builtin:quick-fix": { "plan-review": false, "code-review": false, "browser-verification": false },
      "builtin:review-heavy": { "plan-review": true, "code-review": true, "browser-verification": false },
      "builtin:design": { "plan-review": true, "code-review": true, "browser-verification": false },
      "builtin:compound-engineering": { "plan-review": true, "code-review": true, "browser-verification": false, "manual-pr-review": false },
      "builtin:stepwise-coding": { "plan-review": true, "code-review": true, "browser-verification": false },
    };

    for (const [workflowId, defaults] of Object.entries(expectedDefaults)) {
      const workflow = getBuiltinWorkflow(workflowId)!;
      const byId = new Map(workflow.ir.nodes.map((node) => [node.id, node]));
      for (const [groupId, defaultOn] of Object.entries(defaults)) {
        const group = byId.get(groupId);
        expect(group?.kind, `${workflowId}:${groupId}`).toBe("optional-group");
        expect(group?.config?.defaultOn, `${workflowId}:${groupId}`).toBe(defaultOn);
      }
      const nodeOrder = workflow.ir.nodes.map((node) => node.id);
      const executionBoundary = nodeOrder.includes("execute") ? nodeOrder.indexOf("execute") : nodeOrder.indexOf("steps");
      expect(executionBoundary, workflowId).toBeGreaterThanOrEqual(0);
      expect(nodeOrder.indexOf("plan-review"), workflowId).toBeLessThan(executionBoundary);
      expect(nodeOrder.indexOf("browser-verification"), workflowId).toBeGreaterThan(executionBoundary);
      expect(nodeOrder.indexOf("code-review"), workflowId).toBeGreaterThan(nodeOrder.indexOf("browser-verification"));
    }
  });

  it("scopes deterministic external-integration plan validation to Coding (per-step review)", () => {
    const perStepPlanReview = planReviewInnerConfig(BUILTIN_STEPWISE_CODING_WORKFLOW_IR);
    const defaultCodingPlanReview = planReviewInnerConfig(BUILTIN_CODING_WORKFLOW_IR);
    const legacyCodingPlanReview = planReviewInnerConfig(getBuiltinWorkflow("builtin:legacy-coding")!.ir);
    const quickFixPlanReview = planReviewInnerConfig(getBuiltinWorkflow("builtin:quick-fix")!.ir);

    expect(perStepPlanReview.requireExternalIntegrationEvidence).toBe(true);
    expect(defaultCodingPlanReview.requireExternalIntegrationEvidence).toBeUndefined();
    expect(legacyCodingPlanReview.requireExternalIntegrationEvidence).toBeUndefined();
    expect(quickFixPlanReview.requireExternalIntegrationEvidence).toBeUndefined();
  });

  it("all built-in Code Review optional groups are blocking gates", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      const codeReview = workflow.ir.nodes.find((node) => node.id === "code-review");
      if (!codeReview) continue;
      expect(codeReview.kind, workflow.id).toBe("optional-group");
      const template = codeReview.config?.template as { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } | undefined;
      const inner = template?.nodes?.find((node) => node.id === CODE_REVIEW_STEP_NODE_ID);
      expect(inner, workflow.id).toBeDefined();
      expect(inner?.config?.gateMode, workflow.id).toBe("gate");
    }
  });

  it("engineering built-in review failures loop through graph-owned remediation", () => {
    const expectedLoops = [
      { gate: "plan-review", remediation: "plan-replan" },
      { gate: "browser-verification", remediation: "browser-verification-remediation" },
      { gate: "code-review", remediation: "code-review-remediation" },
    ];

    for (const workflow of BUILTIN_WORKFLOWS) {
      const nodeIds = new Set(workflow.ir.nodes.map((node) => node.id));
      if (!expectedLoops.some(({ gate }) => nodeIds.has(gate))) continue;

      for (const { gate, remediation } of expectedLoops) {
        if (!nodeIds.has(gate)) continue;
        expect(workflow.ir.edges, `${workflow.id}:${gate}:failure`).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ from: gate, to: remediation, condition: "failure" }),
          ]),
        );
        expect(workflow.ir.edges, `${workflow.id}:${remediation}:return`).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ from: remediation, to: gate, condition: "success", kind: "rework" }),
          ]),
        );
        expect(workflow.ir.nodes.find((node) => node.id === gate)?.config, `${workflow.id}:${gate}:reworkRegion`).toMatchObject({
          reworkRegion: true,
          maxReworkCycles: 3,
          maxRevisions: gate === "browser-verification" ? 3 : "unbounded",
        });
      }
    }
  });

  it("all built-in workflows generate a task completion summary as a graph node", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      if (workflow.kind === "fragment") continue;
      const summaryNodes = workflow.ir.nodes.filter((node) => node.id === "completion-summary");
      expect(summaryNodes, workflow.id).toHaveLength(1);
      expect(summaryNodes[0]?.kind, workflow.id).toBe("prompt");
      expect(summaryNodes[0]?.config?.summaryTarget, workflow.id).toBe("task");
      expect(summaryNodes[0]?.config?.toolMode, workflow.id).toBe("readonly");
    }
  });

  it("merge-capable built-ins expose a default-off post-merge verification node after merge proof", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      if (workflow.kind === "fragment") continue;
      if (workflow.id === "builtin:coding-ideas") continue; // intentionally minimal pipeline
      const mergeNode = workflow.ir.nodes.find((node) => node.id === "merge-attempt" || node.id === "merge");
      if (!mergeNode) continue;

      const postMerge = workflow.ir.nodes.find((node) => node.id === "post-merge-verification");
      expect(postMerge?.kind, workflow.id).toBe("optional-group");
      expect(postMerge?.config, workflow.id).toMatchObject({
        phase: "post-merge",
        defaultOn: false,
      });
      const template = postMerge?.config?.template as { nodes?: Array<{ config?: Record<string, unknown> }> } | undefined;
      expect(template?.nodes?.[0]?.config?.gateMode, workflow.id).toBe("gate");
      expect(workflow.ir.edges, `${workflow.id}:post-merge-entry`).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: mergeNode.id, to: "post-merge-verification", condition: "success" }),
        ]),
      );
      if (mergeNode.id === "merge-attempt") {
        expect(workflow.ir.edges, `${workflow.id}:no-direct-merge-end`).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ from: "merge-attempt", to: "end", condition: "success" }),
          ]),
        );
      }
      expect(workflow.ir.nodes.map((node) => node.id).indexOf("post-merge-verification"), workflow.id).toBeGreaterThan(
        workflow.ir.nodes.map((node) => node.id).indexOf(mergeNode.id),
      );
    }
  });

  it("built-in workflow layouts cover every authored node", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      const missingLayoutNodes = workflow.ir.nodes
        .map((node) => node.id)
        .filter((nodeId) => !workflow.layout[nodeId]);
      expect(missingLayoutNodes, workflow.id).toEqual([]);
    }
  });

  it("does not expose lowercase Code review step names in built-in workflow nodes", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      for (const node of workflow.ir.nodes) {
        expect(node.config?.name, `${workflow.id}:${node.id}`).not.toBe("Code review");
      }
    }
  });

  it("includes the stepwise coding built-in modeling step inversion (KTD-9)", () => {
    const stepwise = getBuiltinWorkflow("builtin:stepwise-coding");
    expect(stepwise).toBeDefined();
    const ir = parseWorkflowIr(stepwise!.ir);
    if (ir.version !== "v2") throw new Error("expected v2");
    // The chain: a parse-steps node dominating a foreach with a step-review template.
    expect(ir.nodes.some((n) => n.kind === "parse-steps")).toBe(true);
    expect(ir.nodes.some((n) => n.id === "plan-review" && n.kind === "optional-group")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "plan" && edge.to === "plan-review")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "plan-review" && edge.to === "parse")).toBe(true);
    expect(ir.nodes.some((n) => n.id === "browser-verification" && n.kind === "optional-group")).toBe(true);
    expect(ir.nodes.some((n) => n.id === "code-review" && n.kind === "optional-group")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "steps" && edge.to === "browser-verification" && edge.condition === "success")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "browser-verification" && edge.to === "code-review" && edge.condition === "success")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "code-review" && edge.to === "completion-summary" && edge.condition === "success")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "completion-summary" && edge.to === "merge-gate" && edge.condition === "success")).toBe(true);
    expect(ir.nodes.some((node) => node.id === "review")).toBe(false);
    const foreach = ir.nodes.find((n) => n.kind === "foreach");
    expect(foreach).toBeDefined();
    const template = (
      foreach!.config as { template: { nodes: Array<{ kind: string; config?: { seam?: string } }> } }
    ).template;
    expect(template.nodes.some((n) => n.kind === "step-review")).toBe(true);
    expect(template.nodes.some((n) => n.config?.seam === "step-execute")).toBe(true);
  });

  it("backs default coding with stepwise execution without per-step review", () => {
    const workflow = getBuiltinWorkflow("builtin:coding");
    expect(workflow).toBeDefined();
    expect(workflow!.ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    const ir = parseWorkflowIr(workflow!.ir);
    if (ir.version !== "v2") throw new Error("expected v2");

    expect(ir.nodes.some((node) => node.kind === "parse-steps")).toBe(true);
    expect(ir.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(["plan", "plan-review", "parse", "steps", "browser-verification", "code-review", "completion-summary", "merge-gate", "merge-attempt"]),
    );
    expect(ir.nodes.some((node) => node.id === "rework-hold")).toBe(false);
    expect(ir.nodes.some((node) => node.id === "review")).toBe(false);
    expect(ir.edges.some((edge) => edge.from === "plan" && edge.to === "plan-review" && edge.condition === "success")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "plan-review" && edge.to === "parse" && edge.condition === "success")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "code-review" && edge.to === "completion-summary" && edge.condition === "success")).toBe(true);
    expect(ir.edges.some((edge) => edge.from === "completion-summary" && edge.to === "merge-gate" && edge.condition === "success")).toBe(true);

    const foreach = ir.nodes.find((node) => node.kind === "foreach");
    expect(foreach).toBeDefined();
    const template = (
      foreach!.config as {
        template: {
          nodes: Array<{ id: string; kind: string }>;
          edges: Array<{ from: string; to: string; condition?: string; kind?: string }>;
        };
      }
    ).template;
    expect(template.nodes.map((node) => node.id)).toEqual(["step-execute", "step-done"]);
    expect(template.nodes.some((node) => node.kind === "step-review")).toBe(false);
    expect(template.edges).toEqual([
      expect.objectContaining({ from: "step-execute", to: "step-done", condition: "success" }),
    ]);
    expect(template.edges.some((edge) => edge.kind === "rework")).toBe(false);
  });

  it("all coding built-ins expose Browser Verification as an optional group", () => {
    for (const workflowId of ["builtin:coding", "builtin:legacy-coding", "builtin:stepwise-coding"]) {
      const workflow = getBuiltinWorkflow(workflowId)!;
      const browserVerification = workflow.ir.nodes.find((node) => node.id === "browser-verification");
      expect(browserVerification?.kind, workflowId).toBe("optional-group");
      expect(browserVerification?.config?.defaultOn, workflowId).toBe(false);
    }
  });

  it("includes the PR lifecycle built-in wiring the PR nodes end to end (U9)", () => {
    const pr = getBuiltinWorkflow("builtin:pr-workflow");
    expect(pr).toBeDefined();
    expect(pr!.kind).toBe("fragment");
    expect(BUILTIN_WORKFLOWS.some((workflow) => workflow.id === "builtin:pr-workflow")).toBe(true);
    const ir = parseWorkflowIr(pr!.ir);
    if (ir.version !== "v2") throw new Error("expected v2");

    // The three PR node kinds plus the await holds are all present.
    const kinds = ir.nodes.map((n) => n.kind);
    expect(kinds).toContain("pr-create");
    expect(kinds).toContain("pr-respond");
    expect(kinds).toContain("pr-merge");
    expect(ir.nodes.filter((n) => n.kind === "hold").length).toBeGreaterThanOrEqual(3);

    // The auto-merge gate (U6) routes after approval.
    expect(ir.nodes.some((n) => n.kind === "gate" && (n.config as { gate?: string })?.gate === "auto-merge")).toBe(true);

    // await-review is the bounded-rework region head; pr-respond loops back to it.
    const awaitReview = ir.nodes.find((n) => n.id === "await-review");
    expect((awaitReview?.config as { reworkRegion?: boolean })?.reworkRegion).toBe(true);
    expect((awaitReview?.config as { release?: string })?.release).toBe("external-event");
    expect(
      ir.edges.some((e) => e.from === "pr-respond" && e.to === "await-review" && e.kind === "rework"),
    ).toBe(true);

    // The create→await-review→gate→merge→end spine exists.
    expect(ir.edges.some((e) => e.from === "pr-create" && e.to === "await-review")).toBe(true);
    expect(ir.edges.some((e) => e.from === "await-review" && e.to === "gate")).toBe(true);
    expect(ir.edges.some((e) => e.from === "gate" && e.to === "pr-merge")).toBe(true);
    expect(ir.edges.some((e) => e.from === "pr-merge" && e.to === "end")).toBe(true);
  });

  it("the PR built-in IR round-trips through serialize → parse unchanged (U9)", () => {
    const pr = getBuiltinWorkflow("builtin:pr-workflow")!;
    const serialized = serializeWorkflowIr(pr.ir);
    const reparsed = parseWorkflowIr(serialized);
    // Re-serializing the reparsed IR yields the identical bytes (stable round-trip).
    expect(serializeWorkflowIr(reparsed)).toBe(serialized);
  });

  it("includes the lead-generation built-in after existing built-ins without disturbing default order", () => {
    const leadGeneration = getBuiltinWorkflow("builtin:lead-generation");
    expect(leadGeneration).toBeDefined();
    expect(leadGeneration!.kind).toBe("workflow");
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:lead-generation");
    expect(BUILTIN_WORKFLOWS.findIndex((workflow) => workflow.id === "builtin:lead-generation")).toBeGreaterThan(
      BUILTIN_WORKFLOWS.findIndex((workflow) => workflow.id === "builtin:pr-workflow"),
    );
  });

  it("keeps deprecated builtin:brainstorming resolvable while excluding it from defaults", () => {
    const brainstorming = getBuiltinWorkflow("builtin:brainstorming");
    expect(brainstorming).toBeDefined();
    expect(brainstorming!.kind).toBe("workflow");
    expect(() => parseWorkflowIr(brainstorming!.ir)).not.toThrow();
    expect(isBuiltinWorkflowDeprecated("builtin:brainstorming")).toBe(true);
    expect(defaultEnabledBuiltinWorkflowIds()).not.toContain("builtin:brainstorming");
    expect(BUILTIN_WORKFLOWS.findIndex((workflow) => workflow.id === "builtin:brainstorming")).toBeGreaterThan(
      BUILTIN_WORKFLOWS.findIndex((workflow) => workflow.id === "builtin:lead-generation"),
    );
  });

  it("keeps builtin:coding-ideas selectable as the simple five-stage pipeline", () => {
    const codingIdeas = getBuiltinWorkflow("builtin:coding-ideas");
    expect(codingIdeas).toBeDefined();
    expect(codingIdeas!.kind).toBe("workflow");
    expect(() => parseWorkflowIr(codingIdeas!.ir)).not.toThrow();
    expect(isBuiltinWorkflowDeprecated("builtin:coding-ideas")).toBe(false);
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:coding-ideas");
  });

  it("orders builtin:brainstorming's ask-user/exit-gate loop ahead of the plan/execute spine", () => {
    const brainstorming = getBuiltinWorkflow("builtin:brainstorming")!;
    const nodes = brainstorming.ir.nodes;
    const askIndex = nodes.findIndex((node) => node.kind === "ask-user");
    const exitIndex = nodes.findIndex((node) => node.kind === "exit-gate");
    const planIndex = nodes.findIndex((node) => node.id === "plan");
    const parseIndex = nodes.findIndex((node) => node.id === "parse");
    const stepsIndex = nodes.findIndex((node) => node.id === "steps");

    expect(askIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(askIndex);
    expect(planIndex).toBeGreaterThan(exitIndex);
    expect(parseIndex).toBeGreaterThan(planIndex);
    expect(stepsIndex).toBeGreaterThan(parseIndex);
  });

  it("builtin:brainstorming still satisfies every merge-capable built-in invariant (completion summary, post-merge-verification, merge primitives, settings)", () => {
    const brainstorming = getBuiltinWorkflow("builtin:brainstorming")!;
    const summaryNodes = brainstorming.ir.nodes.filter(
      (node) => node.kind === "prompt" && (node.config as { summaryTarget?: unknown } | undefined)?.summaryTarget === "task",
    );
    expect(summaryNodes).toHaveLength(1);
    expect((summaryNodes[0]!.config as { toolMode?: unknown }).toolMode).toBe("readonly");

    expect(brainstorming.ir.nodes.some((node) => node.id === "post-merge-verification")).toBe(true);
    for (const id of [
      "merge-gate",
      "merge-retry",
      "merge-manual-hold",
      "branch-group-member-integration",
      "branch-group-promotion",
      "merge-attempt",
      "recovery-router",
    ]) {
      expect(brainstorming.ir.nodes.some((node) => node.id === id)).toBe(true);
    }

    expect(brainstorming.ir.settings?.some((setting) => setting.id === "planReviewMaxRevisions")).toBe(true);
    expect(brainstorming.ir.settings?.some((setting) => setting.id === "codeReviewMaxRevisions")).toBe(true);
  });

  it("default workflow column ids equal the legacy enum values, in legacy order (KTD-1)", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    expect(BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => c.id)).toEqual([
      ...DEFAULT_WORKFLOW_COLUMN_IDS,
    ]);
  });

  // FNXC:Workflows 2026-07-05-00:00: FN-7599 — hand-authored default workflows (stepwise-coding, pr-workflow)
  // must also label the intake column "Planning" while keeping the "triage" id, matching builtin-coding.
  it("hand-authored default workflows label the intake column 'Planning' (FN-7599)", () => {
    for (const ir of [BUILTIN_STEPWISE_CODING_WORKFLOW_IR, BUILTIN_PR_WORKFLOW_IR]) {
      expect(ir.version).toBe("v2");
      if (ir.version !== "v2") throw new Error("expected v2");
      const triageColumn = ir.columns.find((column) => column.id === "triage");
      expect(triageColumn).toEqual({ id: "triage", name: "Planning", traits: [{ trait: "intake" }] });
    }
  });

  it("builtin:coding catalog entry is backed by the stepwise final-review IR", () => {
    const coding = getBuiltinWorkflow("builtin:coding");
    expect(coding).toBeDefined();
    expect(coding!.id).toBe("builtin:coding");
    expect(coding!.name).toBe("Coding");
    expect(coding!.description).toContain("optional final code review");
    expect(coding!.kind).toBe("workflow");
    expect(coding!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(coding!.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(coding!.ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(serializeWorkflowIr(coding!.ir)).toBe(serializeWorkflowIr(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR));
  });

  it("builtin:legacy-coding catalog entry preserves the original monolithic coding IR", () => {
    const legacy = getBuiltinWorkflow("builtin:legacy-coding");
    expect(legacy).toBeDefined();
    expect(legacy!.id).toBe("builtin:legacy-coding");
    expect(legacy!.name).toBe("Legacy coding");
    expect(legacy!.description).toContain("original monolithic coding pipeline");
    expect(legacy!.kind).toBe("workflow");
    expect(legacy!.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(serializeWorkflowIr(legacy!.ir)).toBe(serializeWorkflowIr(BUILTIN_CODING_WORKFLOW_IR));
  });

  it("built-in workflow names omit textual built-in suffixes", () => {
    expect(BUILTIN_WORKFLOWS.map((workflow) => workflow.name)).not.toContainEqual(expect.stringContaining("(built-in)"));
  });

  it("linear built-ins use the canonical trait-bearing default columns", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected coding v2");
    const canonicalColumns = columnTraitMatrix(BUILTIN_CODING_WORKFLOW_IR);

    for (const workflowId of LINEAR_BUILTIN_IDS) {
      const workflow = getBuiltinWorkflow(workflowId);
      expect(workflow, workflowId).toBeDefined();
      const ir = parseWorkflowIr(workflow!.ir);
      expect(ir.version, workflowId).toBe("v2");
      if (ir.version !== "v2") throw new Error(`expected ${workflowId} v2`);

      expect(columnTraitMatrix(ir), workflowId).toEqual(canonicalColumns);
      const todo = ir.columns.find((column) => column.id === "todo");
      expect(todo?.traits).toContainEqual({ trait: "hold", config: { release: "capacity" } });
      expect(todo?.traits).toContainEqual({ trait: "reset-on-entry" });
      expect(ir.columns.find((column) => column.id === "in-progress")?.traits.map((trait) => trait.trait)).toContain("wip");
      expect(ir.columns.find((column) => column.id === "in-review")?.traits.map((trait) => trait.trait)).toContain("merge");
    }

    const quickFix = parseWorkflowIr(getBuiltinWorkflow("builtin:quick-fix")!.ir);
    if (quickFix.version !== "v2") throw new Error("expected quick-fix v2");
    expect(quickFix.nodes.find((node) => node.id === "execute")?.column).toBe("in-progress");
    expect(quickFix.nodes.find((node) => node.id === "merge")?.column).toBe("in-review");
  });

  it("hand-authored built-in workflow columns stay on their authored trait sets", () => {
    const expected = new Map([
      [
        "builtin:coding",
        [
          { id: "triage", traits: ["intake"] },
          { id: "todo", traits: ["hold", "reset-on-entry"] },
          { id: "in-progress", traits: ["wip", "abort-on-exit", "timing"] },
          { id: "in-review", traits: ["merge-blocker", "human-review", "stall-detection", "merge"] },
          { id: "done", traits: ["complete"] },
          { id: "archived", traits: ["archived"] },
        ],
      ],
      [
        "builtin:marketing",
        [
          { id: "ideation", traits: ["intake"] },
          { id: "backlog", traits: ["hold", "reset-on-entry"] },
          { id: "drafting", traits: ["wip", "abort-on-exit", "timing"] },
          { id: "editorial-review", traits: ["merge-blocker", "human-review", "stall-detection", "merge"] },
          { id: "published", traits: ["complete"] },
          { id: "archived", traits: ["archived"] },
        ],
      ],
      [
        "builtin:stepwise-coding",
        [
          { id: "triage", traits: ["intake"] },
          { id: "todo", traits: ["hold", "reset-on-entry"] },
          { id: "in-progress", traits: ["wip", "abort-on-exit", "timing"] },
          { id: "in-review", traits: ["merge-blocker", "human-review", "stall-detection", "merge"] },
          { id: "done", traits: ["complete"] },
          { id: "archived", traits: ["archived"] },
        ],
      ],
      [
        "builtin:legacy-coding",
        [
          { id: "triage", traits: ["intake"] },
          { id: "todo", traits: ["hold", "reset-on-entry"] },
          { id: "in-progress", traits: ["wip", "abort-on-exit", "timing"] },
          { id: "in-review", traits: ["merge-blocker", "human-review", "stall-detection", "merge"] },
          { id: "done", traits: ["complete"] },
          { id: "archived", traits: ["archived"] },
        ],
      ],
      [
        "builtin:lead-generation",
        [
          { id: "triage", traits: ["intake"] },
          { id: "sourcing", traits: ["timing"] },
          { id: "qualification", traits: ["wip", "timing"] },
          { id: "enrichment", traits: ["timing"] },
          { id: "outreach", traits: ["human-review", "stall-detection"] },
          { id: "converted", traits: ["complete"] },
          { id: "archived", traits: ["archived"] },
        ],
      ],
      [
        "builtin:pr-workflow",
        [
          { id: "triage", traits: ["intake"] },
          { id: "in-progress", traits: ["wip", "timing"] },
          { id: "await-review", traits: ["merge-blocker", "stall-detection"] },
          { id: "done", traits: ["complete"] },
          { id: "archived", traits: ["archived"] },
        ],
      ],
    ]);

    for (const [workflowId, expectedColumns] of expected) {
      const workflow = getBuiltinWorkflow(workflowId)!;
      const ir = parseWorkflowIr(workflow.ir);
      expect(ir.version, workflowId).toBe("v2");
      if (ir.version !== "v2") throw new Error(`expected ${workflowId} v2`);
      expect(
        ir.columns.map((column) => ({ id: column.id, traits: column.traits.map((trait) => trait.trait) })),
        workflowId,
      ).toEqual(expectedColumns);
    }
  });

  it("builtin:coding catalog IR exposes canonical columns, placements, and settings", () => {
    const coding = getBuiltinWorkflow("builtin:coding")!;
    const ir = parseWorkflowIr(coding.ir);
    expect(ir.version).toBe("v2");
    if (ir.version !== "v2") throw new Error("expected v2");

    expect(ir.columns.map((column) => column.id)).toEqual([
      "triage",
      "todo",
      "in-progress",
      "in-review",
      "done",
      "archived",
    ]);
    expect(ir.columns.map((column) => column.traits.map((trait) => trait.trait))).toEqual([
      ["intake"],
      ["hold", "reset-on-entry"],
      ["wip", "abort-on-exit", "timing"],
      ["merge-blocker", "human-review", "stall-detection", "merge"],
      ["complete"],
      ["archived"],
    ]);

    const byId = new Map(ir.nodes.map((node) => [node.id, node]));
    expect(byId.get("plan")?.column).toBe("in-progress");
    expect(byId.get("plan-review")?.kind).toBe("optional-group");
    expect(byId.get("plan-review")?.column).toBe("in-progress");
    expect(byId.get("plan-review")?.config?.maxRevisions).toBe("unbounded");
    expect(planReviewInnerConfig(ir)).toMatchObject({
      toolMode: "readonly",
      gateMode: "gate",
    });
    expect(byId.get("parse")?.column).toBe("in-progress");
    expect(byId.get("steps")?.column).toBe("in-progress");
    // U6: the legacy `workflow-step` seam is replaced by the pre-merge
    // `browser-verification` optional-group, placed in the implementation column.
    expect(byId.get("workflow-step")).toBeUndefined();
    expect(byId.get("browser-verification")?.kind).toBe("optional-group");
    expect(byId.get("browser-verification")?.column).toBe("in-progress");
    expect(browserVerificationInnerConfig(ir)).toMatchObject({
      toolMode: "coding",
      gateMode: "advisory",
      requiresBrowser: true,
    });
    expect(byId.get("review")).toBeUndefined();
    // Merge is the native primitive region (FN-6035), placed in in-review.
    expect(byId.get("merge")).toBeUndefined();
    expect(byId.get("merge-gate")?.column).toBe("in-review");
    expect(byId.get("merge-retry")?.column).toBe("in-review");
    expect(byId.get("merge-manual-hold")?.column).toBe("in-review");
    expect(byId.get("branch-group-member-integration")?.column).toBe("in-review");
    expect(byId.get("branch-group-promotion")?.column).toBe("in-review");
    expect(byId.get("merge-attempt")?.column).toBe("in-review");
    expect(byId.get("recovery-router")?.column).toBe("in-review");
    expect(ir.settings).toEqual(BUILTIN_WORKFLOW_SETTINGS);
    expect(ir.settings?.find((setting) => setting.id === "planReviewMaxRevisions")).toMatchObject({
      type: "number",
      description: expect.stringMatching(/unbounded/i),
    });
    expect(ir.settings?.find((setting) => setting.id === "codeReviewMaxRevisions")).toMatchObject({
      type: "number",
      description: expect.stringMatching(/unbounded/i),
    });
  });

  it("includes the marketing built-in with custom columns, prompts, and lifecycle traits", () => {
    const marketing = getBuiltinWorkflow("builtin:marketing");
    expect(marketing).toBeDefined();
    expect(marketing!.kind).toBe("workflow");
    expect(BUILTIN_WORKFLOWS.some((workflow) => workflow.id === "builtin:marketing")).toBe(true);
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:marketing");
    expect(() => parseWorkflowIr(marketing!.ir)).not.toThrow();

    const ir = parseWorkflowIr(marketing!.ir);
    expect(ir.version).toBe("v2");
    if (ir.version !== "v2") throw new Error("expected v2");

    expect(ir.columns.map((column) => column.id)).toEqual([
      "ideation",
      "backlog",
      "drafting",
      "editorial-review",
      "published",
      "archived",
    ]);

    const editorialReview = ir.columns.find((column) => column.id === "editorial-review");
    expect(editorialReview).toBeDefined();
    expect(editorialReview!.traits.map((trait) => trait.trait)).toEqual([
      "merge-blocker",
      "human-review",
      "stall-detection",
      "merge",
    ]);
    const editorialFlags = resolveColumnFlags(editorialReview!);
    expect(editorialFlags.mergeBlocker).toBe(true);
    expect(editorialFlags.humanReview).toBe(true);

    const drafting = ir.columns.find((column) => column.id === "drafting");
    expect(drafting).toBeDefined();
    expect(resolveColumnFlags(drafting!).countsTowardWip).toBe(true);

    const execute = ir.nodes.find((node) => node.config?.seam === "execute");
    const review = ir.nodes.find((node) => node.config?.seam === "review");
    expect(execute?.id).toBe("draft");
    expect(execute?.config?.name).toBe("Draft content");
    expect(String(execute?.config?.prompt ?? "")).toContain("marketing copywriter");
    expect(String(execute?.config?.prompt ?? "")).toContain("fn_task_document_write");
    expect(String(execute?.config?.prompt ?? "").length).toBeGreaterThan(100);
    expect(review?.id).toBe("editorial");
    expect(review?.config?.name).toBe("Editorial review");
    expect(String(review?.config?.prompt ?? "")).toContain("editorial reviewer");
    expect(String(review?.config?.prompt ?? "").length).toBeGreaterThan(100);
  });

  it("includes the design built-in with an ordered design review gate", () => {
    const design = getBuiltinWorkflow("builtin:design");
    expect(design).toBeDefined();
    expect(design!.kind).toBe("workflow");
    expect(() => parseWorkflowIr(design!.ir)).not.toThrow();

    const authoredNodeIds = design!.ir.nodes.filter((node) => node.id !== "start" && node.id !== "end").map((node) => node.id);
    expect(authoredNodeIds).toEqual([
      "plan-review",
      "execute",
      "browser-verification",
      "code-review",
      "design-review",
      "review",
      "completion-summary",
      "merge",
      "post-merge-verification",
      "plan-replan",
      "browser-verification-remediation",
      "code-review-remediation",
    ]);

    const execute = design!.ir.nodes.find((node) => node.id === "execute");
    expect(execute?.config?.seam).toBe("execute");
    expect(execute?.config?.name).toBe("Execute");
    const executePrompt = String(execute?.config?.prompt ?? "");
    expect(executePrompt).toContain("fn_task_document_write");
    expect(executePrompt).toContain("preview");

    const designReview = design!.ir.nodes.find((node) => node.id === "design-review");
    expect(designReview?.kind).toBe("gate");
    expect(designReview?.config?.name).toBe("Design review");
    expect(designReview?.config?.gateMode).toBe("gate");
    const prompt = String(designReview?.config?.prompt ?? "");
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("visual hierarchy");
    expect(prompt).toContain("design tokens");
    expect(prompt).toContain("responsive behavior");
  });

  it("leaves coding-oriented built-in prompts and shared seam defaults on their existing paths", () => {
    const reviewHeavy = getBuiltinWorkflow("builtin:review-heavy")!;
    const security = reviewHeavy.ir.nodes.find((node) => node.id === "security");
    expect(security?.config?.prompt).toBe(
      "Review the diff for security issues: injection, auth/authorization gaps, secret handling, unsafe deserialization. Block on any exploitable finding.",
    );

    expect(builtinPromptConfig("execute", "Execute").prompt).toBe(BUILTIN_SEAM_PROMPTS.execute);
    expect(
      getBuiltinWorkflow("builtin:quick-fix")!.ir.nodes.find((node) => node.id === "execute")?.config?.prompt,
    ).toBe(BUILTIN_SEAM_PROMPTS.execute);
  });

  it("repeated catalog reads and listings keep builtin:coding in the enabled order", () => {
    expect(getBuiltinWorkflow("builtin:coding")?.ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(getBuiltinWorkflow("builtin:coding")?.ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(BUILTIN_WORKFLOWS.find((workflow) => workflow.id === "builtin:coding")?.ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(defaultEnabledBuiltinWorkflowIds()).toEqual(
      BUILTIN_WORKFLOWS.filter(
        (workflow) => workflow.kind !== "fragment"
          && !isBuiltinWorkflowPluginGated(workflow.id)
          && !isBuiltinWorkflowDeprecated(workflow.id),
      ).map((workflow) => workflow.id),
    );
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:design");
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:marketing");
    expect(defaultEnabledBuiltinWorkflowIds()).not.toContain("builtin:compound-engineering");
    expect(defaultEnabledBuiltinWorkflowIds()).not.toContain("builtin:brainstorming");
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:coding-ideas");
    expect(defaultEnabledBuiltinWorkflowIds()).not.toContain("builtin:pr-workflow");
    expect(getBuiltinWorkflow("builtin:pr-workflow")!.kind).toBe("fragment");
    expect(defaultEnabledBuiltinWorkflowIds().length).toBeGreaterThanOrEqual(5);
    expect(defaultEnabledBuiltinWorkflowIds().slice(0, 5)).toEqual([
      "builtin:coding",
      "builtin:coding-ideas",
      "builtin:legacy-coding",
      "builtin:quick-fix",
      "builtin:review-heavy",
    ]);
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:stepwise-coding");
  });

  it("identifies plugin-gated and deprecated built-in workflows", () => {
    expect(isBuiltinWorkflowPluginGated("builtin:compound-engineering")).toBe(true);
    expect(isBuiltinWorkflowPluginGated("builtin:coding")).toBe(false);
    expect(isBuiltinWorkflowPluginGated("builtin:quick-fix")).toBe(false);
    expect(isBuiltinWorkflowDeprecated("builtin:brainstorming")).toBe(true);
    expect(isBuiltinWorkflowDeprecated("builtin:coding-ideas")).toBe(false);
    expect(isBuiltinWorkflowDeprecated("builtin:coding")).toBe(false);
  });

  it("resolves required plugin ids for plugin-gated built-in workflows", () => {
    expect(getRequiredPluginIdForBuiltinWorkflow("builtin:compound-engineering")).toBe(
      "fusion-plugin-compound-engineering",
    );
    expect(getRequiredPluginIdForBuiltinWorkflow("builtin:coding")).toBeUndefined();
    expect(getRequiredPluginIdForBuiltinWorkflow("builtin:quick-fix")).toBeUndefined();
  });
  it("builtin:legacy-coding exposes execute retries after registry lookup and parse round-trip", () => {
    const coding = getBuiltinWorkflow("builtin:legacy-coding");
    expect(coding).toBeDefined();
    const ir = parseWorkflowIr(coding!.ir);
    const reparsed = parseWorkflowIr(serializeWorkflowIr(ir));

    for (const candidate of [ir, reparsed]) {
      const executeNodes = candidate.nodes.filter((node) => node.id === "execute" && node.config?.seam === "execute");
      expect(executeNodes).toHaveLength(1);
      const executeConfig = executeNodes[0].config;
      expect(executeConfig).toBeDefined();
      expect(Object.keys(executeConfig ?? {})).not.toHaveLength(0);
      expect(executeConfig?.maxRetries).toBe(EXECUTE_NODE_MAX_RETRIES);
      expect(Number.isInteger(executeConfig?.maxRetries)).toBe(true);
      expect(executeConfig?.maxRetries).toBeGreaterThanOrEqual(1);
      expect(executeConfig?.maxRetries).toBeLessThanOrEqual(10);

      const byId = new Map(candidate.nodes.map((node) => [node.id, node]));
      // U6: pre-merge browser-verification is an optional-group (default OFF),
      // not the legacy `workflow-step` seam.
      expect(byId.get("workflow-step")).toBeUndefined();
      expect(byId.get("browser-verification")?.kind).toBe("optional-group");
      expect(byId.get("browser-verification")?.config?.name).toBe("Browser Verification");
      expect(byId.get("review")?.config?.name).toBe("Review");
      expect(byId.get("review")?.config?.maxRetries).toBeUndefined();
      // The merge lifecycle is no longer a single `merge` seam node (FN-6035): it
      // is expressed as the merge-gate/merge-attempt/branch-group primitive region.
      expect(byId.get("merge")).toBeUndefined();
      expect(byId.get("merge-gate")?.kind).toBe("merge-gate");
      expect(byId.get("merge-retry")?.kind).toBe("retry-backoff");
      expect(byId.get("merge-manual-hold")?.kind).toBe("manual-merge-hold");
      expect(byId.get("branch-group-member-integration")?.kind).toBe("branch-group-member-integration");
      expect(byId.get("branch-group-promotion")?.kind).toBe("branch-group-promotion");
      expect(byId.get("merge-attempt")?.kind).toBe("merge-attempt");
      expect(byId.get("recovery-router")?.kind).toBe("recovery-router");
    }
  });

  it("builtin:coding exposes merge-blocker and human-review traits on in-review", () => {
    const coding = getBuiltinWorkflow("builtin:coding");
    expect(coding).toBeDefined();
    const ir = parseWorkflowIr(coding!.ir);
    expect(ir.version).toBe("v2");
    if (ir.version !== "v2") throw new Error("expected v2");

    const inReview = ir.columns.find((column) => column.id === "in-review");
    expect(inReview).toBeDefined();
    expect(inReview!.traits.length).toBeGreaterThan(0);
    expect(inReview!.traits.map((trait) => trait.trait)).toContain("merge-blocker");
    expect(inReview!.traits.map((trait) => trait.trait)).toContain("human-review");

    const flags = resolveColumnFlags(inReview!);
    expect(flags.mergeBlocker).toBe(true);
    expect(flags.humanReview).toBe(true);
  });

  it("includes a coding and a compound-engineering workflow", () => {
    expect(getBuiltinWorkflow("builtin:coding")).toBeDefined();
    expect(getBuiltinWorkflow("builtin:compound-engineering")).toBeDefined();
  });

  it("all seam nodes carry a descriptive name", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      const visitNodes = (nodes: Array<{ config?: unknown; id: string }>) => {
        for (const node of nodes) {
          const config = node.config as { seam?: unknown; name?: unknown } | undefined;
          if (typeof config?.seam === "string") {
            expect(typeof config.name).toBe("string");
            expect(String(config.name).trim().length).toBeGreaterThan(0);
          }
        }
      };

      visitNodes(workflow.ir.nodes);
      if (workflow.ir.version === "v2") {
        for (const node of workflow.ir.nodes) {
          if (node.kind !== "foreach") continue;
          const template = (node.config as { template?: { nodes?: Array<{ config?: unknown; id: string }> } } | undefined)
            ?.template;
          if (template?.nodes) visitNodes(template.nodes);
        }
      }
    }
  });

  it("compound-engineering exposes ce-code-review as the optional Code Review group and no generic review seam", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const codeReview = ce.ir.nodes.find((node) => node.id === "code-review");
    const template = codeReview?.config?.template as { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } | undefined;
    expect(codeReview?.kind).toBe("optional-group");
    expect(template?.nodes?.filter((node) => node.config?.skillName === "compound-engineering:ce-code-review")).toHaveLength(1);
    expect(ce.ir.nodes.some((node) => node.config?.seam === "review")).toBe(false);
  });

  it("compound-engineering runs ce-work for the execute step in coding mode", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    // The IR node declares the ce-work skill executor (engine wraps the prompt
    // with the invoke-skill preamble on the graph-interpreter path).
    const executeNode = ce.ir.nodes.find((n) => n.id === "execute");
    expect(executeNode?.config?.executor).toBe("skill");
    expect(executeNode?.config?.skillName).toBe("compound-engineering:ce-work");
    expect(executeNode?.config?.toolMode).toBe("coding");
  });

  it("compound-engineering skill-node prompts name their /ce- slash commands", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const byId = (id: string) => ce.ir.nodes.find((n) => n.id === id);
    const expectedPrompts = new Map([
      ["plan", "/ce-plan"],
      ["execute", "/ce-work"],
      ["document", "/ce-compound"],
    ]);

    for (const [nodeId, slashCommand] of expectedPrompts) {
      expect(String(byId(nodeId)?.config?.prompt ?? "")).toContain(slashCommand);
    }
    const docReviewTemplate = byId("ce-doc-review")?.config?.template as { nodes?: Array<{ config?: Record<string, unknown> }> } | undefined;
    expect(String(docReviewTemplate?.nodes?.[0]?.config?.prompt ?? "")).toContain("/ce-doc-review");
    const codeReviewTemplate = byId("code-review")?.config?.template as { nodes?: Array<{ config?: Record<string, unknown> }> } | undefined;
    expect(String(codeReviewTemplate?.nodes?.[0]?.config?.prompt ?? "")).toContain("/ce-code-review");
    const manualPrTemplate = byId("manual-pr-review")?.config?.template as { nodes?: Array<{ config?: Record<string, unknown> }> } | undefined;
    expect(String(manualPrTemplate?.nodes?.[0]?.config?.prompt ?? "")).toContain("/ce-commit");
    expect(String(byId("merge")?.config?.prompt ?? "")).not.toContain("/ce-");
  });

  it("compound-engineering manual PR lane is selected-only, auto-merge-off-only, and uses Fusion PR nodes", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const byId = (id: string) => ce.ir.nodes.find((n) => n.id === id);
    const manualPr = byId("manual-pr-review");
    expect(manualPr?.kind).toBe("optional-group");
    expect(manualPr?.column).toBe("in-review");
    expect(manualPr?.config?.defaultOn).toBe(false);
    expect(manualPr?.config?.requiresAutoMergeOff).toBe(true);
    const template = manualPr?.config?.template as { nodes?: Array<{ id: string; kind: string; config?: Record<string, unknown> }>; edges?: Array<{ from: string; to: string; condition?: string }> } | undefined;
    expect(template?.nodes?.map((node) => [node.id, node.kind])).toEqual([
      ["commit", "prompt"],
      ["open-pr", "pr-create"],
      ["resolve-feedback", "pr-respond"],
    ]);
    expect(template?.nodes?.[0]?.config?.skillName).toBe("compound-engineering:ce-commit");
    expect(template?.edges).toEqual([
      { from: "commit", to: "open-pr", condition: "success" },
      { from: "open-pr", to: "resolve-feedback", condition: "success" },
    ]);
    expect(byId("review-handoff")?.config?.seam).toBe("review-handoff");
    expect(byId("merge")?.config?.seam).toBe("merge");
    const ids = ce.ir.nodes.map((n) => n.id);
    expect(ids.indexOf("review-handoff")).toBeLessThan(ids.indexOf("manual-pr-review"));
    expect(ids.indexOf("manual-pr-review")).toBeLessThan(ids.indexOf("merge"));
    expect(ids.indexOf("merge")).toBeLessThan(ids.indexOf("document"));
  });

  it("compound-engineering review stage is ce-code-review, with graph ordering and layout intact", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const byId = (id: string) => ce.ir.nodes.find((n) => n.id === id);
    const authoredNodeIds = ce.ir.nodes.filter((node) => node.id !== "start" && node.id !== "end").map((node) => node.id);
    expect(authoredNodeIds).toEqual([
      "plan",
      "ce-doc-review",
      "plan-review",
      "execute",
      "browser-verification",
      "code-review",
      "review-handoff",
      "manual-pr-review",
      "completion-summary",
      "merge",
      "post-merge-verification",
      "document",
      "plan-replan",
      "browser-verification-remediation",
      "code-review-remediation",
    ]);
    expect(ce.ir.nodes.some((node) => node.config?.seam === "review")).toBe(false);

    const docReview = byId("ce-doc-review");
    expect(docReview?.kind).toBe("optional-group");
    expect(docReview?.config?.name).toBe("CE Doc Review");
    expect(docReview?.config?.defaultOn).toBe(false);
    const docReviewTemplate = docReview?.config?.template as { nodes?: Array<{ id: string; kind: string; config?: Record<string, unknown> }> } | undefined;
    expect(docReviewTemplate?.nodes?.[0]).toMatchObject({
      id: "ce-doc-review-step",
      kind: "prompt",
      config: {
        skillName: "compound-engineering:ce-doc-review",
        toolMode: "coding",
        gateMode: "advisory",
      },
    });

    const codeReview = byId("code-review");
    expect(codeReview?.kind).toBe("optional-group");
    expect(codeReview?.config?.name).toBe("Code Review");
    expect(codeReview?.config?.defaultOn).toBe(true);
    const codeReviewTemplate = codeReview?.config?.template as { nodes?: Array<{ id: string; kind: string; config?: Record<string, unknown> }> } | undefined;
    expect(codeReviewTemplate?.nodes?.[0]).toMatchObject({
      id: CODE_REVIEW_STEP_NODE_ID,
      kind: "gate",
      config: {
        skillName: "compound-engineering:ce-code-review",
        gateMode: "gate",
        toolMode: "coding",
      },
    });

    const layout = ce.layout ?? {};
    expect(Object.keys(layout).sort()).toEqual(ce.ir.nodes.map((node) => node.id).sort());
    for (let i = 1; i < ce.ir.nodes.length; i += 1) {
      expect(layout[ce.ir.nodes[i].id].x - layout[ce.ir.nodes[i - 1].id].x).toBe(170);
    }
    expect(ce.ir.edges.some((edge) => edge.from === "plan" && edge.to === "ce-doc-review")).toBe(true);
    expect(ce.ir.edges.some((edge) => edge.from === "ce-doc-review" && edge.to === "plan-review")).toBe(true);
    expect(ce.ir.edges.some((edge) => edge.from === "plan-review" && edge.to === "execute")).toBe(true);
    expect(ce.ir.edges.some((edge) => edge.from === "execute" && edge.to === "browser-verification")).toBe(true);
    expect(ce.ir.edges.some((edge) => edge.from === "browser-verification" && edge.to === "code-review")).toBe(true);
    expect(ce.ir.edges.some((edge) => edge.from === "code-review" && edge.to === "review-handoff")).toBe(true);
    expect(ce.ir.edges.some((edge) => edge.from === "review-handoff" && edge.to === "manual-pr-review")).toBe(true);
    expect(ce.ir.edges.some((edge) => edge.from === "manual-pr-review" && edge.to === "completion-summary")).toBe(true);
  });

  it("coding variants only retain generic review nodes where the workflow requires them", () => {
    const coding = getBuiltinWorkflow("builtin:coding")!;
    const legacy = getBuiltinWorkflow("builtin:legacy-coding")!;
    const stepwise = getBuiltinWorkflow("builtin:stepwise-coding")!;
    const reviewHeavy = getBuiltinWorkflow("builtin:review-heavy")!;

    expect(coding.ir.nodes.some((node) => node.id === "review" && node.config?.seam === "review")).toBe(false);
    expect(legacy.ir.nodes.some((node) => node.id === "review" && node.config?.seam === "review")).toBe(true);
    expect(stepwise.ir.nodes.some((node) => node.id === "review" && node.config?.seam === "review")).toBe(false);
    expect(reviewHeavy.ir.nodes.some((node) => node.id === "review" && node.config?.seam === "review")).toBe(true);
  });

  it("compound-engineering runs plan/code-review/document in coding mode and carries skillName onto compiled steps (U1/U4)", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const byId = (id: string) => ce.ir.nodes.find((n) => n.id === id);
    // U4: fan-out steps (plan, code-review) need coding so fn_spawn_agent is
    // available for persona fan-out; document needs coding to WRITE docs/solutions.
    expect(byId("plan")?.config?.toolMode).toBe("coding");
    expect(byId("document")?.config?.toolMode).toBe("coding");
    const codeReview = byId("code-review");
    const template = codeReview?.config?.template as { nodes?: Array<{ config?: Record<string, unknown> }> } | undefined;
    expect(template?.nodes?.[0]?.config?.skillName).toBe("compound-engineering:ce-code-review");
    expect(template?.nodes?.[0]?.config?.gateMode).toBe("gate");
    expect(template?.nodes?.[0]?.config?.toolMode).toBe("coding");
  });

  /*
  FNXC:PostgresCutover 2026-07-05-14:00:
  Store-integration coverage runs on the shared PostgreSQL harness (the sync
  SQLite TaskStore runtime was removed under VAL-REMOVAL-005). pgDescribe
  auto-skips when PostgreSQL is unreachable so the merge gate stays green.
  */
  pgDescribe("store integration (PostgreSQL)", () => {
    const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_builtin_wf" });

    beforeAll(harness.beforeAll);
    afterAll(harness.afterAll);
    let store: ReturnType<typeof harness.store>;
    beforeEach(async () => {
      await harness.beforeEach();
      store = harness.store();
    });
    afterEach(async () => {
      await harness.afterEach();
    });

    it("lists built-ins ahead of user workflows and resolves them by id", async () => {
      const list = await store.listWorkflowDefinitions();
      expect(list[0].id.startsWith("builtin:")).toBe(true);
      expect(await store.getWorkflowDefinition("builtin:coding")).toBeDefined();
    });

    it("filters disabled built-ins from normal listings but keeps direct resolution", async () => {
      await store.updateSettings({ enabledBuiltinWorkflowIds: ["builtin:coding"] });

      const list = await store.listWorkflowDefinitions();
      expect(list.filter((workflow) => workflow.id.startsWith("builtin:")).map((workflow) => workflow.id)).toEqual([
        "builtin:coding",
      ]);
      expect(await store.getWorkflowDefinition("builtin:review-heavy")).toBeDefined();
    });

    it("can include disabled built-ins for workflow management surfaces", async () => {
      await store.updateSettings({ enabledBuiltinWorkflowIds: [] });

      const normalList = await store.listWorkflowDefinitions();
      expect(normalList.some((workflow) => workflow.id.startsWith("builtin:"))).toBe(false);

      const managementList = await store.listWorkflowDefinitions({ includeDisabledBuiltins: true });
      expect(managementList.some((workflow) => workflow.id === "builtin:coding")).toBe(true);
      expect(managementList.some((workflow) => workflow.id === "builtin:compound-engineering")).toBe(false);
    });

    it("hides deprecated built-ins from selection listings while preserving management and direct resolution", async () => {
      const deprecatedIds = ["builtin:brainstorming"];
      const selectionList = await store.listWorkflowDefinitions();
      for (const id of deprecatedIds) {
        expect(selectionList.some((workflow) => workflow.id === id)).toBe(false);
      }

      const managementList = await store.listWorkflowDefinitions({ includeDisabledBuiltins: true });
      for (const id of deprecatedIds) {
        expect(managementList.some((workflow) => workflow.id === id)).toBe(true);
        expect(await store.getWorkflowDefinition(id)).toMatchObject({ id });
      }
    });

    it("hides the compound-engineering built-in when its plugin is not installed", async () => {
      const list = await store.listWorkflowDefinitions();
      expect(list.some((workflow) => workflow.id === "builtin:compound-engineering")).toBe(false);
      expect(await store.getWorkflowDefinition("builtin:compound-engineering")).toBeUndefined();
    });

    it("opens the plugin store before the shared harness resets globalDir", async () => {
      const pluginStore = store.getPluginStore();
      await pluginStore.init();
      expect(await pluginStore.listPlugins()).toEqual([]);
    });

    it("shows the compound-engineering built-in when its plugin is installed", async () => {
      await store.getPluginStore().registerPlugin({
        manifest: {
          id: "fusion-plugin-compound-engineering",
          name: "Compound Engineering",
          version: "1.0.0",
        },
        path: "/tmp/fusion-plugin-compound-engineering",
      });

      const list = await store.listWorkflowDefinitions();
      expect(list.some((workflow) => workflow.id === "builtin:compound-engineering")).toBe(true);
      expect(await store.getWorkflowDefinition("builtin:compound-engineering")).toBeDefined();
    });

    it("shows the built-in prompt text in node config", () => {
      const coding = getBuiltinWorkflow("builtin:coding");
      const plan = coding?.ir.nodes.find((node) => node.id === "plan");
      const steps = coding?.ir.nodes.find((node) => node.id === "steps");
      const codeReview = coding?.ir.nodes.find((node) => node.id === "code-review");
      const legacy = getBuiltinWorkflow("builtin:legacy-coding");
      const legacyExecute = legacy?.ir.nodes.find((node) => node.id === "execute");

      expect((plan?.config as { prompt?: string } | undefined)?.prompt).toContain("You are a task specification agent");
      expect(steps?.kind).toBe("foreach");
      expect(codeReview?.kind).toBe("optional-group");
      expect(coding?.ir.edges.some((edge) => edge.from === "code-review" && edge.to === "completion-summary")).toBe(true);
      expect(coding?.ir.edges.some((edge) => edge.from === "completion-summary" && edge.to === "merge-gate")).toBe(true);
      expect((legacyExecute?.config as { prompt?: string } | undefined)?.prompt).toContain("You are a task execution agent");
      // No `merge` seam node post-FN-6035 — merge runs as native primitives.
      expect(coding?.ir.nodes.find((node) => node.id === "merge")).toBeUndefined();
    });

    it("rejects editing or deleting a built-in", async () => {
      await expect(
        store.updateWorkflowDefinition("builtin:coding", { name: "x" }),
      ).rejects.toThrow(/cannot be edited/i);
      await expect(store.deleteWorkflowDefinition("builtin:coding")).rejects.toThrow(/cannot be deleted/i);
    });

    it("branching built-ins can be selected without throwing, seeding default-on optional-group ids", async () => {
      // FNXC:WorkflowStepCRUD 2026-06-26-14:00: U7c — `selectTaskWorkflow` no longer
      // materializes legacy `workflow_steps` rows; it seeds `enabledWorkflowSteps` with the
      // workflow's DEFAULT-ON optional-group node ids, exactly matching the create-time path
      // (a task that SELECTS builtin:coding now enables default-on optional groups just
      // like one CREATED with builtin:coding — previously select returned [] and silently
      // skipped the gate).
      const expectedGroups: Record<string, string[]> = {
        "builtin:coding": ["plan-review", "code-review"],
        "builtin:legacy-coding": ["plan-review", "code-review"],
        "builtin:marketing": [],
        "builtin:stepwise-coding": ["plan-review", "code-review"],
      };
      for (const workflowId of ["builtin:coding", "builtin:legacy-coding", "builtin:marketing", "builtin:stepwise-coding"]) {
        const task = await store.createTask({ description: `select ${workflowId}`, enabledWorkflowSteps: [] });
        const expected = expectedGroups[workflowId];

        await expect(store.selectTaskWorkflow(task.id, workflowId)).resolves.toEqual(expected);

        const detail = await store.getTask(task.id);
        expect(detail.enabledWorkflowSteps ?? []).toEqual(expected);
        expect(await store.getTaskWorkflowSelectionAsync(task.id)).toEqual({ workflowId, stepIds: expected });
      }
    });

    it("create-time branching built-in workflowId records selection and seeds the default-on review groups", async () => {
      const task = await store.createTask({ description: "explicit builtin coding", workflowId: "builtin:coding" });

      const detail = await store.getTask(task.id);
      // FNXC:PlanReviewStep/FNXC:CodeReviewStep — builtin:coding carries DEFAULT-ON
      // `plan-review` and `code-review` optional groups, so the explicit-workflow
      // create path seeds them into the task's enabledWorkflowSteps.
      expect(detail.enabledWorkflowSteps ?? []).toEqual(["plan-review", "code-review"]);
      expect(await store.getTaskWorkflowSelectionAsync(task.id)).toEqual({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] });
    });

    it("a task can disable code-review by creating with explicit enabledWorkflowSteps excluding it", async () => {
      // FNXC:WorkflowCreation 2026-06-28-23:09:
      // Default-on optional groups are toggleable, but toggling them must not erase
      // the explicit workflow selection row. User-facing create flows send workflowId
      // and enabledWorkflowSteps together.
      const task = await store.createTask({
        description: "coding without code review",
        workflowId: "builtin:coding",
        enabledWorkflowSteps: ["plan-review", "browser-verification"],
      });
      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps ?? []).not.toContain("code-review");
      expect(detail.enabledWorkflowSteps ?? []).toEqual(["plan-review", "browser-verification"]);
      expect(await store.getTaskWorkflowSelectionAsync(task.id)).toEqual({
        workflowId: "builtin:coding",
        stepIds: ["plan-review", "browser-verification"],
      });
    });

    it("create-time stepwise workflowId persists when optional steps are submitted", async () => {
      const task = await store.createTask({
        description: "stepwise with toggles",
        workflowId: "builtin:stepwise-coding",
        enabledWorkflowSteps: ["plan-review", "code-review"],
      });

      expect((await store.getTask(task.id)).enabledWorkflowSteps ?? []).toEqual(["plan-review", "code-review"]);
      expect(await store.getTaskWorkflowSelectionAsync(task.id)).toEqual({
        workflowId: "builtin:stepwise-coding",
        stepIds: ["plan-review", "code-review"],
      });
    });

    it("create-time workflowId with empty optional steps disables default-on groups but keeps selection", async () => {
      const task = await store.createTask({
        description: "coding with all optional groups off",
        workflowId: "builtin:coding",
        enabledWorkflowSteps: [],
      });

      /*
      FNXC:WorkflowOptionalSteps 2026-06-29-02:55:
      An explicit empty optional-step selection must hydrate back as `[]`, not
      `undefined`; otherwise later workflow execution can confuse "all disabled"
      with "not materialized" and re-run default-on Plan Review / Code Review.
      */
      expect((await store.getTask(task.id)).enabledWorkflowSteps).toEqual([]);
      expect(await store.getTaskWorkflowSelectionAsync(task.id)).toEqual({
        workflowId: "builtin:coding",
        stepIds: [],
      });
    });

    it("reserved-id create-time workflowId persists when optional steps are submitted", async () => {
      const task = await store.createTaskWithReservedId(
        {
          description: "reserved stepwise with toggles",
          workflowId: "builtin:stepwise-coding",
          enabledWorkflowSteps: ["plan-review", "code-review"],
        },
        { taskId: "reserved-stepwise-with-toggles" },
      );

      expect((await store.getTask(task.id)).enabledWorkflowSteps ?? []).toEqual(["plan-review", "code-review"]);
      expect(await store.getTaskWorkflowSelectionAsync(task.id)).toEqual({
        workflowId: "builtin:stepwise-coding",
        stepIds: ["plan-review", "code-review"],
      });
    });

    it("branching built-in project defaults do not throw", async () => {
      await expect(store.createTask({ description: "implicit builtin default" })).resolves.toMatchObject({
        description: "implicit builtin default",
      });

      // FNXC:PlanReviewStep/FNXC:CodeReviewStep — builtin:coding/stepwise are interpreter-deferred (they
      // carry optional-group nodes), so DEFAULT-workflow materialization records no legacy
      // WorkflowStep rows. They DO carry DEFAULT-ON optional-group ids, so the project-default
      // create path now seeds those ids into enabledWorkflowSteps and records a selection
      // (mirroring the explicit-workflow path). browser-verification stays off (defaultOn:false).
      await store.setDefaultWorkflowId("builtin:coding");
      const codingTask = await store.createTask({ description: "default builtin coding" });
      expect((await store.getTask(codingTask.id)).enabledWorkflowSteps ?? []).toEqual(["plan-review", "code-review"]);
      expect(await store.getTaskWorkflowSelectionAsync(codingTask.id)).toEqual({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] });

      const reservedCodingTask = await store.createTaskWithReservedId(
        { description: "reserved default builtin coding" },
        { taskId: "reserved-default-builtin-coding" },
      );
      expect((await store.getTask(reservedCodingTask.id)).enabledWorkflowSteps ?? []).toEqual(["plan-review", "code-review"]);
      expect(await store.getTaskWorkflowSelectionAsync(reservedCodingTask.id)).toEqual({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] });

      await store.setDefaultWorkflowId("builtin:stepwise-coding");
      const stepwiseTask = await store.createTask({ description: "default builtin stepwise" });
      expect((await store.getTask(stepwiseTask.id)).enabledWorkflowSteps ?? []).toEqual(["plan-review", "code-review"]);
      expect(await store.getTaskWorkflowSelectionAsync(stepwiseTask.id)).toEqual({ workflowId: "builtin:stepwise-coding", stepIds: ["plan-review", "code-review"] });

      const reservedStepwiseTask = await store.createTaskWithReservedId(
        { description: "reserved default builtin stepwise" },
        { taskId: "reserved-default-builtin-stepwise" },
      );
      expect((await store.getTask(reservedStepwiseTask.id)).enabledWorkflowSteps ?? []).toEqual(["plan-review", "code-review"]);
      expect(await store.getTaskWorkflowSelectionAsync(reservedStepwiseTask.id)).toEqual({ workflowId: "builtin:stepwise-coding", stepIds: ["plan-review", "code-review"] });
    });

    it("rejects selecting the PR lifecycle fragment for a task", async () => {
      const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
      await expect(store.selectTaskWorkflow(task.id, "builtin:pr-workflow")).rejects.toThrow(
        "is a fragment and cannot be selected for a task",
      );
    });
  });
});
