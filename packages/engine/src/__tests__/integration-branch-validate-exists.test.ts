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

describe("integration-branch resolver — settings branch existence guard", () => {
  beforeEach(() => {
    __resetIntegrationBranchCacheForTests();
    execMock.mockReset();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    __resetIntegrationBranchCacheForTests();
    vi.restoreAllMocks();
  });

  it("skips a settings branch that does not exist locally or in origin, falling through to origin/HEAD", async () => {
    // First call: verify existence of "homolog" → fails (empty stdout, exit non-zero via try/catch)
    // Second call: origin/HEAD → resolves to "main"
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("rev-parse --verify --quiet refs/heads/homolog refs/remotes/origin/homolog")) {
        cb(new Error("not a ref"), { stdout: "" });
        return {};
      }
      if (command.includes("refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "origin/main\n" });
        return {};
      }
      if (command.includes("for-each-ref") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(null, { stdout: "" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "homolog", baseBranch: "main" } as any);
    expect(resolved).toBe("main");
  });

  it("accepts a settings branch that exists locally", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("rev-parse --verify --quiet refs/heads/homolog")) {
        cb(null, { stdout: "abc123\n" });
        return {};
      }
      cb(new Error("unexpected command"), { stdout: "" });
      return {};
    });

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "homolog" } as any);
    expect(resolved).toBe("homolog");
  });

  it("accepts a settings branch that only exists in origin remote-tracking", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("rev-parse --verify --quiet refs/heads/develop refs/remotes/origin/develop")) {
        cb(null, { stdout: "deadbeef\n" });
        return {};
      }
      cb(new Error("unexpected"), { stdout: "" });
      return {};
    });

    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "develop" } as any);
    expect(resolved).toBe("develop");
  });

  it("falls through to INTEGRATION_BRANCH_FALLBACK when settings branch is missing and no other rung resolves", async () => {
    execMock.mockImplementation((command: string, _opts: object, cb: (error: Error | null, result: { stdout: string }) => void) => {
      if (command.includes("rev-parse --verify --quiet refs/heads/homolog")) {
        cb(new Error("not a ref"), { stdout: "" });
        return {};
      }
      if (command.includes("refs/remotes/origin/HEAD")) {
        cb(new Error("no symbolic ref"), { stdout: "" });
        return {};
      }
      if (command.includes("for-each-ref") || command.includes("symbolic-ref --quiet --short HEAD")) {
        cb(null, { stdout: "" });
        return {};
      }
      if (command === "git remote") {
        cb(null, { stdout: "origin\n" });
        return {};
      }
      cb(null, { stdout: "" });
      return {};
    });

    const warn = vi.fn();
    const resolved = await resolveIntegrationBranch("/repo", { integrationBranch: "homolog" } as any, { logger: { warn } });
    expect(resolved).toBe(INTEGRATION_BRANCH_FALLBACK);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("origin/HEAD is unset"));
  });

  it("resolveIntegrationBranchSync applies the same existence guard for the missing case", () => {
    execSyncMock.mockImplementation((command: string, _opts: object) => {
      if (typeof command === "string" && command.includes("rev-parse --verify --quiet refs/heads/homolog")) {
        throw new Error("not a ref");
      }
      if (typeof command === "string" && command.includes("refs/remotes/origin/HEAD")) {
        return Buffer.from("origin/main\n");
      }
      if (typeof command === "string" && (command.includes("for-each-ref") || command.includes("symbolic-ref --quiet --short HEAD"))) {
        return Buffer.from("");
      }
      if (typeof command === "string" && command === "git remote") {
        return Buffer.from("origin\n");
      }
      return Buffer.from("");
    });

    const resolved = resolveIntegrationBranchSync("/repo", { integrationBranch: "homolog", baseBranch: "main" } as any);
    expect(resolved).toBe("main");
  });
});
