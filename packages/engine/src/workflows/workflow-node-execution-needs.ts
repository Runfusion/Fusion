import type { WorkflowIrNode } from "@fusion/core";

export interface WorkflowNodeExecutionNeedsOptions {
  optionalGroupId?: string;
}

/**
 * FNXC:WorkflowExecution 2026-09-03-05:40:
 * A Code Review is read-only by default but still needs the task checkout: modified-file capture,
 * diff-base resolution, and content-review proof all consume its worktree path. Making checkout
 * preparation depend on inline-fix permission left the execution target stale and fell back to the
 * shared repository root, so reviewers inspected the wrong tree or failed closed on unprovable input.
 * This helper classifies checkout need independently from the session's write-tool policy; preparation
 * and runtime must both use it before selecting an execution target.
 */
export function workflowNodeRequiresWorktree(
  node: WorkflowIrNode,
  { optionalGroupId }: WorkflowNodeExecutionNeedsOptions = {},
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
  const isCheckoutReview = executorKind !== "cli"
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
    || isCheckoutReview;
}
