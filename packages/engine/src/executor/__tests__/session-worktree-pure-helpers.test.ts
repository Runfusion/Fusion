/**
 * FNXC:CodeOrganization 2026-08-03-20:20:
 * Unit tests for U4 pure peels: hasLiveSessionSurface, listWorktreeHolders,
 * isAgentEffectivelyExecuting, getWorktreePath, ephemeral deletion helpers,
 * and buildInjectedRuntimeEnv.
 */
import { describe, expect, it } from "vitest";
import { hasLiveSessionSurface } from "../has-live-session-surface.js";
import { listWorktreeHolders } from "../list-worktree-holders.js";
import { isAgentEffectivelyExecuting } from "../is-agent-effectively-executing.js";
import { getWorktreePath } from "../get-worktree-path.js";
import {
  disposeEphemeralTimers,
  isEphemeralDeletionPending,
} from "../ephemeral-deletion-pending.js";
import { buildInjectedRuntimeEnv } from "../build-injected-runtime-env.js";

describe("hasLiveSessionSurface", () => {
  it("is true when any session map owns the task", () => {
    const deps = {
      activeSessions: new Map([["T1", {}]]),
      activeStepExecutors: new Map<string, unknown>(),
      activeWorkflowStepSessions: new Map<string, unknown>(),
      activeCliTaskSessions: new Map<string, unknown>(),
      pathsForTask: () => [] as string[],
    };
    expect(hasLiveSessionSurface(deps, "T1")).toBe(true);
    expect(hasLiveSessionSurface(deps, "T2")).toBe(false);
  });

  it("is true when registry paths exist even if maps are empty", () => {
    const deps = {
      activeSessions: new Map<string, unknown>(),
      activeStepExecutors: new Map<string, unknown>(),
      activeWorkflowStepSessions: new Map<string, unknown>(),
      activeCliTaskSessions: new Map<string, unknown>(),
      pathsForTask: (id: string) => (id === "T1" ? ["/wt"] : []),
    };
    expect(hasLiveSessionSurface(deps, "T1")).toBe(true);
    expect(hasLiveSessionSurface(deps, "T2")).toBe(false);
  });
});

describe("listWorktreeHolders", () => {
  it("emits one row per path including multi-worktree tasks", () => {
    const map = new Map<string, Set<string>>([
      ["T1", new Set(["/a", "/b"])],
      ["T2", new Set(["/c"])],
    ]);
    expect(listWorktreeHolders(map)).toEqual([
      { taskId: "T1", worktreePath: "/a" },
      { taskId: "T1", worktreePath: "/b" },
      { taskId: "T2", worktreePath: "/c" },
    ]);
  });
});

describe("isAgentEffectivelyExecuting", () => {
  it("matches any effective column-agent principal", () => {
    const map = new Map([
      ["T1", "agent-a"],
      ["T2", "agent-b"],
    ]);
    expect(isAgentEffectivelyExecuting(map, "agent-b")).toBe(true);
    expect(isAgentEffectivelyExecuting(map, "agent-c")).toBe(false);
    expect(isAgentEffectivelyExecuting(map, "")).toBe(false);
  });
});

describe("getWorktreePath", () => {
  it("returns first path for single-repo mode and undefined in workspace mode", () => {
    const paths = (id: string) => (id === "T1" ? ["/only"] : []);
    expect(getWorktreePath(null, paths, "T1")).toBe("/only");
    expect(getWorktreePath({ repos: [] }, paths, "T1")).toBeUndefined();
  });
});

describe("ephemeral deletion helpers", () => {
  it("tracks pending deletes and clears on dispose", () => {
    const pending = new Set<string>(["a1"]);
    expect(isEphemeralDeletionPending(pending, "a1")).toBe(true);
    expect(isEphemeralDeletionPending(pending, "a2")).toBe(false);
    disposeEphemeralTimers(pending);
    expect(pending.size).toBe(0);
  });
});

describe("buildInjectedRuntimeEnv", () => {
  it("merges plugin env and path prepend without mutating process.env", async () => {
    const originalPath = process.env.PATH;
    const result = await buildInjectedRuntimeEnv(
      {
        rootDir: "/repo",
        collectExecutorRuntimeEnv: async () => ({
          env: { FUSION_CE_SKILLS_DIR: "/skills" },
          pathPrepend: ["/plugin/bin"],
        }),
      },
      "T1",
      "/wt",
      "branch",
    );
    expect(result.injectedKeyCount).toBe(1);
    expect(result.pathEntryCount).toBe(1);
    expect(result.env.FUSION_CE_SKILLS_DIR).toBe("/skills");
    expect(result.env.PATH?.startsWith("/plugin/bin")).toBe(true);
    expect(process.env.PATH).toBe(originalPath);
    expect(process.env.FUSION_CE_SKILLS_DIR).toBeUndefined();
  });

  it("works without a plugin collector", async () => {
    const result = await buildInjectedRuntimeEnv(
      { rootDir: "/repo" },
      "T1",
      "/wt",
      undefined,
    );
    expect(result.injectedKeyCount).toBe(0);
    expect(result.pathEntryCount).toBe(0);
  });
});
