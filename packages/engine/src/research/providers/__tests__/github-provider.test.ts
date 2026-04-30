import { beforeEach, describe, expect, it, vi } from "vitest";

const { runGhAsyncMock, runGhJsonAsyncMock, isGhAvailableMock, isGhAuthenticatedMock } = vi.hoisted(() => ({
  runGhAsyncMock: vi.fn(),
  runGhJsonAsyncMock: vi.fn(),
  isGhAvailableMock: vi.fn(),
  isGhAuthenticatedMock: vi.fn(),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    runGhAsync: runGhAsyncMock,
    runGhJsonAsync: runGhJsonAsyncMock,
    isGhAvailable: isGhAvailableMock,
    isGhAuthenticated: isGhAuthenticatedMock,
  };
});

import { GitHubProvider } from "../github-provider.js";

describe("GitHubProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGhAvailableMock.mockReturnValue(true);
    isGhAuthenticatedMock.mockReturnValue(true);
  });

  it("searches repositories", async () => {
    runGhJsonAsyncMock.mockResolvedValueOnce([
      { fullName: "org/repo", description: "desc", htmlUrl: "https://github.com/org/repo", stargazersCount: 12, language: "ts", updatedAt: "2026" },
    ]);
    const provider = new GitHubProvider();

    const results = await provider.search("query", { metadata: { searchType: "repos" } });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "github", title: "org/repo", reference: "https://github.com/org/repo" });
  });

  it("searches issues", async () => {
    runGhJsonAsyncMock.mockResolvedValueOnce([
      { title: "Issue", body: "body", htmlUrl: "https://github.com/org/repo/issues/1", state: "open", labels: [{ name: "bug" }] },
    ]);

    const provider = new GitHubProvider();
    const results = await provider.search("query", { metadata: { searchType: "issues" } });

    expect(results[0]?.metadata).toMatchObject({ resultType: "issue", state: "open", labels: ["bug"] });
  });

  it("supports combined search", async () => {
    runGhJsonAsyncMock
      .mockResolvedValueOnce([{ fullName: "org/repo", htmlUrl: "https://github.com/org/repo" }])
      .mockResolvedValueOnce([{ title: "Issue", htmlUrl: "https://github.com/org/repo/issues/1" }]);

    const provider = new GitHubProvider();
    const results = await provider.search("query", {});
    expect(results).toHaveLength(2);
  });

  it("fetches repo README", async () => {
    runGhJsonAsyncMock.mockResolvedValueOnce({
      content: Buffer.from("# Hello").toString("base64"),
      encoding: "base64",
      name: "README.md",
    });

    const provider = new GitHubProvider();
    const result = await provider.fetchContent("https://github.com/org/repo", {});

    expect(result.content).toContain("# Hello");
    expect(result.metadata).toMatchObject({ kind: "repo-readme" });
  });

  it("fetches issue content", async () => {
    runGhAsyncMock.mockResolvedValueOnce("Issue body\nComments");

    const provider = new GitHubProvider();
    const result = await provider.fetchContent("https://github.com/org/repo/issues/123", {});

    expect(result.content).toContain("Issue body");
    expect(result.metadata).toMatchObject({ kind: "issue", number: "123" });
  });

  it("fetches pr content", async () => {
    runGhAsyncMock.mockResolvedValueOnce("PR body\nComments");

    const provider = new GitHubProvider();
    const result = await provider.fetchContent("https://github.com/org/repo/pull/9", {});
    expect(result.metadata).toMatchObject({ kind: "pr", number: "9" });
  });

  it("fetches file content from blob url", async () => {
    runGhJsonAsyncMock.mockResolvedValueOnce({
      content: Buffer.from("file content").toString("base64"),
      encoding: "base64",
      name: "index.ts",
    });

    const provider = new GitHubProvider();
    const result = await provider.fetchContent("https://github.com/org/repo/blob/main/src/index.ts", {});
    expect(result.content).toContain("file content");
    expect(result.metadata).toMatchObject({ kind: "file", path: "src/index.ts" });
  });

  it("reports configuration state", () => {
    const provider = new GitHubProvider();
    expect(provider.isConfigured()).toBe(true);

    isGhAvailableMock.mockReturnValue(false);
    expect(provider.isConfigured()).toBe(false);

    isGhAvailableMock.mockReturnValue(true);
    isGhAuthenticatedMock.mockReturnValue(false);
    expect(provider.isConfigured()).toBe(false);
  });

  it("maps abort and timeout errors", async () => {
    runGhJsonAsyncMock.mockRejectedValueOnce(Object.assign(new Error("gh command aborted"), { code: "ABORT_ERR", stderr: "", stdout: "" }));
    const provider = new GitHubProvider();
    await expect(provider.search("q", {})).rejects.toMatchObject({ code: "abort" });

    runGhJsonAsyncMock.mockRejectedValueOnce(Object.assign(new Error("gh command timed out after 30000ms"), { code: null, stderr: "", stdout: "" }));
    await expect(provider.search("q", {})).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps rate limit and auth failures", async () => {
    const provider = new GitHubProvider();

    runGhJsonAsyncMock.mockRejectedValueOnce(Object.assign(new Error("API rate limit exceeded"), { code: 403, stderr: "", stdout: "" }));
    await expect(provider.search("q", {})).rejects.toMatchObject({ code: "rate-limited", retryable: true });

    runGhJsonAsyncMock.mockRejectedValueOnce(Object.assign(new Error("authentication required"), { code: 401, stderr: "", stdout: "" }));
    await expect(provider.search("q", {})).rejects.toMatchObject({ code: "auth-failed" });
  });

  it("errors on unsupported urls", async () => {
    const provider = new GitHubProvider();
    await expect(provider.fetchContent("https://example.com/a", {})).rejects.toMatchObject({ code: "provider-unavailable" });
  });
});
