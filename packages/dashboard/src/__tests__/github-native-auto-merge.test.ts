import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAvailable: vi.fn(() => true),
    isGhAuthenticated: vi.fn(() => true),
    runGh: vi.fn(),
    runGhAsync: vi.fn(),
  };
});

import { runGh, runGhAsync } from "@fusion/core";
import { GitHubClient, PrAutoMergeUnavailableError } from "../github.js";

const openPr = { number: 8, url: "https://github.test/o/r/pull/8", status: "open" as const, title: "PR", headBranch: "head", baseBranch: "main", commentCount: 0 };

function client(mode: "gh-cli" | "token", getPrStatus = vi.fn().mockResolvedValue(openPr)) {
  const result = new GitHubClient({ token: "token", forceMode: mode });
  vi.spyOn(result, "getPrStatus").mockImplementation(getPrStatus);
  return result;
}

function graphqlResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GitHubClient native auto-merge", () => {
  it("uses gh --auto without a head fence", async () => {
    const github = client("gh-cli");
    await github.mergePr({ owner: "o", repo: "r", number: 8, auto: true, expectedHeadOid: "ignored" });

    expect(runGh).toHaveBeenCalledWith([
      "pr", "merge", "8", "--repo", "o/r", "--squash", "--auto", "--delete-branch",
    ]);
    expect(vi.mocked(runGh).mock.calls[0]?.[0]).not.toContain("--match-head-commit");
  });

  it("preserves the legacy gh argv when auto is unset", async () => {
    const github = client("gh-cli");
    await github.mergePr({ owner: "o", repo: "r", number: 8, method: "merge", expectedHeadOid: "head" });

    expect(runGh).toHaveBeenCalledWith([
      "pr", "merge", "8", "--repo", "o/r", "--merge", "--delete-branch", "--match-head-commit", "head",
    ]);
  });

  it.each([
    [undefined, "SQUASH"],
    ["rebase", "REBASE"],
    ["merge", "MERGE"],
  ] as const)("enables token auto-merge with %s as %s and returns the live open state", async (method, enumValue) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(graphqlResponse({ repository: { pullRequest: { id: "PR_node" } } }))
      .mockResolvedValueOnce(graphqlResponse({ enablePullRequestAutoMerge: { pullRequest: { id: "PR_node" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const github = client("token");

    const result = await github.mergePr({ owner: "o", repo: "r", number: 8, auto: true, ...(method ? { method } : {}) });

    expect(result.status).toBe("open");
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/pulls/8/merge") || init?.method === "PUT")).toBe(false);
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain(`mergeMethod: ${enumValue}`);
  });

  it("pins the API mutation to fetch even when gh auth is available", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(graphqlResponse({ repository: { pullRequest: { id: "PR_node" } } }))
      .mockResolvedValueOnce(graphqlResponse({ enablePullRequestAutoMerge: { pullRequest: { id: "PR_node" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const github = client("token");

    await github.mergePr({ owner: "o", repo: "r", number: 8, auto: true });

    expect(runGhAsync).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/graphql", expect.objectContaining({ method: "POST" }));
  });

  it("preserves auto through a gh-to-token fallback without issuing a REST merge", async () => {
    vi.mocked(runGh).mockImplementation(() => { throw new Error("gh transient failure"); });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(graphqlResponse({ repository: { pullRequest: { id: "PR_node" } } }))
      .mockResolvedValueOnce(graphqlResponse({ enablePullRequestAutoMerge: { pullRequest: { id: "PR_node" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const github = client("gh-cli");

    await github.mergePr({ owner: "o", repo: "r", number: 8, auto: true });

    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain("enablePullRequestAutoMerge");
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/pulls/8/merge") || init?.method === "PUT")).toBe(false);
  });

  it.each(["gh-cli", "token"] as const)("fails closed when %s reports native auto-merge unavailable", async (mode) => {
    const github = client(mode);
    if (mode === "gh-cli") {
      vi.mocked(runGh).mockImplementation(() => { throw new Error("Pull request auto merge is not allowed for this repository"); });
    } else {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(graphqlResponse({ repository: { pullRequest: { id: "PR_node" } } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Pull request auto merge is not allowed for this repository" }] }), { status: 200 })));
    }

    await expect(github.mergePr({ owner: "o", repo: "r", number: 8, auto: true })).rejects.toBeInstanceOf(PrAutoMergeUnavailableError);
    expect(vi.mocked(runGh).mock.calls.filter(([args]) => args.includes("--auto"))).toHaveLength(mode === "gh-cli" ? 1 : 0);
  });
});
