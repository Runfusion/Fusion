import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectIntegrationBranch } from "@fusion/core";

const { execMock, execSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execSync: execSyncMock,
  execFile: vi.fn(),
}));

import {
  __resetIntegrationBranchCacheForTests,
  INTEGRATION_BRANCH_FALLBACK,
  resolveIntegrationBranch,
  resolveIntegrationBranchSync,
} from "../merge/integration-branch.js";

describe("integration-branch resolver", () => {
  beforeEach(() => {
    __resetIntegrationBranchCacheForTests();
    execMock.mockReset();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    __resetIntegrationBranchCacheForTests();
    vi.restoreAllMocks();
  });

  it("integrationBranch override wins over baseBranch and origin/HEAD", async () => {
    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: " trunk ", baseBranch: "develop" } as any);

    expect(resolved).toBe("trunk");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("baseBranch wins over origin/HEAD", async () => {
    const resolved = await resolveIntegrationBranch("/repo", { baseBranch: " develop " } as any);

    expect(resolved).toBe("develop");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("strips refs/remotes/origin and origin prefixes", async () => {
    execMock.mockImplementationOnce((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: "refs/remotes/origin/master\n" });
      return {};
    });
    execMock.mockImplementationOnce((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: "origin/develop\n" });
      return {};
    });

    const first = await resolveIntegrationBranch("/repo-a", {} as any);
    const second = await resolveIntegrationBranch("/repo-b", {} as any);

    expect(first).toBe("master");
    expect(second).toBe("develop");
  });

  it("treats whitespace and empty settings as unset", async () => {
    execMock.mockImplementation((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: "origin/master\n" });
      return {};
    });

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "   ", baseBranch: "" } as any);

    expect(resolved).toBe("master");
  });

  it("falls back to main and warns once per rootDir", async () => {
    execMock.mockImplementation((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(new Error("no symbolic ref"), { stdout: "" });
      return {};
    });
    const warn = vi.fn();

    const first = await resolveIntegrationBranch("/repo", undefined, { logger: { warn } });
    const second = await resolveIntegrationBranch("/repo", undefined, { logger: { warn } });

    expect(first).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(second).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("origin/HEAD unset and no project override"));
  });

  it("falls back to main with actionable guidance when origin is absent but gitlab remote exists", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("origin/HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(null, { stdout: "" });
        return {};
      }
      cb(null, { stdout: "gitlab\n" });
      return {};
    });
    const warn = vi.fn();

    const resolved = await resolveIntegrationBranch("/repo", undefined, { logger: { warn } });

    expect(resolved).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("auto-detect checks origin/HEAD");
    expect(warn.mock.calls[0]?.[0]).toContain("origin is absent");
    expect(warn.mock.calls[0]?.[0]).toContain("found remote gitlab");
    expect(warn.mock.calls[0]?.[0]).toContain("set integrationBranch manually");
  });

  it("warns once per rootDir when origin exists but has no HEAD", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("origin/HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(null, { stdout: "" });
        return {};
      }
      cb(null, { stdout: "origin\ngitlab\norigin\n" });
      return {};
    });
    const warn = vi.fn();

    await expect(resolveIntegrationBranch("/repo", undefined, { logger: { warn } })).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);
    await expect(resolveIntegrationBranch("/repo", undefined, { logger: { warn } })).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("origin/HEAD is unset");
    expect(warn.mock.calls[0]?.[0]).toContain("found remote origin, gitlab");
  });

  it("adopts the only local master branch instead of naming main", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("origin/HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("refs/heads/")) {
        cb(null, { stdout: "master\n" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(null, { stdout: "master\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });
    const warn = vi.fn();

    await expect(resolveIntegrationBranch("/master-only", undefined, { logger: { warn } })).resolves.toBe("master");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'master'"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("well-known-local"));
  });

  it("prefers a well-known local branch when multiple local branches exist", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("origin/HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("refs/heads/")) {
        cb(null, { stdout: "develop\nmain\n" });
        return {};
      }
      if (command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(null, { stdout: "develop\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });

    await expect(resolveIntegrationBranch("/multiple-local", undefined, { logger: { warn: vi.fn() } })).resolves.toBe("main");
  });

  it("adopts an unambiguous remote-only branch", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("origin/HEAD") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("refs/heads/")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/develop\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });

    await expect(resolveIntegrationBranch("/remote-only", undefined, { logger: { warn: vi.fn() } })).resolves.toBe("develop");
  });

  it("falls back when every inferred branch is a Fusion sibling", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("origin/HEAD") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("refs/heads/")) {
        cb(null, { stdout: "fusion/fn-123\n" });
        return {};
      }
      if (command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/fusion/fn-456\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });

    await expect(resolveIntegrationBranch("/fusion-only", undefined, { logger: { warn: vi.fn() } })).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);
  });

  it("keeps sync and async inference aligned with the shared selector", async () => {
    const respondAsync = (command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("origin/HEAD") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("refs/heads/")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command.includes("refs/remotes/origin/")) {
        cb(null, { stdout: "origin/develop\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    };
    execMock.mockImplementation(respondAsync);
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("origin/HEAD") || command.includes("symbolic-ref --quiet --short HEAD")) {
        throw new Error("no symbolic ref");
      }
      if (command.includes("refs/remotes/origin/")) return "origin/develop\n";
      return "";
    });
    const expected = selectIntegrationBranch({
      localBranches: [],
      currentBranch: "",
      remoteBranches: ["develop"],
    });

    const asyncResolved = await resolveIntegrationBranch("/parity", undefined, { logger: { warn: vi.fn() } });
    const syncResolved = resolveIntegrationBranchSync("/parity-sync", undefined, { logger: { warn: vi.fn() } });

    expect(expected).toEqual({ branch: "develop", source: "remote-tracking" });
    expect(asyncResolved).toBe(expected?.branch);
    expect(syncResolved).toBe(expected?.branch);
  });

  it("sync and async variants match", async () => {
    execMock.mockImplementation((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: "refs/remotes/origin/master\n" });
      return {};
    });
    execSyncMock.mockReturnValue("origin/master\n");

    const asyncResolved = await resolveIntegrationBranch("/repo", undefined);
    const syncResolved = resolveIntegrationBranchSync("/repo", undefined);

    expect(syncResolved).toEqual(asyncResolved);
    expect(syncResolved).toBe("master");
  });

  it("swallows git failures and does not throw", async () => {
    execMock.mockImplementation((_command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      cb(new Error("git failed"), { stdout: "" });
      return {};
    });
    execSyncMock.mockImplementation(() => {
      throw new Error("git failed");
    });

    await expect(resolveIntegrationBranch("/repo", undefined)).resolves.toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(() => resolveIntegrationBranchSync("/repo", undefined)).not.toThrow();
  });
});
