import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunCommandResult, TaskStore } from "@fusion/core";

const { loadWorkspaceConfig } = vi.hoisted(() => ({ loadWorkspaceConfig: vi.fn() }));
vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), { loadWorkspaceConfig });
});

import { createInstallWorktreeDependenciesTool } from "../agent-tools.js";
import { readDependencyInstallRecord, resolveWorktreeDependencyReadiness } from "../worktree/worktree-dependency-install.js";
import { COMMAND_EXECUTION_FN_TOOLS } from "../execution/gating-classifications.js";
import { READONLY_ALLOWLIST } from "../workflows/workflow-step-tool-policy.js";

const roots: string[] = [];

function root(files: Record<string, string>): string {
  const path = mkdtempSync(join(tmpdir(), "fn-258-planner-tool-"));
  roots.push(path);
  mkdirSync(join(path, ".git"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(path, name), value);
  return path;
}

function commandResult(exitCode: number): RunCommandResult {
  return { stdout: exitCode === 0 ? "done" : "", stderr: exitCode === 0 ? "" : "failure", exitCode, signal: null, timedOut: false, bufferExceeded: false };
}

function storeFor(task: Record<string, unknown>) {
  return {
    getTask: vi.fn().mockResolvedValue(task),
    getSettings: vi.fn().mockResolvedValue({}),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

async function execute(tool: ReturnType<typeof createInstallWorktreeDependenciesTool>, params: Record<string, unknown>) {
  return tool.execute("tool-call", params as never, undefined as never, undefined as never, undefined as never);
}

afterEach(() => {
  vi.clearAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("fn_install_worktree_dependencies", () => {
  it("records installed only after an engine-observed zero exit", async () => {
    const worktree = root({ "flake.nix": "{}" });
    loadWorkspaceConfig.mockResolvedValue(null);
    const runner = vi.fn().mockResolvedValue(commandResult(0));
    const store = storeFor({ id: "FN-258", worktree });
    const tool = createInstallWorktreeDependenciesTool(store, "FN-258", {
      rootDir: worktree,
      runConfiguredCommand: runner,
      getSettings: async () => ({} as never),
    });

    const result = await execute(tool, { action: "install", command: "nix develop --command true" });
    expect(result.isError).not.toBe(true);
    expect(runner).toHaveBeenCalledWith("nix develop --command true", worktree, 300_000, expect.any(Object));
    expect(readDependencyInstallRecord(worktree)?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ ecosystem: "planner", outcome: "installed" }),
    ]));
    expect(getText(result)).toContain("Readiness: satisfied");
  });

  it("retains a blocking result after a non-zero engine command", async () => {
    const worktree = root({ "flake.nix": "{}" });
    loadWorkspaceConfig.mockResolvedValue(null);
    const tool = createInstallWorktreeDependenciesTool(storeFor({ id: "FN-258", worktree }), "FN-258", {
      rootDir: worktree,
      runConfiguredCommand: vi.fn().mockResolvedValue(commandResult(2)),
      getSettings: async () => ({} as never),
    });

    const result = await execute(tool, { action: "install", command: "nix develop --command true" });
    expect(result.isError).toBe(true);
    const readiness = resolveWorktreeDependencyReadiness(worktree, [], ["flake.nix"]);
    expect(readiness.readiness).toBe("unrecognized");
    expect(readDependencyInstallRecord(worktree)?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ ecosystem: "planner", outcome: "install-failed" }),
    ]));
  });

  it("requires a reason for none and records a reasoned no-install resolution", async () => {
    const worktree = root({ "something.lock": "opaque" });
    loadWorkspaceConfig.mockResolvedValue(null);
    const store = storeFor({ id: "FN-258", worktree });
    const tool = createInstallWorktreeDependenciesTool(store, "FN-258", {
      rootDir: worktree,
      runConfiguredCommand: vi.fn(),
      getSettings: async () => ({} as never),
    });

    expect((await execute(tool, { action: "none" })).isError).toBe(true);
    const result = await execute(tool, { action: "none", reason: "The file is an application lock, not a package-manager lock." });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain("Readiness: satisfied");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-258",
      expect.stringContaining("Planner recorded no dependency install step"),
      expect.stringContaining("application lock"),
      undefined,
    );
  });

  it("requires and scopes repository selection in multi-repository workspaces", async () => {
    const first = root({ "flake.nix": "{}" });
    const second = root({ "flake.nix": "{}" });
    loadWorkspaceConfig.mockResolvedValue({ repos: ["first", "second"] });
    const runner = vi.fn().mockResolvedValue(commandResult(0));
    const tool = createInstallWorktreeDependenciesTool(storeFor({
      id: "FN-258",
      workspaceWorktrees: { first: { worktreePath: first }, second: { worktreePath: second } },
    }), "FN-258", {
      rootDir: first,
      runConfiguredCommand: runner,
      getSettings: async () => ({} as never),
    });

    expect((await execute(tool, { action: "install", command: "nix develop --command true" })).isError).toBe(true);
    await execute(tool, { action: "install", command: "nix develop --command true", repository: "second" });
    expect(runner).toHaveBeenCalledWith("nix develop --command true", second, 300_000, expect.any(Object));
  });

  it("rewrites the planner resolution instead of appending duplicates", async () => {
    const worktree = root({ "flake.nix": "{}" });
    loadWorkspaceConfig.mockResolvedValue(null);
    const tool = createInstallWorktreeDependenciesTool(storeFor({ id: "FN-258", worktree }), "FN-258", {
      rootDir: worktree,
      runConfiguredCommand: vi.fn().mockResolvedValue(commandResult(0)),
      getSettings: async () => ({} as never),
    });

    await execute(tool, { action: "install", command: "nix develop --command true" });
    await execute(tool, { action: "install", command: "nix develop --command true" });
    expect(readDependencyInstallRecord(worktree)?.entries.filter((entry) => entry.ecosystem === "planner")).toHaveLength(1);
  });

  it("is command-classified but never available to readonly workflow steps", () => {
    expect(COMMAND_EXECUTION_FN_TOOLS.has("fn_install_worktree_dependencies")).toBe(true);
    expect(READONLY_ALLOWLIST).not.toContain("fn_install_worktree_dependencies");
  });
});

function getText(result: any): string {
  return result?.content?.[0]?.type === "text" ? result.content[0].text : "";
}
