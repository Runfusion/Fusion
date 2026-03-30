import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:readline/promises before importing the module under test
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
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
import { runTaskShow, runTaskCreate, runTaskDuplicate, runTaskRefine } from "./task.js";

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
