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
  /*
  FNXC:WorkflowNodeNeeds 2026-08-25-02:10:
  Classify by STRUCTURE, never by display name. The old test matched
  `/(?:^|\b)(?:review|verification)(?:\b|$)/i` against `config.name`, which made behaviour hostage to
  a label: a DETERMINISTIC verification gate — exit codes only, no mutation path whatsoever — was
  classified write-capable purely because it is called "Verification", and the review seal then
  refused it on every post-approval replay. It also silently blocked renaming a gate, since
  "Final Review" and "Code Review" would classify differently for no structural reason.
  `reviewKind`, `workflowAction` and the optional-group id are the real signals and are already
  carried by every built-in node; a hand-authored node opts in explicitly with `reviewCanFixInline`.
  */
  const isPlanReview = node.id === "plan-review-step"
    || optionalGroupId === "plan-review"
    || cfg.reviewKind === "plan";
  const isDeterministicGate = cfg.workflowAction === "deterministic-verification";
  const isInlineFixReview = reviewerInlineFixes !== false
    && executorKind !== "cli"
    && !isPlanReview
    && !isDeterministicGate
    && (
      cfg.reviewCanFixInline === true
      || cfg.reviewKind === "code"
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
