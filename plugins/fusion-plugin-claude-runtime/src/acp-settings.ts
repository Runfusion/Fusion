import { resolveBundledClaudeBridgeBinary } from "./cli-spawn.js";

/** Only minimal login/path context crosses the untrusted ACP subprocess boundary. */
export const CLAUDE_ACP_ENV_ALLOWLIST = ["HOME", "PATH", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"] as const;
export function normalizeClaudeCliModel(model: string | undefined): string | undefined {
 const value=model?.trim(); if (!value) return undefined;
 for (const prefix of ["claude-cli/", "claude/"]) if (value.startsWith(prefix)) return value.slice(prefix.length).trim() || undefined;
 return value;
}
export function modelForCli(model: string | undefined): string | undefined { const value=normalizeClaudeCliModel(model); return value === "default" ? undefined : value; }
/** Builds settings for the pinned bridge, never a same-named PATH executable. */
export function buildClaudeAcpRuntimeSettings(options: { model?: string; pluginDirs?: string[]; binary?: string } = {}): Record<string, unknown> {
 const bridge=options.binary ? {kind:"resolved" as const,path:options.binary} : resolveBundledClaudeBridgeBinary();
 /*
 FNXC:ClaudeAcp 2026-07-18-11:45:
 Claude is an untrusted ACP subprocess. Do not silently acknowledge unrestricted
 sensitive operations: the action gate must require approval unless an operator
 explicitly opts in through a supported setting.
 */
 return {acpBinaryPath: bridge.path ?? "", acpArgs: [], acpModel: options.model ?? "claude/default", acpEnvAllowList:[...CLAUDE_ACP_ENV_ALLOWLIST], acpFsRead:false, acpFsWrite:false, acpAllowUnrestricted:false, pluginDirs:options.pluginDirs ?? [], binaryResolution:bridge};
}
