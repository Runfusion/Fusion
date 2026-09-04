import type { Task, TaskStore } from "@fusion/core";
import { reassertRemediationAttempt, type ReviewRemediationClaim } from "./claim-review-remediation-attempt.js";

/**
 * FNXC:LifecycleContainment 2026-08-30-13:36:
 * FN-267 raised the supersession boundary from a per-call-site guard to a STORE FENCE.
 *
 * Guarding sites one at a time does not converge: `requestPreMergeOptionalStepFix` writes durable,
 * operator-facing state from more than a dozen branches (operator-hold refusal, empty-content close,
 * plan-review replan, both convergence rungs, budget refusals, the workspace review-state write, the
 * attempt counter), and each review round found the next unguarded one. A task-log entry cannot be
 * withdrawn by a later fenced refusal, so ANY missed branch permanently attributes an old review
 * round's outcome to a newer one.
 *
 * The fence inverts that: a claimed run gets a store whose durable writers re-assert ownership first
 * and throw {@link ClaimSupersededError} when the claim is gone. The caller converts that to a silent
 * "nothing scheduled", so a branch added later is fenced by construction rather than by review.
 * `reassertRemediationAttempt` runs against the RAW store, so the fence cannot recurse through it.
 */
export class ClaimSupersededError extends Error {
  constructor() {
    super("review remediation claim superseded");
    this.name = "ClaimSupersededError";
  }
}

/** Durable, task-visible writers. Reads stay unfenced: only writes can misattribute a round. */
const FENCED_WRITERS = new Set([
  "logEntry",
  "updateTask",
  "updateTaskAtomic",
  "moveTask",
  "addTaskComment",
  "appendRemediationSteps",
  "updateWorkspaceReviewState",
]);

export function fenceStoreForClaim(store: TaskStore, taskId: string, claim: ReviewRemediationClaim): TaskStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof property !== "string" || !FENCED_WRITERS.has(property)) return method.bind(target);
      return async (...args: unknown[]) => {
        const held = await reassertRemediationAttempt(target, taskId, claim);
        if (!held.applied) throw new ClaimSupersededError();
        return method.apply(target, args);
      };
    },
  }) as TaskStore & { readonly __fencedFor?: Task };
}
