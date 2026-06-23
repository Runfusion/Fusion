import { describe, expect, it } from "vitest";
import { assertNotWorkspaceTaskMerge } from "../types.js";

// FNXC:Workspace 2026-06-21-19:05: R7 merge-boundary guard (master-plan U0).
// This shared predicate is called at all four merge entry points (engine
// dispatch, store.mergeTask, CLI onMergeImpl, CLI runTaskMerge). Workspace-mode
// tasks (populated workspaceWorktrees) must be held until per-repo merge support
// lands (master-plan U6); single-repo tasks are a no-op.
describe("assertNotWorkspaceTaskMerge (R7 workspace merge-boundary guard)", () => {
  it("is a no-op for a single-repo task (no workspaceWorktrees)", () => {
    expect(() => assertNotWorkspaceTaskMerge({ id: "FN-1" })).not.toThrow();
  });

  it("is a no-op when workspaceWorktrees is an empty record", () => {
    expect(() =>
      assertNotWorkspaceTaskMerge({ id: "FN-1", workspaceWorktrees: {} }),
    ).not.toThrow();
  });

  it("throws a U6-named error for a populated workspace task", () => {
    expect(() =>
      assertNotWorkspaceTaskMerge({
        id: "FN-WS",
        workspaceWorktrees: {
          "repo-a": { worktreePath: "/tmp/a", branch: "fusion/fn-ws-a" },
          "repo-b": { worktreePath: "/tmp/b", branch: "fusion/fn-ws-b" },
        },
      }),
    ).toThrow(
      "Workspace task FN-WS cannot merge until per-repo merge support (master-plan U6) lands",
    );
  });

  it("throws even with a single workspace worktree entry", () => {
    expect(() =>
      assertNotWorkspaceTaskMerge({
        id: "FN-WS1",
        workspaceWorktrees: { "repo-a": { worktreePath: "/tmp/a", branch: "b" } },
      }),
    ).toThrow(/master-plan U6/);
  });
});
