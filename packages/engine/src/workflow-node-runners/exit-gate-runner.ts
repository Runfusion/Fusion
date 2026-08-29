import type { WorkflowLoopExitCondition } from "@fusion/core";

import type { WorkflowNodeHandler, WorkflowNodeResult } from "../workflows/workflow-graph-executor.js";
import type { WorkflowNodeRunner, WorkflowNodeRunnerContext } from "../workflows/workflow-node-runner.js";

/*
FNXC:WorkflowExitGate 2026-07-05-00:00:
FN-7579's `exit-gate` node lets a workflow terminate early instead of always
walking to the terminal `end` node the long way (e.g. breaking out of a
brainstorming ask-user/refine loop once the user approves). It is validated
(workflow-ir.ts) to always have a path to `end`, but it is NOT itself an `end`
node — it only routes there.

Contract: `config.condition` is optional and reuses the same shape as a `loop`
node's `exitWhen` (`WorkflowLoopExitCondition`: `output-contains` /
`output-matches`), read against `context[\`input:${condition.nodeId}\`]` — the
same context key an `ask-user` node's answer is published under — so an
exit-gate can gate directly on what the user said. Absent `condition`, the gate
is unconditional and always exits. The runner never throws on a malformed
condition; it degrades to "does not match" so a bad author config can't crash
the walk, it just falls through instead of exiting early.

Routing: the runner returns `outcome: "success"` with `value: "exit"` (match /
unconditional) or `value: "continue"` (no match). Workflow edges select on
`outcome:exit` / `outcome:continue` (or a single unconditional edge, which
matches any `success` outcome) exactly like the existing gate/step-review
outcome-edge convention.
*/
export interface WorkflowExitGateConfig {
  condition?: WorkflowLoopExitCondition;
}

function resolveConditionText(
  condition: WorkflowLoopExitCondition,
  context: Record<string, unknown>,
): string {
  const key = typeof condition.nodeId === "string" && condition.nodeId ? `input:${condition.nodeId}` : undefined;
  const raw = key ? context[key] : undefined;
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw : String(raw);
}

function matchesExitCondition(
  condition: WorkflowLoopExitCondition,
  context: Record<string, unknown>,
): boolean {
  const text = resolveConditionText(condition, context);
  if (condition.type === "output-contains") {
    return typeof condition.value === "string" && text.includes(condition.value);
  }
  if (condition.type === "output-matches") {
    try {
      return new RegExp(condition.pattern, condition.flags).test(text);
    } catch {
      // Malformed author-supplied regex: degrade to no-match rather than throw.
      return false;
    }
  }
  return false;
}

export class ExitGateNodeRunner implements WorkflowNodeRunner {
  public readonly kind = "exit-gate" as const;

  public async run(
    node: Parameters<WorkflowNodeHandler>[0],
    context: WorkflowNodeRunnerContext,
  ): Promise<WorkflowNodeResult> {
    const cfg = (node.config ?? {}) as WorkflowExitGateConfig;
    if (!cfg.condition) {
      return { outcome: "success", value: "exit" };
    }
    const matched = matchesExitCondition(cfg.condition, context.context);
    return { outcome: "success", value: matched ? "exit" : "continue" };
  }
}

export function createExitGateHandler(): WorkflowNodeHandler {
  const runner = new ExitGateNodeRunner();
  return (node, context) => runner.run(node, context);
}
