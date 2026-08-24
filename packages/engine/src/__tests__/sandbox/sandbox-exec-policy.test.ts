import { describe, expect, it } from "vitest";

import {
  fusionWorktreePreset,
  policyToSbplProfile,
  SandboxPolicyError,
  sbplEscape,
  type SandboxExecContext,
} from "../../sandbox/sandbox-exec-policy.js";

const ctx: SandboxExecContext = {
  worktreePath: "/tmp/worktree",
  repoRootPath: "/tmp/repo",
  pnpmStorePath: "/Users/test/Library/pnpm/store",
  nodeBinPath: "/usr/local/bin/node",
  homeDir: "/Users/test",
};

describe("sandbox-exec policy", () => {
  it("escapes sbpl paths", () => {
    expect(sbplEscape('a\\b"c d')).toBe('a\\\\b\\"c d');
    expect(sbplEscape("emoji-📦")).toContain("\\x");
  });

  it.each([
    { allowNetwork: true, expected: "(allow network-outbound)" },
    { allowNetwork: false, expected: "(deny network*)" },
  ])("emits network clauses", ({ allowNetwork, expected }) => {
    const profile = policyToSbplProfile({ allowNetwork }, ctx);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain(expected);
  });

  it("includes defaults plus custom read/write paths", () => {
    const profile = policyToSbplProfile(
      {
        allowNetwork: true,
        allowedWritePaths: ["/tmp/custom write"],
        allowedReadPaths: ["/opt/custom-read"],
      },
      ctx,
    );

    // Explicit write paths are an exact task-session allowlist, not the legacy preset.
    expect(profile).not.toContain("(allow file-write* (subpath \"/tmp/worktree\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/tmp/custom write\"))");
    expect(profile).toContain("(allow file-read* (subpath \"/opt/custom-read\"))");
  });

  it("guards port 4040", () => {
    expect(() => policyToSbplProfile({ allowNetwork: true, allowedPorts: [4040] }, ctx)).toThrow(SandboxPolicyError);
  });

  it.each(["/tmp/repo/.fusion/tasks", "/tmp/repo/.fusion/fusion.db"])("guards fusion writes for %s", (writePath) => {
    expect(() =>
      policyToSbplProfile(
        {
          allowNetwork: true,
          allowedWritePaths: [writePath],
        },
        ctx,
      ),
    ).toThrow(SandboxPolicyError);
  });

  it("allows only the declared task worktree below .fusion", () => {
    const workspaceCtx = { ...ctx, worktreePath: "/tmp/repo/.fusion/worktrees/fn-158" };
    expect(() => policyToSbplProfile({
      allowNetwork: true,
      allowedWritePaths: [workspaceCtx.worktreePath],
    }, workspaceCtx)).not.toThrow();
    expect(() => policyToSbplProfile({
      allowNetwork: true,
      allowedWritePaths: ["/tmp/repo/.fusion/worktrees/other-task"],
    }, workspaceCtx)).toThrow(SandboxPolicyError);
  });

  it("preset enables pnpm-friendly paths", () => {
    const profile = policyToSbplProfile(fusionWorktreePreset(ctx), ctx);
    expect(profile).toContain("(allow file-write* (subpath \"/tmp/worktree\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/Users/test/Library/pnpm/store\"))");
    expect(profile).toContain("(allow file-read* (subpath \"/usr\"))");
    expect(profile).toContain("(allow file-read* (subpath \"/tmp/repo\"))");
    expect(profile).toContain("(allow file-read* (subpath \"/usr/local/bin\"))");
    expect(profile).toContain("(allow file-read* (subpath \"/private/var/folders\"))");
    expect(profile).toContain("(deny network-bind (local ip \"*:4040\"))");
  });
});
