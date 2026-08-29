import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext, PluginSetupCheckResult, PluginSetupHooks, PluginSetupManifest } from "@fusion/plugin-sdk";
import { CLAUDE_CODE_CLI_ACP_BINARY, bundledClaudeBridgeBinPath, resolveClaudeBridgeAskSettings } from "./cli-spawn.js";
import { buildSpawnEnv } from "./process-manager.js";
import { probeAcpReadiness, type AcpProbeStatus, type ProbeOptions } from "./probe.js";

export const setupManifest: PluginSetupManifest = {
  binaryName: CLAUDE_CODE_CLI_ACP_BINARY,
  description: "Claude Code ACP bridge used by Fusion's read-only ask path",
  channel: "beta",
  defaultTimeoutMs: 30_000,
};

export interface CheckAcpSetupDeps {
  probe?: (opts: ProbeOptions) => Promise<AcpProbeStatus>;
  pluginRoot?: string;
}

const MAX_PROBE_TIMEOUT_MS = 30_000;

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function defaultPluginRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function validateBundledBridgeIdentity(binaryPath: string, pluginRoot = defaultPluginRoot()): string | undefined {
  const expectedBin = resolve(bundledClaudeBridgeBinPath(pluginRoot));
  const expectedNodeModules = resolve(pluginRoot, "node_modules");
  if (resolve(binaryPath) !== expectedBin && !isInside(expectedNodeModules, binaryPath)) {
    return `Resolved ${CLAUDE_CODE_CLI_ACP_BINARY} must come from this plugin's node_modules, got ${binaryPath}`;
  }
  return undefined;
}

function statusFromProbe(probe: AcpProbeStatus, binaryPath: string): PluginSetupCheckResult {
  if (probe.ok) {
    if (probe.authRequired) {
      return {
        status: "error",
        binaryPath,
        error: "Claude authentication required: run `claude` once to authenticate before using the ACP bridge.",
      };
    }
    return { status: "installed", binaryPath };
  }

  if (probe.reason === "missing_binary") {
    return {
      status: "not-installed",
      error: `Install bundled dependency ${CLAUDE_CODE_CLI_ACP_BINARY}@0.1.1 and run pnpm install for this plugin.`,
    };
  }
  if (probe.reason === "unauthenticated") {
    return {
      status: "error",
      binaryPath,
      error: "Claude authentication required: run `claude` once to authenticate before using the ACP bridge.",
    };
  }
  return { status: "error", binaryPath, error: probe.detail ?? `ACP readiness failed: ${probe.reason}` };
}

export async function checkSetup(
  ctx: PluginContext,
  deps: CheckAcpSetupDeps = {},
): Promise<PluginSetupCheckResult> {
  const settings = resolveClaudeBridgeAskSettings(ctx.settings as Record<string, unknown> | undefined);
  if (settings.binaryResolution?.kind === "not_resolved") {
    return {
      status: "not-installed",
      error: settings.binaryResolution.reason ?? `Install ${CLAUDE_CODE_CLI_ACP_BINARY}@0.1.1`,
    };
  }

  const identityError = validateBundledBridgeIdentity(settings.binaryPath, deps.pluginRoot);
  if (identityError) {
    return { status: "error", error: identityError, binaryPath: settings.binaryPath };
  }

  let env: NodeJS.ProcessEnv;
  try {
    env = buildSpawnEnv(settings.envAllowList, { required: settings.requiredEnv });
  } catch (err) {
    return { status: "error", binaryPath: settings.binaryPath, error: err instanceof Error ? err.message : String(err) };
  }

  const probe = await (deps.probe ?? probeAcpReadiness)({
    binaryPath: settings.binaryPath,
    args: settings.args,
    cwd: process.cwd(),
    env,
    timeoutMs: MAX_PROBE_TIMEOUT_MS,
  });
  return statusFromProbe(probe, settings.binaryPath);
}

export const setupHooks: PluginSetupHooks = {
  checkSetup,
};
