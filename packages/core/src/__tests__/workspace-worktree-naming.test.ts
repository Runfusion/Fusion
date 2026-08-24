/*
FNXC:WorkspaceWorktree 2026-08-24-06:11:
R14/R16: a workspace task's directory segment is named after its unit of work by honoring the
project's existing `worktreeNaming` setting. The interesting behavior is the fallback ladder, not
the happy path: a branch-derived name is operator convenience, so an unusable one degrades to the
task id and never fails an acquisition.
*/
import { describe, expect, it } from "vitest";
import {
  deriveWorkspaceTaskDirSegment,
  resolveWorkspaceTaskWorktreeDir,
  WORKSPACE_RESERVED_TASK_DIR_SEGMENTS,
} from "../tasks/worktree-layout.js";

describe("workspace task directory naming", () => {
  const workspace = "/tmp/PRD-1234-my-slug";

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
      .toBe("/tmp/PRD-1234-my-slug/.fusion/worktrees/prd-1234-my-slug");
    expect(resolveWorkspaceTaskWorktreeDir(workspace, { worktreesDir: "/var/tmp/trees" } as any, segment))
      .toBe("/var/tmp/trees/PRD-1234-my-slug/prd-1234-my-slug");
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
});
