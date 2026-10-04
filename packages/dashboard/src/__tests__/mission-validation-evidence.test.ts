import { describe, expect, it, vi } from "vitest";
import { createDashboardMissionForgeReader } from "../mission-validation-evidence.js";

describe("createDashboardMissionForgeReader", () => {
  it("normalizes configured GitHub PR comments into bounded read-only evidence", async () => {
    const listPrComments = vi.fn().mockResolvedValue([{ id: 4, body: "Merged after review", created_at: "2026-10-04T00:00:00.000Z" }]);
    const reader = createDashboardMissionForgeReader({ githubClient: { listPrComments } as any });

    const result = await reader.read({ prInfo: { url: "https://github.com/acme/repo/pull/12" } } as any);

    expect(listPrComments).toHaveBeenCalledWith("acme", "repo", 12);
    expect(result).toEqual({ records: [expect.objectContaining({ source: "forge-record", identifier: "github-pr-comment:4" })] });
  });

  it("normalizes durable GitHub source-issue comments without PR metadata", async () => {
    const getIssueDetail = vi.fn().mockResolvedValue({
      comments: [{ author: "reviewer", body: "Issue requirement confirmed", createdAt: "2026-10-04T01:00:00.000Z", authorIsBot: false }],
    });
    const reader = createDashboardMissionForgeReader({ githubClient: { getIssueDetail } as any });

    const result = await reader.read({
      sourceIssue: { provider: "github", repository: "acme/repo", issueNumber: 42 },
    } as any);

    expect(getIssueDetail).toHaveBeenCalledWith("acme", "repo", 42);
    expect(result).toEqual({ records: [expect.objectContaining({
      identifier: "github-issue-comment:acme/repo#42:0",
      excerpt: "Issue requirement confirmed",
    })] });
  });

  it("returns retryable forge evidence when a GitHub source-issue read is unavailable", async () => {
    const getIssueDetail = vi.fn().mockRejectedValue(new Error("token abc"));
    const reader = createDashboardMissionForgeReader({ githubClient: { getIssueDetail } as any });

    await expect(reader.read({
      sourceIssue: { provider: "github", repository: "acme/repo", issueNumber: 42 },
    } as any)).resolves.toEqual({
      unavailable: { source: "forge-record", retryable: true, reason: "configured forge record read is unavailable" },
    });
    expect(getIssueDetail).toHaveBeenCalledWith("acme", "repo", 42);
  });

  it("redacts credential-like GitHub comment text before returning evidence", async () => {
    const reader = createDashboardMissionForgeReader({
      githubClient: { listPrComments: vi.fn().mockResolvedValue([{ id: 7, body: "Authorization: Bearer sk-live-ABCDEFG1234567890abcdef" }]) } as any,
    });

    const result = await reader.read({ prInfo: { url: "https://github.com/acme/repo/pull/12" } } as any);

    expect(result.records?.[0]?.excerpt).not.toContain("sk-live-ABCDEFG1234567890abcdef");
  });

  it("normalizes configured GitLab merge-request notes into read-only evidence", async () => {
    const listNotes = vi.fn().mockResolvedValue(["Reviewed and merged"]);
    const reader = createDashboardMissionForgeReader({ getGitLabClient: async () => ({ listNotes }) });

    const result = await reader.read({
      gitlabTracking: {
        item: { kind: "merge_request", projectPath: "group/project", iid: 12, instanceUrl: "https://gitlab.example", host: "gitlab.example", url: "https://gitlab.example/group/project/-/merge_requests/12", createdAt: "2026-10-04T00:00:00.000Z" },
      },
    } as any);

    expect(listNotes).toHaveBeenCalledWith("merge_requests", "group/project", 12);
    expect(result).toEqual({ records: [expect.objectContaining({ source: "forge-record", identifier: "gitlab-merge_request-note:group/project!12:0" })] });
  });

  it("returns a redacted retryable forge diagnostic when configured reads fail", async () => {
    const reader = createDashboardMissionForgeReader({ githubClient: { listPrComments: vi.fn().mockRejectedValue(new Error("token abc")) } as any });

    await expect(reader.read({ prInfo: { url: "https://github.com/acme/repo/pull/12" } } as any)).resolves.toEqual({
      unavailable: { source: "forge-record", retryable: true, reason: "configured forge record read is unavailable" },
    });
  });
});
