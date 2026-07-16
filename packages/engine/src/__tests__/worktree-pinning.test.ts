import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isTaskPinnedWorktreeNaming,
  pinnedWorktreeSlug,
  pinnedWorktreePathForTask,
} from "../worktree-pinning.js";

describe("worktree-pinning", () => {
  describe("isTaskPinnedWorktreeNaming", () => {
    it("is true only for task-id naming", () => {
      expect(isTaskPinnedWorktreeNaming({ worktreeNaming: "task-id" })).toBe(true);
      expect(isTaskPinnedWorktreeNaming({ worktreeNaming: "random" })).toBe(false);
      expect(isTaskPinnedWorktreeNaming({ worktreeNaming: "task-title" })).toBe(false);
      expect(isTaskPinnedWorktreeNaming({})).toBe(false);
      expect(isTaskPinnedWorktreeNaming(undefined)).toBe(false);
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
  });
});
