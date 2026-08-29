import type { PluginContext, PluginSetupCheckResult, PluginSetupHooks, PluginSetupManifest } from "@fusion/plugin-sdk";
import { probeAgentBrowserBinary } from "./probe.js";
import { resolveSettings } from "./types.js";

export const setupManifest: PluginSetupManifest = {
  binaryName: "agent-browser",
  description: "Headless browser runtime for web-enabled agents",
  channel: "stable",
  defaultTimeoutMs: 120000,
};

const MAX_PROBE_TIMEOUT_MS = 30_000;

export async function checkSetup(ctx: PluginContext): Promise<PluginSetupCheckResult> {
  const settings = resolveSettings(ctx.settings);
  const probe = await probeAgentBrowserBinary({ timeoutMs: Math.min(settings.commandTimeoutMs, MAX_PROBE_TIMEOUT_MS) });

  if (probe.available) {
    return { status: "installed", version: probe.version, binaryPath: probe.binaryPath };
  }

  const reason = probe.reason ?? "agent-browser probe failed";
  if (probe.notFound === true) {
    return { status: "not-installed", error: reason };
  }
  return { status: "error", error: reason };
}

export const setupHooks: PluginSetupHooks = {
  checkSetup,
};
