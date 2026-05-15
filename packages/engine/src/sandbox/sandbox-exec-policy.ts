import { dirname, resolve } from "node:path";

import {
  SBPL_BASE_ALLOW,
  SBPL_FILE_READ_BASE,
  SBPL_HEADER,
  SBPL_NETWORK_ALLOW_OUTBOUND,
  SBPL_NETWORK_DENY_ALL,
  SBPL_TMP_WRITE,
} from "./sandbox-exec-profile-templates.js";
import type { SandboxPolicy } from "./types.js";

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

export interface SandboxExecPolicy extends SandboxPolicy {
  failureMode?: "fail-hard" | "fallback-native";
  allowedPorts?: number[];
  allowPort4040Override?: boolean;
}

export interface SandboxExecContext {
  worktreePath: string;
  repoRootPath: string;
  pnpmStorePath: string;
  nodeBinPath: string;
  homeDir: string;
  tmpDirOverride?: string;
}

function uniq(paths: string[]): string[] {
  return [...new Set(paths.map((p) => resolve(p)))];
}

export function sbplEscape(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += "\\\\";
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

function asSubpath(path: string): string {
  return `(subpath "${sbplEscape(path)}")`;
}

function ensureNoFusionWrites(paths: string[], repoRootPath: string): void {
  const fusionRoot = resolve(repoRootPath, ".fusion");
  const fusionDb = resolve(fusionRoot, "fusion.db");
  for (const candidate of paths) {
    const resolved = resolve(candidate);
    if (resolved === fusionRoot || resolved === fusionDb || resolved.startsWith(`${fusionRoot}/`)) {
      throw new SandboxPolicyError("Sandbox policy cannot include writable paths under .fusion/.");
    }
  }
}

export function fusionWorktreePreset(ctx: SandboxExecContext): SandboxExecPolicy {
  return {
    allowNetwork: true,
    allowedReadPaths: [ctx.repoRootPath],
    allowedWritePaths: [ctx.worktreePath, ctx.pnpmStorePath],
  };
}

export function policyToSbplProfile(policy: SandboxExecPolicy, ctx: SandboxExecContext): string {
  if (policy.allowedPorts?.includes(4040) && policy.allowPort4040Override !== true) {
    throw new SandboxPolicyError("Port 4040 is reserved and cannot be allowed in sandbox policy.");
  }

  const tmpDir = resolve(ctx.tmpDirOverride ?? "/private/tmp");
  const nodeDir = dirname(ctx.nodeBinPath);

  const writePaths = uniq([ctx.worktreePath, ctx.pnpmStorePath, ...(policy.allowedWritePaths ?? [])]);
  ensureNoFusionWrites(writePaths, ctx.repoRootPath);

  const readPaths = uniq([
    ...((policy.allowedReadPaths ?? []).length ? (policy.allowedReadPaths ?? []) : [ctx.repoRootPath]),
    ...(ctx.repoRootPath !== ctx.worktreePath ? [ctx.repoRootPath] : []),
    nodeDir,
  ]).filter((path) => !writePaths.includes(path));

  const lines = [SBPL_HEADER, SBPL_BASE_ALLOW, SBPL_FILE_READ_BASE, SBPL_TMP_WRITE, `(allow file-read* ${asSubpath(tmpDir)})`, `(allow file-write* ${asSubpath(tmpDir)})`];

  for (const readPath of readPaths) {
    lines.push(`(allow file-read* ${asSubpath(readPath)})`);
  }

  for (const writePath of writePaths) {
    lines.push(`(allow file-write* ${asSubpath(writePath)})`);
  }

  lines.push(policy.allowNetwork ? SBPL_NETWORK_ALLOW_OUTBOUND : SBPL_NETWORK_DENY_ALL);
  return `${lines.join("\n")}\n`;
}
