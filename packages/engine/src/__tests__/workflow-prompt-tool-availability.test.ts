/*
FNXC:PromptToolAvailability 2026-08-26-07:52:
NO NODE MAY BE INSTRUCTED TO CALL A TOOL ITS OWN TOOL POLICY DENIES.

This has now cost two separate defects, both invisible for days because the instruction READ
correctly and the session simply could not obey it:

  - the V2 Code Review prompt told a readonly reviewer to run lint/tests/build. Measured 19s and 23s
    "reviews" that silently read the diff alone. The danger is not the missing check, it is the
    fluent claim that the check passed.
  - the Documentation milestone was told to call fn_task_done, fn_task_document_write,
    fn_artifact_register and to create follow-up tasks. It could call NONE of them, produced a
    well-formed report every run, and persisted nothing — while having replaced the node that did.

Prose review cannot catch this: the prompt and the policy live in different files and are both
individually correct. Only a structural comparison catches it, so this guard compares them.

Scope: an INSTRUCTION to call, written `fn_tool(`. A bare mention in backticks is how a prompt tells
an agent what it may NOT do ("`bash` is denied"), which must stay legal.
*/
import { describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOWS } from "@fusion/core";

import { READONLY_ALLOWLIST } from "../workflows/workflow-step-tool-policy.js";

/** Plan Review opts into the narrow PROMPT.md writer through an explicit per-tool predicate. */
const PLAN_REVIEW_EXTRA_TOOLS = new Set(["fn_task_prompt_write"]);

const READONLY_ALLOWED = new Set<string>(READONLY_ALLOWLIST);

interface PromptNode {
  workflowId: string;
  nodeId: string;
  toolMode: string;
  prompt: string;
  optionalGroupId?: string;
}

function collectPromptNodes(): PromptNode[] {
  const collected: PromptNode[] = [];
  for (const workflow of BUILTIN_WORKFLOWS) {
    if (workflow.kind === "fragment") continue;
    for (const node of workflow.ir.nodes) {
      const config = (node.config ?? {}) as Record<string, unknown>;
      if (typeof config.prompt === "string" && config.prompt.trim()) {
        collected.push({
          workflowId: workflow.id,
          nodeId: node.id,
          toolMode: typeof config.toolMode === "string" ? config.toolMode : "coding",
          prompt: config.prompt,
        });
      }
      const template = config.template as { nodes?: Array<{ id: string; config?: Record<string, unknown> }> } | undefined;
      for (const child of template?.nodes ?? []) {
        const childConfig = (child.config ?? {}) as Record<string, unknown>;
        if (typeof childConfig.prompt !== "string" || !childConfig.prompt.trim()) continue;
        collected.push({
          workflowId: workflow.id,
          nodeId: child.id,
          toolMode: typeof childConfig.toolMode === "string" ? childConfig.toolMode : "coding",
          prompt: childConfig.prompt,
          optionalGroupId: node.id,
        });
      }
    }
  }
  return collected;
}

/** Tool names the prompt tells the agent to CALL, not ones it merely names. */
function instructedTools(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\b(fn_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]))];
}

describe("built-in workflow prompts only instruct tools their node can use", () => {
  it("finds prompt nodes to check", () => {
    const nodes = collectPromptNodes();
    expect(nodes.length).toBeGreaterThan(0);
    // The two nodes whose defects motivated this guard must be in scope.
    expect(nodes.some((node) => node.nodeId === "documentation-delivery-step")).toBe(true);
    expect(nodes.some((node) => node.nodeId === "code-review-step")).toBe(true);
  });

  it("never instructs a readonly node to call a tool it is denied", () => {
    const violations: string[] = [];
    for (const node of collectPromptNodes()) {
      if (node.toolMode !== "readonly") continue;
      const allowed = new Set(READONLY_ALLOWED);
      if (node.optionalGroupId === "plan-review" || node.nodeId === "plan-review-step") {
        for (const tool of PLAN_REVIEW_EXTRA_TOOLS) allowed.add(tool);
      }
      for (const tool of instructedTools(node.prompt)) {
        if (!allowed.has(tool)) {
          violations.push(`${node.workflowId} / ${node.nodeId} instructs ${tool}() but runs toolMode:"readonly"`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  /*
  The guard must actually fire — a scanner that cannot fail is decoration. This reproduces the exact
  Documentation defect and proves the rule rejects it.
  */
  it("rejects the instruction shape that produced the Documentation defect", () => {
    const offending = 'Write the card summary with fn_task_done(summary=...) and save it with fn_task_document_write(key="docs", ...).';
    expect(instructedTools(offending)).toEqual(["fn_task_done", "fn_task_document_write"]);
    expect(instructedTools(offending).every((tool) => READONLY_ALLOWED.has(tool))).toBe(false);
  });

  /* Naming a denied tool to FORBID it is how a prompt states its own limits, and stays legal. */
  it("allows a prompt to name a tool it is telling the agent not to use", () => {
    expect(instructedTools("`bash` is denied and `fn_run_verification` is not available to you."))
      .toEqual([]);
  });
});
