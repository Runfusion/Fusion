/**
 * OMP CLI discovery → model-picker mapping, behind a short-TTL single-flight cache.
 *
 * FNXC:OmpAcp 2026-07-13-22:50:
 * Mirrors grok-model-cache / cursor-model-cache. When useOmpCli is true, surface
 * models from `omp models` under provider id `omp-cli`. Never throws; empty on failure.
 */

import { discoverOmpCliModels } from "./runtime-provider-probes.js";

export interface OmpPickerModel {
  provider: "omp-cli";
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
}

export const OMP_PICKER_PROVIDER_ID = "omp-cli" as const;

const DEFAULT_TTL_MS = 60_000;
const EMPTY_RESULT_TTL_MS = 5_000;

export function ompDiscoveryToModels(
  models: ReadonlyArray<{ id: string; label?: string }>,
): OmpPickerModel[] {
  const seen = new Set<string>();
  const result: OmpPickerModel[] = [];
  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      provider: OMP_PICKER_PROVIDER_ID,
      id,
      name: model.label?.trim() || id,
      reasoning: false,
      contextWindow: 0,
    });
  }
  return result;
}

interface CacheEntry {
  fetchedAt: number;
  models: OmpPickerModel[];
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OmpPickerModel[]>>();

export function __resetOmpPickerModelsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export interface GetOmpPickerModelsOptions {
  binaryPath?: string;
  ttlMs?: number;
  now?: () => number;
}

export async function getOmpPickerModels(
  opts?: GetOmpPickerModelsOptions,
): Promise<OmpPickerModel[]> {
  const binaryPath = opts?.binaryPath ?? "omp";
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  const nowMs = now();

  const cached = cache.get(binaryPath);
  if (cached && nowMs - cached.fetchedAt < cached.ttlMs) {
    return cached.models;
  }

  const existingInFlight = inFlight.get(binaryPath);
  if (existingInFlight) return existingInFlight;

  const fetchPromise = (async (): Promise<OmpPickerModel[]> => {
    try {
      const result = await discoverOmpCliModels({ binaryPath });
      if (!result || result.models.length === 0) return [];
      return ompDiscoveryToModels(result.models);
    } catch {
      return [];
    }
  })();

  inFlight.set(binaryPath, fetchPromise);
  try {
    const models = await fetchPromise;
    const effectiveTtlMs = models.length === 0 ? EMPTY_RESULT_TTL_MS : ttlMs;
    cache.set(binaryPath, { fetchedAt: now(), models, ttlMs: effectiveTtlMs });
    return models;
  } finally {
    inFlight.delete(binaryPath);
  }
}
