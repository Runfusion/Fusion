import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubClient, CreatePrParams, PrComment, isPrMergeReady } from "./github.js";

// Mock the gh-cli module from @kb/core
vi.mock("@kb/core", async () => {
  const actual = await vi.importActual<typeof import("@kb/core")>("@kb/core");
  return {
    ...actual,
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    runGh: vi.fn(),
    runGhAsync: vi.fn(),
    runGhJson: vi.fn(),
    runGhJsonAsync: vi.fn(),
    getGhErrorMessage: vi.fn((err) => err instanceof Error ? err.message : String(err)),
    getCurrentRepo: vi.fn(),
  };
});

import {
  isGhAvailable,
  isGhAuthenticated,
  runGh,
  runGhAsync,
  runGhJson,
  runGhJsonAsync,
  getCurrentRepo,
} from "@kb/core";

const mockIsGhAvailable = vi.mocked(isGhAvailable);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockRunGh = vi.mocked(runGh);
const mockRunGhAsync = vi.mocked(runGhAsync);
const mockRunGhJson = vi.mocked(runGhJson);
const mockRunGhJsonAsync = vi.mocked(runGhJsonAsync);
const mockGetCurrentRepo = vi.mocked(getCurrentRepo);

describe("GitHubClient", () => {
  let client: GitHubClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    // Create client after mocks are set up
    client = new GitHubClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("can be created without token (gh CLI auth preferred)", () => {
      expect(() => new GitHubClient()).not.toThrow();
    });

    it("can be created with token for REST API fallback", () => {
      expect(() => new GitHubClient("ghp_token123")).not.toThrow();
    });
  });

  describe("createPr", () => {
    const mockPrParams: CreatePrParams = {
      owner: "test-owner",
      repo: "test-repo",
      title: "Test PR",
      body: "Test body",
      head: "feature-branch",
      base: "main",
    };

    it("creates PR using gh CLI when available", async () => {
      mockRunGh.mockReturnValue("https://github.com/test-owner/test-repo/pull/42\n");

      const result = await client.createPr(mockPrParams);

      expect(mockRunGh).toHaveBeenCalledWith([
        "pr", "create",
        "--repo", "test-owner/test-repo",
        "--title", "Test PR",
        "--head", "feature-branch",
        "--body", "Test body",
        "--base", "main",
      ]);
      expect(result.number).toBe(42);
      expect(result.url).toBe("https://github.com/test-owner/test-repo/pull/42");
      expect(result.status).toBe("open");
    });

    it("creates PR without body when not provided", async () => {
      mockRunGh.mockReturnValue("https://github.com/test-owner/test-repo/pull/42\n");
      const paramsWithoutBody: CreatePrParams = {
        owner: "test-owner",
        repo: "test-repo",
        title: "Test PR",
        head: "feature-branch",
        // body and base not provided
      };

      await client.createPr(paramsWithoutBody);

      expect(mockRunGh).toHaveBeenCalledWith([
        "pr", "create",
        "--repo", "test-owner/test-repo",
        "--title", "Test PR",
        "--head", "feature-branch",
      ]);
      // Should not include --body or --base when not provided
      const callArgs = mockRunGh.mock.calls[0][0];
      expect(callArgs).not.toContain("--body");
      expect(callArgs).not.toContain("--base");
    });

    it("uses current repo context when owner/repo not specified", async () => {
      mockGetCurrentRepo.mockReturnValue({ owner: "current-owner", repo: "current-repo" });
      mockRunGh.mockReturnValue("https://github.com/current-owner/current-repo/pull/5\n");

      const paramsWithoutRepo = {
        title: "Test PR",
        head: "feature-branch",
      };

      const result = await client.createPr(paramsWithoutRepo);

      expect(mockGetCurrentRepo).toHaveBeenCalled();
      expect(mockRunGh).toHaveBeenCalledWith([
        "pr", "create",
        "--repo", "current-owner/current-repo",
        "--title", "Test PR",
        "--head", "feature-branch",
      ]);
      expect(result.number).toBe(5);
    });

    it("throws error when repo cannot be determined", async () => {
      mockGetCurrentRepo.mockReturnValue(null);

      const paramsWithoutRepo = {
        title: "Test PR",
        head: "feature-branch",
      };

      await expect(client.createPr(paramsWithoutRepo)).rejects.toThrow("Could not determine repository");
    });

    it("falls back to REST API when gh CLI fails and token is available", async () => {
      mockRunGh.mockImplementation(() => {
        throw new Error("gh command failed");
      });

      // Create client with token for fallback
      const clientWithToken = new GitHubClient("ghp_fallback_token");

      // Mock global fetch for REST API fallback
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          number: 42,
          html_url: "https://github.com/test-owner/test-repo/pull/42",
          title: "Test PR",
          state: "open",
          head: { ref: "feature-branch" },
          base: { ref: "main" },
          comments: 0,
        }),
      });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.createPr(mockPrParams);

      expect(mockFetch).toHaveBeenCalled();
      expect(result.number).toBe(42);

      // Restore fetch
      vi.restoreAllMocks();
    });

    it("throws error when gh CLI fails and no token available", async () => {
      mockRunGh.mockImplementation(() => {
        throw new Error("gh command failed: not authenticated");
      });

      await expect(client.createPr(mockPrParams)).rejects.toThrow();
    });
  });

  describe("getPrStatus", () => {
    it("fetches PR status using gh CLI", async () => {
      mockRunGhJsonAsync.mockResolvedValue({
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        title: "Test PR",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature-branch",
      });

      const result = await client.getPrStatus("owner", "repo", 42);

      expect(mockRunGhJsonAsync).toHaveBeenCalledWith([
        "pr", "view", "42",
        "--repo", "owner/repo",
        "--json", "number,url,title,state,baseRefName,headRefName",
      ]);
      expect(result.number).toBe(42);
      expect(result.status).toBe("open");
      expect(result.title).toBe("Test PR");
    });

    it("maps gh CLI states correctly", async () => {
      const states = [
        { input: "OPEN", expected: "open" },
        { input: "CLOSED", expected: "closed" },
        { input: "MERGED", expected: "merged" },
      ];

      for (const { input, expected } of states) {
        vi.clearAllMocks();
        mockRunGhJsonAsync.mockResolvedValue({
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          title: "Test PR",
          state: input,
          baseRefName: "main",
          headRefName: "feature-branch",
        });

        const result = await client.getPrStatus("owner", "repo", 42);
        expect(result.status).toBe(expected);
      }
    });

    it("falls back to REST API when gh CLI fails and token is available", async () => {
      mockRunGhJsonAsync.mockRejectedValue(new Error("gh failed"));

      const clientWithToken = new GitHubClient("ghp_token");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          number: 42,
          html_url: "https://github.com/owner/repo/pull/42",
          title: "Test PR",
          state: "open",
          merged: false,
          head: { ref: "feature-branch" },
          base: { ref: "main" },
          comments: 5,
          updated_at: "2024-01-01T00:00:00Z",
        }),
      });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.getPrStatus("owner", "repo", 42);

      expect(mockFetch).toHaveBeenCalled();
      expect(result.number).toBe(42);

      vi.restoreAllMocks();
    });
  });

  describe("listPrComments", () => {
    const mockComments = [
      {
        id: "100",
        body: "First comment",
        author: { login: "user1" },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        url: "https://github.com/owner/repo/pull/42#issuecomment-100",
      },
      {
        id: "200",
        body: "Second comment",
        author: { login: "user2" },
        createdAt: "2024-01-02T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        url: "https://github.com/owner/repo/pull/42#issuecomment-200",
      },
    ];

    it("fetches PR comments using gh CLI", async () => {
      mockRunGhJsonAsync.mockResolvedValue({ comments: mockComments });

      const result = await client.listPrComments("owner", "repo", 42);

      expect(mockRunGhJsonAsync).toHaveBeenCalledWith([
        "pr", "view", "42",
        "--repo", "owner/repo",
        "--json", "comments",
      ]);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(100);
      expect(result[0].body).toBe("First comment");
      expect(result[0].user.login).toBe("user1");
    });

    it("filters comments by timestamp when since is provided", async () => {
      mockRunGhJsonAsync.mockResolvedValue({ comments: mockComments });

      const result = await client.listPrComments("owner", "repo", 42, "2024-01-01T12:00:00Z");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(200);
    });

    it("returns empty array when no comments", async () => {
      mockRunGhJsonAsync.mockResolvedValue({ comments: [] });

      const result = await client.listPrComments("owner", "repo", 42);

      expect(result).toEqual([]);
    });

    it("falls back to REST API when gh CLI fails and token is available", async () => {
      mockRunGhJsonAsync.mockRejectedValue(new Error("gh failed"));

      const clientWithToken = new GitHubClient("ghp_token");

      const apiComments: PrComment[] = [
        {
          id: 100,
          body: "API comment",
          user: { login: "user1" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-100",
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(apiComments),
      });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.listPrComments("owner", "repo", 42);

      expect(mockFetch).toHaveBeenCalled();
      expect(result).toHaveLength(1);

      vi.restoreAllMocks();
    });
  });

  describe("getIssueStatus", () => {
    it("fetches issue status using gh CLI", async () => {
      mockRunGhJsonAsync.mockResolvedValue({
        number: 1,
        url: "https://github.com/owner/repo/issues/1",
        title: "Test Issue",
        state: "OPEN",
      });

      const result = await client.getIssueStatus("owner", "repo", 1);

      expect(mockRunGhJsonAsync).toHaveBeenCalledWith([
        "issue", "view", "1",
        "--repo", "owner/repo",
        "--json", "number,url,title,state,stateReason",
      ]);
      expect(result).not.toBeNull();
      expect(result?.number).toBe(1);
      expect(result?.state).toBe("open");
    });

    it("returns null for PRs (not issues)", async () => {
      mockRunGhJsonAsync.mockRejectedValue(
        new Error("Could not resolve to an issue with the number 1")
      );

      const result = await client.getIssueStatus("owner", "repo", 1);

      expect(result).toBeNull();
    });

    it("falls back to REST API when gh CLI fails and token is available", async () => {
      mockRunGhJsonAsync.mockRejectedValue(new Error("gh failed"));

      const clientWithToken = new GitHubClient("ghp_token");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          number: 1,
          html_url: "https://github.com/owner/repo/issues/1",
          title: "Test Issue",
          state: "open",
          state_reason: null,
        }),
      });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.getIssueStatus("owner", "repo", 1);

      expect(mockFetch).toHaveBeenCalled();
      expect(result?.number).toBe(1);

      vi.restoreAllMocks();
    });
  });

  describe("listIssues", () => {
    const mockIssues = [
      {
        number: 1,
        title: "Issue 1",
        body: "Body 1",
        url: "https://github.com/owner/repo/issues/1",
        labels: [{ name: "bug" }],
      },
      {
        number: 2,
        title: "Issue 2",
        body: "Body 2",
        url: "https://github.com/owner/repo/issues/2",
        labels: [{ name: "feature" }],
      },
    ];

    it("lists open issues using gh CLI", async () => {
      mockRunGhJsonAsync.mockResolvedValue(mockIssues);

      const result = await client.listIssues("owner", "repo");

      expect(mockRunGhJsonAsync).toHaveBeenCalledWith([
        "issue", "list",
        "--repo", "owner/repo",
        "--state", "open",
        "--limit", "30",
        "--json", "number,title,body,url,labels",
      ]);
      expect(result).toHaveLength(2);
      expect(result[0].number).toBe(1);
    });

    it("respects limit parameter", async () => {
      mockRunGhJsonAsync.mockResolvedValue(mockIssues.slice(0, 1));

      await client.listIssues("owner", "repo", { limit: 10 });

      expect(mockRunGhJsonAsync).toHaveBeenCalledWith(
        expect.arrayContaining(["--limit", "10"])
      );
    });

    it("filters by labels client-side", async () => {
      mockRunGhJsonAsync.mockResolvedValue(mockIssues);

      const result = await client.listIssues("owner", "repo", { labels: ["bug"] });

      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);
    });

    it("falls back to REST API when gh CLI fails and token is available", async () => {
      mockRunGhJsonAsync.mockRejectedValue(new Error("gh failed"));

      const clientWithToken = new GitHubClient("ghp_token");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          {
            number: 1,
            title: "API Issue",
            body: "API body",
            html_url: "https://github.com/owner/repo/issues/1",
            labels: [{ name: "api" }],
          },
        ]),
      });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.listIssues("owner", "repo");

      expect(mockFetch).toHaveBeenCalled();
      expect(result).toHaveLength(1);

      vi.restoreAllMocks();
    });
  });

  describe("getIssue", () => {
    it("fetches single issue using gh CLI", async () => {
      mockRunGhJsonAsync.mockResolvedValue({
        number: 1,
        title: "Test Issue",
        body: "Test body",
        url: "https://github.com/owner/repo/issues/1",
        state: "OPEN",
        stateReason: "reopened",
      });

      const result = await client.getIssue("owner", "repo", 1);

      expect(mockRunGhJsonAsync).toHaveBeenCalledWith([
        "issue", "view", "1",
        "--repo", "owner/repo",
        "--json", "number,title,body,url,state,stateReason",
      ]);
      expect(result).not.toBeNull();
      expect(result?.number).toBe(1);
      expect(result?.state).toBe("open");
      expect(result?.stateReason).toBe("reopened");
    });

    it("returns null for non-existent issues", async () => {
      mockRunGhJsonAsync.mockRejectedValue(
        new Error("HTTP 404: not found")
      );

      const result = await client.getIssue("owner", "repo", 999);

      expect(result).toBeNull();
    });

    it("returns null for PRs", async () => {
      mockRunGhJsonAsync.mockRejectedValue(
        new Error("Could not resolve to an issue")
      );

      const result = await client.getIssue("owner", "repo", 1);

      expect(result).toBeNull();
    });

    it("falls back to REST API when gh CLI fails and token is available", async () => {
      mockRunGhJsonAsync.mockRejectedValue(new Error("gh failed"));

      const clientWithToken = new GitHubClient("ghp_token");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          number: 1,
          title: "API Issue",
          body: "API body",
          html_url: "https://github.com/owner/repo/issues/1",
          state: "open",
          state_reason: null,
        }),
      });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.getIssue("owner", "repo", 1);

      expect(mockFetch).toHaveBeenCalled();
      expect(result?.number).toBe(1);

      vi.restoreAllMocks();
    });
  });

  describe("findPrForBranch", () => {
    it("finds an existing PR for a head branch via gh CLI", async () => {
      mockRunGhJsonAsync.mockResolvedValue([
        {
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          title: "Existing PR",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "kb/kb-093",
          mergedAt: null,
        },
      ]);

      const result = await client.findPrForBranch({ owner: "owner", repo: "repo", head: "kb/kb-093", state: "all" });

      expect(mockRunGhJsonAsync).toHaveBeenCalledWith([
        "pr", "list",
        "--repo", "owner/repo",
        "--head", "kb/kb-093",
        "--state", "all",
        "--json", "number,url,title,state,baseRefName,headRefName,mergedAt",
      ]);
      expect(result).toEqual(expect.objectContaining({ number: 42, status: "open" }));
    });

    it("falls back to REST API for branch lookup when gh CLI fails and token is available", async () => {
      mockRunGhJsonAsync.mockRejectedValue(new Error("gh failed"));
      const clientWithToken = new GitHubClient("ghp_token");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          {
            number: 5,
            html_url: "https://github.com/owner/repo/pull/5",
            title: "API PR",
            state: "open",
            merged_at: null,
            head: { ref: "kb/kb-093" },
            base: { ref: "main" },
            comments: 2,
          },
        ]),
      });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.findPrForBranch({ owner: "owner", repo: "repo", head: "kb/kb-093" });

      expect(mockFetch).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ number: 5, commentCount: 2 }));
      vi.restoreAllMocks();
    });
  });

  describe("getPrMergeStatus", () => {
    it("returns merge-ready status only when required checks pass and review is non-blocking", async () => {
      mockRunGhJsonAsync
        .mockResolvedValueOnce({
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          title: "Ready PR",
          state: "OPEN",
          reviewDecision: "APPROVED",
          baseRefName: "main",
          headRefName: "kb/kb-093",
        })
        .mockResolvedValueOnce([
          { name: "ci", state: "SUCCESS" },
          { name: "lint", state: "SUCCESS" },
        ]);

      const result = await client.getPrMergeStatus("owner", "repo", 42);

      expect(result.mergeReady).toBe(true);
      expect(result.blockingReasons).toEqual([]);
      expect(result.checks).toEqual([
        { name: "ci", required: true, state: "success" },
        { name: "lint", required: true, state: "success" },
      ]);
    });

    it("falls back to GraphQL API when gh CLI merge-status lookup fails and token is available", async () => {
      mockRunGhJsonAsync.mockRejectedValue(new Error("gh failed"));
      const clientWithToken = new GitHubClient("ghp_token");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            repository: {
              pullRequest: {
                number: 42,
                url: "https://github.com/owner/repo/pull/42",
                title: "Fallback PR",
                state: "OPEN",
                reviewDecision: null,
                baseRefName: "main",
                headRefName: "kb/kb-093",
                comments: { totalCount: 0 },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              {
                                __typename: "CheckRun",
                                name: "ci",
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                                isRequired: true,
                              },
                              {
                                __typename: "CheckRun",
                                name: "optional-preview",
                                status: "COMPLETED",
                                conclusion: "FAILURE",
                                isRequired: false,
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.getPrMergeStatus("owner", "repo", 42);

      expect(result.mergeReady).toBe(true);
      expect(result.checks).toEqual([{ name: "ci", required: true, state: "success" }]);
      vi.restoreAllMocks();
    });
  });

  describe("mergePr", () => {
    it("merges a PR with gh CLI and refetches merged status", async () => {
      mockRunGh.mockReturnValue("Merged pull request");
      mockRunGhJsonAsync.mockResolvedValue({
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        title: "Merged PR",
        state: "MERGED",
        baseRefName: "main",
        headRefName: "kb/kb-093",
      });

      const result = await client.mergePr({ owner: "owner", repo: "repo", number: 42, method: "squash" });

      expect(mockRunGh).toHaveBeenCalledWith([
        "pr", "merge", "42",
        "--repo", "owner/repo",
        "--squash",
        "--delete-branch",
      ]);
      expect(result.status).toBe("merged");
    });

    it("falls back to REST API merge when gh CLI fails and token is available", async () => {
      mockRunGh.mockImplementation(() => {
        throw new Error("gh failed");
      });
      const clientWithToken = new GitHubClient("ghp_token");
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ merged: true }) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            number: 42,
            html_url: "https://github.com/owner/repo/pull/42",
            title: "Merged PR",
            state: "closed",
            merged: true,
            head: { ref: "kb/kb-093" },
            base: { ref: "main" },
            comments: 0,
            updated_at: "2024-01-01T00:00:00Z",
          }),
        });
      global.fetch = mockFetch as any;

      const result = await clientWithToken.mergePr({ owner: "owner", repo: "repo", number: 42 });

      expect(result.status).toBe("merged");
      vi.restoreAllMocks();
    });
  });

  describe("isPrMergeReady", () => {
    it("blocks closed PRs", () => {
      expect(isPrMergeReady({ status: "closed", reviewDecision: null, checks: [] })).toEqual({
        ready: false,
        blockingReasons: ["PR is closed"],
      });
    });

    it("blocks changes requested review even when checks pass", () => {
      expect(isPrMergeReady({
        status: "open",
        reviewDecision: "CHANGES_REQUESTED",
        checks: [{ name: "ci", required: true, state: "success" }],
      })).toEqual({
        ready: false,
        blockingReasons: ["changes requested review is active"],
      });
    });

    it("blocks pending required checks", () => {
      expect(isPrMergeReady({
        status: "open",
        reviewDecision: null,
        checks: [{ name: "ci", required: true, state: "pending" }],
      })).toEqual({
        ready: false,
        blockingReasons: ["required checks not successful: ci (pending)"],
      });
    });

    it("ignores optional checks when determining readiness", () => {
      expect(isPrMergeReady({
        status: "open",
        reviewDecision: "REVIEW_REQUIRED",
        checks: [
          { name: "required-ci", required: true, state: "success" },
          { name: "optional-preview", required: false, state: "failure" },
        ],
      })).toEqual({ ready: true, blockingReasons: [] });
    });
  });

  describe("error handling when gh CLI not available", () => {
    it("throws error when gh CLI not available and no token", async () => {
      mockIsGhAvailable.mockReturnValue(false);

      await expect(client.createPr({
        title: "Test",
        head: "branch",
      })).rejects.toThrow("GitHub CLI (gh) is not available");
    });

    it("throws error when gh not authenticated and no token", async () => {
      mockIsGhAuthenticated.mockReturnValue(false);

      await expect(client.createPr({
        title: "Test",
        head: "branch",
      })).rejects.toThrow("GitHub CLI (gh) is not available or not authenticated");
    });
  });

  describe("fetchThrottled", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns success with data on successful request", async () => {
      const mockData = { id: 1, title: "Test Issue" };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
      } as Response);

      const result = await client.fetchThrottled("https://api.github.com/repos/owner/repo/issues/1");

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(result.error).toBeUndefined();
    });

    it("returns error on non-429 HTTP error without retry", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.resolve({ message: "Not Found" }),
      } as Response);

      const result = await client.fetchThrottled("https://api.github.com/repos/owner/repo/issues/1");

      expect(result.success).toBe(false);
      expect(result.error).toContain("404");
      expect(fetchSpy).toHaveBeenCalledTimes(1); // No retries for non-429 errors
    });

    it("retries on 429 with exponential backoff", async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers(),
          json: () => Promise.resolve({ message: "Rate limited" }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 1 }),
        } as Response);

      const result = await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/1",
        {},
        { delayMs: 10, maxRetries: 3 }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("respects Retry-After header on 429", async () => {
      const headers = new Headers();
      headers.set("Retry-After", "1"); // Use 1 second for test speed

      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers,
          json: () => Promise.resolve({ message: "Rate limited" }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 1 }),
        } as Response);

      const startTime = Date.now();
      const result = await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/1",
        {},
        { delayMs: 100, maxRetries: 3 }
      );
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(true);
      // Should wait at least 1 second (Retry-After value), not just the exponential backoff
      expect(elapsed).toBeGreaterThanOrEqual(900); // Allow some tolerance
    }, 10000); // Increase timeout for this test

    it("returns error with retryAfter after max retries exceeded", async () => {
      const headers = new Headers();
      headers.set("Retry-After", "1"); // Use 1 second for test speed

      // All attempts return 429
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers,
        json: () => Promise.resolve({ message: "Rate limited" }),
      } as Response);

      const result = await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/1",
        {},
        { delayMs: 1, maxRetries: 2 }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("rate limit exceeded");
      expect(result.retryAfter).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
    }, 10000); // Increase timeout for this test

    it("retries on network errors with exponential backoff", async () => {
      fetchSpy
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 1 }),
        } as Response);

      const result = await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/1",
        {},
        { delayMs: 10, maxRetries: 3 }
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("returns error after max retries on persistent network errors", async () => {
      fetchSpy.mockRejectedValue(new Error("Network error"));

      const result = await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/1",
        {},
        { delayMs: 1, maxRetries: 2 }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
      expect(fetchSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("enforces delay between sequential requests", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 1 }),
      } as Response);

      // First request
      await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/1",
        {},
        { delayMs: 100 }
      );

      const startTime = Date.now();
      // Second request should be delayed
      await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/2",
        {},
        { delayMs: 100 }
      );
      const elapsed = Date.now() - startTime;

      // Should have waited at least 100ms between requests
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some tolerance
    });

    it("uses custom delayMs option", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 1 }),
      } as Response);

      const startTime = Date.now();
      await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/1",
        {},
        { delayMs: 200 }
      );
      const elapsed = Date.now() - startTime;

      // Should be relatively quick since no previous request
      expect(elapsed).toBeLessThan(100);
    });

    it("uses custom maxRetries option", async () => {
      fetchSpy.mockRejectedValue(new Error("Network error"));

      await client.fetchThrottled(
        "https://api.github.com/repos/owner/repo/issues/1",
        {},
        { delayMs: 1, maxRetries: 1 }
      );

      expect(fetchSpy).toHaveBeenCalledTimes(2); // initial + 1 retry
    });
  });
});
