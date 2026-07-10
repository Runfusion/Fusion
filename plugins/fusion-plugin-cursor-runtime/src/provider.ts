import { discoverCursorModels } from "./process-manager.js";
import { probeCursorBinary } from "./probe.js";

function normalizeDiscoveryOptions(options?: unknown): { binaryPath?: string; timeoutMs?: number } {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return {
    binaryPath: typeof record.binaryPath === "string" ? record.binaryPath : undefined,
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
  };
}

/*
FNXC:CursorCli 2026-07-08-00:00:
FN-7700: `reasoning`/`contextWindow` are carried through from the plugin's
`discoverCursorModels` `modelMeta` map (structured JSON discovery entries
only) into each returned `{ id, label, reasoning?, contextWindow? }` entry.
They are omitted (never defaulted here) when the discovery result did not
report them for a given id — pass-through only, never fabricated or parsed
from the plain-text `<id> - <Label>` output.
*/
export async function discoverCursorProviderModels(options?: unknown) {
  const probe = await probeCursorBinary(normalizeDiscoveryOptions(options));
  if (!probe.available || !probe.binaryName) {
    return { models: [], source: "probe", fallbackUsed: true, reason: probe.reason ?? "binary unavailable" };
  }
  const result = await discoverCursorModels(probe.binaryPath ?? probe.binaryName);
  return {
    models: result.models.map((id) => {
      const meta = result.modelMeta?.[id];
      return {
        id,
        label: id,
        ...(meta?.reasoning !== undefined ? { reasoning: meta.reasoning } : {}),
        ...(meta?.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
      };
    }),
    source: result.source,
    fallbackUsed: result.fallbackUsed,
    reason: result.reason,
  };
}
