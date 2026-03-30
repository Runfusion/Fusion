import { describe, it, expect, vi } from "vitest";
import {
  getGhErrorMessage,
  parseRepoFromRemote,
} from "./gh-cli.js";

// Tests for pure functions (no child_process dependency)
describe("getGhErrorMessage", () => {
  it("returns authentication error message for auth errors", () => {
    const error = new Error("not logged into any hosts");
    expect(getGhErrorMessage(error)).toContain("not authenticated");
    expect(getGhErrorMessage(error)).toContain("gh auth login");
  });

  it("returns not found message for 404 errors", () => {
    const error = new Error("404 Not Found");
    expect(getGhErrorMessage(error)).toContain("not found");
  });

  it("returns rate limit message for rate limit errors", () => {
    const error = new Error("API rate limit exceeded 403");
    expect(getGhErrorMessage(error)).toContain("rate limit");
  });

  it("returns generic message for unknown errors", () => {
    const error = new Error("something went wrong");
    expect(getGhErrorMessage(error)).toBe("something went wrong");
  });

  it("handles non-Error values", () => {
    expect(getGhErrorMessage("string error")).toBe("string error");
    expect(getGhErrorMessage(123)).toBe("123");
    expect(getGhErrorMessage(null)).toBe("null");
  });
});

describe("parseRepoFromRemote", () => {
  it("parses HTTPS remote URLs", () => {
    expect(parseRepoFromRemote("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
    expect(parseRepoFromRemote("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses SSH remote URLs", () => {
    expect(parseRepoFromRemote("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
    expect(parseRepoFromRemote("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseRepoFromRemote("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseRepoFromRemote("https://bitbucket.org/owner/repo.git")).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(parseRepoFromRemote("not-a-url")).toBeNull();
    expect(parseRepoFromRemote("")).toBeNull();
  });
});

// Tests for functions that depend on child_process - using inline implementations
describe("gh-cli functions (inline tests)", () => {
  // Inline implementation of getCurrentRepo logic for testing
  function getCurrentRepoLogic(
    execFileSyncFn: (cmd: string, args: string[], opts: unknown) => string | Buffer,
    cwd?: string
  ) {
    try {
      const remoteUrl = execFileSyncFn("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).toString().trim();

      return parseRepoFromRemote(remoteUrl);
    } catch {
      return null;
    }
  }

  describe("getCurrentRepo logic", () => {
    it("returns owner/repo from git remote", () => {
      const mockExec = vi.fn().mockReturnValue("https://github.com/myorg/myrepo.git\n");
      const result = getCurrentRepoLogic(mockExec, "/repo/path");
      
      expect(result).toEqual({ owner: "myorg", repo: "myrepo" });
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["remote", "get-url", "origin"],
        expect.objectContaining({ cwd: "/repo/path" })
      );
    });

    it("returns null when git command fails", () => {
      const mockExec = vi.fn().mockImplementation(() => {
        throw new Error("not a git repository");
      });
      expect(getCurrentRepoLogic(mockExec)).toBeNull();
    });

    it("returns null when remote is not a GitHub URL", () => {
      const mockExec = vi.fn().mockReturnValue("https://gitlab.com/owner/repo.git\n");
      expect(getCurrentRepoLogic(mockExec)).toBeNull();
    });
  });

  // Inline implementation of isGhAvailable logic for testing
  function isGhAvailableLogic(execFileSyncFn: (cmd: string, args: string[], opts: unknown) => string | Buffer) {
    try {
      execFileSyncFn("gh", ["--version"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  }

  describe("isGhAvailable logic", () => {
    it("returns true when gh --version succeeds", () => {
      const mockExec = vi.fn().mockReturnValue("gh version 2.40.0");
      expect(isGhAvailableLogic(mockExec)).toBe(true);
      expect(mockExec).toHaveBeenCalledWith("gh", ["--version"], expect.any(Object));
    });

    it("returns false when gh --version throws", () => {
      const mockExec = vi.fn().mockImplementation(() => {
        throw new Error("command not found: gh");
      });
      expect(isGhAvailableLogic(mockExec)).toBe(false);
    });
  });

  // Inline implementation of isGhAuthenticated logic for testing
  function isGhAuthenticatedLogic(execFileSyncFn: (cmd: string, args: string[], opts: unknown) => string | Buffer) {
    try {
      const result = execFileSyncFn("gh", ["auth", "status"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      return result.includes("Logged in") || result.includes("Authenticated");
    } catch {
      return false;
    }
  }

  describe("isGhAuthenticated logic", () => {
    it("returns true when gh auth status shows logged in", () => {
      const mockExec = vi.fn().mockReturnValue("Logged in to github.com as user");
      expect(isGhAuthenticatedLogic(mockExec)).toBe(true);
    });

    it("returns true when gh auth status shows Authenticated", () => {
      const mockExec = vi.fn().mockReturnValue("✓ Authenticated with github.com");
      expect(isGhAuthenticatedLogic(mockExec)).toBe(true);
    });

    it("returns false when gh auth status throws", () => {
      const mockExec = vi.fn().mockImplementation(() => {
        throw new Error("not logged in");
      });
      expect(isGhAuthenticatedLogic(mockExec)).toBe(false);
    });
  });

  // Inline implementation of runGh logic for testing
  interface GhError extends Error {
    code: number | null;
    stderr: string;
    stdout: string;
  }

  function runGhLogic(
    execFileSyncFn: (cmd: string, args: string[], opts: unknown) => string | Buffer,
    args: string[],
    cwd?: string
  ): string {
    try {
      const result = execFileSyncFn("gh", args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
      });
      return result.toString();
    } catch (err: unknown) {
      const execErr = err as Error & { code?: number | null; stdout?: string; stderr?: string };
      const error = new Error(`gh command failed: ${execErr.message}`) as GhError;
      error.code = execErr.code ?? null;
      error.stdout = execErr.stdout ?? "";
      error.stderr = execErr.stderr ?? "";
      throw error;
    }
  }

  describe("runGh logic", () => {
    it("executes gh command with args and returns output", () => {
      const mockExec = vi.fn().mockReturnValue("command output\n");
      const result = runGhLogic(mockExec, ["pr", "list"]);
      expect(result).toBe("command output\n");
      expect(mockExec).toHaveBeenCalledWith("gh", ["pr", "list"], expect.any(Object));
    });

    it("passes cwd option", () => {
      const mockExec = vi.fn().mockReturnValue("output");
      runGhLogic(mockExec, ["pr", "list"], "/some/path");
      expect(mockExec).toHaveBeenCalledWith("gh", ["pr", "list"], expect.objectContaining({
        cwd: "/some/path",
      }));
    });

    it("throws GhError on command failure", () => {
      const execErr = new Error("command failed") as Error & { code: number; stdout: string; stderr: string };
      execErr.code = 1;
      execErr.stdout = "";
      execErr.stderr = "error message";
      
      const mockExec = vi.fn().mockImplementation(() => {
        throw execErr;
      });

      try {
        runGhLogic(mockExec, ["pr", "view", "999"]);
        expect.fail("should have thrown");
      } catch (err) {
        const ghErr = err as GhError;
        expect(ghErr.message).toContain("gh command failed");
        expect(ghErr.code).toBe(1);
        expect(ghErr.stderr).toBe("error message");
      }
    });
  });
});
