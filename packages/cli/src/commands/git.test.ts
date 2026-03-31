import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Mock node:readline/promises
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
  })),
}));

import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  isGitRepo,
  getGitStatus,
  getDirtyFileCount,
  isValidBranchName,
  fetchGitRemote,
  pullGitBranch,
  pushGitBranch,
  runGitStatus,
  runGitFetch,
  runGitPull,
  runGitPush,
} from "./git.js";

const mockExecSync = vi.mocked(execSync);
const mockCreateInterface = vi.mocked(createInterface);

describe("isGitRepo", () => {
  it("returns true when in a git repository", () => {
    mockExecSync.mockReturnValueOnce(".git");
    expect(isGitRepo()).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith("git rev-parse --git-dir", { encoding: "utf-8", timeout: 5000 });
  });

  it("returns false when not in a git repository", () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("not a git repository");
    });
    expect(isGitRepo()).toBe(false);
  });
});

describe("isValidBranchName", () => {
  it("returns true for valid branch names", () => {
    expect(isValidBranchName("main")).toBe(true);
    expect(isValidBranchName("feature/my-feature")).toBe(true);
    expect(isValidBranchName("bugfix-123")).toBe(true);
    expect(isValidBranchName("hotfix_v1.0")).toBe(true);
  });

  it("returns false for empty names", () => {
    expect(isValidBranchName("")).toBe(false);
  });

  it("returns false for names starting with dash", () => {
    expect(isValidBranchName("-main")).toBe(false);
    expect(isValidBranchName("--help")).toBe(false);
  });

  it("returns false for names with shell metacharacters", () => {
    expect(isValidBranchName("main; rm -rf")).toBe(false);
    expect(isValidBranchName("main|cat")).toBe(false);
    expect(isValidBranchName("main`cmd`")).toBe(false);
  });

  it("returns false for names with spaces", () => {
    expect(isValidBranchName("my branch")).toBe(false);
  });

  it("returns false for names with double dots", () => {
    expect(isValidBranchName("main..feature")).toBe(false);
  });

  it("returns false for reserved git refs", () => {
    expect(isValidBranchName("HEAD")).toBe(false);
    expect(isValidBranchName("FETCH_HEAD")).toBe(false);
    expect(isValidBranchName("ORIG_HEAD")).toBe(false);
  });
});

describe("getGitStatus", () => {
  it("returns status data for normal branch", () => {
    mockExecSync
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("2\t1\n"); // rev-list ahead/behind

    const status = getGitStatus();
    expect(status).toEqual({
      branch: "main",
      commit: "a1b2c3d",
      isDirty: false,
      ahead: 2,
      behind: 1,
    });
  });

  it("handles detached HEAD state", () => {
    mockExecSync
      .mockReturnValueOnce("") // branch --show-current returns empty for detached
      .mockReturnValueOnce("a1b2c3d\n")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("0\t0\n");

    const status = getGitStatus();
    expect(status?.branch).toBe("HEAD detached");
  });

  it("detects dirty state", () => {
    mockExecSync
      .mockReturnValueOnce("main\n")
      .mockReturnValueOnce("a1b2c3d\n")
      .mockReturnValueOnce(" M file.ts\n?? new.txt\n") // dirty
      .mockReturnValueOnce("0\t0\n");

    const status = getGitStatus();
    expect(status?.isDirty).toBe(true);
  });

  it("returns null on error", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("git error");
    });
    expect(getGitStatus()).toBeNull();
  });
});

describe("getDirtyFileCount", () => {
  it("returns zero counts for clean repo", () => {
    mockExecSync.mockReturnValueOnce("");
    expect(getDirtyFileCount()).toEqual({ added: 0, modified: 0, deleted: 0 });
  });

  it("counts added files correctly", () => {
    mockExecSync.mockReturnValueOnce("?? new1.txt\n?? new2.txt\nA  staged.txt\n");
    expect(getDirtyFileCount()).toEqual({ added: 3, modified: 0, deleted: 0 });
  });

  it("counts modified files correctly", () => {
    mockExecSync.mockReturnValueOnce(" M file1.ts\nM  file2.ts\nMM file3.ts\n");
    expect(getDirtyFileCount()).toEqual({ added: 0, modified: 3, deleted: 0 });
  });

  it("counts deleted files correctly", () => {
    mockExecSync.mockReturnValueOnce(" D deleted.txt\nD  staged_del.txt\n");
    expect(getDirtyFileCount()).toEqual({ added: 0, modified: 0, deleted: 2 });
  });

  it("handles mixed changes", () => {
    mockExecSync.mockReturnValueOnce(" M modified.ts\n?? new.txt\n D deleted.txt\nA  added.txt\n");
    expect(getDirtyFileCount()).toEqual({ added: 2, modified: 1, deleted: 1 });
  });
});

describe("fetchGitRemote", () => {
  it("fetches successfully from origin", () => {
    mockExecSync.mockReturnValueOnce("");
    const result = fetchGitRemote("origin");
    expect(result.fetched).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith("git fetch origin", { encoding: "utf-8", timeout: 30000 });
  });

  it("fetches from specified remote", () => {
    mockExecSync.mockReturnValueOnce("");
    const result = fetchGitRemote("upstream");
    expect(result.fetched).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith("git fetch upstream", { encoding: "utf-8", timeout: 30000 });
  });

  it("throws for invalid remote name", () => {
    expect(() => fetchGitRemote("; rm -rf")).toThrow("Invalid remote name");
  });

  it("throws on connection failure", () => {
    mockExecSync.mockImplementation(() => {
      const error = new Error("Could not resolve host github.com");
      throw error;
    });
    expect(() => fetchGitRemote("origin")).toThrow("Failed to connect to remote");
  });

  it("returns not fetched on other errors", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("some other error");
    });
    const result = fetchGitRemote("origin");
    expect(result.fetched).toBe(false);
  });
});

describe("pullGitBranch", () => {
  it("pulls successfully", () => {
    mockExecSync.mockReturnValueOnce("Already up to date.");
    const result = pullGitBranch();
    expect(result.success).toBe(true);
    expect(result.conflict).toBeUndefined();
  });

  it("detects merge conflicts", () => {
    mockExecSync.mockImplementation(() => {
      const error = new Error("CONFLICT (content): Merge conflict in file.ts");
      throw error;
    });
    const result = pullGitBranch();
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it("throws with original error message on other errors", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not possible to fast-forward");
    });
    expect(() => pullGitBranch()).toThrow("not possible to fast-forward");
  });
});

describe("pushGitBranch", () => {
  it("pushes successfully", () => {
    mockExecSync.mockReturnValueOnce("");
    const result = pushGitBranch();
    expect(result.success).toBe(true);
  });

  it("throws when push is rejected", () => {
    mockExecSync.mockImplementation(() => {
      const error = new Error("rejected: non-fast-forward");
      throw error;
    });
    expect(() => pushGitBranch()).toThrow("Push rejected. Pull latest changes first.");
  });

  it("throws on connection failure", () => {
    mockExecSync.mockImplementation(() => {
      const error = new Error("Could not resolve host");
      throw error;
    });
    expect(() => pushGitBranch()).toThrow("Failed to connect to remote");
  });
});

describe("runGitStatus", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays clean status correctly", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n"); // rev-list

    await runGitStatus();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Branch: main"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Commit: a1b2c3d"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Status: clean"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Remote: up to date"));
  });

  it("displays dirty status with counts", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce(" M file.ts\n?? new.txt\n D old.txt\n") // dirty (getGitStatus)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce(" M file.ts\n?? new.txt\n D old.txt\n"); // dirty (getDirtyFileCount)

    await runGitStatus();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Status: dirty"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("+1"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("~1"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("-1"));
  });

  it("displays ahead/behind counts", async () => {
    mockExecSync
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("main\n")
      .mockReturnValueOnce("a1b2c3d\n")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("2\t3\n"); // ahead 2, behind 3

    await runGitStatus();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("↑2"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("↓3"));
  });

  it("exits with error when not a git repo", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    // Since process.exit is mocked and doesn't actually exit,
    // the function will continue and throw when accessing status.branch on null.
    // We just verify the expected error was logged and exit was called.
    try {
      await runGitStatus();
    } catch {
      // Ignore the TypeError from accessing null.status
    }

    expect(errorSpy).toHaveBeenCalledWith("Error: Not a git repository");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error when status fails", async () => {
    mockExecSync
      .mockReturnValueOnce(".git")
      .mockImplementation(() => {
        throw new Error("git error");
      });

    // Since process.exit is mocked and doesn't actually exit,
    // the function will continue and throw when accessing status.branch on null.
    try {
      await runGitStatus();
    } catch {
      // Ignore the TypeError from accessing null.status
    }

    expect(errorSpy).toHaveBeenCalledWith("Error: Failed to get git status");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runGitFetch", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches from origin by default", async () => {
    mockExecSync
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("");

    await runGitFetch();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Fetched from origin"));
  });

  it("fetches from specified remote", async () => {
    mockExecSync
      .mockReturnValueOnce(".git")
      .mockReturnValueOnce("");

    await runGitFetch("upstream");

    expect(mockExecSync).toHaveBeenLastCalledWith("git fetch upstream", { encoding: "utf-8", timeout: 30000 });
  });

  it("exits with error when not a git repo", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    await runGitFetch();

    expect(errorSpy).toHaveBeenCalledWith("Error: Not a git repository");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error for invalid remote name", async () => {
    mockExecSync.mockReturnValueOnce(".git");

    await runGitFetch("; rm -rf");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid remote name"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runGitPull", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pulls successfully with clean repo", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce("Already up to date."); // git pull

    await runGitPull();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Pulled latest changes"));
  });

  it("exits on merge conflict", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockImplementationOnce(() => {
        throw new Error("CONFLICT (content): Merge conflict in file.ts");
      }); // git pull

    await runGitPull();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Merge conflict detected"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prompts for confirmation when dirty", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce(" M file.ts\n") // dirty (getGitStatus)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce(" M file.ts\n") // dirty (getDirtyFileCount)
      .mockReturnValueOnce("Already up to date."); // git pull

    const questionMock = vi.fn().mockResolvedValue("y");
    const closeMock = vi.fn();
    mockCreateInterface.mockReturnValue({
      question: questionMock,
      close: closeMock,
    } as any);

    await runGitPull();

    expect(mockCreateInterface).toHaveBeenCalled();
    expect(questionMock).toHaveBeenCalledWith(expect.stringContaining("Continue with pull?"));
  });

  it("cancels when user declines confirmation", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce(" M file.ts\n") // dirty (getGitStatus)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce(" M file.ts\n"); // dirty (getDirtyFileCount)

    const questionMock = vi.fn().mockResolvedValue("n");
    const closeMock = vi.fn();
    mockCreateInterface.mockReturnValue({
      question: questionMock,
      close: closeMock,
    } as any);

    await runGitPull();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("skips confirmation with skipConfirm option", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce(" M file.ts\n") // dirty (getGitStatus)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce(" M file.ts\n") // dirty (getDirtyFileCount)
      .mockReturnValueOnce("Already up to date."); // git pull

    await runGitPull({ skipConfirm: true });

    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Pulled latest changes"));
  });
});

describe("runGitPush", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pushes successfully", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce("origin/main\n") // upstream exists
      .mockReturnValueOnce(""); // git push

    const questionMock = vi.fn().mockResolvedValue("y");
    const closeMock = vi.fn();
    mockCreateInterface.mockReturnValue({
      question: questionMock,
      close: closeMock,
    } as any);

    await runGitPush();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Pushed main to origin"));
  });

  it("exits when no upstream configured", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockImplementationOnce(() => { // upstream check
        throw new Error("no upstream");
      });

    await runGitPush({ skipConfirm: true });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No upstream configured"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits in detached HEAD state", async () => {
    // Mock detached HEAD detection - empty branch string means detached
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("") // branch - empty means detached
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n"); // rev-list

    await runGitPush({ skipConfirm: true });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("detached HEAD state"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prompts for confirmation by default", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce("origin/main\n") // upstream exists
      .mockReturnValueOnce(""); // git push

    const questionMock = vi.fn().mockResolvedValue("y");
    const closeMock = vi.fn();
    mockCreateInterface.mockReturnValue({
      question: questionMock,
      close: closeMock,
    } as any);

    await runGitPush();

    expect(questionMock).toHaveBeenCalledWith(expect.stringContaining("Push branch main to remote?"));
  });

  it("skips confirmation with skipConfirm option", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce("origin/main\n") // upstream exists
      .mockReturnValueOnce(""); // git push

    await runGitPush({ skipConfirm: true });

    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Pushed main to origin"));
  });

  it("cancels when user declines confirmation", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce("origin/main\n"); // upstream exists

    const questionMock = vi.fn().mockResolvedValue("n");
    const closeMock = vi.fn();
    mockCreateInterface.mockReturnValue({
      question: questionMock,
      close: closeMock,
    } as any);

    await runGitPush();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits on push error", async () => {
    mockExecSync
      .mockReturnValueOnce(".git") // isGitRepo
      .mockReturnValueOnce("main\n") // branch
      .mockReturnValueOnce("a1b2c3d\n") // commit
      .mockReturnValueOnce("") // status --porcelain (clean)
      .mockReturnValueOnce("0\t0\n") // rev-list
      .mockReturnValueOnce("origin/main\n") // upstream exists
      .mockImplementationOnce(() => { // git push
        throw new Error("push failed");
      });

    await runGitPush({ skipConfirm: true });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("push failed"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
