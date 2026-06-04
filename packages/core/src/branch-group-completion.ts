import type { BranchGroup, Task } from "./types.js";

/**
 * Canonical "member landed" predicate, shared by the dashboard branch-groups
 * route and the engine group-merge coordinator so the two gates can never
 * diverge (the historical divergence: the route required `mergeConfirmed` +
 * matching `mergeTargetBranch`, while the coordinator accepted bare
 * `column === "done"` or `in-review` + integration source and never checked
 * the target branch).
 *
 * The stricter route semantics win: a member is landed iff it was actually
 * merge-confirmed onto THIS group's branch via the branch-group-integration
 * path. This is load-bearing for merge-target safety — a member marked done
 * against a sibling `fusion/fn-*` branch or a mismatched branch MUST NOT count
 * as landed (root cause of the 2026-05-23 lost-work incident).
 */
export function isBranchGroupMemberLanded(
  task: Pick<Task, "mergeDetails">,
  group: Pick<BranchGroup, "branchName">,
): boolean {
  return task.mergeDetails?.mergeConfirmed === true
    && task.mergeDetails?.mergeTargetSource === "branch-group-integration"
    && task.mergeDetails?.mergeTargetBranch === group.branchName;
}

/**
 * Canonical "group complete" predicate. A group is complete iff it has at
 * least one member and every member is landed by {@link isBranchGroupMemberLanded}.
 */
export function isBranchGroupComplete(
  members: Pick<Task, "mergeDetails">[],
  group: Pick<BranchGroup, "branchName">,
): boolean {
  return members.length > 0 && members.every((member) => isBranchGroupMemberLanded(member, group));
}
