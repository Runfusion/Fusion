import { describe, expect, it, vi } from "vitest";
import {
  describeDependencySyncDecision,
  getConfiguredWorktreeInitCommand,
  type WorktreeDependencySyncResult,
} from "../merge/merge-dependency-sync.js";
import { ensureWorktreeDependencyReadiness, formatWorktreeDependencyReadinessLog } from "../worktree/dependency-readiness.js";

function syncResult(overrides: Partial<WorktreeDependencySyncResult> = {}): WorktreeDependencySyncResult {
  return {
    installCommand: "pnpm install --frozen-lockfile",
    configured: false,
    skipped: false,
    healed: false,
    durationMs: 42,
    ...overrides,
  };
}

describe("worktree dependency readiness", () => {
  it.each([
    ["fresh inferred install", syncResult(), "ran; source=inferred; command=pnpm install --frozen-lockfile; duration=42ms"],
    ["configured command", syncResult({ configured: true, installCommand: "./bootstrap" }), "ran; source=configured; command=./bootstrap; duration=42ms"],
    ["pooled marker match", syncResult({ skipped: true, skipReason: "lockfile-marker-match" }), "skipped-marker-match; source=inferred; command=pnpm install --frozen-lockfile; duration=42ms"],
    ["no install command", syncResult({ installCommand: null, skipped: true, skipReason: "no-command" }), "no-command; source=inferred; command=none; duration=42ms"],
    ["lockfile heal", syncResult({ healed: true, healedCommand: "pnpm install --no-frozen-lockfile" }), "healed; source=inferred; command=pnpm install --no-frozen-lockfile; duration=42ms"],
  ] as const)("formats the %s decision consistently", (_name, result, expected) => {
    expect(describeDependencySyncDecision(result)).toBe(expected);
  });

  it("delegates acquisition readiness to the shared installer once and preserves its decision", async () => {
    const install = vi.fn().mockResolvedValue(syncResult());

    const readiness = await ensureWorktreeDependencyReadiness({
      cwd: "/workspace/.worktrees/fn-255",
      taskId: "FN-255",
      context: "for task worktree",
      install,
    });

    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace/.worktrees/fn-255",
      taskId: "FN-255",
      context: "for task worktree",
    }));
    expect(readiness).toEqual({
      result: syncResult(),
      decision: "ran; source=inferred; command=pnpm install --frozen-lockfile; duration=42ms",
    });
  });

  it("labels a workspace child in its acquisition decision line", () => {
    expect(formatWorktreeDependencyReadinessLog("ran; source=inferred; command=npm install; duration=8ms", "repo2"))
      .toBe("Worktree dependency readiness [repo2]: ran; source=inferred; command=npm install; duration=8ms");
  });

  it("preserves a configured worktreeInitCommand as the authoritative command", async () => {
    expect(getConfiguredWorktreeInitCommand({ worktreeInitCommand: "  ./scripts/bootstrap  " } as never)).toBe("./scripts/bootstrap");
    expect(getConfiguredWorktreeInitCommand({} as never)).toBeNull();
  });

  it("propagates a non-fatal acquisition installer failure to its caller for first-run narration", async () => {
    await expect(ensureWorktreeDependencyReadiness({
      cwd: "/workspace/.worktrees/fn-255/repo2",
      taskId: "FN-255",
      install: vi.fn().mockRejectedValue(new Error("install unavailable")),
    })).rejects.toThrow("install unavailable");
  });
});
