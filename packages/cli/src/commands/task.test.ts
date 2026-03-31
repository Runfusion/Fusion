import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:readline/promises before importing the module under test
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

// Mock node:fs for runTaskLogs tests
vi.mock("node:fs", () => ({
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock @kb/core before importing the module under test
vi.mock("@kb/core", () => {
  const COLUMNS = ["triage", "specified", "in-progress", "review", "done"];
  const COLUMN_LABELS: Record<string, string> = {
    triage: "Triage",
    specified: "Specified",
    "in-progress": "In Progress",
    review: "Review",
    done: "Done",
  };

  return {
    TaskStore: vi.fn(),
    COLUMNS,
    COLUMN_LABELS,
  };
});

// Mock @kb/engine
vi.mock("@kb/engine", () => ({ aiMergeTask: vi.fn() }));

import { createInterface } from "node:readline/promises";
import { TaskStore } from "@kb/core";
import { watchFile, unwatchFile, statSync, existsSync, readFileSync } from "node:fs";
import { runTaskShow, runTaskCreate, runTaskDuplicate, runTaskRefine, runTaskDelete, runTaskRetry, runTaskLogs, type LogsOptions } from "./task.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "KB-001",
    description: "A short description",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("runTaskShow", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays the full description without truncation when no title", async () => {
    const longDesc = "A".repeat(120); // well over 60 chars
    const task = makeTask({ description: longDesc });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(task),
    }));

    await runTaskShow("KB-001");

    const headerLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("KB-001:")
    );
    expect(headerLine).toBeDefined();
    expect(headerLine![0]).toContain(longDesc);
    // Ensure no truncation happened
    expect(headerLine![0]).not.toContain(longDesc.slice(0, 60) + "…");
    expect(headerLine![0].length).toBeGreaterThan(60 + "  KB-001: ".length);
  });

  it("displays the title when present instead of description", async () => {
    const task = makeTask({
      title: "My Task Title",
      description: "This is the full description that should not appear in the header",
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(task),
    }));

    await runTaskShow("KB-001");

    const headerLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("KB-001:")
    );
    expect(headerLine).toBeDefined();
    expect(headerLine![0]).toContain("My Task Title");
    expect(headerLine![0]).not.toContain("This is the full description");
  });
});

// Mock fs/promises for runTaskCreate attach tests
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("runTaskCreate with --attach", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockAddAttachment: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockAddAttachment = vi.fn().mockResolvedValue({
      filename: "abc123-test.png",
      originalName: "test.png",
      mimeType: "image/png",
      size: 2048,
      createdAt: new Date().toISOString(),
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: vi.fn().mockResolvedValue({
        id: "KB-002",
        description: "test task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      addAttachment: mockAddAttachment,
    }));

    const fsMod = await import("node:fs/promises");
    mockReadFile = vi.mocked(fsMod.readFile);
    mockReadFile.mockResolvedValue(Buffer.from("file content"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates task and attaches files when attachFiles provided", async () => {
    await runTaskCreate("test task", ["/tmp/test.png"]);

    expect(mockAddAttachment).toHaveBeenCalledOnce();
    expect(mockAddAttachment).toHaveBeenCalledWith(
      "KB-002",
      "test.png",
      expect.any(Buffer),
      "image/png",
    );

    const attachLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Attached"),
    );
    expect(attachLine).toBeDefined();
  });

  it("attaches multiple files", async () => {
    mockAddAttachment.mockResolvedValueOnce({
      filename: "abc-screenshot.png",
      originalName: "screenshot.png",
      mimeType: "image/png",
      size: 1024,
      createdAt: new Date().toISOString(),
    }).mockResolvedValueOnce({
      filename: "def-crash.log",
      originalName: "crash.log",
      mimeType: "text/plain",
      size: 512,
      createdAt: new Date().toISOString(),
    });

    await runTaskCreate("test task", ["/tmp/screenshot.png", "/tmp/crash.log"]);

    expect(mockAddAttachment).toHaveBeenCalledTimes(2);
  });

  it("skips files with unsupported extensions", async () => {
    await runTaskCreate("test task", ["/tmp/file.exe"]);

    expect(mockAddAttachment).not.toHaveBeenCalled();
    const errLine = errorSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Unsupported"),
    );
    expect(errLine).toBeDefined();
  });

  it("skips unreadable files", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

    await runTaskCreate("test task", ["/tmp/missing.png"]);

    expect(mockAddAttachment).not.toHaveBeenCalled();
    const errLine = errorSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Cannot read"),
    );
    expect(errLine).toBeDefined();
  });

  it("creates task without attachments when attachFiles is undefined", async () => {
    await runTaskCreate("test task");

    expect(mockAddAttachment).not.toHaveBeenCalled();
  });
});

describe("runTaskCreate with --depends", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockCreateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockCreateTask = vi.fn().mockImplementation((input: { description: string; dependencies?: string[] }) => ({
      id: "KB-003",
      description: input.description,
      column: "triage",
      dependencies: input.dependencies || [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes dependencies to store.createTask when depends provided", async () => {
    await runTaskCreate("test task", undefined, ["KB-124"]);

    expect(mockCreateTask).toHaveBeenCalledWith({
      description: "test task",
      dependencies: ["KB-124"],
    });
  });

  it("passes multiple dependencies correctly", async () => {
    await runTaskCreate("test task", undefined, ["KB-124", "KB-100"]);

    expect(mockCreateTask).toHaveBeenCalledWith({
      description: "test task",
      dependencies: ["KB-124", "KB-100"],
    });

    const depsLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Dependencies:"),
    );
    expect(depsLine).toBeDefined();
    expect(depsLine![0]).toContain("KB-124");
    expect(depsLine![0]).toContain("KB-100");
  });

  it("works without dependencies (backward compatible)", async () => {
    await runTaskCreate("test task");

    expect(mockCreateTask).toHaveBeenCalledWith({
      description: "test task",
      dependencies: undefined,
    });
  });
});

import { runTaskImportGitHubInteractive } from "./task.js";

describe("runTaskImportGitHubInteractive", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockCreateTask: ReturnType<typeof vi.fn>;
  let mockListTasks: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    mockCreateTask = vi.fn().mockImplementation((input: { description: string; title?: string }) => ({
      id: `KB-${String(mockCreateTask.mock.calls.length).padStart(3, "0")}`,
      title: input.title,
      description: input.description,
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    mockListTasks = vi.fn().mockResolvedValue([]);

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
      listTasks: mockListTasks,
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const mockIssue = (num: number, title: string, body: string | null): GitHubIssue => ({
    number: num,
    title,
    body,
    html_url: `https://github.com/owner/repo/issues/${num}`,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  });

  it("imports selected issues via interactive mode", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
        mockIssue(3, "Third Issue", "Description 3"),
      ]),
    } as Response);

    // Mock readline to select issues 1 and 3
    const mockReadline = {
      question: vi.fn().mockResolvedValueOnce("1,3"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "First Issue",
      description: "Description 1\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
    });
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "Third Issue",
      description: "Description 3\n\nSource: https://github.com/owner/repo/issues/3",
      column: "triage",
      dependencies: [],
    });
  });

  it('imports all issues when "all" is selected', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
      ]),
    } as Response);

    // Mock readline to select "all"
    const mockReadline = {
      question: vi.fn().mockResolvedValueOnce("all"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
  });

  it("skips already imported issues", async () => {
    // Setup existing task with source URL
    mockListTasks.mockResolvedValueOnce([
      {
        id: "KB-001",
        description: "Existing\n\nSource: https://github.com/owner/repo/issues/1",
        column: "triage",
      },
    ]);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
      ]),
    } as Response);

    const mockReadline = {
      question: vi.fn().mockResolvedValueOnce("all"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "Second Issue",
      description: "Description 2\n\nSource: https://github.com/owner/repo/issues/2",
      column: "triage",
      dependencies: [],
    });

    const skipLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Skipping #1"),
    );
    expect(skipLine).toBeDefined();
  });

  it("handles empty issues list", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    } as Response);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).not.toHaveBeenCalled();
    const noIssuesLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("No open issues"),
    );
    expect(noIssuesLine).toBeDefined();
  });

  it("exits on invalid owner/repo format", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportGitHubInteractive("invalid-format")).rejects.toThrow("process.exit");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles API errors gracefully", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportGitHubInteractive("owner/repo")).rejects.toThrow("process.exit");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("re-prompts on invalid input", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
      ]),
    } as Response);

    // First invalid input, then valid
    const mockReadline = {
      question: vi.fn()
        .mockResolvedValueOnce("invalid")
        .mockResolvedValueOnce("1"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockReadline.question).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  it("re-prompts on out of range selection", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
      ]),
    } as Response);

    // First out of range, then valid
    const mockReadline = {
      question: vi.fn()
        .mockResolvedValueOnce("99")
        .mockResolvedValueOnce("1"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockReadline.question).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });
});

// GitHub Import Tests
import { fetchGitHubIssues, runTaskImportFromGitHub, type GitHubIssue } from "./task.js";

describe("fetchGitHubIssues", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalEnv;
    vi.restoreAllMocks();
  });

  const mockIssue: GitHubIssue = {
    number: 1,
    title: "Test Issue",
    body: "Test body",
    html_url: "https://github.com/owner/repo/issues/1",
    labels: [{ name: "bug" }],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  };

  it("fetches issues successfully", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue]),
    } as Response);

    const issues = await fetchGitHubIssues("owner", "repo");

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
    expect(issues[0].title).toBe("Test Issue");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("https://api.github.com/repos/owner/repo/issues");
    expect(url).toContain("state=open");
  });

  it("includes Authorization header when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue]),
    } as Response);

    await fetchGitHubIssues("owner", "repo");

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("respects limit option", async () => {
    const manyIssues = Array.from({ length: 50 }, (_, i) => ({
      ...mockIssue,
      number: i + 1,
    }));
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(manyIssues),
    } as Response);

    const issues = await fetchGitHubIssues("owner", "repo", { limit: 10 });

    expect(issues).toHaveLength(10);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("per_page=10");
  });

  it("respects labels option", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue]),
    } as Response);

    await fetchGitHubIssues("owner", "repo", { labels: ["bug", "enhancement"] });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("labels=bug%2Cenhancement");
  });

  it("filters out pull requests", async () => {
    const pr = { ...mockIssue, pull_request: {} };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue, pr]),
    } as Response);

    const issues = await fetchGitHubIssues("owner", "repo");

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it("throws error for 404", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow("Repository not found");
  });

  it("throws error for 401/403", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    } as Response);

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow("Authentication failed");
  });

  it("throws generic error for other status codes", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
    } as Response);

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow("GitHub API error: 500");
  });
});

describe("runTaskImportFromGitHub", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockCreateTask: ReturnType<typeof vi.fn>;
  let mockListTasks: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    mockCreateTask = vi.fn().mockImplementation((input: { description: string; title?: string }) => ({
      id: `KB-${String(mockCreateTask.mock.calls.length).padStart(3, "0")}`,
      title: input.title,
      description: input.description,
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    mockListTasks = vi.fn().mockResolvedValue([]);

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
      listTasks: mockListTasks,
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const mockIssue = (num: number, title: string, body: string | null): GitHubIssue => ({
    number: num,
    title,
    body,
    html_url: `https://github.com/owner/repo/issues/${num}`,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  });

  it("imports issues and creates tasks", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
      ]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "First Issue",
      description: "Description 1\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
    });

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Imported 2 tasks"),
    );
    expect(successLine).toBeDefined();
  });

  it("skips already imported issues", async () => {
    // Setup existing task with source URL
    mockListTasks.mockResolvedValueOnce([
      {
        id: "KB-001",
        description: "Existing\n\nSource: https://github.com/owner/repo/issues/1",
        column: "triage",
      },
    ]);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
      ]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    const skipLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Skipping #1"),
    );
    expect(skipLine).toBeDefined();
  });

  it("handles empty issues list", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).not.toHaveBeenCalled();
    const noIssuesLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("No open issues"),
    );
    expect(noIssuesLine).toBeDefined();
  });

  it("exits on invalid owner/repo format", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportFromGitHub("invalid-format")).rejects.toThrow("process.exit");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles API errors gracefully", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportFromGitHub("owner/repo")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("uses (no description) for empty body", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue(1, "No Body Issue", null)]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "No Body Issue",
      description: "(no description)\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
    });
  });

  it("truncates long titles to 200 chars", async () => {
    const longTitle = "A".repeat(250);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue(1, longTitle, "Body")]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "A".repeat(200),
      description: expect.stringContaining("Body"),
      column: "triage",
      dependencies: [],
    });
  });
});

// --- Duplicate Tests ---

describe("runTaskDuplicate", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockDuplicateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockDuplicateTask = vi.fn().mockResolvedValue({
      id: "KB-002",
      description: "Duplicated task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      duplicateTask: mockDuplicateTask,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("duplicates task and prints success", async () => {
    await runTaskDuplicate("KB-001");

    expect(mockDuplicateTask).toHaveBeenCalledOnce();
    expect(mockDuplicateTask).toHaveBeenCalledWith("KB-001");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Duplicated"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("KB-001");
    expect(successLine![0]).toContain("KB-002");
  });

  it("throws when task not found", async () => {
    mockDuplicateTask.mockRejectedValueOnce(new Error("Task KB-999 not found"));

    await expect(runTaskDuplicate("KB-999")).rejects.toThrow("Task KB-999 not found");
  });
});

// --- Refine Tests ---

describe("runTaskRefine", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockRefineTask: ReturnType<typeof vi.fn>;
  let mockRlQuestion: ReturnType<typeof vi.fn>;
  let mockRlClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockRlQuestion = vi.fn();
    mockRlClose = vi.fn();

    (createInterface as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      question: mockRlQuestion,
      close: mockRlClose,
    });

    mockRefineTask = vi.fn().mockResolvedValue({
      id: "KB-002",
      description: "Refinement of KB-001",
      column: "triage",
      dependencies: ["KB-001"],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      refineTask: mockRefineTask,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refines task with interactive feedback and prints success", async () => {
    mockRlQuestion.mockResolvedValue("Need to add more tests");

    await runTaskRefine("KB-001");

    expect(mockRlQuestion).toHaveBeenCalledWith("What needs to be refined? ");
    expect(mockRlClose).toHaveBeenCalled();
    expect(mockRefineTask).toHaveBeenCalledOnce();
    expect(mockRefineTask).toHaveBeenCalledWith("KB-001", "Need to add more tests");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Created refinement"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("KB-002");
    expect(successLine![0]).toContain("KB-001");

    // Check that dependency is printed
    const depLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Dependency:"),
    );
    expect(depLine).toBeDefined();
    expect(depLine![0]).toContain("KB-001");
  });

  it("refines task with provided feedback (non-interactive)", async () => {
    await runTaskRefine("KB-001", "Fix the error handling");

    expect(mockRlQuestion).not.toHaveBeenCalled();
    expect(mockRefineTask).toHaveBeenCalledOnce();
    expect(mockRefineTask).toHaveBeenCalledWith("KB-001", "Fix the error handling");
  });

  it("exits when interactive feedback is empty", async () => {
    mockRlQuestion.mockResolvedValue("  ");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskRefine("KB-001");

    expect(mockRlClose).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Feedback is required");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("exits when provided feedback is empty", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskRefine("KB-001", "   ");

    expect(errorSpy).toHaveBeenCalledWith("Feedback is required");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("exits when feedback exceeds 2000 characters", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskRefine("KB-001", "A".repeat(2001));

    expect(errorSpy).toHaveBeenCalledWith("Feedback must be 2000 characters or less");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("allows feedback at exactly 2000 characters", async () => {
    const longFeedback = "A".repeat(2000);

    await runTaskRefine("KB-001", longFeedback);

    expect(mockRefineTask).toHaveBeenCalledOnce();
    expect(mockRefineTask).toHaveBeenCalledWith("KB-001", longFeedback);
  });

  it("throws when task not in done or in-review", async () => {
    mockRefineTask.mockRejectedValueOnce(new Error("Task must be in 'done' or 'in-review' column to refine"));

    await expect(runTaskRefine("KB-001", "Some feedback")).rejects.toThrow("done' or 'in-review'");
  });

  it("throws when task not found", async () => {
    mockRefineTask.mockRejectedValueOnce(new Error("Task KB-999 not found"));

    await expect(runTaskRefine("KB-999", "Some feedback")).rejects.toThrow("Task KB-999 not found");
  });
});

// --- Delete Tests ---

describe("runTaskDelete", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockGetTask: ReturnType<typeof vi.fn>;
  let mockDeleteTask: ReturnType<typeof vi.fn>;
  let mockRlQuestion: ReturnType<typeof vi.fn>;
  let mockRlClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockRlQuestion = vi.fn();
    mockRlClose = vi.fn();

    (createInterface as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      question: mockRlQuestion,
      close: mockRlClose,
    });

    mockGetTask = vi.fn().mockResolvedValue({
      id: "KB-001",
      description: "Test task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockDeleteTask = vi.fn().mockResolvedValue({
      id: "KB-001",
      description: "Test task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: mockGetTask,
      deleteTask: mockDeleteTask,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes task successfully with force=true (no prompt)", async () => {
    await runTaskDelete("KB-001", true);

    expect(mockGetTask).toHaveBeenCalledOnce();
    expect(mockGetTask).toHaveBeenCalledWith("KB-001");
    expect(mockRlQuestion).not.toHaveBeenCalled();
    expect(mockDeleteTask).toHaveBeenCalledOnce();
    expect(mockDeleteTask).toHaveBeenCalledWith("KB-001");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Deleted"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("KB-001");
  });

  it("deletes task after confirmation prompt with 'y'", async () => {
    mockRlQuestion.mockResolvedValue("y");

    await runTaskDelete("KB-001", false);

    expect(mockRlQuestion).toHaveBeenCalledOnce();
    expect(mockRlQuestion).toHaveBeenCalledWith("Are you sure you want to delete KB-001? [y/N] ");
    expect(mockRlClose).toHaveBeenCalled();
    expect(mockDeleteTask).toHaveBeenCalledOnce();
    expect(mockDeleteTask).toHaveBeenCalledWith("KB-001");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Deleted"),
    );
    expect(successLine).toBeDefined();
  });

  it("deletes task after confirmation prompt with 'yes'", async () => {
    mockRlQuestion.mockResolvedValue("yes");

    await runTaskDelete("KB-001", false);

    expect(mockDeleteTask).toHaveBeenCalledOnce();
  });

  it("cancels deletion on 'n' response", async () => {
    mockRlQuestion.mockResolvedValue("n");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskDelete("KB-001", false);

    expect(mockRlQuestion).toHaveBeenCalledOnce();
    expect(mockRlClose).toHaveBeenCalled();
    expect(mockDeleteTask).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("cancels deletion on empty response", async () => {
    mockRlQuestion.mockResolvedValue("");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskDelete("KB-001", false);

    expect(mockRlQuestion).toHaveBeenCalledOnce();
    expect(mockDeleteTask).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("exits with error when task not found", async () => {
    mockGetTask.mockRejectedValueOnce(new Error("Task KB-999 not found"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskDelete("KB-999", true);

    expect(errorSpy).toHaveBeenCalledWith("✗ Task KB-999 not found");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockDeleteTask).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("exits with error when deleteTask fails", async () => {
    mockDeleteTask.mockRejectedValueOnce(new Error("Task has dependencies"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskDelete("KB-001", true);

    expect(errorSpy).toHaveBeenCalledWith("✗ Failed to delete KB-001: Task has dependencies");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});

// --- Retry Tests ---

describe("runTaskRetry", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockGetTask: ReturnType<typeof vi.fn>;
  let mockUpdateTask: ReturnType<typeof vi.fn>;
  let mockMoveTask: ReturnType<typeof vi.fn>;
  let mockLogEntry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockGetTask = vi.fn();
    mockUpdateTask = vi.fn();
    mockMoveTask = vi.fn();
    mockLogEntry = vi.fn();

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: mockGetTask,
      updateTask: mockUpdateTask,
      moveTask: mockMoveTask,
      logEntry: mockLogEntry,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries failed task successfully", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ 
      id: "KB-001", 
      status: "failed",
      error: "Some error",
      column: "in-progress"
    }));
    mockUpdateTask.mockResolvedValueOnce(makeTask({ id: "KB-001", status: undefined, error: undefined }));
    mockMoveTask.mockResolvedValueOnce(makeTask({ id: "KB-001", column: "todo" }));
    mockLogEntry.mockResolvedValueOnce(makeTask({ id: "KB-001" }));

    await runTaskRetry("KB-001");

    expect(mockGetTask).toHaveBeenCalledWith("KB-001");
    expect(mockUpdateTask).toHaveBeenCalledWith("KB-001", { status: null, error: null });
    expect(mockMoveTask).toHaveBeenCalledWith("KB-001", "todo");
    expect(mockLogEntry).toHaveBeenCalledWith("KB-001", "Retry requested from CLI", "Task reset to todo for retry");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Retried"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("KB-001");
    expect(successLine![0]).toContain("todo");
  });

  it("throws error when task not found", async () => {
    mockGetTask.mockRejectedValueOnce(new Error("Task not found"));

    await expect(runTaskRetry("KB-999")).rejects.toThrow("Task KB-999 not found");
  });

  it("throws error when task is not failed", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ 
      id: "KB-001", 
      status: undefined,
      column: "in-progress"
    }));

    await expect(runTaskRetry("KB-001")).rejects.toThrow("Task KB-001 is not failed (status: none)");
  });

  it("throws error with correct status when task has different status", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ 
      id: "KB-001", 
      status: "paused",
      column: "in-progress"
    }));

    await expect(runTaskRetry("KB-001")).rejects.toThrow("Task KB-001 is not failed (status: paused)");
  });
});

// --- Logs Tests ---

describe("runTaskLogs", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockGetTask: ReturnType<typeof vi.fn>;
  let mockGetAgentLogs: ReturnType<typeof vi.fn>;
  let mockWatchFile: ReturnType<typeof vi.fn>;
  let mockUnwatchFile: ReturnType<typeof vi.fn>;
  let mockStatSync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReadFileSync: ReturnType<typeof vi.fn>;
  let sigintHandlers: Array<() => void> = [];

  function makeAgentLogEntry(overrides: Record<string, unknown> = {}): import("@kb/core").AgentLogEntry {
    return {
      timestamp: new Date().toISOString(),
      taskId: "KB-001",
      text: "Test message",
      type: "text" as const,
      ...overrides,
    };
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sigintHandlers = [];

    mockGetTask = vi.fn();
    mockGetAgentLogs = vi.fn().mockResolvedValue([]);

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: mockGetTask,
      getAgentLogs: mockGetAgentLogs,
    }));

    // Mock fs functions
    mockWatchFile = vi.mocked(watchFile);
    mockUnwatchFile = vi.mocked(unwatchFile);
    mockStatSync = vi.mocked(statSync);
    mockExistsSync = vi.mocked(existsSync);
    mockReadFileSync = vi.mocked(readFileSync);

    mockWatchFile.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 0 });

    // Mock process.on for SIGINT
    vi.spyOn(process, "on").mockImplementation((event: string, handler: () => void) => {
      if (event === "SIGINT") {
        sigintHandlers.push(handler);
      }
      return process;
    });

    // Mock process.exit
    vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays logs with various entry types", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Analyzing code" }),
      makeAgentLogEntry({ type: "thinking", text: "Let me think" }),
      makeAgentLogEntry({ type: "tool", text: "read", detail: "path/to/file.ts" }),
      makeAgentLogEntry({ type: "tool_result", text: "read", detail: "success" }),
      makeAgentLogEntry({ type: "tool_error", text: "read", detail: "File not found" }),
    ]);

    await runTaskLogs("KB-001");

    expect(mockGetTask).toHaveBeenCalledWith("KB-001");
    expect(mockGetAgentLogs).toHaveBeenCalledWith("KB-001");
    expect(logSpy).toHaveBeenCalledTimes(5);

    // Check that each type is formatted
    const calls = logSpy.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("Analyzing code");
    expect(calls[1]).toContain("[THINK]");
    expect(calls[2]).toContain("[TOOL]");
    expect(calls[2]).toContain("path/to/file.ts");
    expect(calls[3]).toContain("[RESULT]");
    expect(calls[4]).toContain("[ERROR]");
  });

  it("displays agent role when present", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Starting execution", agent: "executor" }),
      makeAgentLogEntry({ type: "text", text: "Reviewing code", agent: "reviewer" }),
    ]);

    await runTaskLogs("KB-001");

    const calls = logSpy.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("[EXECUTOR]");
    expect(calls[1]).toContain("[REVIEWER]");
  });

  it("shows 'no logs found' message when logs are empty", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([]);

    await runTaskLogs("KB-001");

    expect(logSpy).toHaveBeenCalledWith("No agent logs found for KB-001");
  });

  it("exits with error when task not found", async () => {
    mockGetTask.mockRejectedValueOnce(new Error("Task not found"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskLogs("KB-999");

    expect(errorSpy).toHaveBeenCalledWith("Task KB-999 not found");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("respects --limit flag", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce(
      Array.from({ length: 200 }, (_, i) => makeAgentLogEntry({ text: `Line ${i + 1}` }))
    );

    await runTaskLogs("KB-001", { limit: 50 });

    // Should only show 50 entries (default is 100, we specified 50)
    expect(logSpy).toHaveBeenCalledTimes(50);
    
    // Check that we got the last 50 entries
    const calls = logSpy.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("Line 151");
    expect(calls[49]).toContain("Line 200");
  });

  it("enforces max limit of 1000", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce(
      Array.from({ length: 1500 }, (_, i) => makeAgentLogEntry({ text: `Line ${i + 1}` }))
    );

    await runTaskLogs("KB-001", { limit: 2000 });  // Request 2000, should be capped at 1000

    expect(logSpy).toHaveBeenCalledTimes(1000);
  });

  it("filters by --type flag", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Text 1" }),
      makeAgentLogEntry({ type: "tool", text: "tool1" }),
      makeAgentLogEntry({ type: "text", text: "Text 2" }),
      makeAgentLogEntry({ type: "tool", text: "tool2" }),
      makeAgentLogEntry({ type: "thinking", text: "Think 1" }),
    ]);

    await runTaskLogs("KB-001", { type: "text" });

    // Should only show 2 text entries
    expect(logSpy).toHaveBeenCalledTimes(2);
    const calls = logSpy.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("Text 1");
    expect(calls[1]).toContain("Text 2");
  });

  it("filters by type with --limit combined", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    // Create 50 tool entries interspersed with text entries
    const entries: import("@kb/core").AgentLogEntry[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push(makeAgentLogEntry({ 
        type: i % 2 === 0 ? "tool" : "text", 
        text: `Entry ${i + 1}` 
      }));
    }
    mockGetAgentLogs.mockResolvedValueOnce(entries);

    await runTaskLogs("KB-001", { type: "tool", limit: 10 });

    // Should show 10 tool entries (the last 10 tool entries: #50, #52, #54, #56, #58, #60, #62, #64, #66, #68... wait, that's not right)
    // Actually it's #50, #52, #54, #56, #58, #60, #62, #64, #66, #68... no wait, tool entries are at indices 0, 2, 4...
    // So last 10 tool entries would be indices 80, 82, 84, 86, 88, 90, 92, 94, 96, 98
    // Which correspond to Entry 81, 83, 85, 87, 89, 91, 93, 95, 97, 99
    expect(logSpy).toHaveBeenCalledTimes(10);
  });

  it("calls watchFile when --follow is set", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Existing log" }),
    ]);

    // Don't await - follow mode keeps the promise pending
    const logsPromise = runTaskLogs("KB-001", { follow: true });

    // Give a tick for the async operations to start
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockWatchFile).toHaveBeenCalled();
    expect(process.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    // Trigger SIGINT to clean up
    sigintHandlers.forEach((handler) => handler());
  });

  it("calls unwatchFile in SIGINT handler", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([]);

    // Start follow mode
    runTaskLogs("KB-001", { follow: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Trigger SIGINT
    sigintHandlers.forEach((handler) => handler());

    expect(mockUnwatchFile).toHaveBeenCalled();
  });

  it("prints waiting message in follow mode when no log file exists", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([]);
    mockExistsSync.mockReturnValue(false);

    runTaskLogs("KB-001", { follow: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const waitingMessage = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Waiting for log file")
    );
    expect(waitingMessage).toBeDefined();

    // Clean up
    sigintHandlers.forEach((handler) => handler());
  });

  it("reads and prints new entries in follow mode", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Initial" }),
    ]);

    // Mock file to exist with size 0 initially (no content read yet)
    mockStatSync.mockReturnValue({ size: 0 });
    
    runTaskLogs("KB-001", { follow: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Get the watchFile callback
    const watchCallback = mockWatchFile.mock.calls[0][2] as () => void;
    
    // Simulate file growing with new content
    mockStatSync.mockReturnValueOnce({ size: 100 });
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(makeAgentLogEntry({ type: "text", text: "New entry" })) + "\n");
    
    // Trigger the watch callback
    watchCallback();

    // Check that new entry was printed
    const newEntry = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("New entry")
    );
    expect(newEntry).toBeDefined();

    // Clean up
    sigintHandlers.forEach((handler) => handler());
  });

  it("applies type filter in follow mode", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "KB-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([]);

    mockStatSync.mockReturnValue({ size: 0 });
    
    runTaskLogs("KB-001", { follow: true, type: "tool" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const watchCallback = mockWatchFile.mock.calls[0][2] as () => void;
    
    // Simulate new content
    mockStatSync.mockReturnValueOnce({ size: 200 });
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify(makeAgentLogEntry({ type: "text", text: "Text entry" })) + "\n" +
      JSON.stringify(makeAgentLogEntry({ type: "tool", text: "Tool entry" })) + "\n"
    );
    
    watchCallback();

    // Should only print the tool entry
    const toolEntry = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Tool entry")
    );
    expect(toolEntry).toBeDefined();

    const textEntry = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Text entry")
    );
    expect(textEntry).toBeUndefined();

    // Clean up
    sigintHandlers.forEach((handler) => handler());
  });
});
