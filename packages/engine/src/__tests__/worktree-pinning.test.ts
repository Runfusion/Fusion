import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { workspaceRepoSegment, workspaceWorktreeGroupSegment } from "@fusion/core";
import {
  isTaskPinnedWorktreeNaming,
  pinnedWorktreeSlug,
  pinnedWorktreePathForTask,
  preservedWorktreeTargetPathForTask,
} from "../worktree/worktree-pinning.js";

describe("worktree-pinning", () => {
  describe("isTaskPinnedWorktreeNaming", () => {
    it("is always true because every task now has a task-ID worktree", () => {
      expect(isTaskPinnedWorktreeNaming()).toBe(true);
      expect(isTaskPinnedWorktreeNaming({})).toBe(true);
    });
  });

  describe("pinnedWorktreeSlug", () => {
    it("lowercases the task id and never suffixes", () => {
      expect(pinnedWorktreeSlug("FN-7996")).toBe("fn-7996");
      expect(pinnedWorktreeSlug("fn-42")).toBe("fn-42");
    });
  });

  describe("pinnedWorktreePathForTask", () => {
    it("derives <rootDir>/.worktrees/<task-id> by default", () => {
      expect(pinnedWorktreePathForTask("FN-7996", undefined, "/repo")).toBe(
        join("/repo", ".worktrees", "fn-7996"),
      );
    });

    it("respects a configured worktreesDir with {repo} token", () => {
      expect(
        pinnedWorktreePathForTask("FN-1", { worktreesDir: "../wt/{repo}" }, "/home/me/myrepo"),
      ).toBe(join("/home/me/wt/myrepo", "fn-1"));
    });

    it("respects a ~-expanded worktreesDir", () => {
      expect(pinnedWorktreePathForTask("FN-2", { worktreesDir: "~/trees" }, "/repo")).toBe(
        join(homedir(), "trees", "fn-2"),
      );
    });

    it("is stable across calls (no random/dedup suffix)", () => {
      const a = pinnedWorktreePathForTask("FN-9", {}, "/repo");
      const b = pinnedWorktreePathForTask("FN-9", {}, "/repo");
      expect(a).toBe(b);
    });

    it("groups task-id paths by workspace and repository under a configured root", () => {
      const workspaceRoot = "/projects/PRD-1234-my-slug";
      const settings = { worktreesDir: "/shared/worktrees" };
      const api = pinnedWorktreePathForTask("FN-9162", settings, join(workspaceRoot, "api"), {
        workspaceRootDir: workspaceRoot,
        repoRelPath: "api",
      });
      const web = pinnedWorktreePathForTask("FN-9162", settings, join(workspaceRoot, "web"), {
        workspaceRootDir: workspaceRoot,
        repoRelPath: "web",
      });
      expect(api).toBe(join("/shared/worktrees", workspaceWorktreeGroupSegment(workspaceRoot), workspaceRepoSegment("api"), "fn-9162"));
      expect(web).toBe(join("/shared/worktrees", workspaceWorktreeGroupSegment(workspaceRoot), workspaceRepoSegment("web"), "fn-9162"));
      expect(api).not.toBe(web);
    });
  });

  describe("preservedWorktreeTargetPathForTask", () => {
    it("uses the task ID regardless of stale source metadata", () => {
      expect(preservedWorktreeTargetPathForTask(
        "FN-8400",
        "/legacy/recover-fn-8400",
        {},
        "/repo",
      )).toBe("/repo/.worktrees/fn-8400");
    });

    it("does not preserve a legacy basename", () => {
      expect(preservedWorktreeTargetPathForTask(
        "FN-8400",
        "/legacy/recover-fn-8400",
        {},
        "/repo",
      )).toBe("/repo/.worktrees/fn-8400");
    });
  });
});
