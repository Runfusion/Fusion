import { describe, expect, it } from "vitest";

import { REPO_OVERRIDE_RE, isValidRepoSlug, parseRepoSlug, resolveTaskGithubTracking } from "../github-tracking.js";

describe("REPO_OVERRIDE_RE", () => {
  it("matches valid owner/repo overrides", () => {
    expect(REPO_OVERRIDE_RE.test("owner/repo")).toBe(true);
    expect(REPO_OVERRIDE_RE.test("org.name/repo_name-1")).toBe(true);
    expect(REPO_OVERRIDE_RE.test("owner")).toBe(false);
  });
});

describe("parseRepoSlug", () => {
  it("parses valid owner/repo slugs", () => {
    expect(parseRepoSlug("octocat/hello-world")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("accepts leading and trailing whitespace", () => {
    expect(parseRepoSlug("  octocat/hello-world  ")).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("rejects malformed values", () => {
    expect(parseRepoSlug("octocat")).toBeNull();
    expect(parseRepoSlug("octocat//hello-world")).toBeNull();
    expect(parseRepoSlug("/hello-world")).toBeNull();
    expect(parseRepoSlug("octocat/")).toBeNull();
    expect(parseRepoSlug(null)).toBeNull();
    expect(parseRepoSlug(undefined)).toBeNull();
  });

  it("rejects values with spaces in segments", () => {
    expect(parseRepoSlug("octo cat/hello-world")).toBeNull();
    expect(parseRepoSlug("octocat/hello world")).toBeNull();
  });
});

describe("isValidRepoSlug", () => {
  it("returns true only for valid repo slugs", () => {
    expect(isValidRepoSlug("octocat/hello-world")).toBe(true);
    expect(isValidRepoSlug("octocat")).toBe(false);
  });
});

describe("resolveTaskGithubTracking", () => {
  it.each([
    [{ enabled: true }, { githubTrackingEnabledByDefault: false }, true, "task"],
    [{ enabled: false }, { githubTrackingEnabledByDefault: true }, false, "task"],
    [{}, { githubTrackingEnabledByDefault: true }, true, "project"],
    [{}, {}, false, "default"],
  ] as const)(
    "resolves enabled precedence",
    (taskTracking, projectSettings, expectedEnabled, expectedSource) => {
      const resolved = resolveTaskGithubTracking(
        { githubTracking: taskTracking },
        projectSettings,
        undefined,
      );
      expect(resolved.enabled).toBe(expectedEnabled);
      expect(resolved.source.enabled).toBe(expectedSource);
    },
  );

  it("falls back to global enabled when present", () => {
    const resolved = resolveTaskGithubTracking(
      { githubTracking: {} },
      {},
      { githubTrackingDefaultEnabledForNewTasks: true },
    );
    expect(resolved.enabled).toBe(true);
    expect(resolved.source.enabled).toBe("global");
  });

  it("resolves repo from task override first", () => {
    const resolved = resolveTaskGithubTracking(
      { githubTracking: { repoOverride: "task/override" } },
      { githubTrackingDefaultRepo: "project/default" },
      { githubTrackingDefaultRepo: "global/default" },
    );
    expect(resolved.repo).toEqual({ owner: "task", repo: "override" });
    expect(resolved.source.repo).toBe("task");
  });

  it("falls through invalid repo tiers", () => {
    const resolved = resolveTaskGithubTracking(
      { githubTracking: { repoOverride: "invalid" } },
      { githubTrackingDefaultRepo: "still invalid" },
      { githubDefaultRepo: "global/default" },
    );
    expect(resolved.repo).toEqual({ owner: "global", repo: "default" });
    expect(resolved.source.repo).toBe("global");
  });

  it("returns none source when no valid repo exists", () => {
    const resolved = resolveTaskGithubTracking(
      { githubTracking: { repoOverride: "invalid" } },
      { githubTrackingDefaultRepo: "also invalid" },
      { githubTrackingDefaultRepo: "" },
    );
    expect(resolved.repo).toBeNull();
    expect(resolved.source.repo).toBe("none");
  });
});
