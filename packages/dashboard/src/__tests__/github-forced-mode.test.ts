import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    runGh: vi.fn(),
    runGhJsonAsync: vi.fn(),
    getGhErrorMessage: vi.fn((error) => error instanceof Error ? error.message : String(error)),
  };
});

import { getGhErrorMessage, isGhAuthenticated, isGhAvailable, runGh, runGhJsonAsync } from "@fusion/core";
import { GitHubClient } from "../github.js";

const mockIsGhAvailable = vi.mocked(isGhAvailable);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockRunGh = vi.mocked(runGh);
const mockRunGhJsonAsync = vi.mocked(runGhJsonAsync);
const mockGetGhErrorMessage = vi.mocked(getGhErrorMessage);

describe("GitHubClient forced mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    mockGetGhErrorMessage.mockImplementation((error: unknown) => error instanceof Error ? error.message : String(error));
  });

  it("forced token mode uses only REST path", async () => {
    const fetchSpy = vi.spyOn(global, "fetch" as never).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ number: 1, html_url: "https://github.com/o/r/issues/1", created_at: "2026-01-01T00:00:00.000Z" }),
    } as never);
    mockRunGhJsonAsync.mockRejectedValue(new Error("gh should not run"));

    const client = new GitHubClient({ token: "token-123", forceMode: "token" });
    await client.createIssue({ owner: "o", repo: "r", title: "t", body: "b" });

    expect(fetchSpy).toHaveBeenCalled();
    expect(mockRunGhJsonAsync).not.toHaveBeenCalled();
  });

  it("forced token mode without token throws before network", async () => {
    const fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
      throw new Error("fetch should not run");
    });
    const client = new GitHubClient({ forceMode: "token" });

    await expect(client.createIssue({ owner: "o", repo: "r", title: "t", body: "b" })).rejects.toThrow("forced to token mode");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockRunGhJsonAsync).not.toHaveBeenCalled();
  });

  it("forced gh-cli mode uses only gh path", async () => {
    mockRunGhJsonAsync.mockResolvedValue({ url: "https://github.com/o/r/issues/2", number: 2, createdAt: "2026-01-02T00:00:00.000Z" } as never);
    const fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
      throw new Error("fetch should not run");
    });

    const client = new GitHubClient({ forceMode: "gh-cli" });
    await client.createIssue({ owner: "o", repo: "r", title: "t", body: "b" });

    expect(mockRunGhJsonAsync).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forced gh-cli mode without gh throws before network", async () => {
    mockIsGhAvailable.mockReturnValue(false);
    const fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
      throw new Error("fetch should not run");
    });
    const client = new GitHubClient({ forceMode: "gh-cli" });

    await expect(client.createIssue({ owner: "o", repo: "r", title: "t", body: "b" })).rejects.toThrow("gh CLI is not available");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockRunGhJsonAsync).not.toHaveBeenCalled();
  });

  it("legacy constructor keeps opportunistic fallback semantics", async () => {
    mockRunGh.mockImplementation(() => {
      throw new Error("gh failed");
    });
    const fetchSpy = vi.spyOn(global, "fetch" as never).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ number: 3, html_url: "https://github.com/o/r/pull/3", title: "t", state: "open", head: { ref: "head" }, base: { ref: "main" }, comments: 0 }),
    } as never);

    const client = new GitHubClient("token-legacy");
    await client.createPr({ owner: "o", repo: "r", title: "t", head: "head", base: "main" });

    expect(mockRunGh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("requireToken throws when token missing", () => {
    const client = new GitHubClient({ forceMode: "token" });
    expect(() => (client as any).requireToken()).toThrow("forced to token mode");
  });

  it("requireGh throws when gh unavailable or unauthenticated", () => {
    const client = new GitHubClient({ forceMode: "gh-cli" });

    mockIsGhAvailable.mockReturnValue(false);
    expect(() => (client as any).requireGh()).toThrow("gh CLI is not available");

    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(false);
    expect(() => (client as any).requireGh()).toThrow("gh CLI is not authenticated");
  });
});
