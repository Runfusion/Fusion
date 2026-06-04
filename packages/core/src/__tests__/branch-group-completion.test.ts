import { describe, expect, it } from "vitest";

import { isBranchGroupComplete, isBranchGroupMemberLanded } from "../branch-group-completion.js";
import type { BranchGroup, Task } from "../types.js";

/**
 * ## Surface Enumeration
 * Surfaces over which this regression spec proves the completion invariant
 * (a group is complete iff every member landed onto the group branch via
 * branch-group integration):
 * - Providers / execution paths: the shared `isBranchGroupMemberLanded` and
 *   `isBranchGroupComplete` helpers — the single source of truth consumed by the
 *   branch-group completion gate, the engine merge/promote path, and the
 *   dashboard/CLI rollup surfaces that decide when the managed PR may promote.
 * - Data states: confirmed-vs-unconfirmed merge, matching vs non-matching
 *   `mergeTargetBranch`, wrong `mergeTargetSource`, missing `mergeDetails`, the
 *   all-landed group, a partially-landed group, and the empty membership.
 * - Shared modules/helpers reusing the logic: any caller routing membership
 *   through these two helpers inherits the same invariant rather than
 *   re-deriving "landed" semantics.
 * - Breakpoints/platforms: N/A — pure core logic with no UI surface.
 */

const GROUP_BRANCH = "fusion/groups/planning-x";

const group = { branchName: GROUP_BRANCH } as Pick<BranchGroup, "branchName">;

function landedMember(): Pick<Task, "mergeDetails"> {
  return {
    mergeDetails: {
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: GROUP_BRANCH,
    },
  };
}

describe("isBranchGroupMemberLanded", () => {
  it("returns true when merge is confirmed onto the group branch via integration", () => {
    expect(isBranchGroupMemberLanded(landedMember(), group)).toBe(true);
  });

  it("returns false when mergeTargetBranch does not match the group branch", () => {
    expect(
      isBranchGroupMemberLanded(
        {
          mergeDetails: {
            mergeConfirmed: true,
            mergeTargetSource: "branch-group-integration",
            mergeTargetBranch: "fusion/fn-sibling",
          },
        },
        group,
      ),
    ).toBe(false);
  });

  it("returns false when the merge is not confirmed", () => {
    expect(
      isBranchGroupMemberLanded(
        {
          mergeDetails: {
            mergeConfirmed: false,
            mergeTargetSource: "branch-group-integration",
            mergeTargetBranch: GROUP_BRANCH,
          },
        },
        group,
      ),
    ).toBe(false);
  });

  it("returns false when the merge target source is not branch-group-integration", () => {
    expect(
      isBranchGroupMemberLanded(
        {
          mergeDetails: {
            mergeConfirmed: true,
            mergeTargetSource: "project-default",
            mergeTargetBranch: GROUP_BRANCH,
          },
        },
        group,
      ),
    ).toBe(false);
  });

  it("returns false when there are no merge details", () => {
    expect(isBranchGroupMemberLanded({}, group)).toBe(false);
  });
});

describe("isBranchGroupComplete", () => {
  it("returns true when every member is landed", () => {
    expect(isBranchGroupComplete([landedMember(), landedMember()], group)).toBe(true);
  });

  it("returns false when one member is not landed", () => {
    expect(isBranchGroupComplete([landedMember(), {}], group)).toBe(false);
  });

  it("returns false for an empty membership", () => {
    expect(isBranchGroupComplete([], group)).toBe(false);
  });
});
