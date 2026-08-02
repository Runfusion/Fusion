import { describe, expect, it } from "vitest";
import { resolveGitLabTarget } from "../gitlab-lifecycle.js";

const sourceTask = {
  sourceIssue: { provider: "gitlab", repository: "group/project", issueNumber: 42, url: "https://gitlab.example.com/group/project/-/issues/42" },
  source: { sourceMetadata: { resourceType: "project_issue", projectPath: "group/project", iid: 42 } },
} as any;
const validTracking = { kind: "project_issue", projectPath: "tracking/project", iid: 9, url: "https://gitlab.example.com/tracking/project/-/issues/9" };
const malformedTracking = { kind: "project_issue", iid: 9 };

describe("resolveGitLabTarget", () => {
  it("prefers valid tracking in both fallback modes", () => {
    for (const options of [undefined, { fallbackToSourceOnInvalidTracking: true }]) {
      expect(resolveGitLabTarget({ ...sourceTask, gitlabTracking: { item: validTracking } }, options)).toMatchObject({ project: "tracking/project", iid: 9 });
    }
  });

  it("keeps malformed tracking inert unless the delete-only fallback is requested", () => {
    expect(resolveGitLabTarget({ ...sourceTask, gitlabTracking: { item: malformedTracking } })).toBeNull();
    expect(resolveGitLabTarget({ ...sourceTask, gitlabTracking: { item: malformedTracking } }, { fallbackToSourceOnInvalidTracking: true })).toMatchObject({ project: "group/project", iid: 42 });
  });

  it("does not manufacture a source target for malformed tracking without a GitLab source", () => {
    expect(resolveGitLabTarget({ sourceIssue: { provider: "github" }, gitlabTracking: { item: malformedTracking } } as any, { fallbackToSourceOnInvalidTracking: true })).toBeNull();
    expect(resolveGitLabTarget({ gitlabTracking: { item: malformedTracking } } as any, { fallbackToSourceOnInvalidTracking: true })).toBeNull();
  });

  it("uses a GitLab source without tracking in both modes, including source-only imports", () => {
    expect(resolveGitLabTarget(sourceTask)).toMatchObject({ project: "group/project", iid: 42 });
    expect(resolveGitLabTarget(sourceTask, { fallbackToSourceOnInvalidTracking: true })).toMatchObject({ project: "group/project", iid: 42 });
    const sourceOnly = { sourceIssue: sourceTask.sourceIssue };
    expect(resolveGitLabTarget(sourceOnly as any)).toMatchObject({ project: "group/project", iid: 42 });
    expect(resolveGitLabTarget(sourceOnly as any, { fallbackToSourceOnInvalidTracking: true })).toMatchObject({ project: "group/project", iid: 42 });
  });
});
