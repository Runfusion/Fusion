/*
FNXC:WorkspaceWorktree 2026-08-24-06:11:
R14/R16: a workspace task's directory segment is named after its unit of work by honoring the
project's existing `worktreeNaming` setting. The interesting behavior is the fallback ladder, not
the happy path: a branch-derived name is operator convenience, so an unusable one degrades to the
task id and never fails an acquisition.
*/
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveWorkspaceTaskDirSegment,
  resolveWorktreesDirLayout,
  resolveWorkspaceTaskWorktreeDir,
  workspaceWorktreeGroupSegment,
  WORKSPACE_RESERVED_TASK_DIR_SEGMENTS,
} from "../tasks/worktree-layout.js";

describe("workspace task directory naming", () => {
  // Pure string fixtures for pure path functions: nothing here touches the filesystem, so they
  // deliberately do not name a real temp directory.
  const workspace = "/repos/PRD-1234-my-slug";

  it("derives a ticket slug from a namespaced working branch", () => {
    expect(deriveWorkspaceTaskDirSegment({ taskId: "FN-9200", worktreeNaming: "branch", branch: "feature/PRD-1234-my-slug" }))
      .toEqual({ segment: "prd-1234-my-slug" });
  });

  it("derives the same slug from a branch with no namespace", () => {
    expect(deriveWorkspaceTaskDirSegment({ taskId: "FN-9200", worktreeNaming: "branch", branch: "PRD-1234-my-slug" }).segment)
      .toBe("prd-1234-my-slug");
  });

  it("names the task directory in both layouts, since only grouping is opt-in", () => {
    const { segment } = deriveWorkspaceTaskDirSegment({ taskId: "FN-9200", worktreeNaming: "branch", branch: "feature/PRD-1234-my-slug" });
    expect(resolveWorkspaceTaskWorktreeDir(workspace, undefined, segment))
      .toBe("/repos/PRD-1234-my-slug/.fusion/worktrees/prd-1234-my-slug");
    expect(resolveWorkspaceTaskWorktreeDir(workspace, { worktreesDir: "/srv/trees" } as any, segment))
      .toBe("/srv/trees/PRD-1234-my-slug/prd-1234-my-slug");
  });

  it("falls back to the task id when the branch slugs to empty", () => {
    expect(deriveWorkspaceTaskDirSegment({ taskId: "FN-9201", worktreeNaming: "branch", branch: "feature/---" }))
      .toEqual({ segment: "fn-9201", fallbackReason: "empty-slug" });
    expect(deriveWorkspaceTaskDirSegment({ taskId: "FN-9201", worktreeNaming: "branch", branch: undefined }))
      .toEqual({ segment: "fn-9201", fallbackReason: "empty-slug" });
  });

  it("falls back for any case variant of a reserved container name", () => {
    for (const reserved of [".ai-merge", ".AI-Merge", "AI-MERGE", ".Fusion-Recovery", ".worktrees", ".Fusion-Workspace-Root"]) {
      const result = deriveWorkspaceTaskDirSegment({ taskId: "FN-9202", worktreeNaming: "branch", branch: `feature/${reserved}` });
      expect(result, reserved).toEqual({ segment: "fn-9202", fallbackReason: "reserved-name" });
    }
    expect(WORKSPACE_RESERVED_TASK_DIR_SEGMENTS).toContain(".ai-merge");
  });

  /*
  FNXC:WorkspaceWorktree 2026-08-25-08:33:
  A derived name may never occupy another task's id. A branch called `feature/FN-A` slugs to exactly
  `fn-a`; if another task claimed that, task FN-A would lose its derived claim AND find its own
  fallback taken — and the pin is write-once, so it could never acquire a workspace at all.
  */
  it("refuses a derived name that is another task's id, keeping every fallback claimable", () => {
    expect(deriveWorkspaceTaskDirSegment({
      taskId: "FN-9220",
      worktreeNaming: "branch",
      branch: "feature/FN-9221",
      siblingTaskIds: ["FN-9221", "FN-9222"],
    })).toEqual({ segment: "fn-9220", fallbackReason: "sibling-collision" });
  });

  it("refuses a derived name inside another task's fallback namespace", () => {
    for (const branch of ["feature/FN-9221-a1b2c3d4", "feature/FN-9221-a1b2c3d4-2", "feature/FN-9221-anything"]) {
      expect(deriveWorkspaceTaskDirSegment({
        taskId: "FN-9220",
        worktreeNaming: "branch",
        branch,
        siblingTaskIds: ["FN-9221"],
      }), branch).toEqual({ segment: "fn-9220", fallbackReason: "sibling-collision" });
    }
  });

  it("still allows a derived name matching the task's OWN id", () => {
    expect(deriveWorkspaceTaskDirSegment({
      taskId: "FN-9223",
      worktreeNaming: "branch",
      branch: "feature/FN-9223",
      siblingTaskIds: ["FN-9224"],
    })).toEqual({ segment: "fn-9223" });
  });

  it("gives two tasks whose branches slug identically distinct directories", () => {
    const first = deriveWorkspaceTaskDirSegment({ taskId: "FN-9203", worktreeNaming: "branch", branch: "feature/PRD-1234-my-slug" });
    expect(first).toEqual({ segment: "prd-1234-my-slug" });
    const second = deriveWorkspaceTaskDirSegment({
      taskId: "FN-9204",
      worktreeNaming: "branch",
      branch: "feature/prd-1234-MY-slug",
      siblingSegments: [first.segment],
    });
    expect(second).toEqual({ segment: "fn-9204", fallbackReason: "sibling-collision" });
    expect(second.segment).not.toBe(first.segment);
  });

  it("reproduces the historic task-id segment for task-id, random, and unset naming", () => {
    for (const worktreeNaming of ["task-id", "random", undefined]) {
      expect(deriveWorkspaceTaskDirSegment({ taskId: "FN-9205", worktreeNaming, branch: "feature/PRD-1234-my-slug", title: "A title" }))
        .toEqual({ segment: "fn-9205" });
    }
  });

  it("slugs the title for task-title naming, matching single-repository behavior", () => {
    expect(deriveWorkspaceTaskDirSegment({ taskId: "FN-9206", worktreeNaming: "task-title", title: "Close the Late Acquire Gap!" }))
      .toEqual({ segment: "close-the-late-acquire-gap" });
    expect(deriveWorkspaceTaskDirSegment({ taskId: "FN-9206", worktreeNaming: "task-title", title: "", description: "Fallback description text" }).segment)
      .toBe("fallback-description-text");
  });

  /*
  FNXC:WorkspaceWorktree 2026-08-24-06:11:
  R17: the group segment above the task directory stays derived from the workspace basename and is
  independent of `worktreeNaming`, so archive disposal and the pi-extension candidate builder can
  still resolve a grouped root from settings alone — neither has a Task in hand. If naming ever
  reached the group level, those two callers would resolve a different directory than acquisition.
  */
  it("resolves the grouped root from settings alone, with no task and no naming mode", () => {
    const grouped = resolveWorktreesDirLayout(join(workspace, "api"), { worktreesDir: "/srv/trees" } as any, {
      workspaceRootDir: workspace,
      repoRelPath: "api",
    });
    expect(grouped).toBe("/srv/trees/PRD-1234-my-slug/api");
    expect(workspaceWorktreeGroupSegment(workspace)).toBe("PRD-1234-my-slug");

    // Every naming mode leaves the group segment untouched; only the task level below it moves.
    for (const worktreeNaming of ["branch", "task-title", "task-id", undefined]) {
      const { segment } = deriveWorkspaceTaskDirSegment({ taskId: "FN-9207", worktreeNaming, branch: "feature/PRD-9999-other", title: "Other" });
      expect(resolveWorkspaceTaskWorktreeDir(workspace, { worktreesDir: "/srv/trees" } as any, segment))
        .toBe(`/srv/trees/PRD-1234-my-slug/${segment}`);
    }
  });
});
