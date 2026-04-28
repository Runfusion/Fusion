import { definePlugin } from "@fusion/plugin-sdk";
import {
  probePaperclipConnection,
  resolvePaperclipConfig,
} from "./paperclip-client.js";
import { PaperclipRuntimeAdapter } from "./runtime-adapter.js";
import type {
  FusionPlugin,
  PluginRuntimeRegistration,
  RuntimeLogger,
} from "./types.js";

// Public exports — consumed by the dashboard probe façade and tests.
export type {
  PaperclipAgentSummary,
  PaperclipCliDiscovery,
  PaperclipCliDiscoveryResult,
  PaperclipCompanySummary,
  PaperclipConnectionStatus,
} from "./paperclip-client.js";
export {
  agentsMe,
  discoverPaperclipCliConfig,
  listCompanies,
  listCompanyAgents,
  mintAgentApiKeyViaCli,
  probePaperclipConnection,
} from "./paperclip-client.js";
export type { MintCliKeyOptions, MintedApiKey } from "./paperclip-client.js";
export { PaperclipRuntimeAdapter } from "./runtime-adapter.js";

function getSettingsConfig(settings: unknown) {
  return resolvePaperclipConfig((settings ?? {}) as Record<string, unknown>);
}

async function paperclipRuntimeFactory(ctx: {
  settings?: unknown;
  logger?: RuntimeLogger;
}): Promise<unknown> {
  const config = getSettingsConfig(ctx.settings);
  // resolvePaperclipConfig returns `mode: string`; the adapter narrows it.
  return new PaperclipRuntimeAdapter(
    config as unknown as Record<string, unknown>,
    ctx.logger,
  );
}

const paperclipRuntime: PluginRuntimeRegistration = {
  metadata: {
    runtimeId: "paperclip",
    name: "Paperclip Runtime",
    description: "Drives a Paperclip agent via the wakeup + heartbeat-run REST API",
    version: "1.0.0",
  },
  factory: paperclipRuntimeFactory,
};

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-paperclip-runtime",
    name: "Paperclip Runtime Plugin",
    version: "1.0.0",
    description: "Drives a Paperclip agent via the wakeup + heartbeat-run REST API",
    author: "Fusion Team",
    homepage: "https://paperclip.ing/",
    fusionVersion: ">=0.1.0",
    runtime: {
      runtimeId: "paperclip",
      name: "Paperclip Runtime",
      description: "Drives a Paperclip agent via the wakeup + heartbeat-run REST API",
      version: "1.0.0",
    },
  },
  state: "installed",
  runtime: paperclipRuntime,
  hooks: {
    onLoad: async (ctx) => {
      const config = getSettingsConfig(ctx.settings);
      ctx.logger.info(`Paperclip Runtime Plugin loaded (apiUrl=${config.apiUrl})`);

      // Best-effort connectivity probe; failures are warnings, not errors.
      try {
        const status = await probePaperclipConnection({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
        });
        if (status.available) {
          const ident = status.identity;
          ctx.logger.info(
            ident
              ? `Paperclip reachable as ${ident.agentName} (${ident.role ?? "agent"}) at ${ident.companyName ?? ident.companyId}`
              : `Paperclip reachable at ${config.apiUrl}`,
          );
        } else {
          ctx.logger.warn(`Paperclip probe failed: ${status.reason ?? "unknown"}`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`Paperclip probe threw: ${reason}`);
      }
    },
  },
});

export default plugin;
