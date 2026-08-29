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

import { runGh } from "@fusion/core";
import { GitHubClient } from "../github.js";

const mockRunGh = vi.mocked(runGh);

describe("GitHubClient.createPr draft/reviewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { draft: true, reviewers: ["alice", "bob"], expectsDraft: true, expectsReviewer: true },
    { draft: undefined, reviewers: [], expectsDraft: false, expectsReviewer: false },
  ])("passes gh flags %#", async ({ draft, reviewers, expectsDraft, expectsReviewer }) => {
    mockRunGh.mockReturnValue("https://github.com/owner/repo/pull/42\n");
    const client = new GitHubClient({ forceMode: "gh-cli" });

    await client.createPr({ title: "T", body: "B", head: "fusion/fn-001", base: "main", draft, reviewers });

    const args = mockRunGh.mock.calls[0][0];
    expect(args.includes("--draft")).toBe(expectsDraft);
    expect(args.includes("--reviewer")).toBe(expectsReviewer);
  });

  it("sends draft and reviewers through REST path", async () => {
    const client = new GitHubClient({ token: "ghp_token", forceMode: "token" });
    const fetchSpy = vi.spyOn(global, "fetch" as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 7, html_url: "https://github.com/owner/repo/pull/7", title: "T", state: "open", draft: true, head: { ref: "fusion/fn-001" }, base: { ref: "main" }, comments: 0 }),
      } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as any);

    await client.createPr({ title: "T", body: "B", head: "fusion/fn-001", base: "main", draft: true, reviewers: ["alice", "bob"] });

    expect(String(fetchSpy.mock.calls[0][1]?.body)).toContain('"draft":true');
    expect(fetchSpy.mock.calls[1][0]).toContain("/requested_reviewers");
    fetchSpy.mockRestore();
  });

  it("continues when reviewer request fails on REST path", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const client = new GitHubClient({ token: "ghp_token", forceMode: "token" });
    const fetchSpy = vi.spyOn(global, "fetch" as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 8, html_url: "https://github.com/owner/repo/pull/8", title: "T", state: "open", head: { ref: "fusion/fn-001" }, base: { ref: "main" }, comments: 0 }),
      } as any)
      .mockResolvedValueOnce({ ok: false, status: 422, statusText: "Unprocessable", json: async () => ({ message: "invalid reviewers" }) } as any);

    const pr = await client.createPr({ title: "T", body: "B", head: "fusion/fn-001", reviewers: ["alice"] });

    expect(pr.number).toBe(8);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed to request reviewers"));
    fetchSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
