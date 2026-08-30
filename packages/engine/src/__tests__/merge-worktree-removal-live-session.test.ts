import { describe, expect, it } from "vitest";

import { ActiveSessionRegistry } from "../agents/active-session-registry.js";

/*
 * FNXC:MergeWorktreeLiveSession 2026-08-23-09:15:
 * FN-180's merger cleanup must use the shared removal path so an abort followed by a successor
 * executor registration cannot delete that successor's worktree.
 */
describe("FN-180 merge worktree removal with a live session", () => {
  it("keeps a successor registration live across an abort-like unregister/register handoff", () => {
    const registry = new ActiveSessionRegistry();
    const path = "/worktrees/FN-180";
    registry.registerPath(path, { taskId: "FN-180", kind: "executor" });
    registry.unregisterPath(path);
    registry.registerPath(path, { taskId: "FN-180", kind: "executor" });
    expect(registry.isPathActive(path)).toBe(true);
    expect(registry.pathsForTask("FN-180")).toEqual([path]);
    registry.unregisterPath(path);
  });

  it("does not leave a raw force removal route in AI merge cleanup", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../merge/merger-ai.ts", import.meta.url), "utf8",
    );
    expect(source).toContain("RemovalReason.MergerCleanup");
    expect(source).not.toMatch(/git\s+worktree\s+remove\s+--force/);
  });
});
