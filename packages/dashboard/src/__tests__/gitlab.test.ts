import { describe, expect, it, vi } from "vitest";
import { GITLAB_AUTH_HEADER_NAME, type ResolvedGitlabAuth } from "../gitlab-auth.js";
import { buildGitLabTaskDescription, buildGitLabTaskProvenance, encodeGitLabPathId, GitLabClient, isGitLabAlreadyImported } from "../gitlab.js";

const auth: ResolvedGitlabAuth = {
  apiBaseUrl: "https://gitlab.example.com/api/v4",
  webBaseUrl: "https://gitlab.example.com",
  token: "SECRET_TOKEN",
  tokenType: "personal",
  headerName: GITLAB_AUTH_HEADER_NAME,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("GitLabClient", () => {
  it("encodes path identifiers with slashes but preserves numeric identifiers", () => {
    expect(encodeGitLabPathId("group/sub/project")).toBe("group%2Fsub%2Fproject");
    expect(encodeGitLabPathId(123)).toBe("123");
  });

  it("sends PRIVATE-TOKEN auth without putting tokens in errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ iid: 1, title: "Issue", description: null, web_url: "https://gitlab.example.com/g/p/-/issues/1", state: "opened", labels: [] }]));
    const client = new GitLabClient(auth, fetchImpl as any);
    await client.listProjectIssues("g/p", { limit: 1 });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/issues?per_page=1&page=1&state=opened");
    expect(fetchImpl.mock.calls[0][1].headers["PRIVATE-TOKEN"]).toBe("SECRET_TOKEN");

    fetchImpl.mockResolvedValueOnce(jsonResponse({ message: "bad SECRET_TOKEN" }, 401));
    await expect(client.listProjectIssues("g/p", { limit: 1 })).rejects.toThrow("GitLab authentication failed");
  });

  it("posts notes and state events for issues and merge requests", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, project_id: 7, title: "Issue", web_url: "https://gitlab.example.com/g/p/-/issues/2", state: "closed", labels: [] }))
      .mockResolvedValueOnce(jsonResponse({ iid: 4, project_id: 7, title: "MR", web_url: "https://gitlab.example.com/g/p/-/merge_requests/4", state: "closed", labels: [] }));
    const client = new GitLabClient(auth, fetchImpl as any);
    await client.commentOnProjectIssue("g/p", 2, "done");
    await client.commentOnMergeRequest(7, 4, "done");
    await client.setProjectIssueState("g/p", 2, "closed");
    await client.setMergeRequestState(7, 4, "closed");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/issues/2/notes");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ body: "done" }) });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://gitlab.example.com/api/v4/projects/7/merge_requests/4/notes");
    expect(fetchImpl.mock.calls[2][0]).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/issues/2?state_event=close");
    expect(fetchImpl.mock.calls[3][0]).toBe("https://gitlab.example.com/api/v4/projects/7/merge_requests/4?state_event=close");
  });

  it("normalizes project issues, group issues, and merge requests", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 10, iid: 2, project_id: 7, title: "Issue", description: "Body", web_url: "https://gitlab.example.com/g/p/-/issues/2", state: "opened", labels: ["bug"], author: { username: "ana" }, user_notes_count: 3 }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 11, iid: 3, project_id: 8, title: "Group issue", description: null, web_url: "https://gitlab.example.com/g/q/-/issues/3", state: "closed", labels: [] }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 12, iid: 4, project_id: 7, title: "MR", description: "Review", web_url: "https://gitlab.example.com/g/p/-/merge_requests/4", state: "opened", labels: ["backend"], source_branch: "feat", target_branch: "main", draft: false }]));
    const client = new GitLabClient(auth, fetchImpl as any);
    expect(await client.listProjectIssues(7, { limit: 1 })).toMatchObject([{ resourceKind: "project_issue", iid: 2, projectId: 7, projectPath: "g/p", commentsCount: 3 }]);
    expect(await client.listGroupIssues("g", { limit: 1 })).toMatchObject([{ resourceKind: "group_issue", iid: 3, projectPath: "g/q", groupPath: "g" }]);
    expect(await client.listMergeRequests("g/p", { limit: 1 })).toMatchObject([{ resourceKind: "merge_request", iid: 4, projectPath: "g/p", sourceBranch: "feat", targetBranch: "main" }]);
  });

  it("collects note bodies from every GitLab page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ body: `note-${index}` }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([{ body: "page-two-image" }]));
    const client = new GitLabClient(auth, fetchImpl as any);

    await expect(client.listNotes("issues", "g/p", 2)).resolves.toHaveLength(101);
    expect(fetchImpl.mock.calls[1][0]).toContain("notes?per_page=100&page=2");
  });
});

describe("GitLab provenance helpers", () => {
  it("build gitlab_import source metadata and duplicate keys", () => {
    const item = { resourceKind: "merge_request" as const, id: 50, iid: 9, projectId: 7, projectPath: "g/p", title: "MR", description: "", webUrl: "https://gitlab.example.com/g/p/-/merge_requests/9", state: "opened", labels: [], sourceBranch: "feat", targetBranch: "main" };
    const provenance = buildGitLabTaskProvenance({ auth, resourceType: "merge_request", item, projectInput: "g/p" });
    expect(provenance.sourceIssue).toMatchObject({ provider: "gitlab", repository: "g/p", externalIssueId: "gitlab:mr:7:50", issueNumber: 9 });
    expect(provenance.sourceMetadata).toMatchObject({ provider: "gitlab", resourceType: "merge_request", mergeRequestIid: 9, sourceBranch: "feat" });
    expect(buildGitLabTaskDescription(item)).toBe("(no description)\n\nSource: https://gitlab.example.com/g/p/-/merge_requests/9");
    expect(isGitLabAlreadyImported({ description: "x", sourceIssue: provenance.sourceIssue, source: { sourceType: "gitlab_import", sourceMetadata: {} } }, provenance)).toBe(true);
    expect(isGitLabAlreadyImported({ description: `Source: ${item.webUrl}`, source: undefined }, provenance)).toBe(true);
  });
});
