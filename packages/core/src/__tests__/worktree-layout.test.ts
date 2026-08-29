import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceRepoRelPath,
  resolveWorktreesDirLayout,
  resolveWorkspaceRepoWorktreePath,
  resolveWorkspaceTaskWorktreeDir,
  isLegacyWorkspaceWorktreeLayout,
  sanitizePathSegment,
  workspaceRepoSegment,
  workspaceWorktreeGroupSegment,
} from "../tasks/worktree-layout.js";

describe("workspace worktree layout", () => {
  const workspace = "/tmp/PRD-1234-my-slug";
  const context = { workspaceRootDir: workspace, repoRelPath: "api" };

  it("keeps the unset layout byte-identical", () => {
    expect(resolveWorktreesDirLayout("/tmp/repo", undefined)).toBe("/tmp/repo/.worktrees");
    expect(resolveWorktreesDirLayout(join(workspace, "api"), undefined, context)).toBe(join(workspace, "api", ".worktrees"));
  });

  it("resolves configured roots once at the workspace and groups repositories", () => {
    expect(resolveWorktreesDirLayout(join(workspace, "api"), { worktreesDir: "../trees/{repo}" } as any, context))
      .toBe(resolve(workspace, "../trees/PRD-1234-my-slug/PRD-1234-my-slug/api"));
    expect(resolveWorktreesDirLayout(join(workspace, "api"), { worktreesDir: "/var/tmp/trees" } as any, context))
      .toBe("/var/tmp/trees/PRD-1234-my-slug/api");
    expect(resolveWorktreesDirLayout(join(workspace, "api"), { worktreesDir: "~/.trees" } as any, context))
      .toBe(join(homedir(), ".trees/PRD-1234-my-slug/api"));
  });

  it("preserves safe workspace names and hashes unsafe names deterministically", () => {
    expect(workspaceWorktreeGroupSegment(workspace)).toBe("PRD-1234-my-slug");
    const unsafeRoot = "/tmp/PRD-1234 My Slug";
    expect(workspaceWorktreeGroupSegment(unsafeRoot)).toBe(`PRD-1234-My-Slug-${createHash("sha256").update(resolve(unsafeRoot)).digest("hex").slice(0, 8)}`);
    expect(workspaceWorktreeGroupSegment("/tmp/🧪")).toMatch(/^workspace-[a-f0-9]{8}$/);
    expect(workspaceWorktreeGroupSegment("/a/PRD-1234-my-slug")).toBe(workspaceWorktreeGroupSegment("/b/PRD-1234-my-slug"));
  });

  it("separates nested repository paths from lossy flattened names", () => {
    expect(workspaceRepoSegment("group/api")).toMatch(/^group-api-[a-f0-9]{8}$/);
    expect(workspaceRepoSegment("group/api")).not.toBe(workspaceRepoSegment("group-api"));
    expect(workspaceRepoSegment("group\\api")).toBe(workspaceRepoSegment("group/api"));
  });

  it("resolves one task directory with repository-relative children", () => {
    const defaultTaskDir = resolveWorkspaceTaskWorktreeDir(workspace, undefined, "FN-158");
    expect(defaultTaskDir).toBe(join(workspace, ".fusion", "worktrees", "fn-158"));
    expect(resolveWorkspaceRepoWorktreePath(defaultTaskDir, "apps/web")).toBe(join(defaultTaskDir, "apps", "web"));

    const configuredTaskDir = resolveWorkspaceTaskWorktreeDir(workspace, { worktreesDir: "/var/tmp/trees" } as any, "FN-158");
    expect(configuredTaskDir).toBe("/var/tmp/trees/PRD-1234-my-slug/fn-158");
    expect(() => resolveWorkspaceRepoWorktreePath(defaultTaskDir, "../outside")).toThrow();
  });

  it("distinguishes persisted legacy repository worktrees from task-directory children", () => {
    const taskDir = resolveWorkspaceTaskWorktreeDir(workspace, undefined, "FN-158");
    expect(isLegacyWorkspaceWorktreeLayout({
      workspaceWorktrees: { api: { worktreePath: join(taskDir, "api") } },
    }, taskDir)).toBe(false);
    expect(isLegacyWorkspaceWorktreeLayout({
      workspaceWorktrees: { api: { worktreePath: join(workspace, "api", ".worktrees", "fn-158") } },
    }, taskDir)).toBe(true);
    expect(isLegacyWorkspaceWorktreeLayout({
      workspaceWorktrees: {
        api: { worktreePath: join(taskDir, "api") },
        web: { worktreePath: join(workspace, "web", ".worktrees", "fn-158") },
      },
    }, taskDir)).toBe(true);
  });

  it("sanitizes and rejects escaping paths", () => {
    expect(sanitizePathSegment(".. A/ß ..")).toBe("A");
    for (const path of ["../api", "/api", "..", ""]) expect(() => assertWorkspaceRepoRelPath(path)).toThrow();
  });
});
