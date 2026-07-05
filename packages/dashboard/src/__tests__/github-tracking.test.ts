import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const createIssueMock = vi.fn();
const searchIssuesMock = vi.fn();
const resolveAuthMock = vi.fn();
const summarizeTitleMock = vi.fn();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    summarizeTitle: (...args: unknown[]) => summarizeTitleMock(...args),
  };
});

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function () { return {
    createIssue: createIssueMock,
    searchIssues: searchIssuesMock,
  }; }),
}));

vi.mock("../github-auth.js", () => ({
  resolveGithubTrackingAuth: (...args: unknown[]) => resolveAuthMock(...args),
}));

import { AiServiceError, MIN_DESCRIPTION_LENGTH } from "@fusion/core";
import {
  deriveTitleFromDescription,
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

describe("deriveTitleFromDescription", () => {
  it("returns null for empty input", () => {
    expect(deriveTitleFromDescription(undefined, 40)).toBeNull();
    expect(deriveTitleFromDescription("   \n\n ", 40)).toBeNull();
  });

  it("uses the first non-empty line for a single-line description", () => {
    expect(deriveTitleFromDescription("Build the GitHub tracking issue title", 80)).toBe(
      "Build the GitHub tracking issue title",
    );
  });

  it("uses the first non-empty line from a later paragraph without joining lines", () => {
    expect(deriveTitleFromDescription("\n\nFirst paragraph title\nMore detail here\n\nSecond paragraph", 80)).toBe(
      "First paragraph title",
    );
  });

  it("strips leading heading, list, and quote markers", () => {
    expect(deriveTitleFromDescription("> ## - Ship GitHub tracking fallback\nFollow-up detail", 80)).toBe(
      "Ship GitHub tracking fallback",
    );
  });

  it("skips fenced code blocks at the top", () => {
    expect(deriveTitleFromDescription("```ts\nconst title = 'ignore me';\n```\nReal title line", 80)).toBe(
      "Real title line",
    );
  });

  it("truncates long derived titles with an ellipsis", () => {
    expect(deriveTitleFromDescription("abcdefghijk", 8)).toBe("abcdefg…");
  });

  it.each([
    ["Sentence one. Sentence two", "Sentence one."],
    ["Ship it! Then celebrate", "Ship it!"],
    ["Question first? Answer later", "Question first?"],
  ])("truncates at the first sentence terminator for %s", (input, expected) => {
    expect(deriveTitleFromDescription(input, 80)).toBe(expected);
  });
});

describe("formatTrackingIssueTitle", () => {
  it("formats a normal title", () => {
    expect(formatTrackingIssueTitle({ id: "FN-1", title: "Hello" })).toBe("[FN-1] Hello");
  });

  it("derives the title from description when the title is empty", () => {
    expect(formatTrackingIssueTitle({ id: "FN-1", title: "", description: "Ship GitHub tracking fallback" })).toBe(
      "[FN-1] Ship GitHub tracking fallback",
    );
  });

  it("derives the title from description when the title is whitespace only", () => {
    expect(formatTrackingIssueTitle({ id: "FN-1", title: "   ", description: "Use description instead" })).toBe(
      "[FN-1] Use description instead",
    );
  });

  it("falls back to untitled task only when title and description are both empty", () => {
    expect(formatTrackingIssueTitle({ id: "FN-1", title: "   ", description: "\n\n  " })).toBe("[FN-1] Untitled task");
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

  it("does not include full prompt content or fusion hyperlinks", () => {
    const body = formatTrackingIssueBody({
      id: "FN-X",
      description: "Short summary only",
      prompt: "# PROMPT\nhttp://localhost:4040/tasks/FN-X\nFull private prompt",
    });

    expect(body).toContain("Fusion task: FN-X");
    expect(body).toContain("Short summary only");
    expect(body).not.toContain("localhost:4040/tasks/FN-X");
    expect(body).not.toContain("Full private prompt");
  });
});

describe("maybeCreateTrackingIssue", () => {
  const rootDir = "/tmp/test";
  const longDescription = `Derived fallback title. ${"a".repeat(MIN_DESCRIPTION_LENGTH)}`;

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
    summarizeTitleMock.mockResolvedValue(null);
    searchIssuesMock.mockResolvedValue([]);
  });

  it("returns tracking_disabled when not enabled", async () => {
    const result = await maybeCreateTrackingIssue(buildTask({ githubTracking: { enabled: false } }), {
      taskStore: {} as any,
      projectSettings: {},
      globalSettings: {},
      rootDir,
    });
    expect(result).toEqual({ created: false, reason: "tracking_disabled" });
  });

  it("returns issue_already_linked and does not create again", async () => {
    const result = await maybeCreateTrackingIssue(buildTask({
      githubTracking: {
        enabled: true,
        issue: { owner: "task", repo: "repo", number: 99, url: "https://github.com/task/repo/issues/99" },
      },
    }), {
      taskStore: {} as any,
      projectSettings: { githubTrackingDefaultRepo: "task/repo", githubAuthMode: "token", githubAuthToken: "tok" } as any,
      globalSettings: {},
      rootDir,
    });

    expect(result).toEqual({ created: false, reason: "issue_already_linked" });
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("returns issue_already_linked when store refresh shows a linked issue on a stale task reference", async () => {
    const staleTask = buildTask({ githubTracking: { enabled: true } });
    const getTask = vi.fn().mockResolvedValue(buildTask({
      id: staleTask.id,
      githubTracking: {
        enabled: true,
        issue: { owner: "task", repo: "repo", number: 101, url: "https://github.com/task/repo/issues/101" },
      },
    }));

    const result = await maybeCreateTrackingIssue(staleTask, {
      taskStore: { getTask } as any,
      projectSettings: { githubTrackingDefaultRepo: "task/repo", githubAuthMode: "token", githubAuthToken: "tok" } as any,
      globalSettings: {},
      rootDir,
    });

    expect(result).toEqual({ created: false, reason: "issue_already_linked" });
    expect(getTask).toHaveBeenCalledWith(staleTask.id);
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("returns no_repo_configured and records activity", async () => {
    const recordActivity = vi.fn();
    const result = await maybeCreateTrackingIssue(buildTask({ githubTracking: { enabled: true } }), {
      taskStore: { recordActivity } as any,
      projectSettings: {},
      globalSettings: {},
      rootDir,
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
      rootDir,
      logger: console,
    });

    expect(result.created).toBe(true);
    expect(createIssueMock).toHaveBeenCalledTimes(1);
    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining("[FN-1]"),
      body: expect.stringContaining("Fusion task: FN-1"),
    }));
    expect(linkGithubIssue).toHaveBeenCalledWith("FN-1", expect.objectContaining({ owner: "o", repo: "r", number: 12 }));
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ type: "github-issue-created", repo: "o/r", number: 12 }),
    }));
  });

  it("links existing issue when dedup match is found", async () => {
    const linkGithubIssue = vi.fn();
    const recordActivity = vi.fn();

    // FNXC:GithubTracking Only OPEN issues may be reused (a shared File-Scope path is present here).
    searchIssuesMock.mockResolvedValue([
      {
        number: 400,
        title: "Diff route truncation in packages/dashboard/src/routes/register-session-diff-routes.ts",
        body: "rebase-merge path drops output",
        html_url: "https://github.com/o/r/issues/400",
        state: "open",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    const result = await maybeCreateTrackingIssue(buildTask({
      title: "Fix rebase-merge truncation in registerSessionDiffRoutes",
      description: "## File Scope\n- packages/dashboard/src/routes/register-session-diff-routes.ts",
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue, recordActivity } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toEqual({ created: false, reason: "existing_issue_found" });
    expect(createIssueMock).not.toHaveBeenCalled();
    expect(linkGithubIssue).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      owner: "o",
      repo: "r",
      number: 400,
      url: "https://github.com/o/r/issues/400",
    }));
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ type: "github-issue-dedup-matched", number: 400 }),
    }));
  });

  // FNXC:GithubTracking 2026-07-05 Regression (FN-7579): dedup mis-linked new tasks to old/stale issues.
  // Surfaces: (1) a resolved CLOSED issue that path+keyword-matches must NOT be reused; (2) an OPEN
  // issue that matches only on generic keywords (zero File-Scope path overlap) must NOT be reused.
  // Invariant: the only reusable candidate is an OPEN issue sharing at least one File-Scope path.
  it("does not reuse a CLOSED issue even when file scope and keywords match (FN-7579 stale-issue regression)", async () => {
    const linkGithubIssue = vi.fn();

    searchIssuesMock.mockResolvedValue([
      {
        number: 500,
        title: "Diff route truncation in packages/dashboard/src/routes/register-session-diff-routes.ts",
        body: "rebase-merge truncation resolved long ago",
        html_url: "https://github.com/o/r/issues/500",
        state: "closed",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await maybeCreateTrackingIssue(buildTask({
      title: "Fix rebase-merge truncation in registerSessionDiffRoutes",
      description: "## File Scope\n- packages/dashboard/src/routes/register-session-diff-routes.ts",
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue, recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toMatchObject({ created: true });
    expect(createIssueMock).toHaveBeenCalledTimes(1);
    expect(linkGithubIssue).toHaveBeenCalledWith("FN-1", expect.objectContaining({ number: 12 }));
    expect(linkGithubIssue).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ number: 500 }));
  });

  it("does not reuse an OPEN issue matched on keywords only when no file-scope path overlaps (FN-7579)", async () => {
    const linkGithubIssue = vi.fn();

    // Shares generic identifiers (truncation / registerSessionDiffRoutes) but references a DIFFERENT file.
    searchIssuesMock.mockResolvedValue([
      {
        number: 501,
        title: "truncation bug in registerSessionDiffRoutes helper",
        body: "affects packages/dashboard/src/routes/register-other-routes.ts truncation registerSessionDiffRoutes",
        html_url: "https://github.com/o/r/issues/501",
        state: "open",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);

    const result = await maybeCreateTrackingIssue(buildTask({
      title: "Fix rebase-merge truncation in registerSessionDiffRoutes",
      description: "## File Scope\n- packages/dashboard/src/routes/register-session-diff-routes.ts",
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue, recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toMatchObject({ created: true });
    expect(createIssueMock).toHaveBeenCalledTimes(1);
    expect(linkGithubIssue).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ number: 501 }));
  });

  it("falls through to create issue when dedup search has no qualifying match", async () => {
    searchIssuesMock.mockResolvedValue([
      {
        number: 401,
        title: "Unrelated docs cleanup",
        body: "touches readme only",
        html_url: "https://github.com/o/r/issues/401",
        state: "closed",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    const result = await maybeCreateTrackingIssue(buildTask({
      title: "Fix rebase-merge truncation in registerSessionDiffRoutes",
      description: "## File Scope\n- packages/dashboard/src/routes/register-session-diff-routes.ts",
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(searchIssuesMock).toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ created: true });
  });

  it("skips dedup search when disabled in project settings", async () => {
    await maybeCreateTrackingIssue(buildTask({
      title: "Fix rebase-merge truncation in registerSessionDiffRoutes",
      description: "## File Scope\n- packages/dashboard/src/routes/register-session-diff-routes.ts",
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: { githubTrackingDedupEnabled: false } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(searchIssuesMock).not.toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledTimes(1);
  });

  it("continues issue creation when dedup search errors", async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    searchIssuesMock.mockRejectedValue(new Error("search failed"));

    const result = await maybeCreateTrackingIssue(buildTask({
      title: "Fix rebase-merge truncation in registerSessionDiffRoutes",
      description: "## File Scope\n- packages/dashboard/src/routes/register-session-diff-routes.ts",
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger,
    });

    expect(result).toMatchObject({ created: true });
    expect(createIssueMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("duplicate-search failed"));
  });

  it("skips dedup search when there is no file-scope or keyword signal", async () => {
    await maybeCreateTrackingIssue(buildTask({
      title: "Fix bug",
      description: "tiny",
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(searchIssuesMock).not.toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledTimes(1);
  });

  it("links GitHub sourceIssue instead of creating a duplicate", async () => {
    const linkGithubIssue = vi.fn();
    const recordActivity = vi.fn();

    const result = await maybeCreateTrackingIssue(buildTask({
      sourceType: "github_import",
      title: "Imported issue follow-up",
      description: "Short body",
      sourceIssue: {
        provider: "github",
        repository: "upstream/repo",
        externalIssueId: "123",
        issueNumber: 123,
        url: "https://github.com/upstream/repo/issues/123",
      },
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue, recordActivity } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: console,
    });

    expect(result).toEqual({ created: false, reason: "source_issue_linked" });
    expect(createIssueMock).not.toHaveBeenCalled();
    expect(linkGithubIssue).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      owner: "upstream",
      repo: "repo",
      number: 123,
      url: "https://github.com/upstream/repo/issues/123",
    }));
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ type: "github-issue-source-linked", repo: "upstream/repo", number: 123 }),
    }));
  });

  it("constructs sourceIssue URL when sourceIssue.url is missing", async () => {
    const linkGithubIssue = vi.fn();

    const result = await maybeCreateTrackingIssue(buildTask({
      sourceIssue: {
        provider: "github",
        repository: "upstream/repo",
        externalIssueId: "987",
        issueNumber: 987,
      },
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue, recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toEqual({ created: false, reason: "source_issue_linked" });
    expect(linkGithubIssue).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      url: "https://github.com/upstream/repo/issues/987",
    }));
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("falls through to normal create path when sourceIssue provider is non-github", async () => {
    const result = await maybeCreateTrackingIssue(buildTask({
      title: "Imported issue follow-up",
      description: "Short body",
      sourceIssue: {
        provider: "gitlab",
        repository: "group/project",
        externalIssueId: "321",
        issueNumber: 321,
      },
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toMatchObject({ created: true });
    expect(createIssueMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to normal create path when sourceIssue repository slug is invalid", async () => {
    const result = await maybeCreateTrackingIssue(buildTask({
      title: "Imported issue follow-up",
      description: "Short body",
      sourceIssue: {
        provider: "github",
        repository: "invalidslug",
        externalIssueId: "222",
        issueNumber: 222,
      },
      githubTracking: { enabled: true },
    }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toMatchObject({ created: true });
    expect(createIssueMock).toHaveBeenCalledTimes(1);
  });

  it("uses the AI summarizer when the title is missing and a summarizer model is configured", async () => {
    const linkGithubIssue = vi.fn();
    const recordActivity = vi.fn();
    const updateTask = vi.fn().mockImplementation(async (_id, updates) => buildTask({ title: updates.title, description: longDescription }));
    summarizeTitleMock.mockResolvedValue("AI generated title");

    await maybeCreateTrackingIssue(buildTask({ title: "   ", description: longDescription, githubTracking: { enabled: true } }), {
      taskStore: { linkGithubIssue, recordActivity, updateTask } as any,
      projectSettings: { titleSummarizerProvider: "anthropic", titleSummarizerModelId: "claude" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(summarizeTitleMock).toHaveBeenCalledWith(longDescription, rootDir, "anthropic", "claude");
    expect(updateTask).toHaveBeenCalledWith("FN-1", { title: "AI generated title" });
    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({ title: "[FN-1] AI generated title" }));
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ metadata: { type: "github-tracking-title-summarized" } }));
  });

  it("falls back to a derived description title when the summarizer throws", async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const updateTask = vi.fn();
    summarizeTitleMock.mockRejectedValue(new AiServiceError("model unavailable"));

    const result = await maybeCreateTrackingIssue(buildTask({ title: "", description: longDescription, githubTracking: { enabled: true } }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn(), updateTask } as any,
      projectSettings: { titleSummarizerProvider: "anthropic", titleSummarizerModelId: "claude" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger,
    });

    expect(result.created).toBe(true);
    expect(updateTask).not.toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({ title: "[FN-1] Derived fallback title." }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("AI title summarizer failed"));
  });

  it("returns no_title_available and records activity when no title can be derived", async () => {
    const recordActivity = vi.fn();
    const logger = { warn: vi.fn(), info: vi.fn() };

    const result = await maybeCreateTrackingIssue(buildTask({ title: "   ", description: "\n```ts\nconst hidden = true;\n```\n\n  ", githubTracking: { enabled: true } }), {
      taskStore: { recordActivity } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger,
    });

    expect(result).toEqual({ created: false, reason: "no_title_available" });
    expect(createIssueMock).not.toHaveBeenCalled();
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:updated",
      details: "GitHub tracking issue not created: task has no title yet",
      metadata: expect.objectContaining({ type: "github-tracking-no-title" }),
    }));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("deferred — no usable title"));
  });

  it("returns no_title_available when the summarizer yields no title and no fallback exists", async () => {
    const recordActivity = vi.fn();

    const result = await maybeCreateTrackingIssue(buildTask({
      title: "",
      description: `${" ".repeat(MIN_DESCRIPTION_LENGTH)}\n` + "```md\nignored\n```",
      githubTracking: { enabled: true },
    }), {
      taskStore: { recordActivity, updateTask: vi.fn() } as any,
      projectSettings: { titleSummarizerProvider: "anthropic", titleSummarizerModelId: "claude" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(summarizeTitleMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ created: false, reason: "no_title_available" });
    expect(createIssueMock).not.toHaveBeenCalled();
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ type: "github-tracking-no-title" }),
    }));
  });

  it("still creates an issue when the summarizer fails but a description fallback exists", async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    summarizeTitleMock.mockRejectedValue(new AiServiceError("model unavailable"));

    const result = await maybeCreateTrackingIssue(buildTask({ title: "", description: longDescription, githubTracking: { enabled: true } }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn(), updateTask: vi.fn() } as any,
      projectSettings: { titleSummarizerProvider: "anthropic", titleSummarizerModelId: "claude" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger,
    });

    expect(result.created).toBe(true);
    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({ title: "[FN-1] Derived fallback title." }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("AI title summarizer failed"));
  });

  it("does not invoke the summarizer when the description is too short", async () => {
    await maybeCreateTrackingIssue(buildTask({ title: "", description: "Short title fallback", githubTracking: { enabled: true } }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn(), updateTask: vi.fn() } as any,
      projectSettings: { titleSummarizerProvider: "anthropic", titleSummarizerModelId: "claude" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(summarizeTitleMock).not.toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({ title: "[FN-1] Short title fallback" }));
  });

  it("does not invoke the summarizer when no summarizer model is configured", async () => {
    await maybeCreateTrackingIssue(buildTask({ title: "", description: longDescription, githubTracking: { enabled: true } }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn(), updateTask: vi.fn() } as any,
      projectSettings: {} as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(summarizeTitleMock).not.toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({ title: "[FN-1] Derived fallback title." }));
  });

  it("does not invoke the summarizer when a non-empty title is already present", async () => {
    await maybeCreateTrackingIssue(buildTask({ title: "Keep existing title", description: longDescription, githubTracking: { enabled: true } }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn(), updateTask: vi.fn() } as any,
      projectSettings: { titleSummarizerProvider: "anthropic", titleSummarizerModelId: "claude" } as any,
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(summarizeTitleMock).not.toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({ title: "[FN-1] Keep existing title" }));
  });

  it.each([
    ["task override", { enabled: true, repoOverride: "task/repo" }, { githubTrackingDefaultRepo: "project/repo" }, { githubTrackingDefaultRepo: "global/repo" }, "task", "repo"],
    ["project default", { enabled: true }, { githubTrackingDefaultRepo: "project/repo" }, { githubTrackingDefaultRepo: "global/repo" }, "project", "repo"],
    ["global default", { enabled: true }, {}, { githubTrackingDefaultRepo: "global/repo" }, "global", "repo"],
  ] as const)("resolves repo from %s", async (_label, tracking, projectSettings, globalSettings, owner, repo) => {
    const linkGithubIssue = vi.fn();

    await maybeCreateTrackingIssue(buildTask({ githubTracking: tracking }), {
      taskStore: { linkGithubIssue, recordActivity: vi.fn() } as any,
      projectSettings: projectSettings as any,
      globalSettings: globalSettings as any,
      rootDir,
      logger: console,
    });

    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({ owner, repo }));
  });

  it("creates a tracking issue from explicit task override when defaults are unset", async () => {
    const linkGithubIssue = vi.fn();

    await maybeCreateTrackingIssue(buildTask({ githubTracking: { enabled: true, repoOverride: "task/repo" } }), {
      taskStore: { linkGithubIssue, recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: {},
      rootDir,
      logger: console,
    });

    expect(createIssueMock).toHaveBeenCalledWith(expect.objectContaining({ owner: "task", repo: "repo" }));
  });

  it("skips creation when tracking is on but no repo is configured", async () => {
    const result = await maybeCreateTrackingIssue(buildTask({ githubTracking: { enabled: true } }), {
      taskStore: { recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings: {},
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toEqual({ created: false, reason: "no_repo_configured" });
    expect(createIssueMock).not.toHaveBeenCalled();
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
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toEqual({ created: false, reason: "auth_token_missing" });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ type: "github-issue-skipped", reason: "token_missing" }),
    }));
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("passes global settings through to auth resolution", async () => {
    const globalSettings = { githubTrackingDefaultRepo: "o/r", githubAuthMode: "token" } as any;
    await maybeCreateTrackingIssue(buildTask({ githubTracking: { enabled: true } }), {
      taskStore: { linkGithubIssue: vi.fn(), recordActivity: vi.fn() } as any,
      projectSettings: {},
      globalSettings,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(resolveAuthMock).toHaveBeenCalledWith(expect.objectContaining({ globalSettings }));
  });

  it("records activity when GitHub issue creation fails", async () => {
    const recordActivity = vi.fn();
    createIssueMock.mockRejectedValue(new Error("gh create failed"));

    const result = await maybeCreateTrackingIssue(buildTask({ title: "Test", githubTracking: { enabled: true } }), {
      taskStore: { recordActivity, linkGithubIssue: vi.fn() } as any,
      projectSettings: {},
      globalSettings: { githubTrackingDefaultRepo: "o/r" } as any,
      rootDir,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(result).toEqual({ created: false, reason: "github_error" });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:updated",
      taskId: "FN-1",
      taskTitle: "Test",
      details: "GitHub tracking issue not created: gh create failed",
      metadata: expect.objectContaining({
        type: "github-issue-failed",
        reason: "github_error",
        message: "gh create failed",
      }),
    }));
  });
});
