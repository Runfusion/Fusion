// Resolves the ACP agent launch configuration from plugin settings.
//
// Unlike the Claude/Droid CLIs (one fixed binary per plugin), ACP is a protocol:
// the user points this runtime at *any* ACP-compatible agent binary plus the
// flag that puts it in ACP mode (e.g. `gemini --acp`). Settings therefore carry
// an arbitrary binary + args, plus the conservative-by-default fs capability
// toggles (KTD6: writes default OFF) and an env allow-list (KTD6b).

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_CODE_CLI_ACP_BINARY = "claude-code-cli-acp";

export interface AcpBinaryResolution {
  kind: "resolved" | "not_resolved";
  requested: string;
  path?: string;
  reason?: string;
}

export interface AcpCliSettings {
  /** Agent binary to spawn (e.g. "gemini", "npx", an absolute path). */
  binaryPath: string;
  /** Arguments that launch the agent in ACP/stdio mode (e.g. ["--acp"]). */
  args: string[];
  /** Optional model identifier reported via describeModel. */
  model?: string;
  /** Advertise `fs/read_text_file` capability. Default: false (opt-in). */
  fsRead: boolean;
  /** Advertise `fs/write_text_file` capability. Default: false (opt-in, KTD6). */
  fsWrite: boolean;
  /**
   * Environment variables to forward to the agent subprocess (KTD6b allow-list).
   * The agent is untrusted; inherited `process.env` is NOT forwarded. Empty by
   * default — callers opt specific vars in by name.
   */
  envAllowList: string[];
  /** Env allow-list entries that must be present before spawning this profile. */
  requiredEnv: string[];
  /**
   * Risk S1 acknowledgement. The shipped default permission policy is
   * `unrestricted` (every category → allow). Because the ACP agent is an
   * untrusted subprocess, the permission floor refuses to auto-approve a
   * *sensitive* category on a blanket `allow` disposition unless the user has
   * explicitly acknowledged that risk by setting this true — otherwise such
   * calls are escalated to approval (or denied when no approver exists).
   * Default: false (safe).
   */
  allowUnrestricted: boolean;
  /** Bundled bridge resolution status when `acpBinaryPath` asks for it. */
  binaryResolution?: AcpBinaryResolution;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length === value.length ? out : undefined;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function pluginRootDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export interface ResolveBundledClaudeBridgeOptions {
  pluginRoot?: string;
  exists?: (path: string) => boolean;
}

export function bundledClaudeBridgeBinPath(pluginRoot = pluginRootDir()): string {
  const extension = process.platform === "win32" ? ".cmd" : "";
  return join(pluginRoot, "node_modules", ".bin", `${CLAUDE_CODE_CLI_ACP_BINARY}${extension}`);
}

export function resolveBundledClaudeBridgeBinary(
  options: ResolveBundledClaudeBridgeOptions = {},
): AcpBinaryResolution {
  const root = options.pluginRoot ?? pluginRootDir();
  const exists = options.exists ?? existsSync;
  const candidate = bundledClaudeBridgeBinPath(root);
  /*
  FNXC:ACP-RouteB 2026-06-14-19:47:
  The Claude ACP bridge is a pinned plugin dependency, not a PATH-selected executable. Resolve the sentinel to the plugin-owned node_modules/.bin shim so a same-named global binary cannot replace the reviewed bridge.
  */
  if (!exists(candidate)) {
    return {
      kind: "not_resolved",
      requested: CLAUDE_CODE_CLI_ACP_BINARY,
      path: candidate,
      reason: `Bundled ${CLAUDE_CODE_CLI_ACP_BINARY} binary was not found at ${candidate}`,
    };
  }
  if (!isAbsolute(candidate)) {
    return {
      kind: "not_resolved",
      requested: CLAUDE_CODE_CLI_ACP_BINARY,
      path: candidate,
      reason: `Bundled ${CLAUDE_CODE_CLI_ACP_BINARY} path is not absolute`,
    };
  }
  return { kind: "resolved", requested: CLAUDE_CODE_CLI_ACP_BINARY, path: candidate };
}

export function resolveCliSettings(settings?: Record<string, unknown>): AcpCliSettings {
  const requestedBinaryPath = asTrimmedString(settings?.acpBinaryPath);
  let binaryPath = requestedBinaryPath ?? "acp-agent";
  let binaryResolution: AcpBinaryResolution | undefined;
  if (requestedBinaryPath === CLAUDE_CODE_CLI_ACP_BINARY) {
    binaryResolution = resolveBundledClaudeBridgeBinary();
    if (binaryResolution.kind === "resolved" && binaryResolution.path) {
      binaryPath = binaryResolution.path;
    }
  }
  const args = asStringArray(settings?.acpArgs) ?? [];
  const model = asTrimmedString(settings?.acpModel);
  const fsRead = asBool(settings?.acpFsRead);
  const fsWrite = asBool(settings?.acpFsWrite);
  const envAllowList = asStringArray(settings?.acpEnvAllowList) ?? [];
  const allowUnrestricted = asBool(settings?.acpAllowUnrestricted);
  return {
    binaryPath,
    args,
    model,
    fsRead,
    fsWrite,
    envAllowList,
    requiredEnv: [],
    allowUnrestricted,
    binaryResolution,
  };
}

export function resolveClaudeBridgeAskSettings(settings?: Record<string, unknown>): AcpCliSettings {
  const resolved = resolveCliSettings({
    ...settings,
    acpBinaryPath: CLAUDE_CODE_CLI_ACP_BINARY,
    acpArgs: [],
    acpFsRead: false,
    acpFsWrite: false,
    acpEnvAllowList: ["HOME", "PATH"],
    acpAllowUnrestricted: false,
  });
  return { ...resolved, requiredEnv: ["HOME"] };
}
