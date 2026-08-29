import { describe, expect, it } from "vitest";

import { SandboxPolicyError, fusionWorktreePreset, policyToBwrapArgs, type BubblewrapPolicyContext } from "../../sandbox/bubblewrap-policy.js";

function baseCtx(overrides: Partial<BubblewrapPolicyContext> = {}): BubblewrapPolicyContext {
  return {
    worktreePath: "/repo/.worktrees/fn-1",
    repoRootPath: "/repo",
    pnpmStorePath: "/home/u/.pnpm-store",
    nodeBinPath: "/usr/bin/node",
    homeDir: "/home/u",
    pathExists: (path) => !path.includes("missing"),
    envSource: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      LANG: "en_US.UTF-8",
      FUSION_RUN_ID: "run-1",
      SECRET_TOKEN: "hidden",
    },
    ...overrides,
  };
}

describe("policyToBwrapArgs", () => {
  it.each([
    { allowNetwork: true, expected: false },
    { allowNetwork: false, expected: true },
  ])("maps allowNetwork=$allowNetwork to --unshare-net=$expected", ({ allowNetwork, expected }) => {
    const args = policyToBwrapArgs({ allowNetwork }, baseCtx());
    expect(args.includes("--unshare-net")).toBe(expected);
  });

  it("includes defaults for writable mounts and env allowlist", () => {
    const args = policyToBwrapArgs({ allowNetwork: true }, baseCtx());

    expect(args).toContain("--bind");
    expect(args).toContain("/repo/.worktrees/fn-1");
    expect(args).toContain("/home/u/.pnpm-store");
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/tmp");
    expect(args).toContain("--setenv");
    expect(args.join(" ")).toContain("FUSION_RUN_ID run-1");
    expect(args.join(" ")).not.toContain("SECRET_TOKEN");
  });

  it("supports additional writable paths and skips missing readonly sources", () => {
    const args = policyToBwrapArgs(
      {
        allowNetwork: true,
        allowedWritePaths: ["/custom/write"],
        allowedReadPaths: ["/missing/readonly", "/custom/ro"],
      },
      baseCtx(),
    );

    expect(args.join(" ")).toContain("--bind /custom/write /custom/write");
    expect(args.join(" ")).toContain("--ro-bind /custom/ro /custom/ro");
    expect(args.join(" ")).not.toContain("/missing/readonly");
  });

  it("guards port 4040 unless explicitly overridden", () => {
    expect(() =>
      policyToBwrapArgs({ allowNetwork: true, allowedPorts: [4040] }, baseCtx()),
    ).toThrow(SandboxPolicyError);

    expect(() =>
      policyToBwrapArgs({ allowNetwork: true, allowedPorts: [4040], allowPort4040Override: true }, baseCtx()),
    ).not.toThrow();
  });

  it("fusionWorktreePreset includes worktree and pnpm store but not .fusion db path", () => {
    const preset = fusionWorktreePreset(baseCtx());
    expect(preset.allowedWritePaths).toContain("/repo/.worktrees/fn-1");
    expect(preset.allowedWritePaths).toContain("/home/u/.pnpm-store");
    expect((preset.allowedWritePaths ?? []).some((path) => path.includes(".fusion"))).toBe(false);

    const args = policyToBwrapArgs(preset, baseCtx());
    expect(args.join(" ")).not.toContain(".fusion/fusion.db");
  });
});
