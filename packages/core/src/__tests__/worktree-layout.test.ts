import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceRepoRelPath,
  isStrictDescendantPath,
  resolveLegacyWorktreesDirLayout,
  resolveWorktreesDirCandidates,
  resolveWorktreesDirLayout,
  resolveWorkspaceRepoWorktreePath,
  resolveWorkspaceTaskWorktreeDir,
  resolveWorkspaceTaskDirSegment,
  isLegacyWorkspaceWorktreeLayout,
  sanitizePathSegment,
  workspaceRepoSegment,
  workspaceWorktreeGroupSegment,
} from "../tasks/worktree-layout.js";

describe("workspace worktree layout", () => {
  const workspace = "/tmp/PRD-1234-my-slug";
  const context = { workspaceRootDir: workspace, repoRelPath: "api" };

  it("defaults singular and workspace repositories under .fusion/worktrees", () => {
    const repoRoot = "/tmp/repo";
    expect(resolveWorktreesDirLayout(repoRoot, undefined)).toBe("/tmp/repo/.fusion/worktrees");
    expect(resolveWorktreesDirLayout(join(workspace, "api"), undefined, context)).toBe(join(workspace, "api", ".fusion", "worktrees"));
    expect(resolveWorkspaceTaskWorktreeDir(repoRoot, undefined, "FN-1")).toBe(join(repoRoot, ".fusion", "worktrees", "fn-1"));
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

  it("returns configured or primary-plus-legacy root candidates", () => {
    expect(resolveWorktreesDirCandidates("/tmp/repo", { worktreesDir: "trees" } as any)).toEqual(["/tmp/repo/trees"]);
    expect(resolveWorktreesDirCandidates("/tmp/repo", undefined)).toEqual([
      "/tmp/repo/.fusion/worktrees",
      resolveLegacyWorktreesDirLayout("/tmp/repo"),
    ]);
  });

  it("accepts only strict descendant paths", () => {
    expect(isStrictDescendantPath("/tmp/repo/.fusion/worktrees", "/tmp/repo/.fusion/worktrees/fn-1")).toBe(true);
    expect(isStrictDescendantPath("/tmp/repo/.fusion/worktrees", "/tmp/repo/.fusion/worktrees")).toBe(false);
    expect(isStrictDescendantPath("/tmp/repo/.fusion/worktrees", "/tmp/repo/.fusion/worktrees-sibling/fn-1")).toBe(false);
    expect(isStrictDescendantPath("/tmp/repo/.fusion/worktrees", "/tmp/repo/.fusion/worktrees/../outside")).toBe(false);
  });

  it("resolves one task directory with repository-relative children", () => {
    const defaultTaskDir = resolveWorkspaceTaskWorktreeDir(workspace, undefined, resolveWorkspaceTaskDirSegment({ id: "FN-158" }));
    expect(defaultTaskDir).toBe(join(workspace, ".fusion", "worktrees", "fn-158"));
    expect(resolveWorkspaceRepoWorktreePath(defaultTaskDir, "apps/web")).toBe(join(defaultTaskDir, "apps", "web"));

    const configuredTaskDir = resolveWorkspaceTaskWorktreeDir(workspace, { worktreesDir: "/var/tmp/trees" } as any, resolveWorkspaceTaskDirSegment({ id: "FN-158" }));
    expect(configuredTaskDir).toBe("/var/tmp/trees/PRD-1234-my-slug/fn-158");
    expect(() => resolveWorkspaceRepoWorktreePath(defaultTaskDir, "../outside")).toThrow();
  });

  it("distinguishes persisted legacy repository worktrees from task-directory children", () => {
    const taskDir = resolveWorkspaceTaskWorktreeDir(workspace, undefined, resolveWorkspaceTaskDirSegment({ id: "FN-158" }));
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

/*
FNXC:WorkspaceWorktree 2026-08-23-19:52:
R15 characterization gate. The pinned task-directory segment must not move any path for a
task that has no pin — every task that exists today. These literals were captured against the
pre-pin implementation and are the invariant the pin refactor may not change.
*/
describe("unpinned workspace task directory characterization", () => {
  const safeWorkspace = "/tmp/PRD-1234-my-slug";
  const unsafeWorkspace = "/tmp/PRD-1234 My Slug";
  const unsafeGroup = `PRD-1234-My-Slug-${createHash("sha256").update(resolve(unsafeWorkspace)).digest("hex").slice(0, 8)}`;
  const unpinned = { id: "FN-158" };

  it("resolves the historic path for a safe workspace basename in both layouts", () => {
    expect(resolveWorkspaceTaskWorktreeDir(safeWorkspace, undefined, resolveWorkspaceTaskDirSegment(unpinned)))
      .toBe(join(safeWorkspace, ".fusion", "worktrees", "fn-158"));
    expect(resolveWorkspaceTaskWorktreeDir(safeWorkspace, { worktreesDir: "/var/tmp/trees" } as any, resolveWorkspaceTaskDirSegment(unpinned)))
      .toBe("/var/tmp/trees/PRD-1234-my-slug/fn-158");
  });

  it("resolves the historic sanitize-plus-hash path for an unsafe workspace basename", () => {
    expect(resolveWorkspaceTaskWorktreeDir(unsafeWorkspace, undefined, resolveWorkspaceTaskDirSegment(unpinned)))
      .toBe(join(unsafeWorkspace, ".fusion", "worktrees", "fn-158"));
    expect(resolveWorkspaceTaskWorktreeDir(unsafeWorkspace, { worktreesDir: "/var/tmp/trees" } as any, resolveWorkspaceTaskDirSegment(unpinned)))
      .toBe(`/var/tmp/trees/${unsafeGroup}/fn-158`);
  });

  it("prefers a pinned segment over the task id and never re-derives it", () => {
    const pinned = { id: "FN-158", workspaceWorktreeDirSegment: "prd-1234-my-slug" };
    expect(resolveWorkspaceTaskDirSegment(pinned)).toBe("prd-1234-my-slug");
    expect(resolveWorkspaceTaskWorktreeDir(safeWorkspace, { worktreesDir: "/var/tmp/trees" } as any, resolveWorkspaceTaskDirSegment(pinned)))
      .toBe("/var/tmp/trees/PRD-1234-my-slug/prd-1234-my-slug");
  });
});
