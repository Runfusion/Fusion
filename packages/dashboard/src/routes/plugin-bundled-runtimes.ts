import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeFs from "node:fs";
import { hermesRuntimeMetadata } from "@fusion-plugin-examples/hermes-runtime";
import { openclawRuntimeMetadata } from "@fusion-plugin-examples/openclaw-runtime";

// Bundled runtime metadata exposed in /api/plugins/runtimes even when the
// corresponding plugin has not been explicitly installed. Installed plugins
// override these entries by runtimeId.
export const BUNDLED_PLUGIN_RUNTIMES: Array<{
  pluginId: string;
  runtimeId: string;
  name: string;
  description?: string;
  version: string;
}> = [
  {
    pluginId: "fusion-plugin-hermes-runtime",
    runtimeId: hermesRuntimeMetadata.runtimeId,
    name: hermesRuntimeMetadata.name,
    ...(hermesRuntimeMetadata.description ? { description: hermesRuntimeMetadata.description } : {}),
    version: hermesRuntimeMetadata.version ?? "0.0.0",
  },
  {
    pluginId: "fusion-plugin-openclaw-runtime",
    runtimeId: openclawRuntimeMetadata.runtimeId,
    name: openclawRuntimeMetadata.name,
    ...(openclawRuntimeMetadata.description ? { description: openclawRuntimeMetadata.description } : {}),
    version: openclawRuntimeMetadata.version ?? "0.0.0",
  },
  {
    pluginId: "fusion-plugin-paperclip-runtime",
    runtimeId: "paperclip",
    name: "Paperclip Runtime",
    description: "Drives a Paperclip agent via the wakeup + heartbeat-run REST API",
    version: "1.0.0",
  },
];
const BUNDLED_PLUGIN_IDS = new Set([
  "fusion-plugin-dependency-graph",
  "fusion-plugin-reports",
  "fusion-plugin-whatsapp-chat",
  "fusion-plugin-roadmap",
  "fusion-plugin-hermes-runtime",
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-paperclip-runtime",
  "fusion-plugin-cursor-runtime",
  "fusion-plugin-grok-runtime",
  "fusion-plugin-claude-runtime",
  "fusion-plugin-omp-runtime",
  "fusion-plugin-cli-printing-press",
  "fusion-plugin-compound-engineering",
  "fusion-plugin-quality",
]);

export function extractBundledPluginId(pathInput: string): string | null {
  const normalized = pathInput.replace(/\\/gu, "/").replace(/\/+$/u, "").trim();
  if (BUNDLED_PLUGIN_IDS.has(normalized)) {
    return normalized;
  }

  for (const pluginId of BUNDLED_PLUGIN_IDS) {
    if (normalized.endsWith(`/plugins/${pluginId}`)) {
      return pluginId;
    }
  }

  return null;
}

export function resolveBundledPluginDirInDashboard(pluginId: string): string | null {
  const moduleDir = resolve(fileURLToPath(import.meta.url), "..");
  const dashboardPackageRoot = resolve(moduleDir, "..");
  const candidates = [
    join(dashboardPackageRoot, "dist", "plugins", pluginId),
    join(dashboardPackageRoot, "plugins", pluginId),
    join(dashboardPackageRoot, "..", "..", "plugins", pluginId),
  ];

  for (const candidate of candidates) {
    if (nodeFs.existsSync(join(candidate, "manifest.json"))) {
      return candidate;
    }
  }

  return null;
}

