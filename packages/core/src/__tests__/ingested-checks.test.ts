import { describe, expect, it } from "vitest";
import { mergeIngestedCheckStates } from "../config/ingested-checks.js";

const required = ["ci/build"];
const green = {
  repo: "owner/repo",
  headSha: "abc",
  checkName: "ci/build",
  state: "success",
  reportedAt: "2026-01-01T00:00:00.000Z",
};

function merge(overrides: Partial<Parameters<typeof mergeIngestedCheckStates>[0]> = {}) {
  return mergeIngestedCheckStates({
    polled: [],
    ingested: [green],
    requiredCheckNames: required,
    repo: "owner/repo",
    headSha: "abc",
    ...overrides,
  });
}

describe("mergeIngestedCheckStates", () => {
  it("preserves the polled list when required checks are disabled", () => {
    const polled = [{ name: "ci/build", required: true, state: "pending" }];
    const result = merge({ polled, requiredCheckNames: [] });
    expect(result.checks).toBe(polled);
    expect(result.appliedNames).toEqual(new Set());
  });

  it("fills an absent required check only for the exact repository commit", () => {
    const result = merge({ repo: "OWNER/REPO", headSha: "ABC" });
    expect(result.checks).toMatchObject([{ name: "ci/build", state: "success", required: true }]);
    expect(result.appliedNames).toEqual(new Set(["ci/build"]));
  });

  it("fails closed for missing, foreign, or non-required ingested state", () => {
    expect(merge({ headSha: undefined }).checks).toEqual([]);
    expect(merge({ headSha: "other" }).checks).toEqual([]);
    expect(merge({ repo: "other/repo" }).checks).toEqual([]);
    expect(merge({ ingested: [{ ...green, checkName: "optional" }] }).checks).toEqual([]);
  });

  it("lets an ingested terminal result replace a polled pending result", () => {
    const result = merge({ polled: [{ name: "ci/build", required: true, state: "pending" }] });
    expect(result.checks[0]).toMatchObject({ state: "success", required: true });
  });

  it("retains blocking state whenever polling and ingestion disagree", () => {
    expect(merge({
      polled: [{ name: "ci/build", required: true, state: "success" }],
      ingested: [{ ...green, state: "failure" }],
    }).checks[0]?.state).toBe("failure");
    expect(merge({
      polled: [{ name: "ci/build", required: true, state: "failure" }],
    }).checks[0]?.state).toBe("failure");
  });

  it("treats unknown ingested states as blocking instead of a success", () => {
    expect(merge({ ingested: [{ ...green, state: "unrecognized" }] }).checks[0]).toMatchObject({
      state: "unrecognized",
      required: true,
    });
  });
});
