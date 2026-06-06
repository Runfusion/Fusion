import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAvailable: vi.fn(() => true),
    isGhAuthenticated: vi.fn(() => true),
    runGh: vi.fn(),
    runGhAsync: vi.fn(),
    runGhJson: vi.fn(),
    runGhJsonAsync: vi.fn(),
    getGhErrorMessage: vi.fn((err) => (err instanceof Error ? err.message : String(err))),
    getCurrentRepo: vi.fn(() => ({ owner: "owner", repo: "repo" })),
  };
});

import { runGh, runGhAsync, runGhJsonAsync, isGhAvailable, isGhAuthenticated } from "@fusion/core";
import { GitHubClient, PrStaleHeadError } from "../github.js";

const mockRunGh = vi.mocked(runGh);
const mockRunGhAsync = vi.mocked(runGhAsync);
const mockRunGhJsonAsync = vi.mocked(runGhJsonAsync);

const prView = {
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
  title: "T",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "fusion/t-1",
};

describe("GitHubClient PR thread + merge primitives (U2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
  });

  it("replies to a review thread via the GraphQL mutation", async () => {
    mockRunGhAsync.mockResolvedValue(JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "c1" } } } }));
    const client = new GitHubClient({ forceMode: "gh-cli" });
    await client.replyToReviewThread("THREAD_1", "thanks, fixed in abc123");
    const args = mockRunGhAsync.mock.calls[0][0] as string[];
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args.join(" ")).toContain("addPullRequestReviewThreadReply");
    expect(args).toContain("threadId=THREAD_1");
  });

  it("resolves a review thread via the GraphQL mutation", async () => {
    mockRunGhAsync.mockResolvedValue(JSON.stringify({ data: { resolveReviewThread: { thread: { id: "t", isResolved: true } } } }));
    const client = new GitHubClient({ forceMode: "gh-cli" });
    await client.resolveReviewThread("THREAD_2");
    const args = mockRunGhAsync.mock.calls[0][0] as string[];
    expect(args.join(" ")).toContain("resolveReviewThread");
    expect(args).toContain("threadId=THREAD_2");
  });

  it("surfaces a GraphQL error from a thread mutation", async () => {
    mockRunGhAsync.mockResolvedValue(JSON.stringify({ errors: [{ message: "Thread is locked" }] }));
    const client = new GitHubClient({ forceMode: "gh-cli" });
    await expect(client.replyToReviewThread("T", "x")).rejects.toThrow("Thread is locked");
  });

  it("passes --match-head-commit when expectedHeadOid is set", async () => {
    mockRunGh.mockReturnValue("" as never);
    mockRunGhJsonAsync.mockResolvedValue(prView as never);
    const client = new GitHubClient({ forceMode: "gh-cli" });
    await client.mergePr({ number: 42, expectedHeadOid: "deadbeef" });
    const args = mockRunGh.mock.calls[0][0] as string[];
    expect(args).toContain("--match-head-commit");
    expect(args).toContain("deadbeef");
  });

  it("raises PrStaleHeadError when the head moved (gh path)", async () => {
    mockRunGh.mockImplementation(() => {
      throw new Error("failed to merge: Head branch was modified. Review and try the merge again.");
    });
    const client = new GitHubClient({ forceMode: "gh-cli" });
    await expect(client.mergePr({ number: 42, expectedHeadOid: "deadbeef" })).rejects.toBeInstanceOf(PrStaleHeadError);
  });

  it("does not request a head match when expectedHeadOid is absent", async () => {
    mockRunGh.mockReturnValue("" as never);
    mockRunGhJsonAsync.mockResolvedValue(prView as never);
    const client = new GitHubClient({ forceMode: "gh-cli" });
    await client.mergePr({ number: 42 });
    const args = mockRunGh.mock.calls[0][0] as string[];
    expect(args).not.toContain("--match-head-commit");
  });
});
