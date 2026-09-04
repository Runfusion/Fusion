import { describe, expect, it } from "vitest";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";
import { BUILTIN_WORKFLOWS } from "../workflows/builtin-workflows.js";
import { resolveWorkflowStepVerdictRequirement } from "../workflows/review-verdict-authority.js";
import {
  resolveAllOptionalGroupIds,
  resolveWorkflowOptionalSteps,
} from "../workflows/workflow-optional-steps.js";
import type {
  WorkflowIr,
  WorkflowIrNode,
  WorkflowOptionalGroupConfig,
} from "../workflows/workflow-ir-types.js";

type PromptConfig = Record<string, unknown> & {
  gateMode?: string;
  skillName?: string;
  summaryTarget?: string;
};

function requiredPreMergeGroups(ir: WorkflowIr): Array<WorkflowIrNode & { config: WorkflowOptionalGroupConfig }> {
  const requiredIds = resolveRequiredPreMergeStepIds(ir, resolveAllOptionalGroupIds(ir), undefined);
  if (ir.version !== "v2") return [];
  return ir.nodes.filter(
    (node): node is WorkflowIrNode & { config: WorkflowOptionalGroupConfig } =>
      node.kind === "optional-group" && requiredIds.has(node.id),
  );
}

function promptRequirement(config: PromptConfig, optionalGroupId?: string): boolean {
  return resolveWorkflowStepVerdictRequirement({
    gateMode: config.gateMode,
    skillName: config.skillName,
    summaryTarget: config.summaryTarget,
    optionalGroupId,
  });
}

describe("resolveWorkflowStepVerdictRequirement", () => {
  it("requires a verdict from an advisory skill inside an optional group", () => {
    expect(resolveWorkflowStepVerdictRequirement({
      gateMode: "advisory",
      skillName: "compound-engineering:ce-doc-review",
      optionalGroupId: "ce-doc-review",
    })).toBe(true);
  });

  it("keeps genuine skill work steps verdict-free", () => {
    expect(resolveWorkflowStepVerdictRequirement({
      gateMode: "advisory",
      skillName: "compound-engineering:ce-plan",
    })).toBe(false);
  });

  it("keeps task-summary projections verdict-free even inside optional groups", () => {
    expect(resolveWorkflowStepVerdictRequirement({
      gateMode: "advisory",
      optionalGroupId: "documentation-delivery",
      summaryTarget: "task",
    })).toBe(false);
  });

  it("requires verdicts from blocking gates and skill-less prompt steps", () => {
    expect(resolveWorkflowStepVerdictRequirement({ gateMode: "gate", skillName: "review" })).toBe(true);
    expect(resolveWorkflowStepVerdictRequirement({ gateMode: "advisory" })).toBe(true);
  });

  it("requires verdicts from every built-in prompt in a merge-consulted optional group", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      for (const group of requiredPreMergeGroups(workflow.ir)) {
        const promptNodes = group.config.template.nodes.filter(
          (node): node is WorkflowIrNode & { config: PromptConfig } => node.kind === "prompt",
        );
        for (const promptNode of promptNodes) {
          expect(
            promptRequirement(promptNode.config, group.id),
            `${workflow.id}/${group.id}/${promptNode.id}`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps the ce-doc-review reproduction and every eligible built-in group inside the guard", () => {
    const compound = BUILTIN_WORKFLOWS.find((workflow) => workflow.id === "builtin:compound-engineering");
    expect(compound).toBeDefined();
    expect(requiredPreMergeGroups(compound!.ir).map((group) => group.id)).toContain("ce-doc-review");

    for (const workflow of BUILTIN_WORKFLOWS) {
      const eligible = resolveWorkflowOptionalSteps(workflow.ir)
        .filter((step) => step.phase === "pre-merge" && !step.reportingOnly);
      if (eligible.length > 0) {
        expect(requiredPreMergeGroups(workflow.ir), workflow.id).not.toHaveLength(0);
      }
    }
  });

  it("excludes post-merge and reporting-only groups while preserving summary projection semantics", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      const guardedIds = requiredPreMergeGroups(workflow.ir).map((group) => group.id);
      expect(guardedIds, workflow.id).not.toContain("post-merge-verification");
      expect(guardedIds, workflow.id).not.toContain("documentation-delivery");
    }

    expect(resolveWorkflowStepVerdictRequirement({
      gateMode: "advisory",
      optionalGroupId: "documentation-delivery",
      summaryTarget: "task",
    })).toBe(false);
  });
});
