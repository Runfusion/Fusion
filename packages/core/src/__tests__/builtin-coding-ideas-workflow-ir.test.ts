import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_IDEAS_WORKFLOW_IR,
  parseWorkflowIr,
  serializeWorkflowIr,
  getBuiltinWorkflow,
  resolveEntryColumnId,
} from "../index.js";
import { resolveColumnFlags } from "../trait-registry.js";
import type { WorkflowIrV2 } from "../workflow-ir-types.js";

describe("builtin coding-ideas workflow ir", () => {
  it("parses and round-trips", () => {
    const parsed = parseWorkflowIr(BUILTIN_CODING_IDEAS_WORKFLOW_IR);
    const reparsed = parseWorkflowIr(serializeWorkflowIr(parsed));
    expect(reparsed).toEqual(parsed);
    expect(parsed.version).toBe("v2");
  });

  it("is registered in the builtin catalog as a selectable workflow", () => {
    const workflow = getBuiltinWorkflow("builtin:coding-ideas");
    expect(workflow).toBeDefined();
    expect(workflow!.id).toBe("builtin:coding-ideas");
    expect(workflow!.name).toBe("Coding (Ideas)");
    expect(workflow!.kind).toBe("workflow");
    expect(workflow!.ir).toBe(BUILTIN_CODING_IDEAS_WORKFLOW_IR);
  });

  it("declares the five-stage Ideas → Todo → In-progress → In-review → Done board shape plus archived", () => {
    const ir = BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2;
    expect(ir.columns.map((c) => c.id)).toEqual([
      "ideas",
      "todo",
      "in-progress",
      "in-review",
      "done",
      "archived",
    ]);
  });

  it("makes the ideas column the manual (autoTriage:false) intake", () => {
    const ir = BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2;
    const ideas = ir.columns.find((c) => c.id === "ideas")!;
    expect(resolveColumnFlags(ideas).intake).toBe(true);
    const intakeTrait = ideas.traits.find((t) => t.trait === "intake")!;
    expect(intakeTrait.config).toEqual({ autoTriage: false });
    // The entry column resolves to ideas (the intake column).
    expect(resolveEntryColumnId(ir)).toBe("ideas");
  });

  it("merges the planner and capacity-hold stages into the todo column", () => {
    const ir = BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2;
    const todo = ir.columns.find((c) => c.id === "todo")!;
    const flags = resolveColumnFlags(todo);
    expect(flags.hold).toBe(true);
    expect(flags.resetOnEntry).toBe(true);
  });

  it("keeps the in-progress / in-review / done column traits from the default pipeline", () => {
    const ir = BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2;
    expect(resolveColumnFlags(ir.columns.find((c) => c.id === "in-progress")!)).toMatchObject({
      countsTowardWip: true,
      abortOnExit: true,
      timing: true,
    });
    expect(resolveColumnFlags(ir.columns.find((c) => c.id === "in-review")!)).toMatchObject({
      mergeBlocker: true,
      humanReview: true,
      stallDetection: true,
      mergeOrchestration: true,
    });
    expect(resolveColumnFlags(ir.columns.find((c) => c.id === "done")!).complete).toBe(true);
  });

  it("places the start node in ideas and the planning nodes in the merged todo column", () => {
    const ir = BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2;
    const nodeColumn = (id: string) => ir.nodes.find((n) => n.id === id)?.column;
    expect(nodeColumn("start")).toBe("ideas");
    expect(nodeColumn("plan")).toBe("todo");
    expect(nodeColumn("plan-review")).toBe("todo");
    expect(nodeColumn("plan-replan")).toBe("todo");
  });

  it("retains the default-on optional plan/code review groups from the default coding graph", () => {
    const workflow = getBuiltinWorkflow("builtin:coding-ideas")!;
    const byId = new Map(workflow.ir.nodes.map((n) => [n.id, n]));
    const planReview = byId.get("plan-review");
    expect(planReview?.kind).toBe("optional-group");
    expect(planReview?.config?.defaultOn).toBe(true);
    const codeReview = byId.get("code-review");
    expect(codeReview?.kind).toBe("optional-group");
    expect(codeReview?.config?.defaultOn).toBe(true);
  });

  it("keeps each activity in the column named for that activity", () => {
    const ir = BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2;
    const nodeColumn = (id: string) => ir.nodes.find((node) => node.id === id)?.column;
    expect(nodeColumn("plan")).toBe("todo");
    expect(nodeColumn("plan-review")).toBe("todo");
    expect(nodeColumn("parse")).toBe("in-progress");
    expect(nodeColumn("steps")).toBe("in-progress");
    expect(nodeColumn("code-review")).toBe("in-review");
    expect(nodeColumn("code-review-remediation")).toBe("in-progress");
    expect(nodeColumn("completion-summary")).toBe("in-review");
    for (const node of ir.nodes.filter((candidate) => candidate.id.startsWith("merge-"))) {
      expect(node.column, `${node.id} should remain in review`).toBe("in-review");
    }
    expect(ir.nodes.some((node) => node.id === "browser-verification")).toBe(false);
    expect(ir.nodes.some((node) => node.id === "browser-verification-remediation")).toBe(false);
    expect(ir.nodes.some((node) => node.id === "post-merge-verification")).toBe(false);
  });

  it("never leaves a node in a column the workflow does not declare", () => {
    const ir = BUILTIN_CODING_IDEAS_WORKFLOW_IR as WorkflowIrV2;
    const declared = new Set(ir.columns.map((c) => c.id));
    for (const node of ir.nodes) {
      expect(declared.has(node.column!), `node ${node.id} in undeclared column ${node.column}`).toBe(true);
    }
  });
});
