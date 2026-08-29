/**
 * Hermes profile → model-picker mapping, behind a short-TTL, single-flight
 * cache so `/api/models` never spawns the `hermes` CLI per request.
 *
 * FNXC:ModelCatalog 2026-07-07-09:00:
 * FN-7636 (deferred item 1 of FN-7630/GitHub #1931): Hermes-configured models
 * (`hermes profile list`) must appear additively in Fusion's `/api/models`
 * picker under the stable `"hermes"` provider id (== HERMES_RUNTIME_ID in the
 * plugin's index.ts), so selections route to the Hermes runtime. The source
 * of truth, `listHermesProviderProfiles` (façade over `listHermesProfiles`),
 * spawns the real `hermes` binary as a subprocess — expensive and slow
 * relative to an HTTP handler, and `/api/models` can be polled frequently by
 * dashboard clients. This module owns two contracts:
 *   1. A deterministic, stable profile→model-id mapping (id = profile name)
 *      so picker selections remain stable across requests/restarts.
 *   2. A per-binaryPath TTL cache (default 60s) with single-flight
 *      de-duplication of concurrent in-flight fetches, so parallel
 *      `/api/models` requests spawn the CLI at most once per TTL window.
 * A missing/failed `hermes` binary (ENOENT, non-zero exit, timeout) must
 * degrade to an empty model list — never throw — so `/api/models` always
 * returns HTTP 200 with existing rows intact. The empty result is cached
 * briefly too, so a persistently-missing binary does not turn into a
 * spawn-per-request storm.
 */

import { listHermesProviderProfiles, type HermesProfileSummary } from "./runtime-provider-probes.js";

/** Stable model-picker row shape emitted for a Hermes profile. */
export interface HermesPickerModel {
  provider: "hermes";
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

/** The picker provider id used for all Hermes-derived model rows. */
export const HERMES_PICKER_PROVIDER_ID = "hermes" as const;

/** Default cache TTL for Hermes profile listings, in milliseconds. */
const DEFAULT_TTL_MS = 60_000;

/**
 * Map `hermes profile list` output into the stable `/api/models` row shape.
 *
 * The profile `name` is used as the stable model id (it is the CLI's own
 * unique identifier). The display `name` label incorporates the configured
 * `model` when present so users can tell profiles apart by underlying model,
 * e.g. `"default (MiniMax-M3)"`. `reasoning`/`contextWindow` are unknown at
 * this layer (Hermes does not report them via `profile list`), so they
 * default to `false`/`0` — enrichment is a documented follow-up, not part of
 * this task's scope.
 *
 * Profiles that map to the same id (duplicate profile names — should not
 * normally happen, but the CLI's output is free text) are de-duplicated,
 * keeping the first occurrence.
 */
export function hermesProfilesToModels(profiles: readonly HermesProfileSummary[]): HermesPickerModel[] {
  const seen = new Set<string>();
  const models: HermesPickerModel[] = [];

  for (const profile of profiles) {
    const id = profile.name.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = profile.model ? `${id} (${profile.model})` : id;

    models.push({
      provider: HERMES_PICKER_PROVIDER_ID,
      id,
      name,
      reasoning: false,
      contextWindow: 0,
    });
  }

  return models;
}

interface CacheEntry {
  /** Timestamp (ms) at which this entry was populated. */
  fetchedAt: number;
  /** The resolved (possibly empty, on failure) model list. */
  models: HermesPickerModel[];
}

/** Per-binaryPath cache of the most recently resolved Hermes picker models. */
const cache = new Map<string, CacheEntry>();

/** Per-binaryPath in-flight fetch promise, for single-flight de-duplication. */
const inFlight = new Map<string, Promise<HermesPickerModel[]>>();

/**
 * Reset all cached/in-flight state. Test-only escape hatch — production code
 * should never need this since entries expire naturally via TTL.
 */
export function __resetHermesPickerModelsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export interface GetHermesPickerModelsOptions {
  /** Override the hermes binary path. Defaults to `HERMES_BIN` env, then `"hermes"`. */
  binaryPath?: string;
  /** Cache TTL in milliseconds. Defaults to 60s. */
  ttlMs?: number;
  /** Injectable clock (ms epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolve the Hermes binary path: explicit override, then `HERMES_BIN` env,
 * then the bare `"hermes"` command (resolved via PATH by the CLI spawn layer).
 */
function resolveBinaryPath(explicit?: string): string {
  return explicit ?? process.env.HERMES_BIN ?? "hermes";
}

/**
 * Fetch Hermes-configured models for the model picker, behind a short-TTL,
 * single-flight cache keyed by binary path.
 *
 * Never throws: a `listHermesProviderProfiles` failure (missing binary,
 * non-zero exit, timeout) resolves to `[]`, which is itself cached briefly
 * (same TTL) so a persistently-broken/missing binary does not spawn the CLI
 * on every call.
 */
export async function getHermesPickerModels(
  opts?: GetHermesPickerModelsOptions,
): Promise<HermesPickerModel[]> {
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

  const fetchPromise = (async (): Promise<HermesPickerModel[]> => {
    try {
      const profiles = await listHermesProviderProfiles({ binaryPath });
      return hermesProfilesToModels(profiles);
    } catch {
      // Degrade to zero Hermes rows on any spawn/parse failure (ENOENT,
      // non-zero exit, timeout) — never let a Hermes error propagate into
      // /api/models. See FNXC:ModelCatalog comment at the top of this file.
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
