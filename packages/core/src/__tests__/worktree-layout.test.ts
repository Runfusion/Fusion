import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceRepoRelPath,
  resolveWorktreesDirLayout,
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

  it("sanitizes and rejects escaping paths", () => {
    expect(sanitizePathSegment(".. A/ß ..")).toBe("A");
    for (const path of ["../api", "/api", "..", ""]) expect(() => assertWorkspaceRepoRelPath(path)).toThrow();
  });
});
