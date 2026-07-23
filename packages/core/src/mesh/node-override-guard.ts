export type NodeOverrideBlockReason = "task-in-progress" | "terminal-without-merge-proof";

export interface NodeOverrideValidationResult {
  allowed: boolean;
  reason?: NodeOverrideBlockReason;
  message?: string;
  /**
   * FNXC:StateMachine 2026-07-07-12:00:
   * True when `newNodeId` resolves to the task workflow's terminal `end` node,
   * the task is not already `done`, AND durable merge proof already exists
   * (`mergeDetails.mergeConfirmed === true`). Callers MUST route this case
   * through a finalize-to-done move (e.g. `store.moveTask(id, 'done', {
   * recoveryRehome: true, preserveProgress: true })`) instead of writing
   * `nodeId` as a bare field — a bare field write is exactly the Signature-2
   * silent no-op this flag exists to prevent (FN-7641 / NEXT-322 / NEXT-375 /
   * NEXT-340: a human/agent merges the branch tip directly into `main`, then
   * `nodeId='end'` is set and the card silently stays in `in-review` forever).
   */
  requiresFinalize?: boolean;
}

export interface NodeOverrideTaskInput {
  column: string;
  nodeId?: string;
  id: string;
  mergeDetails?: { mergeConfirmed?: boolean } | null;
}

export interface NodeOverrideValidationOptions {
  /**
   * Resolve whether `nodeId` is the task workflow's terminal `end` node.
   * Callers with access to the task's resolved workflow IR (e.g.
   * `TaskStore`) should pass a real resolver keyed off `node.kind === "end"`.
   * Callers without cheap IR access (dashboard route, CLI tool) may omit this
   * — the default fallback below still catches the literal `nodeId === "end"`
   * id used by every built-in workflow's terminal node, which covers the
   * exact reported symptom and the common case.
   */
  isTerminalNodeId?: (nodeId: string) => boolean;
}

const defaultIsTerminalNodeId = (nodeId: string): boolean => nodeId === "end";

export function validateNodeOverrideChange(
  task: NodeOverrideTaskInput,
  newNodeId: string | null | undefined,
  options?: NodeOverrideValidationOptions,
): NodeOverrideValidationResult {
  if (newNodeId === undefined) {
    return { allowed: true };
  }

  if (task.column === "in-progress") {
    return {
      allowed: false,
      reason: "task-in-progress",
      message: `Cannot change node override for ${task.id} while it is in progress. The task is currently executing and routing cannot be changed mid-flight. Wait for the task to complete, or pause/stop it first before changing the node assignment.`,
    };
  }

  /*
  FNXC:StateMachine 2026-07-07-12:00:
  Signature 2 (FN-7641 / NEXT-322 / NEXT-375 / NEXT-340): setting nodeId='end' after work
  merged out-of-band (bypassing the merge node) must never silently no-op. Before this fix
  the field was written verbatim and the card stayed wherever it was (e.g. in-review with
  all steps done) with no error and no advancement. Resolve the intent explicitly instead:
  a terminal `end` override with durable merge proof finalizes the card (requiresFinalize);
  a terminal `end` override with NO merge proof is rejected with an actionable error so the
  caller knows to confirm the merge first. Non-terminal nodeId overrides and clearing the
  override (newNodeId === null) are untouched — this only gates the terminal-node case.
  */
  const isTerminal =
    newNodeId !== null &&
    (options?.isTerminalNodeId ? options.isTerminalNodeId(newNodeId) : defaultIsTerminalNodeId(newNodeId));
  if (isTerminal && task.column !== "done") {
    const mergeConfirmed = task.mergeDetails?.mergeConfirmed === true;
    if (mergeConfirmed) {
      return { allowed: true, requiresFinalize: true };
    }
    return {
      allowed: false,
      reason: "terminal-without-merge-proof",
      message:
        `Cannot set node override to '${newNodeId}' for ${task.id}: setting nodeId='end' does not finalize a card by itself. ` +
        `This task has no durable merge proof (mergeDetails.mergeConfirmed is not true), so the workflow finalize path was not applied and the card was left unchanged rather than silently no-op. ` +
        `If the work already merged out-of-band, confirm the merge (record mergeDetails.mergeConfirmed=true via the merge-confirm/reconcile path) and retry, or move the task to done through the normal review/merge flow instead of overriding nodeId directly.`,
    };
  }

  return { allowed: true };
}
