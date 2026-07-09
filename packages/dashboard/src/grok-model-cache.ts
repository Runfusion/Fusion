/**
 * Grok CLI discovery → model-picker mapping, behind a short-TTL,
 * single-flight cache so `/api/models` never spawns the `grok` CLI per
 * request.
 *
 * FNXC:GrokCli 2026-07-08-00:00:
 * FN-7705: mirrors the landed Cursor picker cache (cursor-model-cache.ts,
 * FN-7696) end to end. With the Grok Runtime plugin installed and the
 * "Grok — via Grok CLI" provider toggle enabled (`useGrokCli === true`),
 * this module owns two contracts:
 *   1. A deterministic discovery→model-id mapping (id = discovered id; name
 *      = label ?? id) so picker selections remain stable across requests.
 *   2. A per-binaryPath TTL cache (default 60s) with single-flight
 *      de-duplication of concurrent in-flight fetches, so parallel
 *      `/api/models` requests spawn `grok` at most once per TTL window.
 * A missing/failed/unavailable `grok` binary (ENOENT, non-zero exit,
 * timeout, no API key configured) must degrade to an empty model list —
 * never throw — so `/api/models` always returns HTTP 200 with existing rows
 * intact. The empty result is cached briefly too, so a persistently-
 * unavailable binary does not turn into a spawn-per-request storm. Grok has
 * its own settings toggle (`useGrokCli`); the toggle gate lives in the
 * `/api/models` merge site (register-model-routes.ts), not in this module.
 */

import { discoverGrokCliModels } from "./runtime-provider-probes.js";

/** Stable model-picker row shape emitted for a Grok-discovered model. */
export interface GrokPickerModel {
  provider: "grok-cli";
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

/** The picker provider id used for all Grok-derived model rows. */
export const GROK_PICKER_PROVIDER_ID = "grok-cli" as const;

/** Default cache TTL for Grok model discovery, in milliseconds. */
const DEFAULT_TTL_MS = 60_000;

/**
 * Map Grok CLI discovery output into the stable `/api/models` row shape.
 *
 * The discovered `id` is used as the stable model id. `name` falls back to
 * `id` when no `label` is provided. `reasoning`/`contextWindow` default to
 * `false`/`0` — the real `grok models` text output carries no such
 * metadata today; this is pass-through only, never fabricated.
 *
 * Discovered entries that map to the same id are de-duplicated, keeping the
 * first occurrence.
 */
export function grokDiscoveryToModels(
  models: ReadonlyArray<{ id: string; label?: string; reasoning?: boolean; contextWindow?: number }>,
): GrokPickerModel[] {
  const seen = new Set<string>();
  const result: GrokPickerModel[] = [];

  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    result.push({
      provider: GROK_PICKER_PROVIDER_ID,
      id,
      name: model.label?.trim() || id,
      reasoning: model.reasoning ?? false,
      contextWindow: model.contextWindow ?? 0,
    });
  }

  return result;
}

interface CacheEntry {
  /** Timestamp (ms) at which this entry was populated. */
  fetchedAt: number;
  /** The resolved (possibly empty, on failure/unavailability) model list. */
  models: GrokPickerModel[];
}

/** Per-binaryPath cache of the most recently resolved Grok picker models. */
const cache = new Map<string, CacheEntry>();

/** Per-binaryPath in-flight fetch promise, for single-flight de-duplication. */
const inFlight = new Map<string, Promise<GrokPickerModel[]>>();

/**
 * Reset all cached/in-flight state. Test-only escape hatch — production code
 * should never need this since entries expire naturally via TTL.
 */
export function __resetGrokPickerModelsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export interface GetGrokPickerModelsOptions {
  /** Override the Grok CLI binary path. Defaults to `"grok"`. */
  binaryPath?: string;
  /** Cache TTL in milliseconds. Defaults to 60s. */
  ttlMs?: number;
  /** Injectable clock (ms epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolve the Grok CLI binary path: explicit override, then the bare
 * `"grok"` command (resolved via PATH by the CLI spawn layer).
 */
function resolveBinaryPath(explicit?: string): string {
  return explicit ?? "grok";
}

/**
 * Fetch Grok CLI-discovered models for the model picker, behind a
 * short-TTL, single-flight cache keyed by binary path.
 *
 * Never throws: a `discoverGrokCliModels` failure or an unavailable-binary
 * result (empty models + `fallbackUsed: true`) resolves to `[]`, which is
 * itself cached briefly (same TTL) so a persistently-unavailable binary does
 * not spawn the CLI on every call.
 */
export async function getGrokPickerModels(
  opts?: GetGrokPickerModelsOptions,
): Promise<GrokPickerModel[]> {
  const binaryPath = resolveBinaryPath(opts?.binaryPath);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  const nowMs = now();

  const cached = cache.get(binaryPath);
  if (cached && nowMs - cached.fetchedAt < ttlMs) {
    return cached.models;
  }

  const existingInFlight = inFlight.get(binaryPath);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async (): Promise<GrokPickerModel[]> => {
    try {
      const result = await discoverGrokCliModels({ binaryPath });
      if (!result || result.models.length === 0) {
        return [];
      }
      return grokDiscoveryToModels(result.models);
    } catch {
      // Degrade to zero Grok rows on any spawn/parse failure (ENOENT,
      // non-zero exit, timeout, no API key configured) — never let a Grok
      // error propagate into /api/models. See FNXC:GrokCli comment above.
      return [];
    }
  })();

  inFlight.set(binaryPath, fetchPromise);

  try {
    const models = await fetchPromise;
    cache.set(binaryPath, { fetchedAt: now(), models });
    return models;
  } finally {
    inFlight.delete(binaryPath);
  }
}
