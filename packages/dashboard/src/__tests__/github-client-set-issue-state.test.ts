import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../github.js";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    runGh: vi.fn(),
    getGhErrorMessage: vi.fn((err) => err instanceof Error ? err.message : String(err)),
  };
});

import {
  getGhErrorMessage,
  isGhAuthenticated,
  isGhAvailable,
  runGh,
} from "@fusion/core";

const mockIsGhAvailable = vi.mocked(isGhAvailable);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockRunGh = vi.mocked(runGh);
const mockGetGhErrorMessage = vi.mocked(getGhErrorMessage);

describe("GitHubClient.setIssueState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    mockGetGhErrorMessage.mockImplementation((err) => err instanceof Error ? err.message : String(err));
  });

  it("uses gh issue close with reason when authenticated", async () => {
    const client = new GitHubClient();

    await client.setIssueState("owner", "repo", 123, "closed", "completed");

    expect(mockRunGh).toHaveBeenCalledWith([
      "issue",
      "close",
      "123",
      "--repo",
      "owner/repo",
      "--reason",
      "completed",
    ]);
  });

  it("uses gh issue close without reason when no reason provided", async () => {
    const client = new GitHubClient();

    await client.setIssueState("owner", "repo", 123, "closed");

    expect(mockRunGh).toHaveBeenCalledWith([
      "issue",
      "close",
      "123",
      "--repo",
      "owner/repo",
    ]);
  });

  it("uses gh issue reopen when opening and ignores reason", async () => {
    const client = new GitHubClient();

    await client.setIssueState("owner", "repo", 123, "open", "reopened");

    expect(mockRunGh).toHaveBeenCalledWith([
      "issue",
      "reopen",
      "123",
      "--repo",
      "owner/repo",
    ]);
  });

  it("uses REST when gh auth unavailable and token exists for closed state", async () => {
    mockIsGhAvailable.mockReturnValue(false);
    const client = new GitHubClient("ghp_token");
    const fetchSpy = vi.spyOn(client, "fetchThrottled").mockResolvedValue({ success: true, data: { id: 1, state: "closed" } });

    await client.setIssueState("owner", "repo", 123, "closed", "completed");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/123",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      },
    );
  });

  it("uses REST for reopen with reopened reason", async () => {
    mockIsGhAvailable.mockReturnValue(false);
    const client = new GitHubClient("ghp_token");
    const fetchSpy = vi.spyOn(client, "fetchThrottled").mockResolvedValue({ success: true, data: { id: 1, state: "open" } });

    await client.setIssueState("owner", "repo", 123, "open", "reopened");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/123",
      expect.objectContaining({
        body: JSON.stringify({ state: "open", state_reason: "reopened" }),
      }),
    );
  });

  it("omits state_reason when undefined on REST path", async () => {
    mockIsGhAvailable.mockReturnValue(false);
    const client = new GitHubClient("ghp_token");
    const fetchSpy = vi.spyOn(client, "fetchThrottled").mockResolvedValue({ success: true, data: { id: 1, state: "open" } });

    await client.setIssueState("owner", "repo", 123, "open");

    const call = fetchSpy.mock.calls[0];
    const body = call?.[1]?.body;
    expect(body).toBeDefined();
    expect(JSON.parse(String(body))).toEqual({ state: "open" });
  });

  it("falls back to REST when gh command throws and token exists", async () => {
    mockRunGh.mockImplementation(() => {
      throw new Error("gh failed");
    });
    const client = new GitHubClient("ghp_token");
    const fetchSpy = vi.spyOn(client, "fetchThrottled").mockResolvedValue({ success: true, data: { id: 1, state: "closed" } });

    await client.setIssueState("owner", "repo", 123, "closed", "completed");

    expect(fetchSpy).toHaveBeenCalled();
  });

  it("throws wrapped gh error when gh command fails and no token", async () => {
    mockRunGh.mockImplementation(() => {
      throw new Error("gh failed");
    });
    const client = new GitHubClient();

    await expect(client.setIssueState("owner", "repo", 123, "closed", "completed")).rejects.toThrow("gh failed");
    expect(mockGetGhErrorMessage).toHaveBeenCalled();
  });

  it("throws explicit message when gh auth unavailable and no token", async () => {
    mockIsGhAvailable.mockReturnValue(false);
    mockIsGhAuthenticated.mockReturnValue(false);
    const client = new GitHubClient();

    await expect(client.setIssueState("owner", "repo", 123, "closed", "completed")).rejects.toThrow(
      "GitHub CLI (gh) is not available or not authenticated, and no GITHUB_TOKEN provided.",
    );
  });

  it("throws REST error message when PATCH fails", async () => {
    mockIsGhAvailable.mockReturnValue(false);
    const client = new GitHubClient("ghp_token");
    vi.spyOn(client, "fetchThrottled").mockResolvedValue({ success: false, error: "rate limited" });

    await expect(client.setIssueState("owner", "repo", 123, "closed", "completed")).rejects.toThrow("rate limited");
  });
});
