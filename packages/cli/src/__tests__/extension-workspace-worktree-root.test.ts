import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  WORKSPACE_GROUP_MARKER_FILENAME,
  workspaceRepoSegment,
  workspaceWorktreeGroupSegment,
} from "@fusion/core";
import {
  __resolveProjectRootForTesting,
  clearHostTaskStores,
  closeCachedStores,
  setHostTaskStore,
} from "../extension.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

afterEach(async () => {
  await closeCachedStores();
  clearHostTaskStores();
  vi.resetModules();
});

describe("grouped workspace extension root resolution", () => {
  /*
  FNXC:WorkspaceWorktree 2026-08-20-02:23:
  Workspace members are independent Git repositories, so their linked checkout
  cannot discover the host through a local `.fusion` walk. The separately loaded
  Pi module must consume the host registry's forward-derived candidate and return
  the workspace root, never the member, grouped container, or checkout.
  */
  it("resolves a member checkout through the host registry in a separately evaluated extension module", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "PRD-1234-my-slug-"));
    const sharedRoot = join(dirname(workspaceRoot), "fn-9162-shared-worktrees");
    const apiRoot = join(workspaceRoot, "api");
    const worktreeDir = join(
      sharedRoot,
      workspaceWorktreeGroupSegment(workspaceRoot),
      workspaceRepoSegment("api"),
      "fn-9162",
    );

    try {
      mkdirSync(join(workspaceRoot, ".fusion"), { recursive: true });
      writeFileSync(join(workspaceRoot, ".fusion", "config.json"), JSON.stringify({
        settings: { workspaceMode: true, worktreesDir: sharedRoot },
      }));
      writeFileSync(join(workspaceRoot, ".fusion", "workspace.json"), JSON.stringify({ repos: ["api"] }));
      mkdirSync(apiRoot, { recursive: true });
      git(apiRoot, ["init", "-q", "-b", "main"]);
      git(apiRoot, ["config", "user.email", "test@example.com"]);
      git(apiRoot, ["config", "user.name", "Test"]);
      writeFileSync(join(apiRoot, "base.txt"), "base\n");
      git(apiRoot, ["add", "base.txt"]);
      git(apiRoot, ["commit", "-q", "-m", "base"]);
      mkdirSync(dirname(worktreeDir), { recursive: true });
      git(apiRoot, ["worktree", "add", "--detach", worktreeDir, "HEAD"]);
      writeFileSync(join(sharedRoot, workspaceWorktreeGroupSegment(workspaceRoot), WORKSPACE_GROUP_MARKER_FILENAME), resolve(workspaceRoot));

      setHostTaskStore(workspaceRoot, { id: "workspace-host" } as never);
      vi.resetModules();
      const isolated = await import("../extension.js");

      expect(isolated.__resolveProjectRootForTesting(join(worktreeDir, "src"))).toBe(resolve(workspaceRoot));
      expect(isolated.__resolveProjectRootForTesting(worktreeDir)).not.toBe(resolve(apiRoot));
      expect(isolated.__resolveProjectRootForTesting(worktreeDir)).not.toBe(dirname(dirname(worktreeDir)));
    } finally {
      try {
        git(apiRoot, ["worktree", "remove", "--force", worktreeDir]);
      } catch {
        // The fixture may fail before Git records its linked checkout.
      }
      rmSync(sharedRoot, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
