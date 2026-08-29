import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSessionSandboxPolicy } from "../../sandbox/session-policy.js";

describe("resolveSessionSandboxPolicy", () => {
  it("uses the declared task root and linked-worktree git administration paths", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-session-policy-"));
    const repo = join(root, "repo-a");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const linked = join(root, "repo-b");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, ".git"), "gitdir: ../repo-a/.git/worktrees/task\n");

    const policy = resolveSessionSandboxPolicy({
      kind: "workspace-task-dir",
      writableRoot: join(root, "task"),
      projectRoot: root,
      repoRoots: [
        { repoRelPath: "repo-a", repoRootDir: repo },
        { repoRelPath: "repo-b", repoRootDir: linked },
      ],
    }, { sandbox: { policy: { allowNetwork: false }, failureMode: "fallback-native" } });

    expect(policy.allowNetwork).toBe(false);
    expect(policy.failureMode).toBe("fallback-native");
    expect(policy.allowedWritePaths).toEqual(expect.arrayContaining([
      join(root, "task"),
      join(repo, ".git"),
      join(repo, ".git", "worktrees", "task"),
    ]));
  });

  it("does not invent a writable root for read-only sessions", () => {
    const policy = resolveSessionSandboxPolicy({
      kind: "read-only-root",
      writableRoot: null,
      projectRoot: "/workspace",
    }, undefined);
    expect(policy.allowedWritePaths).toEqual([]);
  });
});
