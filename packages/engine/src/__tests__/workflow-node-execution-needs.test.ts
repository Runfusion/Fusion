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
    ["explicit review checkout config", node({ config: { reviewCanFixInline: true } }), undefined],
    ["code-review-kind node", node({ config: { reviewKind: "code" } }), undefined],
    ["code review optional group", node(), "code-review"],
    ["browser verification optional group", node(), "browser-verification"],
  ])("requires a worktree for %s without an inline-fix option", (_name, workflowNode, optionalGroupId) => {
    expect(workflowNodeRequiresWorktree(workflowNode, { optionalGroupId })).toBe(true);
  });

  it.each([
    node({ id: "review", config: { name: "Code Review" } }),
    node({ id: "verify", config: { name: "Browser Verification" } }),
  ])("does not derive checkout requirements from display names", (workflowNode) => {
    expect(workflowNodeRequiresWorktree(workflowNode)).toBe(false);
  });

  it.each([
    ["canonical Plan Review node", node({ id: "plan-review-step", config: { reviewKind: "code" } }), undefined],
    ["Plan Review kind", node({ config: { reviewKind: "plan", reviewCanFixInline: true } }), undefined],
    ["Plan Review optional group", node({ config: { reviewKind: "code" } }), "plan-review"],
    ["deterministic verification", node({ config: { workflowAction: "deterministic-verification", reviewKind: "code" } }), undefined],
  ])("keeps %s excluded from checkout preparation", (_name, workflowNode, optionalGroupId) => {
    expect(workflowNodeRequiresWorktree(workflowNode, { optionalGroupId })).toBe(false);
  });
});
