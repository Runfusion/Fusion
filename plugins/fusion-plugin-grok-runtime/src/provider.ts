import { discoverGrokModels } from "./process-manager.js";
import { probeGrokBinary } from "./probe.js";

function normalizeDiscoveryOptions(options?: unknown): { binaryPath?: string; timeoutMs?: number } {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return {
    binaryPath: typeof record.binaryPath === "string" ? record.binaryPath : undefined,
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
  };
}

export async function discoverGrokProviderModels(options?: unknown) {
  const probe = await probeGrokBinary(normalizeDiscoveryOptions(options));
  if (!probe.available || !probe.binaryName) {
    return { models: [], source: "probe", fallbackUsed: true, reason: probe.reason ?? "binary unavailable" };
  }
  const result = await discoverGrokModels(probe.binaryPath ?? probe.binaryName);
  return {
    models: result.models.map((id) => ({ id, label: id })),
    source: result.source,
    fallbackUsed: result.fallbackUsed,
    reason: result.reason,
  };
}
