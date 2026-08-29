import { describe, expect, it } from "vitest";
import { assertNotWorkspaceTaskMerge } from "../types.js";

// FNXC:Workspace 2026-08-15-04:54: `landWorkspaceTask` owns workspace-mode
// per-repository land. This shared predicate remains a defense-in-depth backstop
// at single-repository merge doors so a misrouted workspace task fails before git
// runs against the non-git workspace root; single-repo tasks are a no-op.
describe("assertNotWorkspaceTaskMerge (R7 workspace merge-boundary guard)", () => {
  it("is a no-op for a single-repo task (no workspaceWorktrees)", () => {
    expect(() => assertNotWorkspaceTaskMerge({ id: "FN-1" })).not.toThrow();
  });

  it("is a no-op when workspaceWorktrees is an empty record", () => {
    expect(() =>
      assertNotWorkspaceTaskMerge({ id: "FN-1", workspaceWorktrees: {} }),
    ).not.toThrow();
  });

  it("throws a named routing error for a populated workspace task", () => {
    let thrown: Error | undefined;
    try {
      assertNotWorkspaceTaskMerge({
        id: "FN-WS",
        workspaceWorktrees: {
          "repo-a": { worktreePath: "/tmp/a", branch: "fusion/fn-ws-a" },
          "repo-b": { worktreePath: "/tmp/b", branch: "fusion/fn-ws-b" },
        },
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.name).toBe("WorkspaceTaskMergeError");
    expect(thrown?.message).toBe(
      "Workspace task FN-WS reached a single-repo merge path; workspace tasks must land per-repo via landWorkspaceTask",
    );
    expect(thrown?.message).toContain("FN-WS");
  });

  it("throws even with a single workspace worktree entry", () => {
    expect(() =>
      assertNotWorkspaceTaskMerge({
        id: "FN-WS1",
        workspaceWorktrees: { "repo-a": { worktreePath: "/tmp/a", branch: "b" } },
      }),
    ).toThrow(/reached a single-repo merge path; workspace tasks must land per-repo via landWorkspaceTask/);
  });
});
