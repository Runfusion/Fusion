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
    mockRunGh.mockReset();
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    mockGetGhErrorMessage.mockImplementation((err) => err instanceof Error ? err.message : String(err));
  });

  it.each([
    [undefined, "completed", "completed"],
    [undefined, "not_planned", "not planned"],
    ["gh-cli", "completed", "completed"],
    ["gh-cli", "not_planned", "not planned"],
  ] as const)("uses the CLI spelling for %s mode and %s reason", async (forceMode, stateReason, cliReason) => {
    const client = new GitHubClient({ forceMode });

    await client.setIssueState("owner", "repo", 123, "closed", stateReason);

    expect(mockRunGh).toHaveBeenCalledWith([
      "issue",
      "close",
      "123",
      "--repo",
      "owner/repo",
      "--reason",
      cliReason,
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

  it.each([
    [undefined, "completed"],
    [undefined, "not_planned"],
    ["token", "completed"],
    ["token", "not_planned"],
  ] as const)("preserves the REST spelling for %s mode and %s reason", async (forceMode, stateReason) => {
    mockIsGhAvailable.mockReturnValue(forceMode === "token");
    const client = new GitHubClient({ token: "ghp_token", forceMode });
    const fetchSpy = vi.spyOn(client, "fetchThrottled").mockResolvedValue({ success: true, data: { id: 1, state: "closed" } });

    await client.setIssueState("owner", "repo", 123, "closed", stateReason);

    expect(mockRunGh).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/123",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: "closed", state_reason: stateReason }),
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

  it.each(["completed", "not_planned"] as const)("preserves %s in REST fallback after a CLI failure", async (stateReason) => {
    mockRunGh.mockImplementation(() => {
      throw new Error("gh failed");
    });
    const client = new GitHubClient("ghp_token");
    const fetchSpy = vi.spyOn(client, "fetchThrottled").mockResolvedValue({ success: true, data: { id: 1, state: "closed" } });

    await client.setIssueState("owner", "repo", 123, "closed", stateReason);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/123",
      expect.objectContaining({ body: JSON.stringify({ state: "closed", state_reason: stateReason }) }),
    );
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
