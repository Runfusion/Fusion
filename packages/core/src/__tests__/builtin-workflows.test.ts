import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

import {
  BUILTIN_WORKFLOWS,
  defaultEnabledBuiltinWorkflowIds,
  getBuiltinWorkflow,
  getRequiredPluginIdForBuiltinWorkflow,
  isBuiltinWorkflowId,
  isBuiltinWorkflowPluginGated,
} from "../builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { builtinPromptConfig, BUILTIN_SEAM_PROMPTS } from "../builtin-workflow-prompts.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";
import { resolveColumnFlags } from "../trait-registry.js";
import { compileWorkflowToSteps } from "../workflow-compiler.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS, parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";
import { createSharedTaskStoreTestHarness } from "./store-test-helpers.js";

const EXECUTE_NODE_MAX_RETRIES = 2;

describe("built-in workflows", () => {
  // Non-compiler built-ins model graph-only node kinds or reusable fragments the
  // linear compiler cannot lower to a step list. They still must parse as valid IR.
  const NON_COMPILABLE_BUILTIN_IDS = new Set([
    "builtin:coding",
    "builtin:marketing",
    "builtin:stepwise-coding",
    "builtin:pr-workflow",
  ]);

  it("every built-in has a valid IR; linear built-ins compile without error", () => {
    expect(BUILTIN_WORKFLOWS.length).toBeGreaterThanOrEqual(4);
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(isBuiltinWorkflowId(wf.id)).toBe(true);
      expect(() => parseWorkflowIr(wf.ir)).not.toThrow();
      if (!NON_COMPILABLE_BUILTIN_IDS.has(wf.id)) {
        expect(() => compileWorkflowToSteps(wf.ir)).not.toThrow();
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
    const foreach = ir.nodes.find((n) => n.kind === "foreach");
    expect(foreach).toBeDefined();
    const template = (
      foreach!.config as { template: { nodes: Array<{ kind: string; config?: { seam?: string } }> } }
    ).template;
    expect(template.nodes.some((n) => n.kind === "step-review")).toBe(true);
    expect(template.nodes.some((n) => n.config?.seam === "step-execute")).toBe(true);
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

  it("default workflow column ids equal the legacy enum values, in legacy order (KTD-1)", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    expect(BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => c.id)).toEqual([
      ...DEFAULT_WORKFLOW_COLUMN_IDS,
    ]);
  });

  it("builtin:coding catalog entry is backed by the canonical coding IR", () => {
    const coding = getBuiltinWorkflow("builtin:coding");
    expect(coding).toBeDefined();
    expect(coding!.id).toBe("builtin:coding");
    expect(coding!.name).toBe("Coding (built-in)");
    expect(coding!.description).toContain("standard coding pipeline");
    expect(coding!.kind).toBe("workflow");
    expect(coding!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(coding!.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(coding!.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(serializeWorkflowIr(coding!.ir)).toBe(serializeWorkflowIr(BUILTIN_CODING_WORKFLOW_IR));
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
    expect(byId.get("execute")?.column).toBe("in-progress");
    // U6: the legacy `workflow-step` seam is replaced by the pre-merge
    // `browser-verification` optional-group, placed in the implementation column.
    expect(byId.get("workflow-step")).toBeUndefined();
    expect(byId.get("browser-verification")?.kind).toBe("optional-group");
    expect(byId.get("browser-verification")?.column).toBe("in-progress");
    expect(byId.get("review")?.column).toBe("in-review");
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
    expect(() => compileWorkflowToSteps(design!.ir)).not.toThrow();

    const authoredNodeIds = design!.ir.nodes.filter((node) => node.id !== "start" && node.id !== "end").map((node) => node.id);
    expect(authoredNodeIds).toEqual(["execute", "design-review", "review", "merge"]);

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
    expect(getBuiltinWorkflow("builtin:coding")?.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(getBuiltinWorkflow("builtin:coding")?.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(BUILTIN_WORKFLOWS.find((workflow) => workflow.id === "builtin:coding")?.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(defaultEnabledBuiltinWorkflowIds()).toEqual(
      BUILTIN_WORKFLOWS.filter(
        (workflow) => workflow.kind !== "fragment" && !isBuiltinWorkflowPluginGated(workflow.id),
      ).map((workflow) => workflow.id),
    );
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:design");
    expect(defaultEnabledBuiltinWorkflowIds()).toContain("builtin:marketing");
    expect(defaultEnabledBuiltinWorkflowIds()).not.toContain("builtin:compound-engineering");
    expect(defaultEnabledBuiltinWorkflowIds()).not.toContain("builtin:pr-workflow");
    expect(getBuiltinWorkflow("builtin:pr-workflow")!.kind).toBe("fragment");
    expect(defaultEnabledBuiltinWorkflowIds().length).toBeGreaterThanOrEqual(5);
    expect(defaultEnabledBuiltinWorkflowIds().slice(0, 5)).toEqual([
      "builtin:coding",
      "builtin:quick-fix",
      "builtin:review-heavy",
      "builtin:marketing",
      "builtin:stepwise-coding",
    ]);
  });

  it("identifies plugin-gated built-in workflows", () => {
    expect(isBuiltinWorkflowPluginGated("builtin:compound-engineering")).toBe(true);
    expect(isBuiltinWorkflowPluginGated("builtin:coding")).toBe(false);
    expect(isBuiltinWorkflowPluginGated("builtin:quick-fix")).toBe(false);
  });

  it("resolves required plugin ids for plugin-gated built-in workflows", () => {
    expect(getRequiredPluginIdForBuiltinWorkflow("builtin:compound-engineering")).toBe(
      "fusion-plugin-compound-engineering",
    );
    expect(getRequiredPluginIdForBuiltinWorkflow("builtin:coding")).toBeUndefined();
    expect(getRequiredPluginIdForBuiltinWorkflow("builtin:quick-fix")).toBeUndefined();
  });
  it("builtin:coding exposes execute retries after registry lookup and parse round-trip", () => {
    const coding = getBuiltinWorkflow("builtin:coding");
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

  it("compound-engineering compiles exactly one ce-code-review step and no generic review seam", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const steps = compileWorkflowToSteps(ce.ir);
    // plan + execute (ce-work) + code-review (pre-merge) + commit-pr +
    // resolve-feedback + document (post-merge) — merge seams are skipped.
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(steps.some((s) => s.name === "Plan")).toBe(true);
    expect(steps.filter((s) => s.skillName === "compound-engineering:ce-code-review")).toHaveLength(1);
    expect(steps.some((s) => s.name === "Review" && !s.skillName)).toBe(false);
  });

  it("compound-engineering runs ce-work for the execute step in coding mode", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    // The IR node declares the ce-work skill executor (engine wraps the prompt
    // with the invoke-skill preamble on the graph-interpreter path).
    const executeNode = ce.ir.nodes.find((n) => n.id === "execute");
    expect(executeNode?.config?.executor).toBe("skill");
    expect(executeNode?.config?.skillName).toBe("compound-engineering:ce-work");
    // The compiled step runs in coding mode so write/spawn tools are available.
    const steps = compileWorkflowToSteps(ce.ir);
    const execute = steps.find((s) => s.name === "Execute");
    expect(execute).toBeDefined();
    expect(execute!.toolMode).toBe("coding");
  });

  it("compound-engineering skill-node prompts name their /ce- slash commands", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const byId = (id: string) => ce.ir.nodes.find((n) => n.id === id);
    const expectedPrompts = new Map([
      ["plan", "/ce-plan"],
      ["execute", "/ce-work"],
      ["code-review", "/ce-code-review"],
      ["commit-pr", "/ce-commit-push-pr"],
      ["resolve-feedback", "/ce-resolve-pr-feedback"],
      ["document", "/ce-compound"],
    ]);

    for (const [nodeId, slashCommand] of expectedPrompts) {
      expect(String(byId(nodeId)?.config?.prompt ?? "")).toContain(slashCommand);
    }
    expect(String(byId("merge")?.config?.prompt ?? "")).not.toContain("/ce-");
  });

  it("compound-engineering merge stage uses the CE commit/PR + resolve-feedback skills", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const byId = (id: string) => ce.ir.nodes.find((n) => n.id === id);
    expect(byId("commit-pr")?.config?.skillName).toBe("compound-engineering:ce-commit-push-pr");
    expect(byId("commit-pr")?.config?.toolMode).toBe("coding");
    expect(byId("resolve-feedback")?.config?.skillName).toBe("compound-engineering:ce-resolve-pr-feedback");
    // KTD-6: the Fusion board-merge seam is preserved (CE prepares the PR, Fusion
    // owns the merge transition).
    expect(byId("merge")?.config?.seam).toBe("merge");
    // Ordering: commit-pr → resolve-feedback → merge → document.
    const ids = ce.ir.nodes.map((n) => n.id);
    expect(ids.indexOf("commit-pr")).toBeLessThan(ids.indexOf("resolve-feedback"));
    expect(ids.indexOf("resolve-feedback")).toBeLessThan(ids.indexOf("merge"));
    expect(ids.indexOf("merge")).toBeLessThan(ids.indexOf("document"));
  });

  it("compound-engineering review stage is ce-code-review, with graph ordering and layout intact", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const byId = (id: string) => ce.ir.nodes.find((n) => n.id === id);
    const authoredNodeIds = ce.ir.nodes.filter((node) => node.id !== "start" && node.id !== "end").map((node) => node.id);
    expect(authoredNodeIds).toEqual([
      "plan",
      "execute",
      "code-review",
      "commit-pr",
      "resolve-feedback",
      "merge",
      "document",
    ]);
    expect(ce.ir.nodes.some((node) => node.config?.seam === "review")).toBe(false);

    const codeReview = byId("code-review");
    expect(codeReview?.kind).toBe("gate");
    expect(codeReview?.config?.skillName).toBe("compound-engineering:ce-code-review");
    expect(codeReview?.config?.gateMode).toBe("gate");
    expect(codeReview?.config?.toolMode).toBe("coding");

    const layout = ce.layout ?? {};
    expect(Object.keys(layout).sort()).toEqual(ce.ir.nodes.map((node) => node.id).sort());
    for (let i = 1; i < ce.ir.nodes.length; i += 1) {
      expect(layout[ce.ir.nodes[i].id].x - layout[ce.ir.nodes[i - 1].id].x).toBe(170);
    }
    expect(ce.ir.edges.some((edge) => edge.from === "execute" && edge.to === "code-review")).toBe(true);
    expect(ce.ir.edges.some((edge) => edge.from === "code-review" && edge.to === "commit-pr")).toBe(true);
  });

  it("other built-in workflows retain their generic review nodes", () => {
    const coding = getBuiltinWorkflow("builtin:coding")!;
    const reviewHeavy = getBuiltinWorkflow("builtin:review-heavy")!;

    expect(coding.ir.nodes.some((node) => node.id === "review" && node.config?.seam === "review")).toBe(true);
    expect(reviewHeavy.ir.nodes.some((node) => node.id === "review" && node.config?.seam === "review")).toBe(true);
  });

  it("compound-engineering runs plan/code-review/document in coding mode and carries skillName onto compiled steps (U1/U4)", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const byId = (id: string) => ce.ir.nodes.find((n) => n.id === id);
    // U4: fan-out steps (plan, code-review) need coding so fn_spawn_agent is
    // available for persona fan-out; document needs coding to WRITE docs/solutions.
    expect(byId("plan")?.config?.toolMode).toBe("coding");
    expect(byId("code-review")?.config?.toolMode).toBe("coding");
    expect(byId("document")?.config?.toolMode).toBe("coding");
    // U1: the compiler carries each node's skillName onto the materialized step so
    // the step session can actually LOAD the skill (not just name it in prompt text).
    const steps = compileWorkflowToSteps(ce.ir);
    const plan = steps.find((s) => s.name === "Plan");
    expect(plan?.skillName).toBe("compound-engineering:ce-plan");
    expect(plan?.toolMode).toBe("coding");
    const codeReviewSteps = steps.filter((s) => s.skillName === "compound-engineering:ce-code-review");
    expect(codeReviewSteps).toHaveLength(1);
    expect(codeReviewSteps[0].gateMode).toBe("gate");
    expect(codeReviewSteps[0].toolMode).toBe("coding");
    const document = steps.find((s) => s.skillName === "compound-engineering:ce-compound");
    expect(document?.toolMode).toBe("coding");
  });

  describe("store integration", () => {
    const harness = createSharedTaskStoreTestHarness();

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

    it("hides the compound-engineering built-in when its plugin is not installed", async () => {
      const list = await store.listWorkflowDefinitions();
      expect(list.some((workflow) => workflow.id === "builtin:compound-engineering")).toBe(false);
      expect(await store.getWorkflowDefinition("builtin:compound-engineering")).toBeUndefined();
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

    it("shows the built-in seam prompt text in node config", () => {
      const coding = getBuiltinWorkflow("builtin:coding");
      const execute = coding?.ir.nodes.find((node) => node.id === "execute");
      const review = coding?.ir.nodes.find((node) => node.id === "review");

      expect((execute?.config as { prompt?: string } | undefined)?.prompt).toContain("You are a task execution agent");
      expect((review?.config as { prompt?: string } | undefined)?.prompt).toContain("You are an independent code and plan reviewer");
      // No `merge` seam node post-FN-6035 — merge runs as native primitives.
      expect(coding?.ir.nodes.find((node) => node.id === "merge")).toBeUndefined();
    });

    it("rejects editing or deleting a built-in", async () => {
      await expect(
        store.updateWorkflowDefinition("builtin:coding", { name: "x" }),
      ).rejects.toThrow(/cannot be edited/i);
      await expect(store.deleteWorkflowDefinition("builtin:coding")).rejects.toThrow(/cannot be deleted/i);
    });

    it("branching built-ins can be selected without throwing", async () => {
      for (const workflowId of ["builtin:coding", "builtin:marketing", "builtin:stepwise-coding"]) {
        const task = await store.createTask({ description: `select ${workflowId}`, enabledWorkflowSteps: [] });

        await expect(store.selectTaskWorkflow(task.id, workflowId)).resolves.toEqual([]);

        const detail = await store.getTask(task.id);
        expect(detail.enabledWorkflowSteps ?? []).toEqual([]);
        expect(store.getTaskWorkflowSelection(task.id)).toEqual({ workflowId, stepIds: [] });
      }
    });

    it("create-time branching built-in workflowId records selection without throwing", async () => {
      const task = await store.createTask({ description: "explicit builtin coding", workflowId: "builtin:coding" });

      const detail = await store.getTask(task.id);
      expect(detail.enabledWorkflowSteps ?? []).toEqual([]);
      expect(store.getTaskWorkflowSelection(task.id)).toEqual({ workflowId: "builtin:coding", stepIds: [] });
    });

    it("branching built-in project defaults do not throw", async () => {
      await expect(store.createTask({ description: "implicit builtin default" })).resolves.toMatchObject({
        description: "implicit builtin default",
      });

      // U6: builtin:coding now carries the `browser-verification` optional-group
      // (an interpreter-deferred construct), so its DEFAULT-workflow materialization
      // falls back to no legacy WorkflowStep rows and records no selection row —
      // identical to the stepwise built-in below. The group is defaultOn:false, so
      // enabledWorkflowSteps stays empty.
      await store.setDefaultWorkflowId("builtin:coding");
      const codingTask = await store.createTask({ description: "default builtin coding" });
      expect((await store.getTask(codingTask.id)).enabledWorkflowSteps ?? []).toEqual([]);
      expect(store.getTaskWorkflowSelection(codingTask.id)).toBeUndefined();

      const reservedCodingTask = await store.createTaskWithReservedId(
        { description: "reserved default builtin coding" },
        { taskId: "reserved-default-builtin-coding" },
      );
      expect((await store.getTask(reservedCodingTask.id)).enabledWorkflowSteps ?? []).toEqual([]);
      expect(store.getTaskWorkflowSelection(reservedCodingTask.id)).toBeUndefined();

      await store.setDefaultWorkflowId("builtin:stepwise-coding");
      const stepwiseTask = await store.createTask({ description: "default builtin stepwise" });
      expect((await store.getTask(stepwiseTask.id)).enabledWorkflowSteps ?? []).toEqual([]);
      expect(store.getTaskWorkflowSelection(stepwiseTask.id)).toBeUndefined();

      const reservedStepwiseTask = await store.createTaskWithReservedId(
        { description: "reserved default builtin stepwise" },
        { taskId: "reserved-default-builtin-stepwise" },
      );
      expect((await store.getTask(reservedStepwiseTask.id)).enabledWorkflowSteps ?? []).toEqual([]);
      expect(store.getTaskWorkflowSelection(reservedStepwiseTask.id)).toBeUndefined();
    });

    it("rejects selecting the PR lifecycle fragment for a task", async () => {
      const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
      await expect(store.selectTaskWorkflow(task.id, "builtin:pr-workflow")).rejects.toThrow(
        "is a fragment and cannot be selected for a task",
      );
    });
  });
});
