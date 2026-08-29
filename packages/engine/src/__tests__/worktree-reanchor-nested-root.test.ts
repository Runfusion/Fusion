import { beforeEach, describe, expect, it } from "vitest";
import "./executor-test-helpers.js";
import { detectNestedWorktreeRoot } from "../worktree/worktree-pool.js";
import { mockedExecSync, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";
describe("detectNestedWorktreeRoot", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("re-anchors when task worktree is a nested subdirectory of a registered worktree root", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/gentle-flame\n");
      if (cmd.includes("worktree list --porcelain")) {
        return Buffer.from("worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.worktrees/gentle-flame\nbranch refs/heads/fusion/fn-1\n");
      }
      return Buffer.from("");
    });

    const result = await detectNestedWorktreeRoot("/repo", "/repo/.worktrees/gentle-flame/packages/core");
    expect(result).toEqual({ reanchored: true, root: "/repo/.worktrees/gentle-flame" });
  });

  it("does not re-anchor when git top-level is repo root", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo\n");
      return Buffer.from("");
    });

    const result = await detectNestedWorktreeRoot("/repo", "/repo/.worktrees/gentle-flame/packages/core");
    expect(result).toEqual({ reanchored: false, reason: "toplevel_is_repo_root" });
  });

  it("does not re-anchor when top-level is outside configured worktrees dir", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/tmp/other\n");
      return Buffer.from("");
    });

    const result = await detectNestedWorktreeRoot("/repo", "/repo/.worktrees/gentle-flame/packages/core");
    expect(result).toEqual({ reanchored: false, reason: "toplevel_outside_configured_dir" });
  });

  it("does not re-anchor when top-level worktree is not registered", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/gentle-flame\n");
      if (cmd.includes("worktree list --porcelain")) {
        return Buffer.from("worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.worktrees/some-other\nbranch refs/heads/fusion/fn-2\n");
      }
      return Buffer.from("");
    });

    const result = await detectNestedWorktreeRoot("/repo", "/repo/.worktrees/gentle-flame/packages/core");
    expect(result).toEqual({ reanchored: false, reason: "toplevel_not_registered_worktree" });
  });

  it("does not re-anchor when worktree path is missing", async () => {
    mockedExistsSync.mockReturnValue(false);

    const result = await detectNestedWorktreeRoot("/repo", "/repo/.worktrees/gentle-flame/packages/core");
    expect(result).toEqual({ reanchored: false, reason: "worktree_missing" });
  });

  it("does not re-anchor when worktree path is already at top-level", async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/gentle-flame\n");
      return Buffer.from("");
    });

    const result = await detectNestedWorktreeRoot("/repo", "/repo/.worktrees/gentle-flame");
    expect(result).toEqual({ reanchored: false, reason: "already_at_toplevel" });
  });
});
