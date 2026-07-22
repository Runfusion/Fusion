import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { BranchAttributionError } from "../execution/branch-attribution.js";
import { createMockStore, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

const { filterFilesToOwnTaskCommitsMock } = vi.hoisted(() => ({
  filterFilesToOwnTaskCommitsMock: vi.fn(),
}));

vi.mock("../execution/branch-attribution.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/branch-attribution.js")>("../branch-attribution.js");
  return {
    ...actual,
    filterFilesToOwnTaskCommits: filterFilesToOwnTaskCommitsMock,
  };
});

describe("FN-5039 executor captureModifiedFiles attribution", () => {
  beforeEach(() => {
    resetExecutorMocks();
    filterFilesToOwnTaskCommitsMock.mockReset();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("merge-base HEAD origin/main") || cmd.includes("merge-base HEAD main")) {
        return Buffer.from("base123\n");
      }
      if (cmd.includes("git diff --name-only base123..HEAD")) {
        return Buffer.from("own.ts\nforeign.ts\n");
      }
      return Buffer.from("");
    });
  });

  it("returns attributed own files and skips contamination audit when no divergence", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");
    filterFilesToOwnTaskCommitsMock.mockResolvedValue({
      files: ["own.ts"],
      foreignCommits: [],
      ownCommitCount: 1,
      rawDiffFileCount: 1,
    });
    const audit = { database: vi.fn() };

    const files = await (executor as any).captureModifiedFiles("/repo/.worktrees/wt", "base123", "FN-5039", audit, "post-session");

    expect(files).toEqual(["own.ts"]);
    expect(audit.database).not.toHaveBeenCalled();
  });

  it("emits contamination audit when raw diff exceeds attributed files", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");
    filterFilesToOwnTaskCommitsMock.mockResolvedValue({
      files: ["own.ts"],
      foreignCommits: [
        { sha: "abc", subject: "foreign", attributedTaskId: "FN-1000" },
        { sha: "def", subject: "foreign2", attributedTaskId: null },
      ],
      ownCommitCount: 1,
      rawDiffFileCount: 3,
    });
    const audit = { database: vi.fn() };

    const files = await (executor as any).captureModifiedFiles("/repo/.worktrees/wt", "base123", "FN-5039", audit, "scope-leak-guard");

    expect(files).toEqual(["own.ts"]);
    expect(audit.database).toHaveBeenCalledTimes(1);
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:worktree-contamination-detected",
      target: "FN-5039",
      metadata: expect.objectContaining({
        rawDiffFileCount: 3,
        attributedFileCount: 1,
        foreignCommitCount: 2,
        source: "scope-leak-guard",
      }),
    }));
  });

  it("falls back to raw diff when branch attribution fails", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");
    filterFilesToOwnTaskCommitsMock.mockRejectedValue(new BranchAttributionError("bad log"));
    const audit = { database: vi.fn() };

    const files = await (executor as any).captureModifiedFiles("/repo/.worktrees/wt", "base123", "FN-5039", audit, "post-session");

    expect(files).toEqual(["own.ts", "foreign.ts"]);
    expect(audit.database).not.toHaveBeenCalled();
  });

  it("returns [] when diff base cannot be resolved", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git merge-base HEAD origin/main") || cmd.includes("git merge-base HEAD main")) {
        throw new Error("no base");
      }
      if (cmd.includes("git rev-parse HEAD~1")) {
        throw new Error("no head~1");
      }
      return Buffer.from("");
    });
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/repo");

    const files = await (executor as any).captureModifiedFiles("/repo/.worktrees/wt", undefined, "FN-5039");

    expect(files).toEqual([]);
    expect(filterFilesToOwnTaskCommitsMock).not.toHaveBeenCalled();
  });

  it("scope-leak guard excludes foreign-only contamination from warning", async () => {
    const store = createMockStore();
    store.parseFileScopeFromPrompt.mockResolvedValue(["task-file.ts"]);
    const executor = new TaskExecutor(store as any, "/repo");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue(["task-file.ts"]);
    vi.spyOn(executor as any, "captureUncommittedModifiedFiles").mockResolvedValue([]);

    const result = await (executor as any).evaluateTaskDoneScopeLeak(
      { id: "FN-5039", baseCommitSha: "base123" } as Task,
      "/repo/.worktrees/wt",
      "## Review Level: 1",
      { planOnlyScopeLeakEnforcement: "block" },
    );

    expect(result).toEqual({ blocked: false });
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-5039",
      expect.stringMatching(/\[scope-leak\].*off-scope/),
      undefined,
      undefined,
    );
  });

  it("scope-leak guard still warns for own committed off-scope files", async () => {
    const store = createMockStore();
    store.parseFileScopeFromPrompt.mockResolvedValue(["task-file.ts"]);
    const executor = new TaskExecutor(store as any, "/repo");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue(["task-file.ts", "AGENTS.md"]);
    vi.spyOn(executor as any, "captureUncommittedModifiedFiles").mockResolvedValue([]);

    const result = await (executor as any).evaluateTaskDoneScopeLeak(
      { id: "FN-5039", baseCommitSha: "base123" } as Task,
      "/repo/.worktrees/wt",
      "## Review Level: 1",
      { planOnlyScopeLeakEnforcement: "block" },
    );

    expect(result).toEqual(expect.objectContaining({ blocked: true }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-5039",
      expect.stringMatching(/\[scope-leak\].*AGENTS\.md/),
      undefined,
      undefined,
    );
  });

  it("scope-leak guard still warns for uncommitted off-scope files", async () => {
    const store = createMockStore();
    store.parseFileScopeFromPrompt.mockResolvedValue(["task-file.ts"]);
    const executor = new TaskExecutor(store as any, "/repo");
    vi.spyOn(executor as any, "captureModifiedFiles").mockResolvedValue(["task-file.ts"]);
    vi.spyOn(executor as any, "captureUncommittedModifiedFiles").mockResolvedValue(["AGENTS.md"]);

    const result = await (executor as any).evaluateTaskDoneScopeLeak(
      { id: "FN-5039", baseCommitSha: "base123" } as Task,
      "/repo/.worktrees/wt",
      "## Review Level: 1",
      { planOnlyScopeLeakEnforcement: "block" },
    );

    expect(result).toEqual(expect.objectContaining({ blocked: true }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-5039",
      expect.stringMatching(/\[scope-leak\].*AGENTS\.md/),
      undefined,
      undefined,
    );
  });

});
