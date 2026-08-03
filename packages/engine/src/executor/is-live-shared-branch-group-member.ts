/**
 * FNXC:CodeOrganization 2026-08-03-14:05:
 * isLiveSharedBranchGroupMember peeled from TaskExecutor (U4).
 *
 * FNXC:PostgresCutover 2026-07-10:
 * getBranchGroup is async on the PG branch.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import { isLiveSharedBranchGroupMemberIntegration } from "@fusion/core";

export type IsLiveSharedBranchGroupMemberDeps = {
  store: TaskStore;
};

export async function isLiveSharedBranchGroupMember(
  deps: IsLiveSharedBranchGroupMemberDeps,
  live: Pick<TaskDetail, "branchContext">,
): Promise<boolean> {
  const groupId = live.branchContext?.groupId?.trim();
  // FNXC:PostgresCutover 2026-07-10: getBranchGroup is async on the PG branch.
  const branchGroup = groupId ? await deps.store.getBranchGroup(groupId) : null;
  return isLiveSharedBranchGroupMemberIntegration(live, branchGroup);
}
