import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginRuntimeFactory, PluginRuntimeManifestMetadata } from "@fusion/plugin-sdk";
import { resolveCliSettings } from "./cli-spawn.js";
import { AcpRuntimeAdapter } from "./runtime-adapter.js";
import { killAllProcesses } from "./process-manager.js";

// Reap any live agent subprocesses on hard process exit so none are orphaned
// (KTD4 — the registry SIGKILL is the authoritative no-orphan guarantee). Scoped
// to tracked agent subprocesses only; never touches other processes/ports.
process.on("exit", killAllProcesses);

export const ACP_RUNTIME_ID = "acp";
const ACP_RUNTIME_VERSION = "0.1.0";

export const acpRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: ACP_RUNTIME_ID,
  name: "ACP Runtime",
  description: "Drives any external ACP-compatible agent over JSON-RPC/stdio",
  version: ACP_RUNTIME_VERSION,
};

export const acpRuntimeFactory: PluginRuntimeFactory = async (ctx) =>
  new AcpRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined);

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-acp-runtime",
    name: "ACP Runtime Plugin",
    version: ACP_RUNTIME_VERSION,
    description: "Drives any external ACP-compatible agent over JSON-RPC/stdio",
    runtime: acpRuntimeMetadata,
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      const settings = resolveCliSettings(ctx.settings as Record<string, unknown>);
      ctx.logger.info(
        // Log the arg COUNT, not values — args can carry inline tokens/secrets.
        `ACP Runtime Plugin loaded — binary=${settings.binaryPath} argCount=${settings.args.length} ` +
          `fsRead=${settings.fsRead} fsWrite=${settings.fsWrite}`,
      );
      // Risk S1: the ACP agent is an untrusted subprocess. Acknowledging the
      // unrestricted policy disables the per-call approval escalation — warn so
      // it is a deliberate, visible choice.
      if (settings.allowUnrestricted) {
        ctx.logger.warn(
          "ACP Runtime: acpAllowUnrestricted is set — sensitive tool calls from the untrusted agent " +
            "will be auto-approved under an allow-all policy. Prefer an approval-required policy.",
        );
      }
    },
  },
  runtime: {
    metadata: acpRuntimeMetadata,
    factory: acpRuntimeFactory,
  },
});

export default plugin;
export { AcpRuntimeAdapter };
export { resolveCliSettings } from "./cli-spawn.js";
export type { AcpCliSettings } from "./cli-spawn.js";
