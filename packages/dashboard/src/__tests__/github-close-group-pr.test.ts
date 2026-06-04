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

import { runGh, runGhJsonAsync, isGhAvailable, isGhAuthenticated } from "@fusion/core";
import { GitHubClient, closeGroupPullRequest, reconcileGroupPullRequest } from "../github.js";

const mockRunGh = vi.mocked(runGh);
const mockRunGhJsonAsync = vi.mocked(runGhJsonAsync);
const mockIsGhAvailable = vi.mocked(isGhAvailable);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);

const group = {
  id: "BG-1",
  branchName: "fusion/groups/planning-x",
  sourceType: "planning" as const,
  sourceId: "PS-1",
  prNumber: 42,
};

const ghPrViewOpen = {
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
  title: "T",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: group.branchName,
};

describe("closeGroupPullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
  });

  it("closes an open PR via the gh-CLI backend", async () => {
    mockRunGhJsonAsync.mockResolvedValue({ ...ghPrViewOpen, state: "CLOSED" } as any);
    // First getPrStatus returns open, then close, then getPrStatus returns closed.
    mockRunGhJsonAsync
      .mockResolvedValueOnce(ghPrViewOpen as any)
      .mockResolvedValueOnce({ ...ghPrViewOpen, state: "CLOSED" } as any);
    const client = new GitHubClient({ forceMode: undefined as never });

    const result = await closeGroupPullRequest(client, { id: group.id, prNumber: group.prNumber });

    expect(result.prState).toBe("closed");
    const closeArgs = mockRunGh.mock.calls.find((c) => c[0]?.[0] === "pr" && c[0]?.[1] === "close")?.[0];
    expect(closeArgs).toEqual(expect.arrayContaining(["pr", "close", "42"]));
  });

  it("reconciles (no close) when the PR is already merged out-of-band", async () => {
    mockRunGhJsonAsync.mockResolvedValue({ ...ghPrViewOpen, state: "MERGED" } as any);
    const client = new GitHubClient({ forceMode: undefined as never });

    const result = await closeGroupPullRequest(client, { id: group.id, prNumber: group.prNumber });
    expect(result.prState).toBe("merged");
    expect(mockRunGh.mock.calls.find((c) => c[0]?.[1] === "close")).toBeUndefined();
  });
});

describe("reconcileGroupPullRequest (Fix #3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
  });

  it("maps a merged GitHub PR to prState=merged without mutating it", async () => {
    mockRunGhJsonAsync.mockResolvedValue({ ...ghPrViewOpen, state: "MERGED" } as any);
    const client = new GitHubClient({ forceMode: undefined as never });

    const result = await reconcileGroupPullRequest(client, { id: group.id, prNumber: group.prNumber });
    expect(result.prState).toBe("merged");
    // Pure read — never edits or closes.
    expect(mockRunGh.mock.calls.find((c) => c[0]?.[1] === "close" || c[0]?.[1] === "edit")).toBeUndefined();
  });

  it("returns prState=open for a still-open PR", async () => {
    mockRunGhJsonAsync.mockResolvedValue(ghPrViewOpen as any);
    const client = new GitHubClient({ forceMode: undefined as never });

    const result = await reconcileGroupPullRequest(client, { id: group.id, prNumber: group.prNumber });
    expect(result.prState).toBe("open");
  });
});
