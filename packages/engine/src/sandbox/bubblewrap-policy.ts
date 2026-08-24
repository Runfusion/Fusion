import { dirname, resolve } from "node:path";

import type { SandboxPolicy } from "./types.js";

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

export interface BubblewrapPolicy extends SandboxPolicy {
  allowedPorts?: number[];
  allowPort4040Override?: boolean;
}

export interface BubblewrapPolicyContext {
  worktreePath: string;
  repoRootPath: string;
  pnpmStorePath: string;
  nodeBinPath: string;
  homeDir: string;
  tmpDirOverride?: string;
  pathExists?: (path: string) => boolean;
  envSource?: NodeJS.ProcessEnv;
}

function shouldPassEnv(key: string): boolean {
  return key === "PATH"
    || key === "HOME"
    || key === "USER"
    || key === "LANG"
    || key.startsWith("LC_")
    || key.startsWith("NODE_")
    || key.startsWith("npm_")
    || key.startsWith("PNPM_")
    || key === "CI"
    || key.startsWith("FUSION_");
}

function uniq(paths: string[]): string[] {
  return [...new Set(paths.map((p) => resolve(p)))];
}

export function fusionWorktreePreset(ctx: BubblewrapPolicyContext): BubblewrapPolicy {
  return {
    allowNetwork: true,
    allowedReadPaths: [ctx.repoRootPath],
    allowedWritePaths: [ctx.worktreePath, ctx.pnpmStorePath],
  };
}

export function policyToBwrapArgs(policy: BubblewrapPolicy, ctx: BubblewrapPolicyContext): string[] {
  if (policy.allowedPorts?.includes(4040) && policy.allowPort4040Override !== true) {
    throw new SandboxPolicyError("Port 4040 is reserved and cannot be allowed in sandbox policy.");
  }

  const pathExists = ctx.pathExists ?? (() => true);
  const tmpDir = ctx.tmpDirOverride ?? "/tmp";

  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--clearenv",
    "--tmpfs",
    tmpDir,
  ];

  if (!policy.allowNetwork) {
    args.push("--unshare-net");
  }

  // FNXC:WorkspaceSandbox 2026-08-22-23:45: An explicit empty list is a
  // read-only session policy; only unspecified write paths retain the legacy preset.
  const writablePaths = uniq(policy.allowedWritePaths === undefined
    ? [ctx.worktreePath, ctx.pnpmStorePath]
    : policy.allowedWritePaths);

  for (const path of writablePaths) {
    if (!pathExists(path)) continue;
    args.push("--bind", path, path);
  }

  const nodeInstallDir = dirname(ctx.nodeBinPath);
  const readonlyPaths = uniq([
    ...((policy.allowedReadPaths ?? []).length ? (policy.allowedReadPaths ?? []) : [ctx.repoRootPath]),
    ...(ctx.repoRootPath !== ctx.worktreePath ? [ctx.repoRootPath] : []),
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/etc/resolv.conf",
    "/etc/ssl",
    "/etc/ca-certificates",
    nodeInstallDir,
  ]).filter((path) => !writablePaths.includes(path));

  for (const path of readonlyPaths) {
    if (!pathExists(path)) continue;
    args.push("--ro-bind", path, path);
  }

  const env = {
    ...(ctx.envSource ?? process.env),
    ...(policy.env ?? {}),
  };

  for (const [key, value] of Object.entries(env)) {
    if (!value || !shouldPassEnv(key)) continue;
    args.push("--setenv", key, value);
  }

  args.push("--chdir", ctx.worktreePath);
  return args;
}
