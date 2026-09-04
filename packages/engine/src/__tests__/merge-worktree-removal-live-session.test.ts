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

  it("routes AI merge cleanup through the proof-gated shared helper without raw force removal", async () => {
    const fs = await import("node:fs/promises");
    const [mergerSource, cleanupSource] = await Promise.all([
      fs.readFile(new URL("../merge/merger-ai.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("../merge/post-landing-worktree-cleanup.ts", import.meta.url), "utf8"),
    ]);

    expect(mergerSource).toContain("cleanupLandedTaskWorktree");
    expect(cleanupSource).toContain("RemovalReason.CompletionLandedCleanup");
    expect(mergerSource).not.toMatch(/git\s+worktree\s+remove\s+--force/);
    expect(cleanupSource).not.toMatch(/git\s+worktree\s+remove\s+--force/);
  });
});
