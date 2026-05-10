import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const createIssueMock = vi.fn();
const resolveAuthMock = vi.fn();

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    createIssue: createIssueMock,
  })),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => resolveAuthMock(...args),
}));

import {
  formatTrackingIssueBody,
  formatTrackingIssueTitle,
  maybeCreateTrackingIssue,
} from "../github-tracking.js";

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "desc",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("formatTrackingIssueTitle", () => {
  it("formats a normal title", () => {
    expect(formatTrackingIssueTitle({ id: "FN-1", title: "Hello" })).toBe("[FN-1] Hello");
  });

  it("truncates very long titles while preserving id prefix", () => {
    const longTitle = "x".repeat(400);
    const formatted = formatTrackingIssueTitle({ id: "FN-123", title: longTitle });
    expect(formatted.startsWith("[FN-123] ")).toBe(true);
    expect(formatted.length).toBeLessThanOrEqual(240);
  });
});

describe("formatTrackingIssueBody", () => {
  it("prefers first description paragraph", () => {
    expect(formatTrackingIssueBody({
      id: "FN-X",
      description: "Primary paragraph\n\nSecond paragraph",
      prompt: "Prompt paragraph",
      summary: "Summary paragraph",
    })).toBe("Fusion task: FN-X\n\nPrimary paragraph");
  });
});

describe("maybeCreateTrackingIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAuthMock.mockReturnValue({ ok: true, auth: { mode: "token", token: "tok" } });
    createIssueMock.mockResolvedValue({
      owner: "o",
      repo: "r",
      number: 12,
      htmlUrl: "https://github.com/o/r/issues/12",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns tracking_disabled when not enabled", async () => {
    const result = await maybeCreateTrackingIssue(buildTask({ githubTracking: { enabled: false } }), {
      taskStore: {} as any,
      projectSettings: {},
      globalSettings: {},
    });
    expect(result).toEqual({ created: false, reason: "tracking_disabled" });
  });

  it("returns no_repo_configured and records activity", async () => {
    const recordActivity = vi.fn();
    const result = await maybeCreateTrackingIssue(buildTask({ githubTracking: { enabled: true } }), {
      taskStore: { recordActivity } as any,
      projectSettings: {},
      globalSettings: {},
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toEqual({ created: false, reason: "no_repo_configured" });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("creates issue, links metadata, and records activity", async () => {
    const linkGithubIssue = vi.fn();
    const recordActivity = vi.fn();

    const result = await maybeCreateTrackingIssue(buildTask({ title: "Test", description: "Short body", githubTracking: { enabled: true } }), {
      taskStore: { linkGithubIssue, recordActivity } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      logger: console,
    });

    expect(result.created).toBe(true);
    expect(createIssueMock).toHaveBeenCalledTimes(1);
    expect(linkGithubIssue).toHaveBeenCalledWith("FN-1", expect.objectContaining({ owner: "o", repo: "r", number: 12 }));
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ type: "github-issue-created", repo: "o/r", number: 12 }),
    }));
  });

  it("returns auth reason when resolver fails", async () => {
    resolveAuthMock.mockReturnValue({
      ok: false,
      requestedMode: "token",
      reason: "token_missing",
      message: "missing token",
    });
    const recordActivity = vi.fn();

    const result = await maybeCreateTrackingIssue(buildTask({ githubTracking: { enabled: true } }), {
      taskStore: { recordActivity } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toEqual({ created: false, reason: "auth_token_missing" });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ type: "github-issue-skipped", reason: "token_missing" }),
    }));
    expect(createIssueMock).not.toHaveBeenCalled();
  });
});
