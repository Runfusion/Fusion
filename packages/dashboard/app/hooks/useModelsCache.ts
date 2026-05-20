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
    inflight = fetchModels().finally(() => {
      inflight = null;
    });
  }
  return inflight;
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
