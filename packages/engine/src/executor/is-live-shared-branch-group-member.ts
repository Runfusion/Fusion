/**
 * FNXC:CodeOrganization 2026-08-03-14:05:
 * isLiveSharedBranchGroupMember peeled from TaskExecutor (U4).
 *
 * FNXC:PostgresCutover 2026-07-10:
 * getBranchGroup is async on the PG branch.
 *
 * FNXC:CodeOrganization 2026-08-03-19:55:
 * FN-8769 (main): pass projectDefaultBranch from resolveIntegrationBranch so
 * default-branch mission group members do not retain the shared-member auto-merge exemption.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import { isLiveSharedBranchGroupMemberIntegration } from "@fusion/core";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";

export type IsLiveSharedBranchGroupMemberDeps = {
  store: TaskStore;
  rootDir: string;
};

export async function isLiveSharedBranchGroupMember(
  deps: IsLiveSharedBranchGroupMemberDeps,
  live: Pick<TaskDetail, "branchContext" | "autoMerge" | "autoMergeProvenance">,
): Promise<boolean> {
  const groupId = live.branchContext?.groupId?.trim();
  // FNXC:PostgresCutover 2026-07-10: getBranchGroup is async on the PG branch.
  const branchGroup = groupId ? await deps.store.getBranchGroup(groupId) : null;
  const settings = await deps.store.getSettings();
  const projectDefaultBranch = await resolveIntegrationBranch(deps.rootDir, settings);
  return isLiveSharedBranchGroupMemberIntegration(live, branchGroup, projectDefaultBranch);
}
