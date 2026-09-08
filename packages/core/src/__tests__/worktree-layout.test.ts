import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertWorkspaceRepoRelPath,
  isStrictDescendantPath,
  resolveLegacyWorktreesDirLayout,
  resolveWorktreesDirCandidates,
  resolveWorktreesDirLayout,
  resolveWorkspaceRepoWorktreePath,
  resolveWorkspaceTaskWorktreeDir,
  isLegacyWorkspaceWorktreeLayout,
  sanitizePathSegment,
  workspaceRepoSegment,
  workspaceWorktreeGroupSegment,
} from "../tasks/worktree-layout.js";

describe("workspace worktree layout", () => {
  /*
  FNXC:Worktrees 2026-09-04-04:42:
  Layout fixtures compare path strings only. Build them under mkdtemp so ThreatCrush does not treat literal /tmp and /var/tmp names as CWE-377 predictable temp files.
  */
  let tmpRoot: string;
  let workspace: string;
  let repoRoot: string;
  let treesRoot: string;
  let unsafeRoot: string;
  let emojiRoot: string;
  let altSafeRootA: string;
  let altSafeRootB: string;
  let context: { workspaceRootDir: string; repoRelPath: string };

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "wt-layout-"));
    workspace = join(tmpRoot, "PRD-1234-my-slug");
    repoRoot = join(tmpRoot, "repo");
    treesRoot = join(tmpRoot, "trees");
    unsafeRoot = join(tmpRoot, "PRD-1234 My Slug");
    emojiRoot = join(tmpRoot, "🧪");
    altSafeRootA = join(tmpRoot, "a", "PRD-1234-my-slug");
    altSafeRootB = join(tmpRoot, "b", "PRD-1234-my-slug");
    context = { workspaceRootDir: workspace, repoRelPath: "api" };
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("defaults singular and workspace repositories under .fusion/worktrees", () => {
    expect(resolveWorktreesDirLayout(repoRoot, undefined)).toBe(join(repoRoot, ".fusion", "worktrees"));
    expect(resolveWorktreesDirLayout(join(workspace, "api"), undefined, context)).toBe(join(workspace, "api", ".fusion", "worktrees"));
    expect(resolveWorkspaceTaskWorktreeDir(repoRoot, undefined, "FN-1")).toBe(join(repoRoot, ".fusion", "worktrees", "fn-1"));
  });

  it("resolves configured roots once at the workspace and groups repositories", () => {
    expect(resolveWorktreesDirLayout(join(workspace, "api"), { worktreesDir: "../trees/{repo}" } as any, context))
      .toBe(resolve(workspace, "../trees/PRD-1234-my-slug/PRD-1234-my-slug/api"));
    expect(resolveWorktreesDirLayout(join(workspace, "api"), { worktreesDir: treesRoot } as any, context))
      .toBe(join(treesRoot, "PRD-1234-my-slug", "api"));
    expect(resolveWorktreesDirLayout(join(workspace, "api"), { worktreesDir: "~/.trees" } as any, context))
      .toBe(join(homedir(), ".trees/PRD-1234-my-slug/api"));
  });

  it("preserves safe workspace names and hashes unsafe names deterministically", () => {
    expect(workspaceWorktreeGroupSegment(workspace)).toBe("PRD-1234-my-slug");
    expect(workspaceWorktreeGroupSegment(unsafeRoot)).toBe(`PRD-1234-My-Slug-${createHash("sha256").update(resolve(unsafeRoot)).digest("hex").slice(0, 8)}`);
    expect(workspaceWorktreeGroupSegment(emojiRoot)).toMatch(/^workspace-[a-f0-9]{8}$/);
    expect(workspaceWorktreeGroupSegment(altSafeRootA)).toBe(workspaceWorktreeGroupSegment(altSafeRootB));
  });

  it("separates nested repository paths from lossy flattened names", () => {
    expect(workspaceRepoSegment("group/api")).toMatch(/^group-api-[a-f0-9]{8}$/);
    expect(workspaceRepoSegment("group/api")).not.toBe(workspaceRepoSegment("group-api"));
    expect(workspaceRepoSegment("group\\api")).toBe(workspaceRepoSegment("group/api"));
  });

  it("returns configured or primary-plus-legacy root candidates", () => {
    expect(resolveWorktreesDirCandidates(repoRoot, { worktreesDir: "trees" } as any)).toEqual([join(repoRoot, "trees")]);
    expect(resolveWorktreesDirCandidates(repoRoot, undefined)).toEqual([
      join(repoRoot, ".fusion", "worktrees"),
      resolveLegacyWorktreesDirLayout(repoRoot),
    ]);
  });

  it("accepts only strict descendant paths", () => {
    const worktrees = join(repoRoot, ".fusion", "worktrees");
    expect(isStrictDescendantPath(worktrees, join(worktrees, "fn-1"))).toBe(true);
    expect(isStrictDescendantPath(worktrees, worktrees)).toBe(false);
    expect(isStrictDescendantPath(worktrees, join(repoRoot, ".fusion", "worktrees-sibling", "fn-1"))).toBe(false);
    expect(isStrictDescendantPath(worktrees, join(worktrees, "..", "outside"))).toBe(false);
  });

  it("resolves one task directory with repository-relative children", () => {
    const defaultTaskDir = resolveWorkspaceTaskWorktreeDir(workspace, undefined, "FN-158");
    expect(defaultTaskDir).toBe(join(workspace, ".fusion", "worktrees", "fn-158"));
    expect(resolveWorkspaceRepoWorktreePath(defaultTaskDir, "apps/web")).toBe(join(defaultTaskDir, "apps", "web"));

    const configuredTaskDir = resolveWorkspaceTaskWorktreeDir(workspace, { worktreesDir: treesRoot } as any, "FN-158");
    expect(configuredTaskDir).toBe(join(treesRoot, "PRD-1234-my-slug", "fn-158"));
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
