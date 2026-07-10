import { useCallback, useEffect, useRef, useState } from "react";
import { fetchModels, type ModelInfo, type ModelsResponse } from "../api";
import { clearCache, readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "../utils/swrCache";

interface ModelsCacheState {
  models: ModelInfo[];
  favoriteProviders: string[];
  favoriteModels: string[];
  defaultProvider: string | null;
  defaultModelId: string | null;
}

export interface UseModelsCacheResult extends ModelsCacheState {
  loading: boolean;
  refresh: () => Promise<void>;
}

const EMPTY_MODELS_STATE: ModelsCacheState = {
  models: [],
  favoriteProviders: [],
  favoriteModels: [],
  defaultProvider: null,
  defaultModelId: null,
};

let inflight: Promise<ModelsResponse> | null = null;
// Guards concurrent refreshModelsCache() callers so they share one forced
// fetch instead of each spawning its own request (see FNXC:ModelCatalog
// comment on refreshModelsCache below).
let refreshInflight: Promise<void> | null = null;
const listeners = new Set<(state: ModelsCacheState) => void>();

function toModelsCacheState(response: ModelsResponse | null | undefined): ModelsCacheState {
  if (!response) {
    return EMPTY_MODELS_STATE;
  }

  return {
    models: response.models ?? [],
    favoriteProviders: response.favoriteProviders ?? [],
    favoriteModels: response.favoriteModels ?? [],
    defaultProvider: response.defaultProvider ?? null,
    defaultModelId: response.defaultModelId ?? null,
  };
}

function readCachedModelsState(): ModelsCacheState | null {
  const cached = readCache<ModelsResponse>(SWR_CACHE_KEYS.MODELS, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
  return cached ? toModelsCacheState(cached) : null;
}

function notifyListeners(state: ModelsCacheState): void {
  for (const listener of listeners) {
    listener(state);
  }
}

async function fetchModelsShared(): Promise<ModelsResponse> {
  if (!inflight) {
    const promise = fetchModels();
    inflight = promise;
    // Only clear `inflight` if it still points at *this* promise — a forced
    // refresh (see refreshModelsCache) may have already replaced it with a
    // newer in-flight fetch, and this stale promise resolving later must not
    // wipe out that newer reference out from under it. `.catch(() => {})`
    // swallows the rejection on THIS bookkeeping branch only — the original
    // `promise` returned below is untouched and still rejects for callers
    // that await it, so error handling (try/catch in load()/refreshModelsCache)
    // is unaffected; this just avoids a duplicate unhandled-rejection listener.
    promise.then(
      () => {
        if (inflight === promise) inflight = null;
      },
      () => {
        if (inflight === promise) inflight = null;
      },
    );
  }
  return inflight;
}

/**
 * FNXC:ModelCatalog 2026-07-08-00:00:
 * FN-7710: Enabling/disabling a CLI provider (Grok, Cursor, Claude CLI,
 * llama.cpp) changes which rows `/api/models` returns, but every already-
 * mounted `useModelsCache()` consumer (board Quick Entry, Task Detail, New
 * Agent, Workflow editor, etc.) only re-fetches on its own mount — it has no
 * way to know the shared catalog is now stale. Previously the CLI provider
 * cards' `onToggled` handler only refreshed the Settings Authentication
 * panel (`loadAuthStatus()`), so newly-enabled `grok-cli`/`cursor-cli`
 * models stayed invisible until some unrelated Settings surface happened to
 * call `fetchModels()` fresh. `refreshModelsCache()` is the shared,
 * single-flight, never-throw entry point any non-hook caller (a settings
 * card, a toggle handler) can invoke to force a fresh fetch, write through
 * `SWR_CACHE_KEYS.MODELS`, and notify every mounted `useModelsCache`
 * subscriber via the module-level `listeners` set — no remount required.
 * Concurrent `refreshModelsCache()` callers share one forced fetch via
 * `refreshInflight`. A failed refresh must never blank an existing good
 * list: on error this simply leaves the current cache/listeners state
 * untouched, so a transient network hiccup degrades to "keep showing the
 * last good list", not an empty picker.
 */
export async function refreshModelsCache(): Promise<void> {
  if (refreshInflight) {
    return refreshInflight;
  }

  refreshInflight = (async () => {
    try {
      // Force a fresh fetch: drop any pre-toggle in-flight promise so a
      // response requested before the provider toggle took effect is never
      // mistaken for the post-toggle catalog.
      inflight = null;
      const response = await fetchModelsShared();
      const nextState = toModelsCacheState(response);
      writeCache(SWR_CACHE_KEYS.MODELS, response, { maxBytes: 500_000 });
      notifyListeners(nextState);
    } catch {
      // Never throw, never blank an existing good list — leave cache/listeners
      // state untouched on failure (see FNXC:ModelCatalog comment above).
    }
  })().finally(() => {
    refreshInflight = null;
  });

  return refreshInflight;
}

export function useModelsCache(): UseModelsCacheResult {
  const cachedState = readCachedModelsState();
  const [state, setState] = useState<ModelsCacheState>(() => cachedState ?? EMPTY_MODELS_STATE);
  const [loading, setLoading] = useState(() => cachedState === null);
  const hasCachedStateRef = useRef(cachedState !== null);

  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetchModelsShared();
      const nextState = toModelsCacheState(response);
      hasCachedStateRef.current = true;
      writeCache(SWR_CACHE_KEYS.MODELS, response, { maxBytes: 500_000 });
      notifyListeners(nextState);
    } catch {
      if (!hasCachedStateRef.current) {
        clearCache(SWR_CACHE_KEYS.MODELS);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await load();
  }, [load]);

  return {
    ...state,
    loading,
    refresh,
  };
}
