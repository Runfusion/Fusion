import { describe, it, expect, vi } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

// Mock child_process before importing gh-cli so runGhAsync's `execFile`
// reference uses our stub. We only mock execFile because the timeout path
// is what we need to exercise; the synchronous helpers don't go through it.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: mockExecFile };
});

import {
  getGhErrorMessage,
  parseRepoFromRemote,
  runGhAsync,
} from "../gh-cli.js";

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

describe("runGhAsync timeout / abort", () => {
  // Each test wires execFile to capture the AbortSignal from gh-cli's
  // internal controller and the user callback, then drives the abort path
  // explicitly. This mirrors what real Node would do: when the signal fires,
  // execFile invokes its callback with an AbortError-shaped failure.
  type ExecFileCb = (
    err: (Error & { code?: string | number; killed?: boolean }) | null,
    stdout: string,
    stderr: string,
  ) => void;

  function captureExecFile(): { signalRef: { current?: AbortSignal }; cbRef: { current?: ExecFileCb } } {
    const signalRef: { current?: AbortSignal } = {};
    const cbRef: { current?: ExecFileCb } = {};
    mockExecFile.mockImplementation((_bin, _args, options, callback) => {
      signalRef.current = (options as { signal?: AbortSignal }).signal;
      cbRef.current = callback as ExecFileCb;
      // When the signal fires, invoke the callback with an AbortError-shaped
      // failure — that's what Node's real execFile does on signal abort.
      signalRef.current?.addEventListener("abort", () => {
        const err = new Error("aborted") as Error & { code?: string };
        err.name = "AbortError";
        err.code = "ABORT_ERR";
        callback?.(err as never, "", "");
      }, { once: true });
      return {} as ReturnType<typeof import("node:child_process").execFile>;
    });
    return { signalRef, cbRef };
  }

  it("rejects with timeout message after timeoutMs elapses and reports ABORT_ERR code", async () => {
    vi.useFakeTimers();
    mockExecFile.mockReset();
    captureExecFile();

    const promise = runGhAsync(["api", "repos/owner/repo"], { timeoutMs: 1_000 });
    const settled = promise.then(
      (v) => ({ ok: true as const, v }),
      (err) => ({ ok: false as const, err }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.err.message).toContain("timed out after 1000ms");
      expect(outcome.err.code).toBe("ABORT_ERR");
    }
    vi.useRealTimers();
  });

  it("propagates an external AbortSignal and rejects with the abort reason", async () => {
    mockExecFile.mockReset();
    captureExecFile();

    const ac = new AbortController();
    const promise = runGhAsync(["api", "x"], { signal: ac.signal, timeoutMs: 0 });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err }),
    );

    ac.abort(new Error("user cancelled"));
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.err.message).toContain("user cancelled");
      expect(outcome.err.code).toBe("ABORT_ERR");
    }
  });

  it("rejects synchronously when the external signal is already aborted", async () => {
    mockExecFile.mockReset();
    // Should never be called — pre-aborted check happens before exec.
    const ac = new AbortController();
    ac.abort(new Error("pre-cancelled"));

    await expect(runGhAsync(["api", "x"], { signal: ac.signal })).rejects.toMatchObject({
      message: expect.stringContaining("pre-cancelled"),
      code: "ABORT_ERR",
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("disables the timeout when timeoutMs <= 0", async () => {
    mockExecFile.mockReset();
    const { cbRef } = captureExecFile();

    const promise = runGhAsync(["api", "x"], { timeoutMs: 0 });
    // Resolve normally — verifies no implicit timeout fires and shorts the call.
    cbRef.current?.(null, "ok\n", "");
    await expect(promise).resolves.toBe("ok\n");
  });
});
