import { describe, expect, it } from "vitest";
import type { WorkflowIrNode } from "@fusion/core";
import { workflowNodeRequiresWorktree } from "../workflows/workflow-node-execution-needs.js";

function node(overrides: Partial<WorkflowIrNode> = {}): WorkflowIrNode {
  return { id: "node", kind: "prompt", ...overrides };
}

describe("workflowNodeRequiresWorktree", () => {
  it.each([
    ["coding tool mode", node({ config: { toolMode: "coding" } })],
    ["script node", node({ kind: "script" })],
    ["named script", node({ config: { scriptName: "validate" } })],
    ["CLI command", node({ config: { executor: "cli", cliCommand: "pnpm lint" } })],
    ["CLI agent", node({ config: { executor: "cli-agent" } })],
  ])("requires a worktree for %s", (_name, workflowNode) => {
    expect(workflowNodeRequiresWorktree(workflowNode)).toBe(true);
  });

  it.each([
    ["explicit inline fix config", node({ config: { reviewCanFixInline: true } }), undefined],
    ["structured code review", node({ id: "review", config: { reviewKind: "code" } }), undefined],
    ["structured browser verification", node({ id: "verify", config: { reviewKind: "code" } }), "browser-verification"],
    ["code review optional group", node(), "code-review"],
    ["browser verification optional group", node(), "browser-verification"],
  ])("requires a worktree for inline fixes from %s", (_name, workflowNode, optionalGroupId) => {
    expect(workflowNodeRequiresWorktree(workflowNode, { optionalGroupId })).toBe(true);
  });

  it("keeps inline-fix reviews read-only when disabled", () => {
    expect(workflowNodeRequiresWorktree(node({ config: { reviewKind: "code" } }), { reviewerInlineFixes: false })).toBe(false);
    expect(workflowNodeRequiresWorktree(node(), {
      optionalGroupId: "code-review",
      reviewerInlineFixes: false,
    })).toBe(false);
  });

  it.each([
    node({ id: "plan-review-step", config: { name: "Code Review" } }),
    node({ config: { name: "Plan Review" } }),
    node(),
  ])("keeps Plan Review read-only", (workflowNode) => {
    expect(workflowNodeRequiresWorktree(workflowNode, {
      optionalGroupId: workflowNode.id === "node" ? "plan-review" : undefined,
    })).toBe(false);
  });
});
