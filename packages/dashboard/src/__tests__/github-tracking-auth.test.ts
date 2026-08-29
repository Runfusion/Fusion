import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { maybeCreateTrackingIssue } from "../github-tracking.js";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
    runGhAsync: vi.fn(),
    runGhJsonAsync: vi.fn(),
  };
});

import { isGhAuthenticated, isGhAvailable, runGhAsync, runGhJsonAsync } from "@fusion/core";

const mockIsGhAvailable = vi.mocked(isGhAvailable);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockRunGhAsync = vi.mocked(runGhAsync);
const mockRunGhJsonAsync = vi.mocked(runGhJsonAsync);

function task(): Task {
  return {
    id: "FN-7",
    title: "Track me",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    githubTracking: { enabled: true },
  } as Task;
}

describe("tracking auth mode integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    mockRunGhAsync.mockResolvedValue("https://github.com/o/r/issues/5");
    mockRunGhJsonAsync.mockResolvedValue({ url: "https://github.com/o/r/issues/5", number: 5, createdAt: "2026-01-01T00:00:00.000Z" } as any);
  });

  it("token mode uses REST and not gh", async () => {
    const fetchSpy = vi.spyOn(global, "fetch" as never).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ number: 5, html_url: "https://github.com/o/r/issues/5", created_at: "2026-01-01T00:00:00.000Z" }),
    } as never);

    await maybeCreateTrackingIssue(task(), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: { githubAuthMode: "token", githubAuthToken: "token" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir: "/tmp/test",
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(mockRunGhJsonAsync).not.toHaveBeenCalled();
  });

  it("token mode missing token returns auth_token_missing", async () => {
    const recordActivity = vi.fn();
    const fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
      throw new Error("fetch should not run");
    });

    const result = await maybeCreateTrackingIssue(task(), {
      taskStore: { recordActivity } as any,
      projectSettings: { githubAuthMode: "token", githubAuthToken: "" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir: "/tmp/test",
    });

    expect(result).toEqual({ created: false, reason: "auth_token_missing" });
    expect(recordActivity).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gh-cli mode uses gh and not REST", async () => {
    const fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
      throw new Error("fetch should not run");
    });

    await maybeCreateTrackingIssue(task(), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: { githubAuthMode: "gh-cli" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir: "/tmp/test",
    });

    expect(mockRunGhJsonAsync).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gh unavailable returns auth_gh_not_installed", async () => {
    mockIsGhAvailable.mockReturnValue(false);
    const result = await maybeCreateTrackingIssue(task(), {
      taskStore: { recordActivity: vi.fn() } as any,
      projectSettings: { githubAuthMode: "gh-cli" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir: "/tmp/test",
    });

    expect(result).toEqual({ created: false, reason: "auth_gh_not_installed" });
  });

  it("default mode uses gh-cli", async () => {
    await maybeCreateTrackingIssue(task(), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: {} as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir: "/tmp/test",
    });

    expect(mockRunGhJsonAsync).toHaveBeenCalled();
  });
});
