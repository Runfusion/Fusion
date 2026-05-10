import { describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", () => ({
  REPO_OVERRIDE_RE: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
}));

import { REPO_OVERRIDE_RE } from "@fusion/core";
import { resolveEffectiveGithubRepoDefault } from "../githubTracking";

describe("githubTracking helper", () => {
  it("accepts valid owner/repo values and rejects malformed values", () => {
    expect(REPO_OVERRIDE_RE.test("owner/repo")).toBe(true);
    expect(REPO_OVERRIDE_RE.test("org.name/repo_name-1")).toBe(true);

    expect(REPO_OVERRIDE_RE.test("owner")).toBe(false);
    expect(REPO_OVERRIDE_RE.test("owner/repo/extra")).toBe(false);
    expect(REPO_OVERRIDE_RE.test("owner repo/repo")).toBe(false);
    expect(REPO_OVERRIDE_RE.test(" owner/repo ")).toBe(false);
  });

  it("prefers project repo, then global repo, then empty string", () => {
    expect(
      resolveEffectiveGithubRepoDefault(
        { githubTrackingDefaultRepo: "project/repo" },
        { githubTrackingDefaultRepo: "global/repo" },
      ),
    ).toBe("project/repo");

    expect(
      resolveEffectiveGithubRepoDefault(
        { githubTrackingDefaultRepo: "  " },
        { githubTrackingDefaultRepo: "global/repo" },
      ),
    ).toBe("global/repo");

    expect(resolveEffectiveGithubRepoDefault({}, {})).toBe("");
  });
});
