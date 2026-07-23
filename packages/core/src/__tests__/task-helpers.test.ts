import { describe, expect, it } from "vitest";
import { getPrimaryPrInfo, taskHasManualOpenPullRequest } from "../tasks/task-helpers.js";
import type { PrInfo } from "../types.js";

function prInfo(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    url: "https://github.com/owner/repo/pull/1",
    number: 1,
    status: "open",
    title: "PR",
    headBranch: "fusion/fn-001",
    baseBranch: "main",
    commentCount: 0,
    ...overrides,
  };
}

describe("taskHasManualOpenPullRequest", () => {
  it("returns true for a legacy single open manual PR", () => {
    expect(taskHasManualOpenPullRequest({ prInfo: prInfo({ manual: true }) })).toBe(true);
  });

  it("returns true for a draft manual PR because it is still active", () => {
    expect(taskHasManualOpenPullRequest({ prInfo: prInfo({ manual: true, status: "draft" }) })).toBe(true);
  });

  it("returns false for closed or merged manual PRs", () => {
    expect(taskHasManualOpenPullRequest({ prInfo: prInfo({ manual: true, status: "closed" }) })).toBe(false);
    expect(taskHasManualOpenPullRequest({ prInfo: prInfo({ manual: true, status: "merged" }) })).toBe(false);
  });

  it("returns false for a non-manual open PR", () => {
    expect(taskHasManualOpenPullRequest({ prInfo: prInfo() })).toBe(false);
  });

  it("returns false when no PR data is present", () => {
    expect(taskHasManualOpenPullRequest({})).toBe(false);
  });

  it("returns true when any multi-PR entry is open and manual", () => {
    expect(taskHasManualOpenPullRequest({
      prInfos: [
        prInfo({ number: 1, status: "closed", manual: true }),
        prInfo({ number: 2, manual: false }),
        prInfo({ number: 3, manual: true }),
      ],
    })).toBe(true);
  });
});

describe("getPrimaryPrInfo", () => {
  it("returns prInfo when only legacy field is set", () => {
    const prInfo = { number: 1 } as any;
    expect(getPrimaryPrInfo({ prInfo })).toBe(prInfo);
  });

  it("returns first prInfos entry when only prInfos is set", () => {
    const first = { number: 2 } as any;
    const second = { number: 3 } as any;
    expect(getPrimaryPrInfo({ prInfos: [first, second] })).toBe(first);
  });

  it("prefers prInfos[0] when both fields are set", () => {
    const prInfo = { number: 1 } as any;
    const first = { number: 2 } as any;
    expect(getPrimaryPrInfo({ prInfo, prInfos: [first] })).toBe(first);
  });

  it("returns undefined when neither field is set", () => {
    expect(getPrimaryPrInfo({})).toBeUndefined();
  });
});

