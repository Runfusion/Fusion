import type { WorkflowIrNode } from "@fusion/core";

export interface WorkflowNodeExecutionNeedsOptions {
  optionalGroupId?: string;
  /** Inline review fixes are enabled unless settings explicitly disable them. */
  reviewerInlineFixes?: boolean;
}

/**
 * FNXC:WorkflowExecution 2026-07-15-00:00:
 * Issue #2075 exposed divergent worktree classifiers: graph preparation treated
 * inline-fix reviews as read-only while runtime rejected them without a worktree.
 * This pure helper is the single source of truth for write-capable workflow nodes;
 * preparation and runtime must both use it before selecting an execution target.
 */
export function workflowNodeRequiresWorktree(
  node: WorkflowIrNode,
  { optionalGroupId, reviewerInlineFixes }: WorkflowNodeExecutionNeedsOptions = {},
): boolean {
  const cfg = node.config ?? {};
  const executorKind = typeof cfg.executor === "string" ? cfg.executor : "model";
  const scriptName = typeof cfg.scriptName === "string" && cfg.scriptName.trim()
    ? cfg.scriptName
    : undefined;
  const rawCliCommand = executorKind === "cli" && typeof cfg.cliCommand === "string" && cfg.cliCommand.trim()
    ? cfg.cliCommand
    : undefined;
  const nodeName = typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : node.id;
  const isPlanReview = node.id === "plan-review-step" || nodeName === "Plan Review" || optionalGroupId === "plan-review";
  const isInlineFixReview = reviewerInlineFixes !== false
    && executorKind !== "cli"
    && !isPlanReview
    && (
      cfg.reviewCanFixInline === true
      || /(?:^|\b)(?:review|verification)(?:\b|$)/i.test(nodeName)
      || optionalGroupId === "code-review"
      || optionalGroupId === "browser-verification"
    );

  return cfg.toolMode === "coding"
    || node.kind === "script"
    || executorKind === "cli-agent"
    || Boolean(scriptName)
    || Boolean(rawCliCommand)
    || isInlineFixReview;
}
